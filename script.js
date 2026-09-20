/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — Public Script (v4 — FINAL)
   Features: Fake price, color circles (admin-only),
             abandoned cart tracking, product separation
   ============================================================ */

// ============================================================
// CONFIGURATION
// ============================================================
const API_URL = 'https://script.google.com/macros/s/AKfycbxGcW2xkagjfp9Dr3Jz_1sflwM-JRbjPV1LUF4UoWzhAGJU2epWVDhXoQH9TgkevU5D/exec';

const CLOUDINARY = {
    cloudName: 'Idtixrva',
    uploadPreset: 'NAKOWA-ABAYAS',
    folder: 'ABAYAS-VIDEO-IMGS',
    baseUrl: 'https://api.cloudinary.com/v1_1/Idtixrva'
};

const SUPABASE = {
    url: 'https://yntkbjzvmizssrxwzuoi.supabase.co',
    key: 'sb_publishable_CFyA2zonltT81jFRMyAQpg_kx5vLA_u',
    bucket: 'Product-images',
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
// Local, network-free image fallback. ROOT-CAUSE FIX: the old fallback
// (https://via.placeholder.com) is dead, so assigning it inside an
// onerror handler re-triggered onerror in an endless loop and flooded
// the console. This data-URI can never fail, and imgFallback() is
// guarded so it runs at most once per <img>.
const DEFAULT_IMG = window.FALLBACK_IMG || 'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22400%22%20height%3D%22400%22%20viewBox%3D%220%200%20400%20400%22%3E%3Crect%20width%3D%22400%22%20height%3D%22400%22%20fill%3D%22%23000000%22%2F%3E%3Ctext%20x%3D%22200%22%20y%3D%22200%22%20fill%3D%22%23d4af37%22%20font-family%3D%22Poppins%2CArial%2Csans-serif%22%20font-size%3D%2256%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22central%22%3ENAKOWA%3C%2Ftext%3E%3C%2Fsvg%3E';

if (typeof window.imgFallback !== 'function') {
    window.imgFallback = function (img) {
        if (!img || img.dataset.fbApplied === '1') return; // hard guard: never loop
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

function optimizeImage(url, width = 500, height = 500) {
    if (!url) return DEFAULT_IMG;
    if (url.includes('res.cloudinary.com')) {
        const parts = url.split('/upload/');
        if (parts.length === 2) {
            const transform = `c_fill,g_center,ar_1:1,w_${width},h_${height},q_auto,f_auto`;
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
// PRICE RENDERER — ACTUAL BOLD + FAKE STRIKETHROUGH
// fakePrice = actualPrice + 5000 (calculated dynamically)
// ============================================================
function renderPrice(actualPrice) {
    const actual = parseFloat(actualPrice) || 0;
    const fake = actual + 5000;
    return `
        <span class="price-actual">₦${actual.toLocaleString()}</span>
        <span class="price-fake">/₦${fake.toLocaleString()}/</span>
    `;
}

function getPriceHTML(actualPrice) {
    return renderPrice(actualPrice);
}

// ============================================================
// SPLASH
// ============================================================
const SPLASH_TIME = 5000;
const splashStart = Date.now();
let splashHidden = false;

function hideSplash() {
    if (splashHidden) return;
    splashHidden = true;
    const s = document.getElementById('splashScreen');
    if (s) {
        s.classList.add('fade-out');
        setTimeout(() => { s.style.display = 'none'; }, 800);
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
            <img src="${item.image || DEFAULT_IMG}" alt="${escapeHtml(item.name)}" onerror="imgFallback(this)" />
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
        // Only show if less than 24 hours old
        if (Date.now() - record.savedAt > 24 * 60 * 60 * 1000) {
            clearAbandonedCart();
            return;
        }
        // Find the product
        const product = products.find(p => String(p.id) === String(record.productId));
        if (!product) return;
        // Find the variant
        const variants = product.variants || [];
        const variant = variants.find(v => v.colorName === record.colorName) || variants[0];
        if (!variant) return;

        // Show a small banner at top of products section
        const grid = document.getElementById('productGrid');
        if (!grid) return;
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
        return p.variants[0].image || '';
    }
    if (Array.isArray(p.images) && p.images.length > 0) return p.images[0];
    if (typeof p.images === 'string' && p.images) return p.images.split(',')[0].trim();
    return '';
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

    grid.innerHTML = filtered.map(p => renderProductCard(p)).join('');
    attachProductListeners();
    applyVideo10sLoop(grid);
}

function renderProductCard(p) {
    const variants = (p.variants && Array.isArray(p.variants)) ? p.variants : [];
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
    const sizes = Array.isArray(p.sizes) ? p.sizes : (typeof p.sizes === 'string' ? p.sizes.split(',').map(s => s.trim()) : []);

    // Color circles — ONLY from admin-added variants, show EXACTLY how many exist
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
                            style="background-color: ${v.colorValue || '#ccc'};"
                            title="${escapeHtml(v.colorName || '')}"
                            aria-label="${escapeHtml(v.colorName || '')}"></button>
                `).join('')}
            </div>
            <div class="selected-color-name" data-product-id="${escapeHtml(p.id)}">${escapeHtml(firstVariant.colorName || '')}</div>
        `;
    }

    return `
        <div class="product-card" data-id="${escapeHtml(p.id)}">
            <div class="product-image">
                ${firstVideo
                    ? `<video src="${firstVideo}" muted autoplay loop playsinline data-autoplay-video></video>`
                    : `<img src="${mainImage}" alt="${escapeHtml(p.name)}" loading="lazy" onerror="imgFallback(this)" />`
                }
                ${flag ? `<span class="country-badge">${flag} ${escapeHtml(country)}</span>` : ''}
                <div class="quick-view-overlay">
                    <button class="btn-quick-view" data-id="${escapeHtml(p.id)}">Quick View</button>
                </div>
            </div>
            <div class="product-info">
                <div class="product-name">${escapeHtml(p.name)}</div>
                <div class="product-code">${escapeHtml(firstVariant.code || p.code || '')}</div>
                ${colorCirclesHTML}
                <div class="product-price" data-product-id="${escapeHtml(p.id)}">${getPriceHTML(firstVariant.price || 0)}</div>
                <div class="product-sizes">
                    ${sizes.map(s => `<span>${escapeHtml(s)}</span>`).join('')}
                </div>
                <button class="btn-order" data-id="${escapeHtml(p.id)}">
                    <i class="fas fa-shopping-cart"></i> Order Now
                </button>
            </div>
        </div>
    `;
}

function attachProductListeners() {
    // Color circle clicks — swap image IN-PLACE
    document.querySelectorAll('.color-circles').forEach(group => {
        group.querySelectorAll('.color-circle').forEach(circle => {
            circle.addEventListener('click', function(e) {
                e.stopPropagation();
                const productId = group.dataset.productId;
                const card = document.querySelector(`.product-card[data-id="${productId}"]`);
                if (!card) return;

                group.querySelectorAll('.color-circle').forEach(c => c.classList.remove('selected'));
                this.classList.add('selected');

                const newImage = this.dataset.image;
                const newColorName = this.dataset.colorName;
                const newPrice = this.dataset.price;
                const newCode = this.dataset.code;

                const imgEl = card.querySelector('.product-image img');
                const videoEl = card.querySelector('.product-image video');
                if (imgEl && newImage) {
                    imgEl.src = optimizeImage(newImage, 500, 500);
                } else if (videoEl && newImage) {
                    videoEl.outerHTML = `<img src="${optimizeImage(newImage, 500, 500)}" alt="" onerror="imgFallback(this)" />`;
                }

                const nameEl = document.querySelector(`.selected-color-name[data-product-id="${productId}"]`);
                if (nameEl) nameEl.textContent = newColorName;

                const priceEl = document.querySelector(`.product-price[data-product-id="${productId}"]`);
                if (priceEl && newPrice) priceEl.innerHTML = getPriceHTML(newPrice);

                const codeEl = card.querySelector('.product-code');
                if (codeEl && newCode) codeEl.textContent = newCode;

                card.dataset.selectedColor = newColorName;
                card.dataset.selectedImage = newImage;
                card.dataset.selectedPrice = newPrice;
                card.dataset.selectedCode = newCode;
            });
        });
    });

    document.querySelectorAll('.btn-quick-view').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const p = products.find(x => String(x.id) === String(this.dataset.id));
            if (p) openQuickView(p);
        });
    });

    document.querySelectorAll('.product-card').forEach(card => {
        card.addEventListener('click', function(e) {
            if (e.target.closest('.btn-order') || e.target.closest('.color-circle') || e.target.closest('.btn-quick-view')) return;
            const p = products.find(x => String(x.id) === String(this.dataset.id));
            if (p) openQuickView(p);
        });
    });

    document.querySelectorAll('.btn-order').forEach(btn => {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const card = this.closest('.product-card');
            const p = products.find(x => String(x.id) === String(this.dataset.id));
            if (!p) return;

            const selectedColor = card.dataset.selectedColor;
            const variants = p.variants || [];
            let variant = variants[0];
            if (selectedColor && variants.length > 1) {
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
}

// ============================================================
// QUICK VIEW
// ============================================================
function openQuickView(product) {
    const modal = document.getElementById('quickViewModal');
    const content = document.getElementById('quickViewContent');
    if (!modal || !content) return;

    const variants = (product.variants && Array.isArray(product.variants)) ? product.variants : [];
    const firstVariant = variants[0] || {
        image: getFirstImage(product),
        colorName: 'Default',
        colorValue: '#d4af37',
        price: product.price || 0,
        code: product.code || ''
    };

    const firstVideo = (product.videos && Array.isArray(product.videos) && product.videos.length > 0) ? product.videos[0] : null;
    const sizes = Array.isArray(product.sizes) ? product.sizes : (typeof product.sizes === 'string' ? product.sizes.split(',').map(s => s.trim()) : []);

    content.innerHTML = `
        <div class="modal-gallery">
            ${firstVideo
                ? `<video src="${firstVideo}" muted autoplay loop playsinline data-autoplay-video></video>`
                : `<img id="qvImage" src="${optimizeImage(firstVariant.image, 800, 800)}" alt="${escapeHtml(product.name)}" onerror="imgFallback(this)" />`
            }
        </div>
        ${variants.length > 0 ? `
            <div class="color-circles" id="qvColorCircles">
                ${variants.map((v, i) => `
                    <button class="color-circle ${i === 0 ? 'selected' : ''}"
                            data-color-index="${i}"
                            data-image="${escapeHtml(v.image || '')}"
                            data-color-name="${escapeHtml(v.colorName || '')}"
                            data-price="${v.price || 0}"
                            data-code="${escapeHtml(v.code || '')}"
                            style="background-color: ${v.colorValue || '#ccc'};"
                            title="${escapeHtml(v.colorName || '')}"></button>
                `).join('')}
            </div>
            <div class="selected-color-name" id="qvSelectedColor">${escapeHtml(firstVariant.colorName || '')}</div>
        ` : ''}
        <h3>${escapeHtml(product.name)}</h3>
        <div class="modal-details">
            <p><strong>Code:</strong> <span id="qvCode">${escapeHtml(firstVariant.code || product.code || '')}</span></p>
            <p><strong>Country:</strong> ${product.country === 'Egypt' ? '🇪🇬' : ''} ${escapeHtml(product.country || 'Egypt')}</p>
            <p><strong>Price:</strong> <span id="qvPrice">${getPriceHTML(firstVariant.price || 0)}</span></p>
            <p><strong>Sizes:</strong> ${sizes.map(escapeHtml).join(' · ') || '—'}</p>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;">
            <select id="qvSize" style="flex:1;min-width:120px;padding:10px;border-radius:8px;border:1px solid var(--border-gold);background:rgba(255,255,255,0.06);color:#fff;">
                <option value="">Select Size</option>
                ${sizes.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
            </select>
            <input type="number" id="qvQty" value="1" min="1" style="width:80px;padding:10px;border-radius:8px;border:1px solid var(--border-gold);background:rgba(255,255,255,0.06);color:#fff;" />
        </div>
        <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap;">
            <button class="btn-outline-gold" style="flex:1;min-width:120px;" id="qvAddToCart">
                <i class="fas fa-shopping-cart"></i> Add to Cart
            </button>
            <button class="btn-gold" style="flex:1;min-width:120px;" id="qvOrderNow">
                <i class="fas fa-bolt"></i> Order Now
            </button>
        </div>
    `;

    modal.classList.add('open');
    applyVideo10sLoop(content);

    let selectedVariant = { ...firstVariant };

    const qvGroup = document.getElementById('qvColorCircles');
    if (qvGroup) {
        qvGroup.querySelectorAll('.color-circle').forEach(circle => {
            circle.addEventListener('click', function() {
                qvGroup.querySelectorAll('.color-circle').forEach(c => c.classList.remove('selected'));
                this.classList.add('selected');

                selectedVariant = {
                    image: this.dataset.image,
                    colorName: this.dataset.colorName,
                    price: this.dataset.price,
                    code: this.dataset.code
                };

                const img = document.getElementById('qvImage');
                const vid = document.querySelector('.modal-gallery video');
                if (img && this.dataset.image) {
                    img.src = optimizeImage(this.dataset.image, 800, 800);
                } else if (vid && this.dataset.image) {
                    vid.outerHTML = `<img id="qvImage" src="${optimizeImage(this.dataset.image, 800, 800)}" alt="" onerror="imgFallback(this)" />`;
                }

                const selColorNameEl = document.getElementById('qvSelectedColor');
                if (selColorNameEl) selColorNameEl.textContent = this.dataset.colorName;
                const qvPriceEl = document.getElementById('qvPrice');
                if (qvPriceEl) qvPriceEl.innerHTML = getPriceHTML(this.dataset.price);
                const qvCodeEl = document.getElementById('qvCode');
                if (qvCodeEl) qvCodeEl.textContent = this.dataset.code;
            });
        });
    }

    document.getElementById('qvAddToCart').addEventListener('click', () => {
        const size = document.getElementById('qvSize').value;
        const qty = parseInt(document.getElementById('qvQty').value) || 1;
        if (!size) { showToast('Please select a size', '⚠️'); return; }
        addToCart(product, selectedVariant, size, qty);
        modal.classList.remove('open');
    });

    document.getElementById('qvOrderNow').addEventListener('click', () => {
        const size = document.getElementById('qvSize').value;
        const qty = parseInt(document.getElementById('qvQty').value) || 1;
        if (!size) { showToast('Please select a size', '⚠️'); return; }
        modal.classList.remove('open');
        setTimeout(() => {
            openOrderModal(product, selectedVariant, size, qty);
        }, 200);
    });
}

// ============================================================
// ORDER MODAL
// ============================================================
function openOrderModal(product, variant, presetSize = '', presetQty = 1) {
    const modal = document.getElementById('orderModal');
    const container = document.getElementById('orderFormContainer');
    if (!modal || !container) return;

    // Save to abandoned cart — if user closes without ordering
    saveAbandonedCart(product, variant);

    const sizes = Array.isArray(product.sizes) ? product.sizes : (typeof product.sizes === 'string' ? product.sizes.split(',').map(s => s.trim()) : []);
    const price = parseFloat(variant.price || product.price) || 0;

    container.innerHTML = `
        <div style="display:flex;gap:12px;align-items:center;padding:12px;background:rgba(212,175,55,0.08);border-radius:10px;margin-bottom:14px;">
            <img src="${optimizeImage(variant.image, 100, 100)}" style="width:70px;height:70px;object-fit:cover;border-radius:8px;border:1px solid var(--border-gold);" onerror="imgFallback(this)" />
            <div style="flex:1;">
                <div style="font-weight:700;color:#fff;">${escapeHtml(product.name)}</div>
                <div style="font-size:0.8rem;color:rgba(255,255,255,0.7);">Code: ${escapeHtml(variant.code || product.code)}</div>
                <div style="font-size:0.8rem;color:${variant.colorValue || '#fff'};">Color: ${escapeHtml(variant.colorName)}</div>
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

    document.getElementById('confirmOrderBtn').addEventListener('click', async function() {
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
        const dateStr = `${now.getDate()}-${now.getMonth() + 1}-${now.getFullYear()}`;

        const order = {
            customerName: name,
            customerPhone: phone,
            customerAddress: address,
            productName: product.name,
            productCode: variant.code || product.code || 'UNKNOWN',
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

        this.disabled = true;
        this.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Placing order...';

        try {
            const res = await apiPost('saveOrder', { order });
            if (!res.success) throw new Error(res.error || 'Order failed');

            const orderId = res.orderId;

            const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
            myOrders.unshift({ ...order, orderId: orderId });
            localStorage.setItem('nakowa_my_orders', JSON.stringify(myOrders.slice(0, 50)));

            // Clear abandoned cart after successful order
            clearAbandonedCart();

            const waNumber = (settings.whatsapp || DEFAULT_WHATSAPP).replace(/\D/g, '');
            const pad = (label, width = 13) => label.padEnd(width, ' ');
            const waLines = [
                '🛍️ *New Order — NAKOWA ABAYAS COLLECTIONS*',
                '',
                pad('Order ID') + '│ ' + orderId,
                pad('Code') + '│ ' + order.productCode,
                pad('Color') + '│ ' + order.colorName,
                pad('Size') + '│ ' + size,
                pad('Price') + '│ ₦' + price.toLocaleString(),
                pad('Quantity') + '│ ' + qty,
                pad('Total') + '│ ₦' + (price * qty).toLocaleString(),
                '',
                pad('Customer Name') + '│ ' + name,
                pad('Phone') + '│ ' + phone,
                pad('Address') + '│ ' + address,
                pad('Date/Time') + '│ ' + dateStr + ' ' + order.time
            ];
            if (notes) waLines.push(pad('Notes') + '│ ' + notes);

            const waMessage = waLines.join('\n');
            const waUrl = `https://wa.me/${waNumber}?text=${encodeURIComponent(waMessage)}`;

            this.innerHTML = '<i class="fas fa-check"></i> Order placed!';
            this.style.background = 'linear-gradient(135deg, #22c55e, #16a34a)';

            showToast('Order placed successfully!', '✅');

            setTimeout(() => {
                modal.classList.remove('open');
                window.open(waUrl, '_blank');
                showTrackingAfterOrder();
            }, 600);

        } catch (err) {
            console.error(err);
            showToast('Failed to place order: ' + err.message, '❌');
            this.disabled = false;
            this.innerHTML = '<i class="fab fa-whatsapp"></i> Confirm Order via WhatsApp';
        }
    });

    // Clear abandoned cart if modal is closed via X
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

    try {
        const allOrders = await apiGet('orders');
        const trackingList = document.getElementById('trackingList');

        trackingList.innerHTML = myOrders.map(myOrder => {
            const liveOrder = Array.isArray(allOrders)
                ? allOrders.find(o => o.orderId === myOrder.orderId)
                : null;

            const currentStatus = (liveOrder && liveOrder.status) || myOrder.status || 'pending';
            const displayId = formatOrderIdDisplay(myOrder.orderId, myOrder.productCode);

            return `
                <div class="tracking-item">
                    <div class="tracking-item-header">
                        <div class="tracking-order-id">
                            ${escapeHtml(displayId.code)}
                            <span class="order-date">${escapeHtml(displayId.date)}${displayId.serial ? ' · ' + escapeHtml(displayId.serial) : ''}</span>
                        </div>
                        <span class="tracking-status ${currentStatus}">${escapeHtml(currentStatus)}</span>
                    </div>
                    <div class="tracking-product">
                        <img src="${optimizeImage(myOrder.productImage, 100, 100)}" alt="" class="tracking-product-img" onerror="imgFallback(this)" />
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
        document.getElementById('trackingList').innerHTML = myOrders.map(myOrder => {
            const displayId = formatOrderIdDisplay(myOrder.orderId, myOrder.productCode);
            return `
                <div class="tracking-item">
                    <div class="tracking-item-header">
                        <div class="tracking-order-id">
                            ${escapeHtml(displayId.code)}
                            <span class="order-date">${escapeHtml(displayId.date)}</span>
                        </div>
                        <span class="tracking-status ${myOrder.status || 'pending'}">${escapeHtml(myOrder.status || 'pending')}</span>
                    </div>
                    <div class="tracking-product">
                        <img src="${optimizeImage(myOrder.productImage, 100, 100)}" alt="" class="tracking-product-img" onerror="imgFallback(this)" />
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

    const total = cart.reduce((s, i) => s + (i.price * i.qty), 0);
    const waNumber = (settings.whatsapp || DEFAULT_WHATSAPP).replace(/\D/g, '');

    let lines = ['🛍️ *Cart Order — NAKOWA ABAYAS COLLECTIONS*', ''];

    for (let i = 0; i < cart.length; i++) {
        const item = cart[i];
        lines.push(`*Item ${i + 1}:*`);
        lines.push('Product: ' + item.name);
        lines.push('Code: ' + item.code);
        lines.push('Color: ' + item.colorName);
        lines.push('Size: ' + item.size);
        lines.push('Qty: ' + item.qty);
        lines.push('Price: ₦' + item.price.toLocaleString());
        lines.push('Subtotal: ₦' + (item.price * item.qty).toLocaleString());
        lines.push('');
    }

    lines.push('*GRAND TOTAL:* ₦' + total.toLocaleString());
    lines.push('');
    lines.push('Please provide your delivery details.');

    const waMessage = lines.join('\n');
    const waUrl = `https://wa.me/${waNumber}?text=${encodeURIComponent(waMessage)}`;
    window.open(waUrl, '_blank');
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
                products = cached;
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
        products = Array.isArray(data) ? data : [];
        renderProducts();
        try {
            localStorage.setItem('nakowa_products_cache', JSON.stringify(products));
        } catch (e) {}
        // After render, check abandoned cart
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

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    window.addEventListener('load', () => {
        const elapsed = Date.now() - splashStart;
        const remaining = SPLASH_TIME - elapsed;
        if (remaining > 0) setTimeout(hideSplash, remaining);
        else hideSplash();
    });
    setTimeout(hideSplash, SPLASH_TIME + 1000);

    setupTheme();
    setupBackToTop();
    setupMobileMenu();
    setupCartSidebar();
    setupChat();
    setupPriceFilters();
    setupSearch();
    setupLogoTrigger();
    setupNewsletter();
    setupModalCloses();
    loadCart();

    loadSettings();
    await loadProducts();

    setInterval(loadProducts, 60000);
});