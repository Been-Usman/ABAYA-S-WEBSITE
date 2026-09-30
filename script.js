/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — Public Storefront Script
   v5 — IndexedDB queue integrated.

   LOAD ORDER
     index.html must load, in this order:
       config.js   queue.js   script.js

   HONEST LIMITS
     • Customers on other devices see new products ONLY after
       the backend save completes. Only the admin's OWN browser
       sees them instantly (from IndexedDB).
     • Browsers cannot upload after the tab is fully closed.
       Jobs persist in IndexedDB and resume on the next visit.
     • IndexedDB unavailable (private mode) → no instant display;
       the storefront shows only backend products.
   ============================================================ */

'use strict';

// ============================================================
// STATE
// ============================================================
let products = [];
let settings = {};
let cart = [];
let currentCountryFilter = 'all';
let currentPriceFilter = 'all';

let _lastProductsHash = '';
let _pendingBannerEl = null;
let _queueUnsubscribers = [];

// Per-card state that survives re-renders:
// productId -> { currentIndex, selectedColor }
const cardState = {};

// ============================================================
// API
// ============================================================
async function apiGet(action) {
    const res = await fetch(API_URL + '?action=' + encodeURIComponent(action));
    return res.json();
}

async function apiPost(action, data) {
    data = data || {};
    const res = await fetch(API_URL, {
        method: 'POST',
        body: JSON.stringify(Object.assign({ action: action }, data))
    });
    return res.json();
}

// ============================================================
// HELPERS
// ============================================================
const DEFAULT_IMG_LOCAL = (typeof DEFAULT_IMG !== 'undefined') ? DEFAULT_IMG : (window.FALLBACK_IMG || '');

if (typeof window.imgFallback !== 'function') {
    window.imgFallback = function (img) {
        if (!img || img.dataset.fbApplied === '1') return;
        img.dataset.fbApplied = '1';
        img.onerror = null;
        img.src = DEFAULT_IMG_LOCAL;
    };
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, function (s) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s];
    });
}

// Keep aspect ratio; do NOT crop tall abaya photos.
// blob: and data: URLs are returned unchanged.
function optimizeImage(url, width) {
    if (!url) return DEFAULT_IMG_LOCAL;
    if (url.indexOf('blob:') === 0) return url;
    if (url.indexOf('data:') === 0) return url;
    if (url.indexOf('res.cloudinary.com') !== -1) {
        const parts = url.split('/upload/');
        if (parts.length === 2) {
            const w = width || 500;
            const transform = 'c_limit,w_' + w + ',q_auto,f_auto';
            return parts[0] + '/upload/' + transform + '/' + parts[1];
        }
    }
    return url;
}

function applyVideo10sLoop(container) {
    if (!container) return;
    container.querySelectorAll('video').forEach(function (v) {
        if (v._loop10sAttached) return;
        v._loop10sAttached = true;
        v.muted = true;
        v.setAttribute('muted', '');
        v.setAttribute('playsinline', '');
        v.autoplay = true;
        v.loop = false;
        v.addEventListener('timeupdate', function () {
            if (this.currentTime >= 10) { this.currentTime = 0; this.play().catch(function () {}); }
        });
        v.addEventListener('loadeddata', function () { v.play().catch(function () {}); });
        v.play().catch(function () {});
    });
}

// Price display — keep current behavior (public shows actual only).
function renderPrice(actualPrice) {
    const actual = parseFloat(actualPrice) || 0;
    return '<span class="price-actual">₦' + actual.toLocaleString() + '</span>';
}
function getPriceHTML(actualPrice) { return renderPrice(actualPrice); }

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
        setTimeout(function () {
            s.style.display = 'none';
            s.style.visibility = 'hidden';
            s.style.opacity = '0';
        }, 800);
    }
}

// ============================================================
// TOAST
// ============================================================
function showToast(message, icon) {
    icon = icon || '✅';
    const toast = document.getElementById('toast');
    if (!toast) return;
    const msgEl = document.getElementById('toastMessage');
    if (msgEl) msgEl.textContent = message;
    const iconEl = toast.querySelector('.toast-icon');
    if (iconEl) iconEl.textContent = icon;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { toast.classList.remove('show'); }, 3000);
}

// ============================================================
// THEME
// ============================================================
function getTheme() { return localStorage.getItem('nakowa_theme') || 'dark'; }

function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nakowa_theme', theme);
    const icon = document.querySelector('#themeToggle i');
    const mobileIcon = document.querySelector('#mobileThemeToggle i');
    const cls = theme === 'light' ? 'fas fa-sun' : 'fas fa-moon';
    if (icon) icon.className = cls;
    if (mobileIcon) mobileIcon.className = cls;
}

// ============================================================
// CART
// ============================================================
function updateCartUI() {
    const count = cart.reduce(function (s, i) { return s + (i.qty || 0); }, 0);
    const total = cart.reduce(function (s, i) { return s + ((i.price || 0) * (i.qty || 0)); }, 0);

    const cartCount = document.getElementById('cartCount');
    const mobileCount = document.getElementById('mobileCartCount');
    const cartTotal = document.getElementById('cartTotalAmount');

    if (cartCount) { cartCount.textContent = count; cartCount.classList.toggle('hidden', count === 0); }
    if (mobileCount) mobileCount.textContent = count;
    if (cartTotal) cartTotal.textContent = '₦' + total.toLocaleString();

    const container = document.getElementById('cartItems');
    if (!container) return;

    if (cart.length === 0) {
        container.innerHTML = '<div class="cart-empty"><i class="fas fa-shopping-bag"></i>Your cart is empty.</div>';
        return;
    }

    container.innerHTML = cart.map(function (item, idx) {
        return '<div class="cart-item">' +
            '<img src="' + escapeHtml(item.image || DEFAULT_IMG_LOCAL) + '" alt="' + escapeHtml(item.name) + '" onerror="imgFallback(this)" />' +
            '<div class="cart-item-info">' +
                '<h4>' + escapeHtml(item.name) + '</h4>' +
                '<p>₦' + (item.price || 0).toLocaleString() + ' × ' + item.qty + '</p>' +
                '<div class="cart-item-meta">Size: ' + escapeHtml(item.size) + ' · Color: ' + escapeHtml(item.colorName) + '</div>' +
            '</div>' +
            '<button class="remove-item" data-idx="' + idx + '"><i class="fas fa-times"></i></button>' +
        '</div>';
    }).join('');

    container.querySelectorAll('.remove-item').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const idx = parseInt(this.dataset.idx, 10);
            const removed = cart[idx];
            cart.splice(idx, 1);
            saveCart();
            updateCartUI();
            if (removed) showToast('Removed ' + removed.name, '🗑️');
        });
    });
}

function saveCart() {
    try { localStorage.setItem('nakowa_cart', JSON.stringify(cart)); } catch (e) {}
}
function loadCart() {
    try {
        const saved = localStorage.getItem('nakowa_cart');
        if (saved) cart = JSON.parse(saved);
    } catch (e) { cart = []; }
    updateCartUI();
}

// ============================================================
// ABANDONED CART TRACKER
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
        if (Date.now() - record.savedAt > 24 * 60 * 60 * 1000) { clearAbandonedCart(); return; }
        const product = products.find(function (p) { return String(p.id) === String(record.productId); });
        if (!product) return;
        const variants = product.variants || [];
        const variant = variants.find(function (v) { return v.colorName === record.colorName; }) || variants[0];
        if (!variant) return;

        const grid = document.getElementById('productGrid');
        if (!grid) return;
        const existing = document.getElementById('abandonedBanner');
        if (existing) existing.remove();

        const banner = document.createElement('div');
        banner.id = 'abandonedBanner';
        banner.className = 'abandoned-banner';
        banner.innerHTML =
            '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between;width:100%;">' +
                '<div style="display:flex;align-items:center;gap:10px;">' +
                    '<i class="fas fa-shopping-bag" style="color:var(--gold);font-size:1.3rem;"></i>' +
                    '<span>You left <strong style="color:var(--gold);">' + escapeHtml(record.productName) + '</strong> in your cart. Complete your order?</span>' +
                '</div>' +
                '<div style="display:flex;gap:8px;">' +
                    '<button class="btn-gold" id="abandonedResumeBtn" style="padding:8px 16px;font-size:0.8rem;">Yes, continue</button>' +
                    '<button class="btn-outline-gold" id="abandonedDismissBtn" style="padding:8px 16px;font-size:0.8rem;">Dismiss</button>' +
                '</div>' +
            '</div>';
        grid.parentElement.insertBefore(banner, grid);

        document.getElementById('abandonedResumeBtn').addEventListener('click', function () {
            banner.remove();
            openOrderModal(product, variant);
        });
        document.getElementById('abandonedDismissBtn').addEventListener('click', function () {
            banner.remove();
            clearAbandonedCart();
        });
    } catch (e) { console.warn('Abandoned cart error:', e); }
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
    if (p.variants && Array.isArray(p.variants) && p.variants.length > 0) return p.variants[0].image || '';
    if (Array.isArray(p.images) && p.images.length > 0) return p.images[0];
    if (typeof p.images === 'string' && p.images) return p.images.split(',')[0].trim();
    return '';
}

function normalizeColor(name) { return (name || '').trim().toLowerCase(); }

// Dedupe by colorName + code + price.
// Different abayas with the same color are NOT collapsed.
function dedupeVariants(variants) {
    if (!Array.isArray(variants)) return [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        const key = normalizeColor(v.colorName) + '|' + String(v.code || '').trim() + '|' + String(v.price || '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(v);
    }
    return out;
}

// ============================================================
// FILTERS
// ============================================================
function rebuildCountryFilters() {
    const container = document.getElementById('countryFilters');
    if (!container) return;
    const countries = [];
    products.forEach(function (p) { if (p.country && countries.indexOf(p.country) === -1) countries.push(p.country); });
    if (countries.indexOf('Egypt') === -1) countries.unshift('Egypt');

    const active = currentCountryFilter;

    container.innerHTML =
        '<button class="filter-btn ' + (active === 'all' ? 'active' : '') + '" data-country="all">All</button>' +
        countries.map(function (c) {
            return '<button class="filter-btn ' + (active === c ? 'active' : '') + '" data-country="' + escapeHtml(c) + '">' +
                (c === 'Egypt' ? '🇪🇬 ' : '') + escapeHtml(c) + '</button>';
        }).join('');

    container.querySelectorAll('.filter-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            container.querySelectorAll('.filter-btn').forEach(function (b) { b.classList.remove('active'); });
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

    let filtered = products.filter(function (p) { return p.status !== 'inactive'; });

    if (currentCountryFilter !== 'all') {
        filtered = filtered.filter(function (p) { return p.country === currentCountryFilter; });
    }
    if (currentPriceFilter !== 'all') {
        const limit = currentPriceFilter === '35k' ? 35000 : 40000;
        filtered = filtered.filter(function (p) {
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

    grid.innerHTML = filtered.map(function (p) { return renderProductCard(p); }).join('');
    attachProductListeners();
    applyVideo10sLoop(grid);
}

function renderProductCard(p) {
    const variants = dedupeVariants((p.variants && Array.isArray(p.variants)) ? p.variants : []);
    const firstVariant = variants[0] || {
        image: getFirstImage(p),
        colorName: 'Default',
        colorValue: '#d4af37',
        price: p.price || 0,
        code: p.code || ''
    };
    const mainImage = optimizeImage(firstVariant.image, 500);
    const firstVideo = (p.videos && Array.isArray(p.videos) && p.videos.length > 0) ? p.videos[0] : null;
    const country = p.country || 'Egypt';
    const flag = country === 'Egypt' ? '🇪🇬' : '';
    const isPending = !!p._pending;

    let colorCirclesHTML = '';
    if (variants.length > 0) {
        colorCirclesHTML =
            '<div class="color-circles" data-product-id="' + escapeHtml(p.id) + '">' +
                variants.map(function (v, i) {
                    return '<button class="color-circle ' + (i === 0 ? 'selected' : '') + '" ' +
                        'data-color-index="' + i + '" ' +
                        'data-image="' + escapeHtml(v.image || '') + '" ' +
                        'data-color-name="' + escapeHtml(v.colorName || '') + '" ' +
                        'data-color-value="' + escapeHtml(v.colorValue || '') + '" ' +
                        'data-price="' + (v.price || p.price || 0) + '" ' +
                        'data-code="' + escapeHtml(v.code || p.code || '') + '" ' +
                        'style="background-color: ' + escapeHtml(v.colorValue || '#ccc') + ';" ' +
                        'title="' + escapeHtml(v.colorName || '') + '" ' +
                        'aria-label="' + escapeHtml(v.colorName || '') + '"></button>';
                }).join('') +
            '</div>';
    }

    let pendingBadge = '';
    if (isPending) {
        const uploaded = p._uploadedCount || 0;
        const total = p._totalCount || variants.length;
        pendingBadge = '<div class="nakowa-pending-badge" style="margin-top:6px;padding:3px 10px;border-radius:20px;' +
            'display:inline-block;font-size:0.7rem;background:rgba(249,229,8,0.15);color:#f9e508;' +
            'border:1px solid currentColor;">Uploading ' + uploaded + '/' + total + '</div>';
    }

    return '<div class="product-card" data-id="' + escapeHtml(p.id) + '"' + (isPending ? ' data-pending="1"' : '') + '>' +
        '<div class="product-image">' +
            (firstVideo
                ? '<video src="' + escapeHtml(firstVideo) + '" muted autoplay loop playsinline data-autoplay-video></video>'
                : '<img src="' + escapeHtml(mainImage) + '" alt="' + escapeHtml(p.name) + '" loading="lazy" onerror="imgFallback(this)" />') +
            (flag ? '<span class="country-badge">' + flag + ' ' + escapeHtml(country) + '</span>' : '') +
        '</div>' +
        '<div class="product-info">' +
            '<div class="product-name">' + escapeHtml(p.name) + '</div>' +
            '<div class="product-code">' + escapeHtml(firstVariant.code || p.code || '') + '</div>' +
            colorCirclesHTML +
            '<div class="product-price" data-product-id="' + escapeHtml(p.id) + '">' + getPriceHTML(firstVariant.price || 0) + '</div>' +
            pendingBadge +
            '<button class="btn-order" data-id="' + escapeHtml(p.id) + '">' +
                '<i class="fas fa-shopping-cart"></i> Order Now' +
            '</button>' +
        '</div>' +
    '</div>';
}

// ============================================================
// PRODUCT LISTENERS — color circles + swipe
//
// Gesture rules (one step per gesture):
//   • After one step is applied, further step triggers are ignored
//     until pointerup / pointercancel.
//   • Wheel locks for 400 ms after a step.
//   • Always moves exactly +1 or -1 from the current index.
//   • Clamp at first and last — no wrap.
//   • currentIndex is preserved across re-renders (cardState).
//   • touch-action: pan-y.
//   • Click right after a swipe is suppressed.
// ============================================================
const SWIPE_THRESHOLD = 40;

function attachProductListeners() {
    document.querySelectorAll('.product-card').forEach(function (card) {
        const productId = card.dataset.id;
        const product = products.find(function (x) { return String(x.id) === String(productId); });
        if (!product) return;

        const variants = dedupeVariants(product.variants || []);
        if (variants.length === 0) return;

        if (!cardState[productId]) cardState[productId] = { currentIndex: 0, selectedColor: '' };
        const state = cardState[productId];
        let currentIndex = state.currentIndex || 0;
        if (currentIndex >= variants.length) currentIndex = variants.length - 1;
        if (currentIndex < 0) currentIndex = 0;

        const circles = card.querySelectorAll('.color-circle');

        function updateToIndex(idx) {
            if (idx < 0) idx = 0;
            if (idx >= variants.length) idx = variants.length - 1;
            currentIndex = idx;
            state.currentIndex = idx;

            const v = variants[idx];

            const imgEl = card.querySelector('.product-image img');
            const videoEl = card.querySelector('.product-image video');
            if (imgEl) {
                if (v.image) imgEl.src = optimizeImage(v.image, 500);
            } else if (videoEl && v.image) {
                videoEl.outerHTML = '<img src="' + escapeHtml(optimizeImage(v.image, 500)) + '" alt="" onerror="imgFallback(this)" />';
            }

            circles.forEach(function (c, i) { c.classList.toggle('selected', i === idx); });

            const priceEl = card.querySelector('.product-price');
            if (priceEl) priceEl.innerHTML = getPriceHTML(v.price || product.price || 0);

            const codeEl = card.querySelector('.product-code');
            if (codeEl) codeEl.textContent = v.code || product.code || '';

            state.selectedColor = v.colorName || '';
            card.dataset.selectedColor = v.colorName || '';
            card.dataset.selectedImage = v.image || '';
            card.dataset.selectedPrice = v.price || product.price || 0;
            card.dataset.selectedCode = v.code || product.code || '';
        }

        // Color circle clicks
        circles.forEach(function (circle, i) {
            circle.addEventListener('click', function (e) {
                e.stopPropagation();
                e.preventDefault();
                updateToIndex(i);
            });
        });

        const imageWrap = card.querySelector('.product-image');
        if (!imageWrap) return;

        let startX = 0, startY = 0;
        let isDragging = false;
        let gestureStepApplied = false;
        let pendingClickSuppress = false;
        let wheelLocked = false;
        let wheelLockTimer = null;

        imageWrap.style.touchAction = 'pan-y';
        imageWrap.style.userSelect = 'none';

        function applyStep(delta) {
            const next = currentIndex + delta;
            if (next < 0 || next >= variants.length) return;
            updateToIndex(next);
        }

        imageWrap.addEventListener('pointerdown', function (e) {
            if (e.target.closest('button')) return;
            startX = e.clientX;
            startY = e.clientY;
            isDragging = true;
            gestureStepApplied = false;
        });

        imageWrap.addEventListener('pointermove', function (e) {
            if (!isDragging) return;
            if (gestureStepApplied) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
                isDragging = false;
                return;
            }
            if (Math.abs(dx) > SWIPE_THRESHOLD) {
                applyStep(dx < 0 ? 1 : -1);
                gestureStepApplied = true;
                pendingClickSuppress = true;
            }
        });

        function endDrag() {
            isDragging = false;
            gestureStepApplied = false;
            if (pendingClickSuppress) {
                // Reset AFTER the capture-phase click handler fires.
                setTimeout(function () { pendingClickSuppress = false; }, 300);
            }
        }

        imageWrap.addEventListener('pointerup', endDrag);
        imageWrap.addEventListener('pointercancel', endDrag);
        imageWrap.addEventListener('pointerleave', endDrag);

        imageWrap.addEventListener('click', function (e) {
            if (pendingClickSuppress) {
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);

        imageWrap.addEventListener('wheel', function (e) {
            if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 20) {
                e.preventDefault();
                if (wheelLocked) return;
                applyStep(e.deltaX > 0 ? 1 : -1);
                wheelLocked = true;
                clearTimeout(wheelLockTimer);
                wheelLockTimer = setTimeout(function () { wheelLocked = false; }, 400);
            }
        }, { passive: false });

        // Apply stored index (or 0 on first render)
        updateToIndex(currentIndex);
    });

    // Order Now
    document.querySelectorAll('.btn-order').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const card = this.closest('.product-card');
            const p = products.find(function (x) { return String(x.id) === String(this.dataset.id); }.bind(this));
            if (!p) return;

            const variants = dedupeVariants(p.variants || []);
            const selectedColor = card.dataset.selectedColor;
            let variant = variants[0];
            if (selectedColor && variants.length > 0) {
                const found = variants.find(function (v) { return v.colorName === selectedColor; });
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
// ORDER MODAL (single product)
//
// ID STRATEGY: the WhatsApp window is opened SYNCHRONOUSLY on
// click (before any await), then its location is set once the
// backend returns the real orderId. This guarantees the
// WhatsApp message shows the SAME id the backend stored.
// ============================================================
function openOrderModal(product, variant, presetSize, presetQty) {
    presetSize = presetSize || '';
    presetQty = presetQty || 1;

    const modal = document.getElementById('orderModal');
    const container = document.getElementById('orderFormContainer');
    if (!modal || !container) return;

    saveAbandonedCart(product, variant);

    const sizes = Array.isArray(product.sizes) ? product.sizes
        : (typeof product.sizes === 'string' ? product.sizes.split(',').map(function (s) { return s.trim(); }) : []);
    const price = parseFloat(variant.price || product.price) || 0;

    container.innerHTML =
        '<div style="display:flex;gap:12px;align-items:center;padding:12px;background:rgba(212,175,55,0.08);border-radius:10px;margin-bottom:14px;">' +
            '<img src="' + escapeHtml(optimizeImage(variant.image, 100)) + '" style="width:70px;height:70px;object-fit:cover;border-radius:8px;border:1px solid var(--border-gold);" onerror="imgFallback(this)" />' +
            '<div style="flex:1;">' +
                '<div style="font-weight:700;color:#fff;">' + escapeHtml(product.name) + '</div>' +
                '<div style="font-size:0.8rem;color:rgba(255,255,255,0.7);">Code: ' + escapeHtml(variant.code || product.code) + '</div>' +
                '<div style="font-size:0.8rem;">Color: ' + escapeHtml(variant.colorName) + '</div>' +
            '</div>' +
        '</div>' +
        '<form class="order-form" id="orderForm">' +
            '<div class="form-group"><label>Full Name *</label><input type="text" id="orderName" required placeholder="Your full name" /></div>' +
            '<div class="form-group"><label>Phone Number *</label><input type="tel" id="orderPhone" required placeholder="+234..." /></div>' +
            '<div class="form-group"><label>Delivery Address *</label><input type="text" id="orderAddress" required placeholder="State, City, Street" /></div>' +
            '<div class="form-group"><label>Size *</label>' +
                '<select id="orderSize" required>' +
                    '<option value="">Select Size</option>' +
                    sizes.map(function (s) {
                        return '<option value="' + escapeHtml(s) + '" ' + (s === presetSize ? 'selected' : '') + '>' + escapeHtml(s) + '</option>';
                    }).join('') +
                '</select>' +
            '</div>' +
            '<div class="form-group"><label>Quantity *</label><input type="number" id="orderQty" value="' + presetQty + '" min="1" required /></div>' +
            '<div class="form-group"><label>Notes (optional)</label><textarea id="orderNotes" placeholder="Any special requests..."></textarea></div>' +
        '</form>' +
        '<div class="order-summary">' +
            '<p><strong>Price:</strong> <span id="sumPrice">₦' + price.toLocaleString() + '</span></p>' +
            '<p><strong>Qty:</strong> <span id="sumQty">' + presetQty + '</span></p>' +
            '<p class="total">Total: ₦<span id="sumTotal">' + (price * presetQty).toLocaleString() + '</span></p>' +
        '</div>' +
        '<button class="btn-gold" style="width:100%;" id="confirmOrderBtn">' +
            '<i class="fab fa-whatsapp"></i> Confirm Order via WhatsApp' +
        '</button>';

    modal.classList.add('open');

    const qtyEl = document.getElementById('orderQty');
    qtyEl.addEventListener('input', function () {
        const q = parseInt(qtyEl.value, 10) || 1;
        document.getElementById('sumQty').textContent = q;
        document.getElementById('sumTotal').textContent = (price * q).toLocaleString();
    });

    document.getElementById('confirmOrderBtn').addEventListener('click', function () {
        const name = document.getElementById('orderName').value.trim();
        const phone = document.getElementById('orderPhone').value.trim();
        const address = document.getElementById('orderAddress').value.trim();
        const size = document.getElementById('orderSize').value;
        const qty = parseInt(document.getElementById('orderQty').value, 10) || 1;
        const notes = document.getElementById('orderNotes').value.trim();

        if (!name || !phone || !address || !size) {
            alert('Please fill in all required fields.');
            return;
        }

        // Open WhatsApp window SYNCHRONOUSLY (user gesture).
        const waWin = window.open('', '_blank');

        const now = new Date();
        const dateStr = now.getDate() + '-' + (now.getMonth() + 1) + '-' + now.getFullYear();
        const tempOrderId = 'TEMP-' + Date.now().toString(36).toUpperCase();

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

        modal.classList.remove('open');
        showToast('Order sent! Opening WhatsApp...', '✅');

        function buildWaMessage(orderId) {
            const waNumber = (settings.whatsapp || DEFAULT_WHATSAPP).replace(/\D/g, '');
            const L = '────────────────────────────';
            function pad(label, value, width) {
                width = width || 15;
                return label + ' '.repeat(Math.max(1, width - label.length)) + value;
            }
            const lines = [
                "NEW ORDER — NAKOWA ABAYA'S COLLECTIONS",
                '',
                L,
                '',
                pad('Product', order.productName),
                pad('Code', order.productCode),
                pad('Color', order.colorName),
                pad('Size', order.size),
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
            if (notes) { lines.push(''); lines.push(pad('Notes', notes)); }
            return 'https://wa.me/' + waNumber + '?text=' + encodeURIComponent(lines.join('\n'));
        }

        apiPost('saveOrder', { order: order }).then(function (res) {
            const orderId = (res && res.success && res.orderId) ? res.orderId : tempOrderId;
            const waUrl = buildWaMessage(orderId);

            if (waWin && !waWin.closed) {
                waWin.location.href = waUrl;
            } else {
                // Popup blocked — show a clickable link.
                showToast('Tap to open WhatsApp', '💬');
                const t = document.getElementById('toast');
                if (t) {
                    const msgEl = document.getElementById('toastMessage');
                    if (msgEl) msgEl.innerHTML = '<a href="' + escapeHtml(waUrl) + '" target="_blank" style="color:#fff;text-decoration:underline;">Open WhatsApp</a>';
                }
            }

            const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
            myOrders.unshift(Object.assign({}, order, { orderId: orderId }));
            localStorage.setItem('nakowa_my_orders', JSON.stringify(myOrders.slice(0, 50)));
            clearAbandonedCart();
        }).catch(function (err) {
            console.error('Background save failed:', err);
            const waUrl = buildWaMessage(tempOrderId);
            if (waWin && !waWin.closed) waWin.location.href = waUrl;

            const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
            myOrders.unshift(Object.assign({}, order, { orderId: tempOrderId }));
            localStorage.setItem('nakowa_my_orders', JSON.stringify(myOrders.slice(0, 50)));
            clearAbandonedCart();
        });
    });

    modal.addEventListener('click', function (e) {
        if (e.target === modal) clearAbandonedCart();
    }, { once: true });
}

// ============================================================
// TRACKING
// ============================================================
function formatOrderIdDisplay(orderId, adminCode) {
    if (!orderId) return { code: '', date: '', serial: null };
    if (adminCode && orderId.indexOf(adminCode + '-') === 0) {
        const rest = orderId.substring(adminCode.length + 1);
        const parts = rest.split('-');
        if (parts.length >= 3) {
            return { code: adminCode, date: parts.slice(0, 3).join('-'), serial: parts.slice(3).join('-') || null };
        }
    }
    const parts = orderId.split('-');
    if (parts.length >= 4) {
        return { code: parts.slice(0, -3).join('-'), date: parts.slice(-3).join('-'), serial: null };
    }
    return { code: orderId, date: '', serial: null };
}

async function openTrackingModal() {
    const modal = document.getElementById('trackingModal');
    const content = document.getElementById('trackingContent');
    if (!modal || !content) return;

    const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');

    content.innerHTML =
        '<div class="tracking-header">' +
            '<img src="images/logo.png" alt="NAKOWA" class="tracking-logo" onerror="this.style.display=\'none\'" />' +
            '<h2>Order Tracking</h2>' +
        '</div>' +
        '<div class="tracking-list" id="trackingList">' +
            '<div class="tracking-empty"><i class="fas fa-box-open"></i>Loading your orders...</div>' +
        '</div>' +
        '<div class="tracking-actions">' +
            '<button class="btn-track-close" id="trackingCloseBtn">Close</button>' +
        '</div>';

    modal.classList.add('open');
    document.getElementById('trackingCloseBtn').addEventListener('click', function () {
        modal.classList.remove('open');
    });

    if (myOrders.length === 0) {
        document.getElementById('trackingList').innerHTML =
            '<div class="tracking-empty"><i class="fas fa-box-open"></i>You have no orders yet.</div>';
        return;
    }

    // Fetch status for each order using trackOrder (orderId + phone).
    // This replaces the old apiGet('orders') call so a visitor can
    // never download another customer's order.
    const statusMap = {};
    await Promise.all(myOrders.map(function (o) {
        if (!o.orderId || !o.customerPhone) return Promise.resolve();
        return apiGet('trackOrder&orderId=' + encodeURIComponent(o.orderId) + '&phone=' + encodeURIComponent(o.customerPhone))
            .then(function (res) {
                if (res && res.success && res.order) statusMap[o.orderId] = res.order.status;
            })
            .catch(function () {});
    }));

    const listEl = document.getElementById('trackingList');
    listEl.innerHTML = myOrders.map(function (myOrder) {
        const currentStatus = statusMap[myOrder.orderId] || myOrder.status || 'pending';
        const displayId = formatOrderIdDisplay(myOrder.orderId, myOrder.productCode);
        return '<div class="tracking-item">' +
            '<div class="tracking-item-header">' +
                '<div class="tracking-order-id">' +
                    escapeHtml(displayId.code) +
                    '<span class="order-date">' + escapeHtml(displayId.date) + (displayId.serial ? ' · ' + escapeHtml(displayId.serial) : '') + '</span>' +
                '</div>' +
                '<span class="tracking-status ' + escapeHtml(currentStatus) + '">' + escapeHtml(currentStatus) + '</span>' +
            '</div>' +
            '<div class="tracking-product">' +
                '<img src="' + escapeHtml(optimizeImage(myOrder.productImage, 100)) + '" alt="" class="tracking-product-img" onerror="imgFallback(this)" />' +
                '<div class="tracking-product-info">' +
                    '<div class="tp-name">' + escapeHtml(myOrder.productName) + '</div>' +
                    '<div class="tp-meta">' +
                        'Code: <strong>' + escapeHtml(myOrder.productCode) + '</strong><br>' +
                        'Color: <strong>' + escapeHtml(myOrder.colorName) + '</strong> · Size: ' + escapeHtml(myOrder.size) + '<br>' +
                        'Qty: ' + (myOrder.quantity || 1) +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="tracking-total"><span>Total</span><span>₦' + (myOrder.total || 0).toLocaleString() + '</span></div>' +
        '</div>';
    }).join('');
}

// ============================================================
// CART CHECKOUT
//
// Opens a small form, collects name/phone/address, then:
//   • opens the WhatsApp window SYNCHRONOUSLY on click
//   • saves ONE consolidated order to the backend
//   • sets the WhatsApp location with the real orderId
//   • clears the cart on success
// ============================================================
function openCheckoutModal() {
    if (cart.length === 0) { showToast('Your cart is empty!', '⚠️'); return; }

    let modal = document.getElementById('checkoutModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'checkoutModal';
        modal.className = 'modal-overlay order-modal';
        modal.innerHTML =
            '<div class="modal-box glass">' +
                '<button class="close-modal" id="closeCheckoutModal" aria-label="Close">&times;</button>' +
                '<div class="order-modal-header">' +
                    '<img src="images/logo.png" alt="NAKOWA" class="logo-img modal-logo site-logo" onerror="imgFallback(this)" />' +
                    '<h3>Complete Your Order</h3>' +
                '</div>' +
                '<div id="checkoutFormContainer"></div>' +
            '</div>';
        document.body.appendChild(modal);

        modal.addEventListener('click', function (e) {
            if (e.target === modal) modal.classList.remove('open');
        });
        document.getElementById('closeCheckoutModal').addEventListener('click', function () {
            modal.classList.remove('open');
        });
    }

    const container = document.getElementById('checkoutFormContainer');
    const grandTotal = cart.reduce(function (s, i) { return s + ((i.price || 0) * (i.qty || 0)); }, 0);

    container.innerHTML =
        '<div style="max-height:200px;overflow:auto;margin-bottom:14px;padding-right:6px;">' +
            cart.map(function (item, idx) {
                return '<div style="display:flex;gap:10px;align-items:center;padding:8px;background:rgba(212,175,55,0.06);border-radius:8px;margin-bottom:6px;">' +
                    '<img src="' + escapeHtml(optimizeImage(item.image, 80)) + '" style="width:50px;height:50px;object-fit:cover;border-radius:6px;" onerror="imgFallback(this)" />' +
                    '<div style="flex:1;font-size:0.85rem;">' +
                        '<div style="font-weight:600;">' + escapeHtml(item.name) + '</div>' +
                        '<div style="opacity:0.75;">Code: ' + escapeHtml(item.code) + ' · ' + escapeHtml(item.colorName) + ' · Size ' + escapeHtml(item.size) + '</div>' +
                        '<div style="opacity:0.75;">₦' + (item.price || 0).toLocaleString() + ' × ' + item.qty + '</div>' +
                    '</div>' +
                    '<button type="button" class="remove-checkout-item" data-idx="' + idx + '" style="background:transparent;border:none;color:#e74c3c;cursor:pointer;font-size:1.1rem;">&times;</button>' +
                '</div>';
            }).join('') +
        '</div>' +
        '<form class="order-form" id="checkoutForm">' +
            '<div class="form-group"><label>Full Name *</label><input type="text" id="checkoutName" required /></div>' +
            '<div class="form-group"><label>Phone Number *</label><input type="tel" id="checkoutPhone" required /></div>' +
            '<div class="form-group"><label>Delivery Address *</label><input type="text" id="checkoutAddress" required /></div>' +
            '<div class="form-group"><label>Notes (optional)</label><textarea id="checkoutNotes" placeholder="Any special requests..."></textarea></div>' +
        '</form>' +
        '<div class="order-summary"><p class="total">Grand Total: ₦<span id="checkoutTotal">' + grandTotal.toLocaleString() + '</span></p></div>' +
        '<button class="btn-gold" style="width:100%;" id="confirmCheckoutBtn"><i class="fab fa-whatsapp"></i> Confirm Order via WhatsApp</button>';

    modal.classList.add('open');

    container.querySelectorAll('.remove-checkout-item').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const i = parseInt(this.dataset.idx, 10);
            cart.splice(i, 1);
            saveCart();
            updateCartUI();
            if (cart.length === 0) { modal.classList.remove('open'); }
            else openCheckoutModal();
        });
    });

    document.getElementById('confirmCheckoutBtn').addEventListener('click', function () {
        const name = document.getElementById('checkoutName').value.trim();
        const phone = document.getElementById('checkoutPhone').value.trim();
        const address = document.getElementById('checkoutAddress').value.trim();
        const notes = document.getElementById('checkoutNotes').value.trim();

        if (!name || !phone || !address) { alert('Please fill in name, phone and address.'); return; }
        if (cart.length === 0) { showToast('Cart is empty', '⚠️'); return; }

        // Open the WhatsApp window SYNCHRONOUSLY on the click.
        const waWin = window.open('', '_blank');

        const now = new Date();
        const dateStr = now.getDate() + '-' + (now.getMonth() + 1) + '-' + now.getFullYear();
        const timeStr = now.toLocaleTimeString('en-US', { hour12: false }).substring(0, 5);
        const total = cart.reduce(function (s, i) { return s + ((i.price || 0) * (i.qty || 0)); }, 0);

        // One backend order summarising the whole cart. The backend
        // will generate a real orderId (or use one we send).
        const order = {
            customerName: name,
            customerPhone: phone,
            customerAddress: address,
            productName: cart.length === 1 ? cart[0].name : ('Cart order (' + cart.length + ' items)'),
            productCode: cart[0] ? (cart[0].code || 'CART') : 'CART',
            colorName: cart.length === 1 ? cart[0].colorName : '',
            colorValue: cart.length === 1 ? cart[0].colorValue : '',
            size: cart.length === 1 ? cart[0].size : '',
            quantity: cart.reduce(function (s, i) { return s + (i.qty || 0); }, 0),
            price: total,
            total: total,
            productImage: cart[0] ? cart[0].image : '',
            status: 'pending',
            notes: notes ? (notes + ' | Items: ' + cart.map(function (i) { return i.code + ' x' + i.qty; }).join(', ')) : ('Items: ' + cart.map(function (i) { return i.code + ' x' + i.qty; }).join(', ')),
            date: dateStr,
            time: timeStr
        };

        modal.classList.remove('open');
        showToast('Order sent! Opening WhatsApp...', '✅');

        function buildWaMessage(orderId) {
            const waNumber = (settings.whatsapp || DEFAULT_WHATSAPP).replace(/\D/g, '');
            const L = '────────────────────────────';
            const lines = [
                "NEW ORDER — NAKOWA ABAYA'S COLLECTIONS",
                '',
                L,
                'Order ID: ' + orderId,
                L,
                ''
            ];
            cart.forEach(function (item, idx) {
                lines.push('Item ' + (idx + 1) + ':');
                lines.push('  Code: ' + item.code);
                lines.push('  Color: ' + item.colorName);
                lines.push('  Size: ' + item.size);
                lines.push('  Qty: ' + item.qty);
                lines.push('  Price: ₦' + (item.price || 0).toLocaleString());
                lines.push('');
            });
            lines.push(L);
            lines.push('GRAND TOTAL: ₦' + total.toLocaleString());
            lines.push(L);
            lines.push('');
            lines.push('CUSTOMER DETAILS');
            lines.push('Name: ' + name);
            lines.push('Phone: ' + phone);
            lines.push('Address: ' + address);
            lines.push('');
            lines.push(L);
            lines.push('Date/Time: ' + dateStr + ' | ' + timeStr);
            if (notes) { lines.push('Notes: ' + notes); }
            lines.push(L);
            return 'https://wa.me/' + waNumber + '?text=' + encodeURIComponent(lines.join('\n'));
        }

        apiPost('saveOrder', { order: order }).then(function (res) {
            const orderId = (res && res.success && res.orderId) ? res.orderId : 'TEMP-' + Date.now().toString(36).toUpperCase();
            const waUrl = buildWaMessage(orderId);

            if (waWin && !waWin.closed) waWin.location.href = waUrl;
            else showToast('Tap the toast to open WhatsApp', '💬');

            const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
            myOrders.unshift(Object.assign({}, order, { orderId: orderId }));
            localStorage.setItem('nakowa_my_orders', JSON.stringify(myOrders.slice(0, 50)));

            cart = [];
            saveCart();
            updateCartUI();
        }).catch(function (err) {
            console.error('Checkout save failed:', err);
            const orderId = 'TEMP-' + Date.now().toString(36).toUpperCase();
            const waUrl = buildWaMessage(orderId);
            if (waWin && !waWin.closed) waWin.location.href = waUrl;

            const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
            myOrders.unshift(Object.assign({}, order, { orderId: orderId }));
            localStorage.setItem('nakowa_my_orders', JSON.stringify(myOrders.slice(0, 50)));

            cart = [];
            saveCart();
            updateCartUI();
        });
    });
}

function checkoutCart() { openCheckoutModal(); }

// ============================================================
// QUEUE INTEGRATION (public side)
//
// Loads pending jobs, merges them into the products list, and
// shows a small banner. The worker runs here too, but it will
// only upload — it will NOT save to the backend unless an admin
// token is present (public visitors never have one).
// ============================================================
function startPublicQueue() {
    try {
        if (!window.NakowaQueue || !NakowaQueue.isAvailable()) return;

        try { NakowaQueue.removeLegacyLocalStorageKey(); } catch (e) {}

        _queueUnsubscribers.forEach(function (fn) { try { fn(); } catch (e) {} });
        _queueUnsubscribers = [];
        _queueUnsubscribers.push(NakowaQueue.onEvent(function (ev) {
            if (ev.type === 'job-progress' || ev.type === 'job-done' || ev.type === 'job-error' || ev.type === 'worker-idle') {
                renderPendingBanner();
                loadProducts();
            }
        }));

        NakowaQueue.startWorker({ getToken: function () { return ''; } }).catch(function () {});
        renderPendingBanner();
    } catch (e) { console.warn('[Queue] public init failed:', e); }
}

function renderPendingBanner() {
    if (!window.NakowaQueue || !NakowaQueue.isAvailable()) return;
    NakowaQueue.getQueueStats().then(function (stats) {
        const active = stats.activeJobs > 0;
        if (!active) {
            if (_pendingBannerEl) { _pendingBannerEl.remove(); _pendingBannerEl = null; }
            return;
        }
        if (!_pendingBannerEl) {
            _pendingBannerEl = document.createElement('div');
            _pendingBannerEl.id = 'nakowaPendingBanner';
            _pendingBannerEl.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);' +
                'background:#111;color:#f9e508;border:1px solid #f9e508;border-radius:30px;' +
                'padding:10px 18px;font-size:0.85rem;z-index:9999;box-shadow:0 6px 30px rgba(0,0,0,0.6);';
            document.body.appendChild(_pendingBannerEl);
        }
        _pendingBannerEl.textContent = 'Uploading ' + stats.uploaded + '/' + stats.total + ' in background';
    }).catch(function () {});
}

// ============================================================
// LOAD DATA
// ============================================================
async function loadProducts() {
    const grid = document.getElementById('productGrid');
    if (!grid) return;

    // First render from cache if we have one and nothing is shown yet.
    if (products.length === 0) {
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
            grid.innerHTML = Array(6).fill(0).map(function () {
                return '<div class="skeleton-card">' +
                    '<div class="skeleton-image"></div>' +
                    '<div class="skeleton-info">' +
                        '<div class="skeleton-text"></div>' +
                        '<div class="skeleton-text short"></div>' +
                        '<div class="skeleton-text price"></div>' +
                        '<div class="skeleton-btn"></div>' +
                    '</div>' +
                '</div>';
            }).join('');
        }
    }

    try {
        const data = await apiGet('products');
        const apiProducts = Array.isArray(data) ? data : [];

        let pending = [];
        try {
            if (window.NakowaQueue && NakowaQueue.isAvailable()) {
                pending = await NakowaQueue.getPendingProducts();
            }
        } catch (e) { console.warn('[Queue] pending load failed:', e); }

        const apiIds = new Set(apiProducts.map(function (p) { return String(p.id); }));
        const pendingFiltered = pending.filter(function (p) { return !apiIds.has(String(p.id)); });
        const merged = apiProducts.concat(pendingFiltered);

        // Re-render only if the data actually changed.
        const hash = JSON.stringify(merged.map(function (p) {
            return [
                p.id,
                getProductPrice(p),
                !!p._pending,
                p._uploadedCount || 0,
                p._totalCount || 0,
                (p.variants || []).length
            ].join('|');
        }));

        if (hash === _lastProductsHash && products.length > 0) return;
        _lastProductsHash = hash;

        // Preserve scroll position across the re-render.
        const scrollY = window.scrollY;

        products = merged;
        renderProducts();

        window.scrollTo(0, scrollY);

        try { localStorage.setItem('nakowa_products_cache', JSON.stringify(apiProducts)); } catch (e) {}

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
    } catch (err) { console.error('Load settings error:', err); }
}

function applySettings(s) {
    if (s.hero) {
        const hero = document.getElementById('home');
        if (hero) hero.style.backgroundImage = 'url(\'' + s.hero + '\')';
    }
    if (s.logo) {
        document.querySelectorAll('.site-logo').forEach(function (img) { img.src = s.logo; });
    }
    if (s.whatsapp) {
        const clean = s.whatsapp.replace(/\D/g, '');
        if (clean) {
            const waUrl = 'https://wa.me/' + clean;
            ['contactWhatsappLink', 'floatWhatsapp'].forEach(function (id) {
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
        ['contactEmail', 'footerEmail'].forEach(function (id) {
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
// FILTERS + SEARCH
// ============================================================
function setupPriceFilters() {
    document.querySelectorAll('#priceFilters .filter-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            document.querySelectorAll('#priceFilters .filter-btn').forEach(function (b) { b.classList.remove('active'); });
            this.classList.add('active');
            currentPriceFilter = this.dataset.price;
            renderProducts();
        });
    });
}

function setupSearch() {
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    if (!searchInput || !searchBtn) return;

    function doSearch() {
        const q = searchInput.value.trim().toLowerCase();
        if (!q) { renderProducts(); return; }
        const grid = document.getElementById('productGrid');
        if (!grid) return;
        const filtered = products.filter(function (p) {
            return (p.name || '').toLowerCase().indexOf(q) !== -1 ||
                   (p.code || '').toLowerCase().indexOf(q) !== -1 ||
                   (p.variants || []).some(function (v) {
                       return (v.colorName || '').toLowerCase().indexOf(q) !== -1 ||
                              (v.code || '').toLowerCase().indexOf(q) !== -1;
                   });
        });
        const display = document.getElementById('productCountDisplay');
        if (display) display.textContent = filtered.length;
        if (filtered.length === 0) { grid.innerHTML = '<div class="empty-state">✨ No results found.</div>'; return; }
        grid.innerHTML = filtered.map(function (p) { return renderProductCard(p); }).join('');
        attachProductListeners();
        applyVideo10sLoop(grid);
        const productsSection = document.getElementById('products');
        if (productsSection) productsSection.scrollIntoView({ behavior: 'smooth' });
    }

    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keyup', function (e) { if (e.key === 'Enter') doSearch(); });
}

// ============================================================
// LOGO 5x → admin
// ============================================================
function setupLogoTrigger() {
    const logo = document.getElementById('logoTrigger');
    if (!logo) return;
    let count = 0, lastClick = 0;
    logo.addEventListener('click', function () {
        const now = Date.now();
        if (now - lastClick > 1500) count = 0;
        lastClick = now;
        count++;
        if (count >= 5) { count = 0; window.location.href = 'admin/admin.html'; }
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

    if (btn && menu) btn.addEventListener('click', function () { menu.classList.add('open'); });
    if (close && menu) close.addEventListener('click', function () { menu.classList.remove('open'); });
    if (menu) {
        menu.addEventListener('click', function (e) {
            if (e.target.tagName === 'A' && !e.target.id) menu.classList.remove('open');
        });
    }
    if (cartLink) cartLink.addEventListener('click', function (e) {
        e.preventDefault();
        menu.classList.remove('open');
        document.getElementById('cartSidebar').classList.add('open');
        document.getElementById('cartOverlay').classList.add('active');
    });
    if (themeLink) themeLink.addEventListener('click', function (e) {
        e.preventDefault();
        setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
        menu.classList.remove('open');
    });
    if (trackLink) trackLink.addEventListener('click', function (e) {
        e.preventDefault();
        menu.classList.remove('open');
        openTrackingModal();
    });
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

    function open() { sidebar.classList.add('open'); overlay.classList.add('active'); }
    function closeFn() { sidebar.classList.remove('open'); overlay.classList.remove('active'); }

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

    float.addEventListener('click', function () { modal.classList.toggle('open'); });
    if (close) close.addEventListener('click', function () { modal.classList.remove('open'); });

    function sendMsg() {
        const text = input.value.trim();
        if (!text) return;
        const user = document.createElement('div');
        user.className = 'chat-message user';
        user.textContent = text;
        messages.appendChild(user);
        input.value = '';
        messages.scrollTop = messages.scrollHeight;

        setTimeout(function () {
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
    }

    if (send) send.addEventListener('click', sendMsg);
    if (input) input.addEventListener('keypress', function (e) { if (e.key === 'Enter') sendMsg(); });
}

// ============================================================
// THEME
// ============================================================
function setupTheme() {
    const btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', function () {
        setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
    });
    setTheme(getTheme());
}

// ============================================================
// BACK TO TOP
// ============================================================
function setupBackToTop() {
    const btn = document.getElementById('backToTop');
    if (!btn) return;
    window.addEventListener('scroll', function () {
        btn.classList.toggle('show', window.scrollY > 500);
    });
    btn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
}

// ============================================================
// NEWSLETTER
// ============================================================
function setupNewsletter() {
    const form = document.getElementById('newsletterForm');
    if (!form) return;
    form.addEventListener('submit', function (e) {
        e.preventDefault();
        const email = document.getElementById('newsletterEmail').value.trim();
        const msg = document.getElementById('newsletterMsg');
        if (email.indexOf('@') === -1) {
            msg.textContent = '❌ Please enter a valid email.';
            msg.style.display = 'block';
            msg.style.color = '#e74c3c';
            return;
        }
        msg.textContent = '✅ Thank you for subscribing!';
        msg.style.display = 'block';
        msg.style.color = 'var(--gold)';
        form.reset();
        setTimeout(function () { msg.style.display = 'none'; }, 4000);
    });
}

// ============================================================
// MODAL CLOSES
// ============================================================
function setupModalCloses() {
    const pairs = [
        ['closeOrderModal', 'orderModal'],
        ['closeTrackingModal', 'trackingModal']
    ];
    pairs.forEach(function (pair) {
        const c = document.getElementById(pair[0]);
        const m = document.getElementById(pair[1]);
        if (c && m) {
            c.addEventListener('click', function () { m.classList.remove('open'); });
            m.addEventListener('click', function (e) { if (e.target === m) m.classList.remove('open'); });
        }
    });
}

function checkAndShowTrackingOnReturn() {
    try {
        if (localStorage.getItem('nakowa_tracking_seen') === 'true') return;
        const myOrders = JSON.parse(localStorage.getItem('nakowa_my_orders') || '[]');
        if (myOrders.length === 0) return;
        localStorage.setItem('nakowa_tracking_seen', 'true');
        setTimeout(function () { openTrackingModal(); }, 1500);
    } catch (e) { console.warn('Auto-tracking error:', e); }
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async function () {
    // Splash — one 3s timeout plus one 5s safety net.
    setTimeout(hideSplash, SPLASH_TIME);
    setTimeout(hideSplash, 5000);

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

    // Start the queue worker on the public page too. It will
    // upload media but will NOT save to the backend unless an
    // admin token is present in sessionStorage (which it is not,
    // for normal visitors).
    startPublicQueue();

    loadSettings();
    await loadProducts();

    setInterval(loadProducts, 60000);

    checkAndShowTrackingOnReturn();
});