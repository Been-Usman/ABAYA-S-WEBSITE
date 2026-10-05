/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — Public Script (v5 — FIXED)
   ------------------------------------------------------------
   Requires: queue.js loaded BEFORE this file.

   WHAT CHANGED IN v5:
   1. checkoutCart() rebuilt — no undefined variables.
   2. Order ID is generated client-side so WhatsApp and the
      backend show the same ID.
   3. dedupeVariants() dedupes by colorName + code + price.
   4. Smart refresh: the 60s interval only re-renders when the
      data actually changed (backend + pending hash).
   5. Swipe click-suppression ordering fixed.
   6. optimizeImage uses c_limit (no crop), passes blob:/data: through.
   7. Dead splash timeouts removed (one + one safety net).
   8. Pending products are read from IndexedDB via queue.js
      (no more nakowa_pending_products localStorage).
   9. BroadcastChannel 'nakowa-queue' refreshes the grid live.
  10. Actual-only price. No fake, no +5000, no strikethrough.
  11. Tracking modal uses trackOrder when the backend supports it,
      and falls back to the old fetch if not.

   Honest limitation:
     Other customers on other devices only see new products AFTER
     the backend save. Only this browser sees them instantly.
   ============================================================ */

// ============================================================
// CONFIGURATION
// ============================================================
const API_URL = 'https://script.google.com/macros/s/AKfycbxGcW2xkagjfp9Dr3Jz_1sflwM-JRbjPV1LUF4UoWzhAGJU2epWVDhXoQH9TgkevU5D/exec';

const CLOUDINARY = {
    cloudName: 'ldtixrva',
    uploadPreset: 'NAKOWA-ABAYAS',
    folder: 'ABAYAS-VIDEO-IMGS',
    baseUrl: 'https://api.cloudinary.com/v1_1/ldtixrva'
};

const SUPABASE = {
    url: 'https://vtvrfbvbulflvhguctej.supabase.co',
    key: 'sb_publishable_A35YZF-EKyOvJAdK2flkkw_3lJoDYjI',
    bucket: 'product-images',
    bucketAliases: ['product-images', 'Product-images', 'PRODUCT-IMAGES', 'Product-Images', 'products-images', 'nakowa-images'],
    maxImages: 200,
    maxSizeMB: 900,
    threshold: 200
};

const DEFAULT_WHATSAPP = '201500766295';

// ============================================================
// STATE
// ============================================================
let products = [];
let settings = {};
let cart = [];
let currentCountryFilter = 'all';
let currentPriceFilter = 'all';

// Track the last rendered product signature so we can skip no-op re-renders
let lastRenderSignature = '';

// ============================================================
// API
// ============================================================
async function apiGet(action) {
    const res = await fetch(`${API_URL}?action=${action}`);
    return res.json();
}

async function apiPost(action, data = {}) {
    const res = await fetch(API_URL, {
        method: 'POST',
        body: JSON.stringify({ action, ...data })
    });
    return res.json();
}

// ============================================================
// HELPERS
// ============================================================
const DEFAULT_IMG = window.FALLBACK_IMG || 'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22400%22%20height%3D%22400%22%20viewBox%3D%220%200%20400%20400%22%3E%3Crect%20width%3D%22400%22%20height%3D%22400%22%20fill%3D%22%23000000%22%2F%3E%3Ctext%20x%3D%22200%22%20y%3D%22200%22%20fill%3D%22%23d4af37%22%20font-family%3D%22Poppins%2CArial%2Csans-serif%22%20font-size%3D%2256%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22central%22%3ENAKOWA%3C%2Ftext%3E%3C%2Fsvg%3E';

if (typeof window.imgFallback !== 'function') {
    window.imgFallback = function (img) {
        if (!img || img.dataset.fbApplied === '1') return;
        img.dataset.fbApplied = '1';
        img.onerror = null;
        img.src = DEFAULT_IMG;
    };
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, s => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[s]);
}

// Sanitize product media: blob: URLs die on page reload, so any product
// restored from localStorage cache (or a stale backend row) carrying a
// blob: image/video would render as a broken icon. Strip them so the
// card falls back to the placeholder instead of a broken-image glyph.
function sanitizeProductMedia(p) {
    if (!p || typeof p !== 'object') return p;
    const cleanUrl = function (u) {
        if (typeof u !== 'string') return u;
        const t = u.trim();
        if (t.toLowerCase().indexOf('blob:') === 0) return '';
        return u;
    };
    if (Array.isArray(p.variants)) {
        p.variants.forEach(function (v) {
            if (v && typeof v === 'object') v.image = cleanUrl(v.image);
        });
    }
    if (Array.isArray(p.images)) {
        p.images = p.images.map(cleanUrl).filter(function (u) { return typeof u === 'string' && u.trim(); });
    } else if (typeof p.images === 'string' && p.images) {
        p.images = p.images.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s && s.toLowerCase().indexOf('blob:') !== 0; }).join(',');
    }
    if (Array.isArray(p.videos)) {
        p.videos = p.videos.filter(function (u) { return typeof u === 'string' && u.trim() && u.trim().toLowerCase().indexOf('blob:') !== 0; });
    }
    return p;
}

// Safety net: if ANY <img> on the page fails (e.g. inline onerror was
// lost, or the URL died), swap in the placeholder once. Capture phase
// catches resource errors that don't bubble.
document.addEventListener('error', function (e) {
    const t = e.target;
    if (t && t.tagName === 'IMG' && !t.dataset.fbApplied) {
        t.dataset.fbApplied = '1';
        try { t.onerror = null; } catch (err) {}
        t.src = DEFAULT_IMG;
    } else if (t && t.tagName === 'VIDEO' && !t.dataset.vbApplied) {
        t.dataset.vbApplied = '1';
        const img = document.createElement('img');
        img.src = DEFAULT_IMG;
        img.alt = t.getAttribute('alt') || '';
        img.setAttribute('onerror', 'imgFallback(this)');
        try { t.replaceWith(img); } catch (err) {}
    }
}, true);

// c_limit — no crop, keeps aspect ratio. Passes blob:/data: through unchanged.
function optimizeImage(url, width = 500, height = 500) {
    url = (typeof url === 'string') ? url.trim() : url;
    if (!url) return DEFAULT_IMG;
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    if (url.includes('res.cloudinary.com')) {
        const parts = url.split('/upload/');
        if (parts.length === 2) {
            const transform = `c_limit,w_${width},h_${height},q_auto,f_auto`;
            return `${parts[0]}/upload/${transform}/${parts[1]}`;
        }
    }
    return url;
}

function applyVideo10sLoop(container) {
    if (!container) return;
    container.querySelectorAll('video').forEach(v => {
        if (v._loop10sAttached) return;
        v._loop10sAttached = true;
        v.muted = true;
        v.setAttribute('muted', '');
        v.setAttribute('playsinline', '');
        v.autoplay = true;
        v.loop = false;
        v.addEventListener('timeupdate', function() {
            if (this.currentTime >= 10) {
                this.currentTime = 0;
                this.play().catch(() => {});
            }
        });
        v.addEventListener('loadeddata', () => v.play().catch(() => {}));
        v.play().catch(() => {});
    });
}

// ============================================================
// PRICE RENDERER — real (actual) price only.
// The struck-through old price (real + 5) is rendered separately by
// getOldPriceHTML() and appears ONLY inside the opened product view,
// never on the normal product card.
// ============================================================
function renderPrice(actualPrice) {
    const actual = parseFloat(actualPrice) || 0;
    return `<span class="price-actual">₦${actual.toLocaleString()}</span>`;
}

function getPriceHTML(actualPrice) {
    return renderPrice(actualPrice);
}

// ============================================================
// SPLASH
// ============================================================
const SPLASH_TIME = 3000;
let splashHidden = false;

function hideSplash() {
    if (splashHidden) return;
    splashHidden = true;
    const s = document.getElementById('splashScreen');
    if (s) {
        s.classList.add('fade-out');
        setTimeout(() => {
            s.style.display = 'none';
            s.style.visibility = 'hidden';
            s.style.opacity = '0';
        }, 800);
    }
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, icon = '✅') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    document.getElementById('toastMessage').textContent = message;
    const iconEl = toast.querySelector('.toast-icon');
    if (iconEl) iconEl.textContent = icon;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ============================================================
// THEME
// ============================================================
function getTheme() {
    return localStorage.getItem('nakowa_theme') || 'dark';
}

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nakowa_theme', theme);
    const icon = document.querySelector('#themeToggle i');
    const mobileIcon = document.querySelector('#mobileThemeToggle i');
    if (theme === 'light') {
        if (icon) icon.className = 'fas fa-sun';
        if (mobileIcon) mobileIcon.className = 'fas fa-sun';
    } else {
        if (icon) icon.className = 'fas fa-moon';
        if (mobileIcon) mobileIcon.className = 'fas fa-moon';
    }
}

// ============================================================
// CART
// ============================================================
function updateCartUI() {
    const count = cart.reduce((s, i) => s + i.qty, 0);
    const total = cart.reduce((s, i) => s + (i.price * i.qty), 0);

    const cartCount = document.getElementById('cartCount');
    const mobileCount = document.getElementById('mobileCartCount');
    const cartTotal = document.getElementById('cartTotalAmount');

    if (cartCount) {
        cartCount.textContent = count;
        cartCount.classList.toggle('hidden', count === 0);
    }
    if (mobileCount) mobileCount.textContent = count;
    if (cartTotal) cartTotal.textContent = '₦' + total.toLocaleString();

    const container = document.getElementById('cartItems');
    if (!container) return;

    if (cart.length === 0) {
        container.innerHTML = '<div class="cart-empty"><i class="fas fa-shopping-bag"></i>Your cart is empty.</div>';
        return;
    }

    container.innerHTML = cart.map((item, idx) => `
        <div class="cart-item">
            <img src="${escapeHtml(item.image || DEFAULT_IMG)}" alt="${escapeHtml(item.name)}" onerror="imgFallback(this)" />
            <div class="cart-item-info">
                <h4>${escapeHtml(item.name)}</h4>
                <p>₦${item.price.toLocaleString()} × ${item.qty}</p>
                <div class="cart-item-meta">Size: ${escapeHtml(item.size)} · Color: ${escapeHtml(item.colorName)}</div>
            </div>
            <button class="remove-item" data-idx="${idx}"><i class="fas fa-times"></i></button>
        </div>
    `).join('');

    container.querySelectorAll('.remove-item').forEach(btn => {
        btn.addEventListener('click', function() {
            const idx = parseInt(this.dataset.idx);
            const removed = cart[idx];
            cart.splice(idx, 1);
            saveCart();
            updateCartUI();
            showToast(`Removed ${removed.name}`, '🗑️');
        });
    });
}

function saveCart() {
    localStorage.setItem('nakowa_cart', JSON.stringify(cart));
}

function loadCart() {
    try {
        const saved = localStorage.getItem('nakowa_cart');
        if (saved) cart = JSON.parse(saved);
    } catch (e) { cart = []; }
    updateCartUI();
}

function addToCart(product, variant, size, qty = 1) {
    const existing = cart.find(i =>
        i.id === product.id &&
        i.size === size &&
        i.colorName === variant.colorName
    );
    if (existing) {
        existing.qty += qty;
    } else {
        cart.push({
            id: product.id,
            name: product.name,
            code: variant.code || product.code,
            price: parseFloat(variant.price || product.price) || 0,
            image: variant.image,
            colorName: variant.colorName,
            colorValue: variant.colorValue,
            size: size,
            qty: qty
        });
    }
    saveCart();
    updateCartUI();
    showToast(`Added ${product.name} (${variant.colorName}) to cart!`, '🛒');
}

// ============================================================
// ABANDONED CHECKOUT TRACKER
// ============================================================
function saveAbandonedCart(product, variant) {
    try {
        const record = {
            productId: product.id,
            productName: product.name,
            productCode: variant.code || product.code,
            colorName: variant.colorName,
            colorValue: variant.colorValue,
            price: parseFloat(variant.price || product.price) || 0,
            image: variant.image,
            savedAt: Date.now()
        };
        localStorage.setItem('nakowa_abandoned', JSON.stringify(record));
    } catch (e) {}
}

function clearAbandonedCart() {
    try { localStorage.removeItem('nakowa_abandoned'); } catch (e) {}
}

function checkAbandonedCart() {
    try {
        const raw = localStorage.getItem('nakowa_abandoned');
        if (!raw) return;
        const record = JSON.parse(raw);
        if (Date.now() - record.savedAt > 24 * 60 * 60 * 1000) {
            clearAbandonedCart();
            return;
        }
        const product = products.find(p => String(p.id) === String(record.productId));
        if (!product) return;
        const variants = product.variants || [];
        const variant = variants.find(v => v.colorName === record.colorName) || variants[0];
        if (!variant) return;

        const grid = document.getElementById('productGrid');
        if (!grid || !grid.parentElement) return;
        const existing = document.getElementById('abandonedBanner');
        if (existing) existing.remove();

        const banner = document.createElement('div');
        banner.id = 'abandonedBanner';
        banner.className = 'abandoned-banner';
        banner.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between;width:100%;">
                <div style="display:flex;align-items:center;gap:10px;">
                    <i class="fas fa-shopping-bag" style="color:var(--gold);font-size:1.3rem;"></i>
                    <span>You left <strong style="color:var(--gold);">${escapeHtml(record.productName)}</strong> in your cart. Complete your order?</span>
                </div>
                <div style="display:flex;gap:8px;">
                    <button class="btn-gold" id="abandonedResumeBtn" style="padding:8px 16px;font-size:0.8rem;">Yes, continue</button>
                    <button class="btn-outline-gold" id="abandonedDismissBtn" style="padding:8px 16px;font-size:0.8rem;">Dismiss</button>
                </div>
            </div>
        `;
        grid.parentElement.insertBefore(banner, grid);

        document.getElementById('abandonedResumeBtn').addEventListener('click', () => {
            banner.remove();
            openOrderModal(product, variant);
        });

        document.getElementById('abandonedDismissBtn').addEventListener('click', () => {
            banner.remove();
            clearAbandonedCart();
        });
    } catch (e) {
        console.warn('Abandoned cart error:', e);
    }
}

// ============================================================
// PRODUCT HELPERS
// ============================================================
function getProductPrice(p) {
    if (p.variants && Array.isArray(p.variants) && p.variants.length > 0) {
        return parseFloat(p.variants[0].price) || 0;
    }
    return parseFloat(p.price) || 0;
}

function getFirstImage(p) {
    if (p.variants && Array.isArray(p.variants) && p.variants.length > 0) {
        let vImg = p.variants[0] && p.variants[0].image;
        if (Array.isArray(vImg) && vImg.length > 0) vImg = vImg[0];
        if (typeof vImg === 'string' && vImg.trim()) return vImg.split(',')[0].trim();
        return '';
    }
    if (Array.isArray(p.images) && p.images.length > 0) return p.images[0];
    if (typeof p.images === 'string' && p.images) return p.images.split(',')[0].trim();
    return '';
}

// ============================================================
// COLOR HELPERS — dedupe by colorName + code + price
// ============================================================
function normalizeColor(name) {
    return (name || '').trim().toLowerCase();
}

function dedupeVariants(variants) {
    if (!Array.isArray(variants)) return [];
    const seen = new Set();
    const out = [];
    for (const v of variants) {
        const key = [
            normalizeColor(v.colorName),
            (v.code || '').toString().trim(),
            (parseFloat(v.price) || 0)
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
    }
    return out;
}

// ============================================================
// DYNAMIC COUNTRY FILTERS
// ============================================================
function rebuildCountryFilters() {
    const container = document.getElementById('countryFilters');
    if (!container) return;

    const countries = [...new Set(products.map(p => p.country).filter(Boolean))];
    if (!countries.includes('Egypt')) countries.unshift('Egypt');

    const active = currentCountryFilter;

    container.innerHTML = `
        <button class="filter-btn ${active === 'all' ? 'active' : ''}" data-country="all">All</button>
        ${countries.map(c => `
            <button class="filter-btn ${active === c ? 'active' : ''}" data-country="${escapeHtml(c)}">
                ${c === 'Egypt' ? '🇪🇬 ' : ''}${escapeHtml(c)}
            </button>
        `).join('')}
    `;

    container.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            container.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            currentCountryFilter = this.dataset.country;
            renderProducts();
        });
    });
}

// ============================================================
// RENDER PRODUCTS
// ============================================================
function renderProducts() {
    const grid = document.getElementById('productGrid');
    if (!grid) return;

    rebuildCountryFilters();

    let filtered = products.filter(p => p.status !== 'inactive');

    if (currentCountryFilter !== 'all') {
        filtered = filtered.filter(p => p.country === currentCountryFilter);
    }

    if (currentPriceFilter !== 'all') {
        const limit = currentPriceFilter === '35k' ? 35000 : 40000;
        filtered = filtered.filter(p => {
            const price = getProductPrice(p);
            return price > 0 && price <= limit;
        });
    }

    const display = document.getElementById('productCountDisplay');
    if (display) display.textContent = filtered.length;

    if (filtered.length === 0) {
        grid.innerHTML = '<div class="empty-state">✨ No Abayas found — try another filter.</div>';
        return;
    }

    // Preserve selected color per card across re-renders.
    const prevSelected = {};
    grid.querySelectorAll('.product-card').forEach(card => {
        if (card.dataset.selectedColor) {
            prevSelected[card.dataset.id] = card.dataset.selectedColor;
        }
    });

    grid.innerHTML = filtered.map(p => renderProductCard(p)).join('');

    // Restore selected color.
    Object.keys(prevSelected).forEach(pid => {
        const card = grid.querySelector(`.product-card[data-id="${pid}"]`);
        if (!card) return;
        const circles = card.querySelectorAll('.color-circle');
        const target = prevSelected[pid];
        circles.forEach((c, i) => {
            if (c.dataset.colorName === target) {
                c.classList.add('selected');
                // Fire the update once to sync image + price.
                c.click();
            }
        });
    });

    attachProductListeners();
    applyVideo10sLoop(grid);
}

function renderProductCard(p) {
    let variants = dedupeVariants((p.variants && Array.isArray(p.variants)) ? p.variants : []);
    variants = variants.map(function (v) {
        let img = v.image;
        if (Array.isArray(img)) img = img[0] || '';
        if (typeof img === 'string' && img.indexOf(',http') !== -1) img = img.split(',')[0].trim();
        return Object.assign({}, v, { image: img });
    });
    const firstVariant = variants[0] || {
        image: getFirstImage(p),
        colorName: 'Default',
        colorValue: '#d4af37',
        price: p.price || 0,
        code: p.code || ''
    };

    const mainImage = optimizeImage(firstVariant.image, 500, 500);
    const firstVideo = (p.videos && Array.isArray(p.videos) && p.videos.length > 0) ? p.videos[0] : null;
    const country = p.country || 'Egypt';
    const flag = country === 'Egypt' ? '🇪🇬' : '';

    const pending = null;
    const isPending = false;
    const uploadedCount = 0;
    const totalCount = 0;

    const pendingBadge = '';

    let colorCirclesHTML = '';
    if (variants.length > 0) {
        colorCirclesHTML = `
            <div class="color-circles" data-product-id="${escapeHtml(p.id)}">
                ${variants.map((v, i) => `
                    <button class="color-circle ${i === 0 ? 'selected' : ''}"
                            data-color-index="${i}"
                            data-image="${escapeHtml(v.image || '')}"
                            data-color-name="${escapeHtml(v.colorName || '')}"
                            data-color-value="${escapeHtml(v.colorValue || '')}"
                            data-price="${v.price || p.price || 0}"
                            data-code="${escapeHtml(v.code || p.code || '')}"
                            style="background-color: ${escapeHtml(v.colorValue || '#ccc')};"
                            title="${escapeHtml(v.colorName || '')}"
                            aria-label="${escapeHtml(v.colorName || '')}"></button>
                `).join('')}
            </div>
        `;
    }

    return `
        <div class="product-card" data-id="${escapeHtml(p.id)}">
            <div class="product-image">
                ${firstVideo
                    ? `<video src="${escapeHtml(firstVideo)}" muted autoplay loop playsinline data-autoplay-video></video>`
                    : `<img src="${escapeHtml(mainImage)}" alt="${escapeHtml(p.name)}" loading="lazy" onerror="imgFallback(this)" />`
                }
                ${flag ? `<span class="country-badge">${flag} ${escapeHtml(country)}</span>` : ''}
                <button class="card-heart" data-product-id="${escapeHtml(p.id)}" aria-label="Like this product">
                    <i class="far fa-heart"></i>
                    <span class="card-heart-count">0</span>
                </button>
            </div>
            <div class="product-info">
                <div class="product-name">${escapeHtml(p.name)}</div>
                <div class="product-code">${escapeHtml(firstVariant.code || p.code || '')}</div>
                ${colorCirclesHTML}
                <div class="product-price" data-product-id="${escapeHtml(p.id)}">${getPriceHTML(firstVariant.price || 0)}</div>
                <button class="btn-order" data-id="${escapeHtml(p.id)}">
                    <i class="fas fa-shopping-cart"></i> Order Now
                </button>
            </div>
        </div>
    `;
}

function attachProductListeners() {
    document.querySelectorAll('.product-card').forEach(card => {
        const productId = card.dataset.id;
        const product = products.find(x => String(x.id) === String(productId));
        if (!product) return;

        const variants = dedupeVariants(product.variants || []);
        if (variants.length === 0) return;

        let currentIndex = 0;
        let suppressClickUntil = 0;

        const imgEl = card.querySelector('.product-image img');
        const videoEl = card.querySelector('.product-image video');
        const circles = card.querySelectorAll('.color-circle');

        function updateToIndex(idx) {
            if (idx < 0) idx = 0;
            if (idx >= variants.length) idx = variants.length - 1;
            currentIndex = idx;

            const v = variants[idx];

            if (imgEl && v.image) {
                imgEl.src = optimizeImage(v.image, 500, 500);
            } else if (videoEl && v.image) {
                videoEl.outerHTML = `<img src="${escapeHtml(optimizeImage(v.image, 500, 500))}" alt="" onerror="imgFallback(this)" />`;
            }

            circles.forEach((c, i) => {
                c.classList.toggle('selected', i === idx);
            });

            const priceEl = card.querySelector('.product-price');
            if (priceEl) priceEl.innerHTML = getPriceHTML(v.price || product.price || 0);

            const codeEl = card.querySelector('.product-code');
            if (codeEl) codeEl.textContent = v.code || product.code || '';

            card.dataset.selectedColor = v.colorName || '';
            card.dataset.selectedImage = v.image || '';
            card.dataset.selectedPrice = v.price || product.price || 0;
            card.dataset.selectedCode = v.code || product.code || '';
        }

        circles.forEach((circle, i) => {
            circle.addEventListener('click', function(e) {
                e.stopPropagation();
                e.preventDefault();
                updateToIndex(i);
            });
        });

        const imageWrap = card.querySelector('.product-image');
        if (!imageWrap) return;

        let startX = 0;
        let startY = 0;
        let isDragging = false;
        const SWIPE_THRESHOLD = 40;

        imageWrap.style.touchAction = 'pan-y';
        imageWrap.style.userSelect = 'none';

        imageWrap.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;
            startX = e.clientX;
            startY = e.clientY;
            isDragging = true;
        });

        imageWrap.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
                isDragging = false;
                return;
            }

            if (Math.abs(dx) > SWIPE_THRESHOLD) {
                // Suppress the click that would fire after this swipe.
                suppressClickUntil = Date.now() + 400;
                // Also block the product view from opening on a swipe.
                card._suppressViewUntil = suppressClickUntil;

                if (dx < 0) updateToIndex(currentIndex + 1);
                else updateToIndex(currentIndex - 1);

                isDragging = false;
            }
        });

        const endDrag = () => { isDragging = false; };
        imageWrap.addEventListener('pointerup', endDrag);
        imageWrap.addEventListener('pointercancel', endDrag);
        imageWrap.addEventListener('pointerleave', endDrag);

        imageWrap.addEventListener('click', (e) => {
            if (Date.now() < suppressClickUntil) {
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);

        imageWrap.addEventListener('wheel', (e) => {
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 20) {
                e.preventDefault();
                suppressClickUntil = Date.now() + 400;
                card._suppressViewUntil = suppressClickUntil;
                if (e.deltaX > 0) updateToIndex(currentIndex + 1);
                else updateToIndex(currentIndex - 1);
            }
        }, { passive: false });

        updateToIndex(0);
    });

    // Tap the image -> open the dedicated full-width product view.
    // Wired in its own loop so it also works on cards with no colour
    // variants (those return early above). Zoom is deliberately NOT
    // offered here: the tap always opens the enlarged view instead.
    document.querySelectorAll('.product-card').forEach(card => {
        const imageWrap = card.querySelector('.product-image');
        if (!imageWrap) return;

        imageWrap.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            // A recent swipe means the user was changing colour, not tapping.
            if (Date.now() < (card._suppressViewUntil || 0)) return;

            const p = products.find(x => String(x.id) === String(card.dataset.id));
            if (!p) return;
            openProductView(p, card);
        });
    });

    document.querySelectorAll('.btn-order').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const card = this.closest('.product-card');
            const p = products.find(x => String(x.id) === String(this.dataset.id));
            if (!p) return;

            const variants = dedupeVariants(p.variants || []);
            const selectedColor = card.dataset.selectedColor;
            let variant = variants[0];
            if (selectedColor && variants.length > 0) {
                const found = variants.find(v => v.colorName === selectedColor);
                if (found) variant = found;
            }

            if (variant) {
                openOrderModal(p, variant);
            } else {
                openOrderModal(p, {
                    image: getFirstImage(p),
                    colorName: 'Default',
                    colorValue: '#d4af37',
                    price: p.price || 0,
                    code: p.code || ''
                });
            }
        });
    });

    // Like / unlike heart on the card image. stopPropagation keeps the
    // tap from opening the enlarged product view.
    document.querySelectorAll('.card-heart').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            e.preventDefault();
            const heartIcon = this.querySelector('i');
            const countEl = this.querySelector('.card-heart-count');
            const count = parseInt(countEl.textContent, 10) || 0;

            if (this.classList.contains('liked')) {
                // Unlike
                this.classList.remove('liked');
                heartIcon.classList.remove('fas');
                heartIcon.classList.add('far');
                countEl.textContent = Math.max(0, count - 1);
            } else {
                // Like
                this.classList.add('liked');
                heartIcon.classList.remove('far');
                heartIcon.classList.add('fas');
                countEl.textContent = count + 1;
            }
        });
    });
}

// ============================================================
// PRODUCT VIEW — full-width enlarged product
// Opened by tapping a product image in the grid. Shows the picture
// as large as the screen allows (aspect ratio preserved) with the
// EXISTING product name and the EXISTING Order Now button below it.
// No card text, button text, colour or styling is altered.
// ============================================================

// Resolve which variant the card is currently showing, so the enlarged
// view matches what the user tapped. Mirrors the btn-order logic.
function resolveCardVariant(product, card) {
    const variants = dedupeVariants(product.variants || []);
    const selectedColor = card && card.dataset ? card.dataset.selectedColor : '';
    if (selectedColor && variants.length > 0) {
        const found = variants.find(v => v.colorName === selectedColor);
        if (found) return found;
    }
    if (variants.length > 0) return variants[0];
    return {
        image: getFirstImage(product),
        colorName: 'Default',
        colorValue: '#d4af37',
        price: product.price || 0,
        code: product.code || ''
    };
}

// ============================================================
// PRODUCT VIEW — OLD (FAKE) PRICE
// The struck-through price is derived automatically from the real
// price (real + 5). It is NEVER stored on the product and never
// hard-coded per product, so it follows the real price everywhere.
// Used ONLY inside the opened product view — never on the card.
// ============================================================
const OLD_PRICE_OFFSET = 5;

function getOldPriceHTML(actualPrice) {
    const real = parseFloat(actualPrice) || 0;
    if (real <= 0) return '';
    const old = real + OLD_PRICE_OFFSET;
    return `<span class="price-old">₦${old.toLocaleString()}</span>`;
}

function openProductView(product, card) {
    const view = document.getElementById('productView');
    const stage = document.getElementById('productViewStage');
    const info = document.getElementById('productViewInfo');
    if (!view || !stage || !info) return;

    const variant = resolveCardVariant(product, card);

    // Use the selected colour image if there is one; otherwise fall back
    // to the product's first image, then the first video.
    const imageSrc = variant.image || '';
    const videoSrc = (product.videos && Array.isArray(product.videos) && product.videos.length > 0) ? product.videos[0] : '';

    if (imageSrc) {
        stage.innerHTML = `<img class="product-view-media"
            src="${escapeHtml(optimizeImage(imageSrc, 1200, 1200))}"
            alt="${escapeHtml(product.name)}" onerror="imgFallback(this)" />`;
    } else if (videoSrc) {
        stage.innerHTML = `<video class="product-view-media" src="${escapeHtml(videoSrc)}"
            controls playsinline preload="metadata"></video>`;
    } else {
        stage.innerHTML = `<img class="product-view-media" src="${DEFAULT_IMG}"
            alt="${escapeHtml(product.name)}" />`;
    }

    // Same title, same code, same price, same button as the card.
    info.innerHTML = `
        <div class="product-name">${escapeHtml(product.name)}</div>
        <div class="product-code">${escapeHtml(variant.code || product.code || '')}</div>
        <div class="product-price" data-product-id="${escapeHtml(product.id)}">${getPriceHTML(variant.price || product.price || 0)}${getOldPriceHTML(variant.price || product.price || 0)}</div>
        <button class="btn-order" data-id="${escapeHtml(product.id)}">
            <i class="fas fa-shopping-cart"></i> Order Now
        </button>
    `;

    // Reuse the existing order flow untouched.
    const orderBtn = info.querySelector('.btn-order');
    if (orderBtn) {
        orderBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openOrderModal(product, variant);
        });
    }

    view.classList.add('open');
    stage.scrollTop = 0;
    // Stop the page behind from scrolling while the view is open.
    document.body.style.overflow = 'hidden';
}

function closeProductView() {
    const view = document.getElementById('productView');
    if (!view) return;
    view.classList.remove('open');
    document.body.style.overflow = '';
}

// The X close button and the Escape key both return to the product grid.
function setupProductView() {
    const view = document.getElementById('productView');
    const close = document.getElementById('productViewClose');
    if (!view) return;

    if (close) close.addEventListener('click', closeProductView);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && view.classList.contains('open')) closeProductView();
    });
}

window.closeProductView = closeProductView;

// ============================================================
// ORDER MODAL
// ============================================================
function openOrderModal(product, variant, presetSize = '', presetQty = 1) {
    const modal = document.getElementById('orderModal');
    const container = document.getElementById('orderFormContainer');
    if (!modal || !container) return;

    saveAbandonedCart(product, variant);

    const sizes = Array.isArray(product.sizes) ? product.sizes : (typeof product.sizes === 'string' ? product.sizes.split(',').map(s => s.trim()) : []);
    const price = parseFloat(variant.price || product.price) || 0;

    container.innerHTML = `
        <div style="display:flex;gap:12px;align-items:center;padding:12px;background:rgba(212,175,55,0.08);border-radius:10px;margin-bottom:14px;">
            <img src="${escapeHtml(optimizeImage(variant.image, 100, 100))}" style="width:70px;height:70px;object-fit:cover;border-radius:8px;border:1px solid var(--border-gold);" onerror="imgFallback(this)" />
            <div style="flex:1;">
                <div style="font-weight:700;color:#fff;">${escapeHtml(product.name)}</div>
                <div style="font-size:0.8rem;color:rgba(255,255,255,0.7);">Code: ${escapeHtml(variant.code || product.code)}</div>
                <div style="font-size:0.8rem;color:${escapeHtml(variant.colorValue || '#fff')};">Color: ${escapeHtml(variant.colorName)}</div>
            </div>
        </div>
        <form class="order-form" id="orderForm">
            <div class="form-group"><label>Full Name *</label><input type="text" id="orderName" required placeholder="Your full name" /></div>
            <div class="form-group"><label>Phone Number *</label><input type="tel" id="orderPhone" required placeholder="+234..." /></div>
            <div class="form-group"><label>Delivery Address *</label><input type="text" id="orderAddress" required placeholder="State, City, Street" /></div>
            <div class="form-group"><label>Size *</label>
                <select id="orderSize" required>
                    <option value="">Select Size</option>
                    ${sizes.map(s => `<option value="${escapeHtml(s)}" ${s === presetSize ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group"><label>Quantity *</label><input type="number" id="orderQty" value="${presetQty}" min="1" required /></div>
            <div class="form-group"><label>Notes (optional)</label><textarea id="orderNotes" placeholder="Any special requests..."></textarea></div>
        </form>
        <div class="order-summary">
            <p><strong>Price:</strong> <span id="sumPrice">₦${price.toLocaleString()}</span></p>
            <p><strong>Qty:</strong> <span id="sumQty">${presetQty}</span></p>
            <p class="total">Total: ₦<span id="sumTotal">${(price * presetQty).toLocaleString()}</span></p>
        </div>
        <button class="btn-gold" style="width:100%;" id="confirmOrderBtn">
            <i class="fab fa-whatsapp"></i> Confirm Order via WhatsApp
        </button>
    `;

    modal.classList.add('open');

    const qtyEl = document.getElementById('orderQty');
    qtyEl.addEventListener('input', () => {
        const q = parseInt(qtyEl.value) || 1;
        document.getElementById('sumQty').textContent = q;
        document.getElementById('sumTotal').textContent = (price * q).toLocaleString();
    });

    document.getElementById('confirmOrderBtn').addEventListener('click', function() {
        const name = document.getElementById('orderName').value.trim();
        const phone = document.getElementById('orderPhone').value.trim();
        const address = document.getElementById('orderAddress').value.trim();
        const size = document.getElementById('orderSize').value;
        const qty = parseInt(document.getElementById('orderQty').value) || 1;
        const notes = document.getElementById('orderNotes').value.trim();

        if (!name || !phone || !address || !size) {
            alert('Please fill in all required fields.');
            return;
        }

        const now = new Date();
        const dateStr = now.getDate() + '-' + (now.getMonth() + 1) + '-' + now.getFullYear();

        // Generate the FINAL order id on the client so WhatsApp and the
        // backend show the same id. Format: <code>-<d-M-yyyy>[-n]
        const productCode = variant.code || product.code || 'UNKNOWN';
        const baseId = productCode + '-' + dateStr;
        const allMyOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
        const sameBase = allMyOrders.filter(o => String(o.orderId || '').startsWith(baseId)).length;
        const orderId = sameBase === 0 ? baseId : (baseId + '-' + (sameBase + 1));

        const order = {
            orderId: orderId,
            customerName: name,
            customerPhone: phone,
            customerAddress: address,
            productName: product.name,
            productCode: productCode,
            colorName: variant.colorName || '',
            colorValue: variant.colorValue || '',
            size: size,
            quantity: qty,
            price: price,
            total: price * qty,
            productImage: variant.image || '',
            status: 'pending',
            notes: notes,
            date: dateStr,
            time: now.toLocaleTimeString('en-US', { hour12: false }).substring(0, 5)
        };

        const waNumber = (settings.whatsapp || DEFAULT_WHATSAPP).replace(/\D/g, '');
        const L = '────────────────────────────';
        const pad = (label, value, width) => {
            width = width || 15;
            return label + ' '.repeat(Math.max(1, width - label.length)) + value;
        };
        const waLines = [
            "NEW ORDER — NAKOWA ABAYA'S COLLECTIONS",
            '',
            L,
            '',
            pad('Product', product.name),
            pad('Code', order.productCode),
            pad('Color', order.colorName),
            pad('Size', size),
            pad('Price', '₦' + price.toLocaleString()),
            pad('Quantity', qty),
            pad('Total', '₦' + (price * qty).toLocaleString()),
            '',
            L,
            '',
            'CUSTOMER DETAILS',
            '',
            pad('Name', name),
            pad('Phone', phone),
            pad('Address', address),
            '',
            L,
            '',
            pad('Date/Time', dateStr + ' | ' + order.time),
            pad('Order ID', orderId),
            '',
            L
        ];
        if (notes) {
            waLines.push('');
            waLines.push(pad('Notes', notes));
        }
        const waMessage = waLines.join('\n');
        const waUrl = 'https://wa.me/' + waNumber + '?text=' + encodeURIComponent(waMessage);

        window.open(waUrl, '_blank');

        modal.classList.remove('open');
        showToast('Order sent! Opening WhatsApp...', '✅');

        apiPost('saveOrder', { order: order }).then(function(res) {
            const finalId = (res && res.success && res.orderId) ? res.orderId : orderId;
            const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
            myOrders.unshift(Object.assign({}, order, { orderId: finalId }));
            localStorage.setItem('nakowa_my_orders', JSON.stringify(myOrders.slice(0, 50)));
            clearAbandonedCart();
        }).catch(function(err) {
            console.error('Background save failed:', err);
            const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
            myOrders.unshift(order);
            localStorage.setItem('nakowa_my_orders', JSON.stringify(myOrders.slice(0, 50)));
            clearAbandonedCart();
        });
    });

    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            clearAbandonedCart();
        }
    }, { once: true });
}

// ============================================================
// TRACKING
// ============================================================
function showTrackingAfterOrder() {
    const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
    if (myOrders.length > 0) {
        openTrackingModal();
    }
}

async function openTrackingModal() {
    const modal = document.getElementById('trackingModal');
    const content = document.getElementById('trackingContent');
    if (!modal || !content) return;

    const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');

    content.innerHTML = `
        <div class="tracking-header">
            <img src="images/logo.png" alt="NAKOWA" class="tracking-logo" onerror="this.style.display='none'" />
            <h2>Order Tracking</h2>
        </div>
        <div class="tracking-list" id="trackingList">
            <div class="tracking-empty"><i class="fas fa-box-open"></i>Loading your orders...</div>
        </div>
        <div class="tracking-actions">
            <button class="btn-track-close" id="trackingCloseBtn">Close</button>
        </div>
    `;

    modal.classList.add('open');

    document.getElementById('trackingCloseBtn').addEventListener('click', () => {
        modal.classList.remove('open');
    });

    if (myOrders.length === 0) {
        document.getElementById('trackingList').innerHTML = `
            <div class="tracking-empty"><i class="fas fa-box-open"></i>You have no orders yet.</div>
        `;
        return;
    }

    // Fetch live status per order.
    // Prefer the public `trackOrder` action (returns one order's status).
    // Fall back to fetching all orders if the backend doesn't support it yet.
    const trackingList = document.getElementById('trackingList');

    try {
        const results = await Promise.all(myOrders.map(async (o) => {
            try {
                const r = await apiGet('trackOrder&orderId=' + encodeURIComponent(o.orderId) + '&phone=' + encodeURIComponent(o.customerPhone || ''));
                if (r && r.success && r.order) return r.order;
            } catch (e) {}
            return null;
        }));

        const anyLive = results.some(x => x);
        let liveById = {};
        if (anyLive) {
            results.forEach(x => { if (x) liveById[x.orderId] = x; });
        } else {
            const allOrders = await apiGet('orders');
            if (Array.isArray(allOrders)) {
                allOrders.forEach(o => { liveById[o.orderId] = o; });
            }
        }

        trackingList.innerHTML = myOrders.map(myOrder => {
            const liveOrder = liveById[myOrder.orderId];
            const currentStatus = (liveOrder && liveOrder.status) || myOrder.status || 'pending';
            const displayId = formatOrderIdDisplay(myOrder.orderId, myOrder.productCode);

            return `
                <div class="tracking-item">
                    <div class="tracking-item-header">
                        <div class="tracking-order-id">
                            ${escapeHtml(displayId.code)}
                            <span class="order-date">${escapeHtml(displayId.date)}${displayId.serial ? ' · ' + escapeHtml(displayId.serial) : ''}</span>
                        </div>
                        <span class="tracking-status ${escapeHtml(currentStatus)}">${escapeHtml(currentStatus)}</span>
                    </div>
                    <div class="tracking-product">
                        <img src="${escapeHtml(optimizeImage(myOrder.productImage, 100, 100))}" alt="" class="tracking-product-img" onerror="imgFallback(this)" />
                        <div class="tracking-product-info">
                            <div class="tp-name">${escapeHtml(myOrder.productName)}</div>
                            <div class="tp-meta">
                                Code: <strong>${escapeHtml(myOrder.productCode)}</strong><br>
                                Color: <strong>${escapeHtml(myOrder.colorName)}</strong> · Size: ${escapeHtml(myOrder.size)}<br>
                                Qty: ${myOrder.quantity}
                            </div>
                        </div>
                    </div>
                    <div class="tracking-total">
                        <span>Total</span>
                        <span>₦${(myOrder.total || 0).toLocaleString()}</span>
                    </div>
                </div>
            `;
        }).join('');

    } catch (err) {
        console.error('Tracking load error:', err);
        trackingList.innerHTML = myOrders.map(myOrder => {
            const displayId = formatOrderIdDisplay(myOrder.orderId, myOrder.productCode);
            return `
                <div class="tracking-item">
                    <div class="tracking-item-header">
                        <div class="tracking-order-id">
                            ${escapeHtml(displayId.code)}
                            <span class="order-date">${escapeHtml(displayId.date)}</span>
                        </div>
                        <span class="tracking-status ${escapeHtml(myOrder.status || 'pending')}">${escapeHtml(myOrder.status || 'pending')}</span>
                    </div>
                    <div class="tracking-product">
                        <img src="${escapeHtml(optimizeImage(myOrder.productImage, 100, 100))}" alt="" class="tracking-product-img" onerror="imgFallback(this)" />
                        <div class="tracking-product-info">
                            <div class="tp-name">${escapeHtml(myOrder.productName)}</div>
                            <div class="tp-meta">Code: ${escapeHtml(myOrder.productCode)} · Color: ${escapeHtml(myOrder.colorName)}</div>
                        </div>
                    </div>
                    <div class="tracking-total">
                        <span>Total</span>
                        <span>₦${(myOrder.total || 0).toLocaleString()}</span>
                    </div>
                </div>
            `;
        }).join('');
    }
}

function formatOrderIdDisplay(orderId, adminCode) {
    if (!orderId) return { code: '', date: '', serial: null };
    if (adminCode && orderId.startsWith(adminCode + '-')) {
        const rest = orderId.substring(adminCode.length + 1);
        const parts = rest.split('-');
        if (parts.length >= 3) {
            return {
                code: adminCode,
                date: parts.slice(0, 3).join('-'),
                serial: parts.slice(3).join('-') || null
            };
        }
    }
    const parts = orderId.split('-');
    if (parts.length >= 4) {
        return {
            code: parts.slice(0, -3).join('-'),
            date: parts.slice(-3).join('-'),
            serial: null
        };
    }
    return { code: orderId, date: '', serial: null };
}

// ============================================================
// CART CHECKOUT → WhatsApp
// ============================================================
async function checkoutCart() {
    if (cart.length === 0) {
        showToast('Your cart is empty!', '⚠️');
        return;
    }

    // Collect customer details using a compact prompt-style modal.
    const name = prompt('Your Full Name:');
    if (!name) return;
    const phone = prompt('Your Phone Number:');
    if (!phone) return;
    const address = prompt('Delivery Address (State, City, Street):');
    if (!address) return;

    const now = new Date();
    const dateStr = now.getDate() + '-' + (now.getMonth() + 1) + '-' + now.getFullYear();
    const timeStr = now.toLocaleTimeString('en-US', { hour12: false }).substring(0, 5);

    const grandTotal = cart.reduce((s, i) => s + (i.price * i.qty), 0);

    // Build ONE order per cart item, all with the same customer info.
    const orderRefs = [];
    for (const item of cart) {
        const productCode = item.code || 'UNKNOWN';
        const baseId = productCode + '-' + dateStr;
        const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
        const sameBase = myOrders.filter(o => String(o.orderId || '').startsWith(baseId)).length;
        const orderId = sameBase === 0 ? baseId : (baseId + '-' + (sameBase + 1));

        orderRefs.push({
            orderId: orderId,
            customerName: name,
            customerPhone: phone,
            customerAddress: address,
            productName: item.name,
            productCode: productCode,
            colorName: item.colorName || '',
            colorValue: item.colorValue || '',
            size: item.size,
            quantity: item.qty,
            price: item.price,
            total: item.price * item.qty,
            productImage: item.image || '',
            status: 'pending',
            notes: '',
            date: dateStr,
            time: timeStr
        });
    }

    // WhatsApp message — one message listing every item.
    const waNumber = (settings.whatsapp || DEFAULT_WHATSAPP).replace(/\D/g, '');
    const L = '────────────────────────────';
    const pad = (label, value, width) => {
        width = width || 15;
        return label + ' '.repeat(Math.max(1, width - label.length)) + value;
    };

    const itemLines = [];
    cart.forEach((it, idx) => {
        itemLines.push('');
        itemLines.push(pad('Item ' + (idx + 1), it.name));
        itemLines.push(pad('  Code', it.code || '-'));
        itemLines.push(pad('  Color', it.colorName || '-'));
        itemLines.push(pad('  Size', it.size));
        itemLines.push(pad('  Qty', it.qty));
        itemLines.push(pad('  Price', '₦' + it.price.toLocaleString()));
        itemLines.push(pad('  Subtotal', '₦' + (it.price * it.qty).toLocaleString()));
    });

    const waLines = [
        "NEW CART ORDER — NAKOWA ABAYA'S COLLECTIONS",
        '',
        L,
        ...itemLines,
        '',
        L,
        pad('GRAND TOTAL', '₦' + grandTotal.toLocaleString()),
        '',
        L,
        'CUSTOMER DETAILS',
        '',
        pad('Name', name),
        pad('Phone', phone),
        pad('Address', address),
        '',
        L,
        pad('Date/Time', dateStr + ' | ' + timeStr),
        '',
        L
    ];
    const waMessage = waLines.join('\n');
    const waUrl = 'https://wa.me/' + waNumber + '?text=' + encodeURIComponent(waMessage);

    window.open(waUrl, '_blank');

    // Clear cart and notify.
    cart = [];
    saveCart();
    updateCartUI();
    showToast('Order sent! Opening WhatsApp...', '✅');

    // Save each order to the backend in the background.
    for (const order of orderRefs) {
        apiPost('saveOrder', { order: order }).then(function(res) {
            const finalId = (res && res.success && res.orderId) ? res.orderId : order.orderId;
            const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
            myOrders.unshift(Object.assign({}, order, { orderId: finalId }));
            localStorage.setItem('nakowa_my_orders', JSON.stringify(myOrders.slice(0, 50)));
        }).catch(function(err) {
            console.error('Background save failed:', err);
            const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
            myOrders.unshift(order);
            localStorage.setItem('nakowa_my_orders', JSON.stringify(myOrders.slice(0, 50)));
        });
    }
}

// ============================================================
// LOAD DATA
// ============================================================
async function loadProducts() {
    const grid = document.getElementById('productGrid');
    if (!grid) return;

    const cachedRaw = localStorage.getItem('nakowa_products_cache');
    if (cachedRaw) {
        try {
            const cached = JSON.parse(cachedRaw);
            if (Array.isArray(cached) && cached.length > 0) {
                products = cached.map(sanitizeProductMedia);
                renderProducts();
            }
        } catch (e) {}
    } else {
        grid.innerHTML = Array(6).fill(0).map(() => `
            <div class="skeleton-card">
                <div class="skeleton-image"></div>
                <div class="skeleton-info">
                    <div class="skeleton-text"></div>
                    <div class="skeleton-text short"></div>
                    <div class="skeleton-text price"></div>
                    <div class="skeleton-btn"></div>
                </div>
            </div>
        `).join('');
    }

    try {
        const data = await apiGet('products');
        const apiProducts = (Array.isArray(data) ? data : []).map(sanitizeProductMedia);

        // Merge pending jobs from IndexedDB.
        let pendingJobs = [];
        try {
            if (window.NakowaQueue && typeof window.NakowaQueue.getPendingProducts === 'function') {
                pendingJobs = await window.NakowaQueue.getPendingProducts();
            }
        } catch (e) {}

        const apiIds = new Set(apiProducts.map(p => String(p.id)));
        const pendingFiltered = pendingJobs.filter(p => !apiIds.has(String(p.id)));

        products = [...apiProducts, ...pendingFiltered];

        // Only re-render if the data actually changed.
        const signature = JSON.stringify(products.map(p => ({
            id: p.id,
            code: p.code,
            price: p.variants && p.variants[0] ? p.variants[0].price : p.price,
            pending: !!p._pending,
            uploaded: p._pending ? p._pending.uploadedCount : 0,
            total: p._pending ? p._pending.totalCount : 0
        })));

        if (signature !== lastRenderSignature) {
            lastRenderSignature = signature;
            const scrollY = window.scrollY;
            renderProducts();
            window.scrollTo(0, scrollY);
        }

        try {
            localStorage.setItem('nakowa_products_cache', JSON.stringify(products));
        } catch (e) {}

        setTimeout(checkAbandonedCart, 300);
    } catch (err) {
        console.error('Load products error:', err);
        if (products.length === 0) {
            grid.innerHTML = '<div class="empty-state">❌ Could not load products. Please refresh.</div>';
        }
    }
}

async function loadSettings() {
    try {
        const data = await apiGet('settings');
        settings = data && typeof data === 'object' ? data : {};
        applySettings(settings);
    } catch (err) {
        console.error('Load settings error:', err);
    }
}

function applySettings(s) {
    if (s.hero) {
        const hero = document.getElementById('home');
        if (hero) hero.style.backgroundImage = `url('${s.hero}')`;
    }
    if (s.logo) {
        document.querySelectorAll('.site-logo').forEach(img => img.src = s.logo);
    }
    if (s.whatsapp) {
        const clean = s.whatsapp.replace(/\D/g, '');
        if (clean) {
            const waUrl = 'https://wa.me/' + clean;
            ['contactWhatsappLink', 'floatWhatsapp'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.href = waUrl;
            });
            const txt = document.getElementById('contactWhatsappText');
            if (txt) txt.textContent = s.whatsapp;
            const phone = document.getElementById('contactPhone');
            if (phone) phone.textContent = s.whatsapp;
            const fPhone = document.getElementById('footerPhone');
            if (fPhone) fPhone.textContent = s.whatsapp;
        }
    }
    if (s.email) {
        ['contactEmail', 'footerEmail'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = s.email;
        });
    }
    if (s.address) {
        const el = document.getElementById('contactAddress');
        if (el) el.textContent = s.address;
    }
}

// ============================================================
// FILTERS
// ============================================================
function setupPriceFilters() {
    document.querySelectorAll('#priceFilters .filter-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('#priceFilters .filter-btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            currentPriceFilter = this.dataset.price;
            renderProducts();
        });
    });
}

// ============================================================
// SEARCH
// ============================================================
function setupSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    if (!searchInput || !searchBtn) return;

    const doSearch = () => {
        const q = searchInput.value.trim().toLowerCase();
        if (!q) { renderProducts(); return; }

        const grid = document.getElementById('productGrid');
        if (!grid) return;

        const filtered = products.filter(p =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.code || '').toLowerCase().includes(q) ||
            ((p.variants || []).some(v =>
                (v.colorName || '').toLowerCase().includes(q) ||
                (v.code || '').toLowerCase().includes(q)
            ))
        );

        const display = document.getElementById('productCountDisplay');
        if (display) display.textContent = filtered.length;

        if (filtered.length === 0) {
            grid.innerHTML = '<div class="empty-state">✨ No results found.</div>';
            return;
        }

        grid.innerHTML = filtered.map(p => renderProductCard(p)).join('');
        attachProductListeners();
        applyVideo10sLoop(grid);
        document.getElementById('products').scrollIntoView({ behavior: 'smooth' });
    };

    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keyup', e => { if (e.key === 'Enter') doSearch(); });
}

// ============================================================
// INTERNET NOTICE
// ============================================================
function setupInternetNotice() {
    const notice = document.getElementById('internetNotice');
    if (!notice) return;

    let failCount = 0;
    let failTimer = null;
    let offline = !navigator.onLine;

    function showNotice() {
        notice.style.display = 'flex';
    }
    function hideNotice() {
        notice.style.display = 'none';
    }
    function refresh() {
        if (offline || failCount >= 3) showNotice();
        else hideNotice();
    }

    // 1. Track online / offline
    window.addEventListener('online', function () {
        offline = false;
        failCount = 0;
        refresh();
    });
    window.addEventListener('offline', function () {
        offline = true;
        refresh();
    });

    // 2. Track image load failures (only inside the product grid)
    window.addEventListener('error', function (e) {
        const t = e.target;
        if (!t || t.tagName !== 'IMG') return;
        if (!t.closest('#productGrid')) return;
        failCount++;
        if (failTimer) clearTimeout(failTimer);
        failTimer = setTimeout(function () { failCount = 0; refresh(); }, 5000);
        refresh();
    }, true);

    // 3. Track successful image loads — reset the failure counter
    window.addEventListener('load', function (e) {
        const t = e.target;
        if (!t || t.tagName !== 'IMG') return;
        if (!t.closest('#productGrid')) return;
        failCount = 0;
        offline = false;
        refresh();
    }, true);

    refresh();
}

// ============================================================
// LOGO 5x → Admin
// ============================================================
function setupLogoTrigger() {
    const logo = document.getElementById('logoTrigger');
    if (!logo) return;
    let count = 0, lastClick = 0;
    logo.addEventListener('click', function() {
        const now = Date.now();
        if (now - lastClick > 1500) count = 0;
        lastClick = now;
        count++;
        if (count >= 5) {
            count = 0;
            window.location.href = 'admin/admin.html';
        }
    });
}

// ============================================================
// MOBILE MENU
// ============================================================
function setupMobileMenu() {
    const btn = document.getElementById('hamburgerBtn');
    const menu = document.getElementById('mobileMenu');
    const close = document.getElementById('closeMobile');
    const cartLink = document.getElementById('mobileCartLink');
    const themeLink = document.getElementById('mobileThemeToggle');
    const trackLink = document.getElementById('mobileTrackLink');

    if (btn && menu) btn.addEventListener('click', () => menu.classList.add('open'));
    if (close && menu) close.addEventListener('click', () => menu.classList.remove('open'));
    if (menu) {
        menu.addEventListener('click', e => {
            if (e.target.tagName === 'A' && !e.target.id) menu.classList.remove('open');
        });
    }
    if (cartLink) {
        cartLink.addEventListener('click', e => {
            e.preventDefault();
            menu.classList.remove('open');
            document.getElementById('cartSidebar').classList.add('open');
            document.getElementById('cartOverlay').classList.add('active');
        });
    }
    if (themeLink) {
        themeLink.addEventListener('click', e => {
            e.preventDefault();
            const cur = document.documentElement.getAttribute('data-theme');
            setTheme(cur === 'light' ? 'dark' : 'light');
            menu.classList.remove('open');
        });
    }
    if (trackLink) {
        trackLink.addEventListener('click', e => {
            e.preventDefault();
            menu.classList.remove('open');
            openTrackingModal();
        });
    }
}

// ============================================================
// CART SIDEBAR
// ============================================================
function setupCartSidebar() {
    const icon = document.getElementById('cartIcon');
    const sidebar = document.getElementById('cartSidebar');
    const overlay = document.getElementById('cartOverlay');
    const close = document.getElementById('cartClose');
    const checkout = document.getElementById('checkoutBtn');

    const open = () => {
        sidebar.classList.add('open');
        overlay.classList.add('active');
    };
    const closeFn = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
    };

    if (icon) icon.addEventListener('click', open);
    if (close) close.addEventListener('click', closeFn);
    if (overlay) overlay.addEventListener('click', closeFn);
    if (checkout) checkout.addEventListener('click', checkoutCart);
}

// ============================================================
// LIVE CHAT
// ============================================================
function setupChat() {
    const float = document.getElementById('chatFloat');
    const modal = document.getElementById('chatModal');
    const close = document.getElementById('chatClose');
    const input = document.getElementById('chatInput');
    const send = document.getElementById('chatSend');
    const messages = document.getElementById('chatMessages');
    if (!float || !modal) return;

    float.addEventListener('click', () => modal.classList.toggle('open'));
    if (close) close.addEventListener('click', () => modal.classList.remove('open'));

    const sendMsg = () => {
        const text = input.value.trim();
        if (!text) return;
        const user = document.createElement('div');
        user.className = 'chat-message user';
        user.textContent = text;
        messages.appendChild(user);
        input.value = '';
        messages.scrollTop = messages.scrollHeight;

        setTimeout(() => {
            const bot = document.createElement('div');
            bot.className = 'chat-message bot';
            const replies = [
                'Thank you! We will get back to you shortly.',
                'How can we assist you today?',
                'Please check our Abaya collection above.'
            ];
            bot.textContent = replies[Math.floor(Math.random() * replies.length)];
            messages.appendChild(bot);
            messages.scrollTop = messages.scrollHeight;
        }, 700);
    };

    if (send) send.addEventListener('click', sendMsg);
    if (input) input.addEventListener('keypress', e => { if (e.key === 'Enter') sendMsg(); });
}

// ============================================================
// THEME TOGGLE
// ============================================================
function setupTheme() {
    const btn = document.getElementById('themeToggle');
    if (btn) {
        btn.addEventListener('click', () => {
            const cur = document.documentElement.getAttribute('data-theme');
            setTheme(cur === 'light' ? 'dark' : 'light');
        });
    }
    setTheme(getTheme());
}

// ============================================================
// BACK TO TOP
// ============================================================
function setupBackToTop() {
    const btn = document.getElementById('backToTop');
    if (!btn) return;
    window.addEventListener('scroll', () => {
        btn.classList.toggle('show', window.scrollY > 500);
    });
    btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
}

// ============================================================
// NEWSLETTER
// ============================================================
function setupNewsletter() {
    const form = document.getElementById('newsletterForm');
    if (!form) return;
    form.addEventListener('submit', e => {
        e.preventDefault();
        const email = document.getElementById('newsletterEmail').value.trim();
        const msg = document.getElementById('newsletterMsg');
        if (!email.includes('@')) {
            msg.textContent = '❌ Please enter a valid email.';
            msg.style.display = 'block';
            msg.style.color = '#e74c3c';
            return;
        }
        msg.textContent = '✅ Thank you for subscribing!';
        msg.style.display = 'block';
        msg.style.color = 'var(--gold)';
        form.reset();
        setTimeout(() => { msg.style.display = 'none'; }, 4000);
    });
}

// ============================================================
// MODAL CLOSES
// ============================================================
function setupModalCloses() {
    const pairs = [
        ['closeQuickView', 'quickViewModal'],
        ['closeOrderModal', 'orderModal'],
        ['closeTrackingModal', 'trackingModal']
    ];
    pairs.forEach(([closeId, modalId]) => {
        const c = document.getElementById(closeId);
        const m = document.getElementById(modalId);
        if (c && m) {
            c.addEventListener('click', () => m.classList.remove('open'));
            m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
        }
    });
}

function checkAndShowTrackingOnReturn() {
    try {
        if (localStorage.getItem('nakowa_tracking_seen') === 'true') return;
        const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
        if (myOrders.length === 0) return;
        localStorage.setItem('nakowa_tracking_seen', 'true');
        setTimeout(() => { openTrackingModal(); }, 1500);
    } catch (e) {
        console.warn('Auto-tracking error:', e);
    }
}

// ============================================================
// QUEUE WIRING
// ============================================================
function setupQueueWiring() {
    if (!window.NakowaQueue) return;

    // When the worker reports progress, refresh the grid if it changed.
    if (typeof window.NakowaQueue.onProgress === 'function') {
        window.NakowaQueue.onProgress(function () {
            loadProducts();
        });
    }
    if (typeof window.NakowaQueue.onDrain === 'function') {
        window.NakowaQueue.onDrain(function () {
            loadProducts();
        });
    }
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    // Splash: hide at SPLASH_TIME (3s) + one hard fallback at 4s.
    setTimeout(hideSplash, SPLASH_TIME);
    setTimeout(hideSplash, 4000);

    setupTheme();
    setupBackToTop();
    setupMobileMenu();
    setupCartSidebar();
    setupChat();
    setupPriceFilters();
    setupSearch();
    setupInternetNotice();
    setupLogoTrigger();
    setupNewsletter();
    setupModalCloses();
    setupProductView();
    setupQueueWiring();
    loadCart();

    loadSettings();
    await loadProducts();

    setInterval(loadProducts, 60000);

    checkAndShowTrackingOnReturn();
});