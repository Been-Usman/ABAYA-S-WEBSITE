/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — Admin Script (v6 — FINAL)

   FEATURES ADDED:
   1. Bulk price update (checkboxes + toolbar)
   2. Bulk delete (Delete Selected)
   3. Search on Products page (client-side)
   4. WhatsApp order status notification
   5. Drag & drop image reorder in variant setup
   6. Faster save (concurrency limit 6 + live progress)
   7. Fake price display (actual bold + fake strikethrough)
   8. Color circles in admin product cards
   9. UTF-8 fixed everywhere
   ============================================================ */

// ============================================================
// CONFIGURATION
// ============================================================
const API_URL = 'https://script.google.com/macros/s/AKfycbxGcW2xkagjfp9Dr3Jz_1sflwM-JRbjPV1LUF4UoWzhAGJU2epWVDhXoQH9TgkevU5D/exec';

const CLOUDINARY = {
    cloudName: 'Idtixrva',
    uploadPreset: 'NAKOWA-ABAYAS',
    folder: 'ABAYAS-VIDEO-IMGS',
    imageUrl: 'https://api.cloudinary.com/v1_1/Idtixrva/image/upload',
    videoUrl: 'https://api.cloudinary.com/v1_1/Idtixrva/video/upload'
};

const SUPABASE = {
    url: 'https://yntkbjzvmizssrxwzuoi.supabase.co',
    key: 'sb_publishable_CFyA2zonltT81jFRMyAQpg_kx5vLA_u',
    bucket: 'Product-images',
    bucketAliases: ['product-images', 'PRODUCT-IMAGES', 'Product-Images', 'products-images', 'nakowa-images'],
    maxImages: 200,
    maxSizeMB: 900,
    threshold: 200
};

const COLOR_PALETTE = [
    { name: 'Black',  value: '#000000' },
    { name: 'White',  value: '#FFFFFF' },
    { name: 'Red',    value: '#E74C3C' },
    { name: 'Blue',   value: '#2563EB' },
    { name: 'Green',  value: '#22C55E' },
    { name: 'Navy',   value: '#1E3A8A' },
    { name: 'Brown',  value: '#8B4513' },
    { name: 'Beige',  value: '#D4B896' },
    { name: 'Cream',  value: '#F5E6C8' },
    { name: 'Pink',   value: '#EC4899' },
    { name: 'Purple', value: '#7C3AED' },
    { name: 'Yellow', value: '#FACC15' },
    { name: 'Orange', value: '#F97316' },
    { name: 'Grey',   value: '#6B7280' },
    { name: 'Gold',   value: '#D4AF37' },
    { name: 'Silver', value: '#C0C0C0' },
    { name: 'Maroon', value: '#7F1D1D' },
    { name: 'Teal',   value: '#14B8A6' },
    { name: 'Lavender', value: '#B0A5D6' },
    { name: 'Olive',  value: '#808000' }
];

// ============================================================
// AUTH — 5-HOUR TOKEN + OWNER LOCK
// Only the FIRST admin who ever logged in on this device
// can log in again. Token expires after 5 hours.
// ============================================================
const TOKEN_LIFETIME_MS = 5 * 60 * 60 * 1000; // 5 hours
const TOKEN_KEY = 'nakowa_admin_token';
const TOKEN_TIME_KEY = 'nakowa_admin_token_time';
const USER_KEY = 'nakowa_admin_user';
const OWNER_KEY = 'nakowa_admin_owner';

function saveToken(token, username) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(TOKEN_TIME_KEY, Date.now().toString());
    localStorage.setItem(USER_KEY, username);
    // Lock this device to this username forever (until cleared manually)
    if (!localStorage.getItem(OWNER_KEY)) {
        localStorage.setItem(OWNER_KEY, username);
    }
}

function getToken() {
    const token = localStorage.getItem(TOKEN_KEY);
    const time = parseInt(localStorage.getItem(TOKEN_TIME_KEY) || '0');
    if (!token) return '';
    if (Date.now() - time > TOKEN_LIFETIME_MS) {
        clearToken();
        return '';
    }
    return token;
}

function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_TIME_KEY);
    localStorage.removeItem(USER_KEY);
    // NOTE: OWNER_KEY is NOT removed — device stays locked to this admin
}

function getTokenRemainingMs() {
    const time = parseInt(localStorage.getItem(TOKEN_TIME_KEY) || '0');
    if (!time) return 0;
    return Math.max(0, TOKEN_LIFETIME_MS - (Date.now() - time));
}

function getOwner() {
    return localStorage.getItem(OWNER_KEY) || '';
}

function isOwner(username) {
    const owner = getOwner();
    return !owner || owner === username;
}

// ============================================================
// STATE
// ============================================================
let authToken = '';
let currentAdmin = '';
let currentSection = 'dashboard';

let cachedProducts = null;
let cachedOrders = null;
let cachedSettings = null;
let cachedCustomers = null;
let cachedUsers = null;

let uploadFiles = [];
let currentVariantIndex = 0;
let currentBatch = [];
let supabaseInitialCount = 0;
let supabaseBucket = SUPABASE.bucket;
let supabaseProbePromise = null;
let supabaseProbeCachedAt = 0;
const SUPABASE_PROBE_TTL = 30 * 60 * 1000;
let supabaseAvailable = false;
let salesChartInstance = null;

// Bulk selection state
let selectedProductIds = new Set();
let productSearchQuery = '';

// ============================================================
// VIEW TOKEN — prevents stale async loads from hijacking the view
// Bumped every time the user navigates to a section
// ============================================================
let viewToken = 0;
function bumpViewToken() { viewToken++; return viewToken; }
function isViewCurrent(token) { return token === viewToken; }

// ============================================================
// UTILITIES
// ============================================================
function $(id) { return document.getElementById(id); }

const DEFAULT_IMG = window.FALLBACK_IMG || 'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22400%22%20height%3D%22400%22%20viewBox%3D%220%200%20400%20400%22%3E%3Crect%20width%3D%22400%22%20height%3D%22400%22%20fill%3D%22%23000000%22%2F%3E%3Ctext%20x%3D%22200%22%20y%3D%22200%22%20fill%3D%22%23d4af37%22%20font-family%3D%22Poppins%2CArial%2Csans-serif%22%20font-size%3D%2256%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22central%22%3ENAKOWA%3C%2Ftext%3E%3C%2Fsvg%3E';

if (typeof window.imgFallback !== 'function') {
    window.imgFallback = function (img) {
        if (!img || img.dataset.fbApplied === '1') return;
        img.dataset.fbApplied = '1';
        img.onerror = null;
        img.src = DEFAULT_IMG;
    };
}

const _reportedOnce = new Set();
function logOnce(key, message, detail) {
    if (_reportedOnce.has(key)) return;
    _reportedOnce.add(key);
    if (detail === undefined) console.error(message);
    else console.error(message, detail);
}
function warnOnce(key, message, detail) {
    if (_reportedOnce.has(key)) return;
    _reportedOnce.add(key);
    if (detail === undefined) console.warn(message);
    else console.warn(message, detail);
}

function showToast(msg, icon = '✅') {
    const t = $('toast');
    if (!t) return;
    $('toastMessage').textContent = msg;
    t.querySelector('.toast-icon').textContent = icon;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 4000);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, s => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[s]);
}

function formatMoney(n) {
    return '₦' + (parseFloat(n) || 0).toLocaleString();
}

function generateId(prefix = 'P') {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
    return prefix + '-' + ts + '-' + rand;
}

function normalizeProductCode(code) {
    code = (code || '').trim();
    if (!code) return 'NAK-000';
    if (/^\d+$/.test(code)) return 'NAK-' + code;
    if (code.startsWith('NAK-')) return code;
    return code;
}

// ============================================================
// FAKE PRICE RENDERER
// ============================================================
function renderPrice(actualPrice) {
    const actual = parseFloat(actualPrice) || 0;
    const fake = actual + 5000;
    return `
        <span class="price-actual">₦${actual.toLocaleString()}</span>
        <span class="price-fake">₦${fake.toLocaleString()}</span>
    `;
}

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
// AUTH
// ============================================================
async function doLogin() {
    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value;
    const errEl = $('loginError');

    if (!username || !password) {
        errEl.textContent = 'Please enter username and password.';
        errEl.style.display = 'block';
        return;
    }

    // OWNER LOCK: only the first admin who ever logged in can log in again
    if (!isOwner(username)) {
        errEl.textContent = 'This device is locked to another admin account.';
        errEl.style.display = 'block';
        return;
    }

    errEl.style.display = 'none';
    const btn = $('loginBtn');
    btn.disabled = true;
    btn.textContent = 'Logging in...';

    try {
        const res = await apiPost('login', { username, password });
        if (!res.success) {
            errEl.textContent = res.message || 'Login failed.';
            errEl.style.display = 'block';
            return;
        }
        authToken = res.token;
        currentAdmin = res.username;
        localStorage.setItem('nakowa_admin_token', authToken);
        localStorage.setItem('nakowa_admin_user', currentAdmin);

        await warmCache();

        $('loginScreen').style.display = 'none';
        $('dashboard').style.display = 'flex';
        loadSection('dashboard');
    } catch (err) {
        errEl.textContent = 'Network error: ' + err.message;
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Login';
    }
}

function doLogout() {
    authToken = '';
    currentAdmin = '';
    cachedProducts = null;
    cachedOrders = null;
    cachedSettings = null;
    cachedCustomers = null;
    cachedUsers = null;
    clearToken();
    window.location.href = '../index.html';
}

function checkAuth() {
    return localStorage.getItem('nakowa_admin_token') || '';
}

async function warmCache() {
    try {
        const [p, o, s] = await Promise.all([
            apiGet('products'),
            apiGet('orders'),
            apiGet('settings')
        ]);
        cachedProducts = p || [];
        cachedOrders = o || [];
        cachedSettings = s || {};
    } catch (e) {
        cachedProducts = cachedProducts || [];
        cachedOrders = cachedOrders || [];
        cachedSettings = cachedSettings || {};
        warnOnce('warm-cache-failed', '[API] Initial prefetch failed.', e);
    }
}

// ============================================================
// NAVIGATION
// ============================================================
function loadSection(section) {
    currentSection = section;
    const myToken = bumpViewToken();

    if (section !== 'dashboard' && salesChartInstance) {
        try { salesChartInstance.destroy(); } catch (e) {}
        salesChartInstance = null;
    }

    document.querySelectorAll('.sidebar li[data-section]').forEach(el => {
        el.classList.toggle('active', el.dataset.section === section);
    });
    $('sidebar').classList.remove('open');

    // Reset bulk selection when leaving products
    if (section !== 'products') {
        selectedProductIds.clear();
    }

    switch (section) {
        case 'dashboard': renderDashboard(); break;
        case 'products': renderProducts(); break;
        case 'orders': renderOrders(); break;
        case 'customers': renderCustomers(); break;
        case 'settings': renderSettings(); break;
        case 'users': renderUsers(); break;
        case 'changepassword': renderChangePassword(); break;
    }
}

// ============================================================
// DASHBOARD
// ============================================================
async function renderDashboard() {
    $('pageTitle').textContent = 'Dashboard';
    $('topbarDate').textContent = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    currentSection = 'dashboard';
    const myToken = viewToken;

    if (cachedProducts === null) cachedProducts = [];
    if (cachedOrders === null) cachedOrders = [];
    if (cachedSettings === null) cachedSettings = {};
    drawDashboard();

    try {
        const [p, o, s] = await Promise.all([
            apiGet('products'),
            apiGet('orders'),
            apiGet('settings')
        ]);
        if (!isViewCurrent(myToken)) return;
        cachedProducts = p || [];
        cachedOrders = o || [];
        cachedSettings = s || {};
        if (currentSection === 'dashboard') drawDashboard();
    } catch (e) {}
}

function drawDashboard() {
    const area = $('contentArea');
    const lowThreshold = parseInt(cachedSettings.lowStockThreshold || 3);

    const totalProducts = cachedProducts.length;
    const totalOrders = cachedOrders.length;
    const totalRevenue = cachedOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
    const pendingOrders = cachedOrders.filter(o => o.status === 'pending').length;
    const lowStock = cachedProducts.filter(p => parseInt(p.stock || 0) <= lowThreshold && parseInt(p.stock || 0) > 0);
    const outOfStock = cachedProducts.filter(p => parseInt(p.stock || 0) === 0);

    const last7 = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dStr = d.getDate() + '-' + (d.getMonth() + 1) + '-' + d.getFullYear();
        const dayOrders = cachedOrders.filter(o => (o.date || '') === dStr);
        last7.push({
            label: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
            count: dayOrders.length,
            revenue: dayOrders.reduce((s, o) => s + (parseFloat(o.total) || 0), 0)
        });
    }

    let lowStockHTML = '';
    if (lowStock.length > 0 || outOfStock.length > 0) {
        lowStockHTML = `
            <div class="admin-card">
                <div class="card-title"><span><i class="fas fa-exclamation-triangle" style="color:#f59e0b;"></i> Stock Alerts</span></div>
                <ul class="recent-list">
                    ${outOfStock.map(p => `<li><span class="product-name">${escapeHtml(p.name)} (${escapeHtml(p.code)})</span><span style="color:#e74c3c;font-weight:700;">OUT OF STOCK</span></li>`).join('')}
                    ${lowStock.map(p => `<li><span class="product-name">${escapeHtml(p.name)} (${escapeHtml(p.code)})</span><span style="color:#f59e0b;font-weight:700;">${p.stock} left</span></li>`).join('')}
                </ul>
            </div>
        `;
    }

    const recentProducts = cachedProducts.slice(-5).reverse().map(p =>
        `<li><span class="product-name">${escapeHtml(p.name)}</span><span class="product-country">${escapeHtml(p.country || 'Egypt')}</span></li>`
    ).join('') || '<li style="opacity:0.5;">No products yet</li>';

    area.innerHTML = `
        <div class="admin-stats-grid">
            <div class="admin-stat-card">
                <span class="stat-icon"><i class="fas fa-box"></i></span>
                <div class="stat-number">${totalProducts}</div>
                <div class="stat-label">Products</div>
            </div>
            <div class="admin-stat-card">
                <span class="stat-icon"><i class="fas fa-shopping-bag"></i></span>
                <div class="stat-number">${totalOrders}</div>
                <div class="stat-label">Orders</div>
            </div>
            <div class="admin-stat-card">
                <span class="stat-icon"><i class="fas fa-money-bill-wave"></i></span>
                <div class="stat-number" style="font-size:1.4rem;">${formatMoney(totalRevenue)}</div>
                <div class="stat-label">Revenue</div>
            </div>
            <div class="admin-stat-card ${pendingOrders > 0 ? 'warning' : ''}">
                <span class="stat-icon"><i class="fas fa-clock"></i></span>
                <div class="stat-number">${pendingOrders}</div>
                <div class="stat-label">Pending</div>
            </div>
        </div>

        <div class="admin-card">
            <div class="card-title"><span><i class="fas fa-chart-line"></i> Sales — Last 7 Days</span></div>
            <div class="chart-container"><canvas id="salesChart"></canvas></div>
        </div>

        ${lowStockHTML}

        <div class="admin-card">
            <div class="card-title"><span><i class="fas fa-clock"></i> Recently Added</span></div>
            <ul class="recent-list">${recentProducts}</ul>
        </div>
    `;

    if (window.Chart) {
        const ctx = document.getElementById('salesChart');
        if (salesChartInstance) {
            try { salesChartInstance.destroy(); } catch (e) {}
            salesChartInstance = null;
        }
        if (ctx) {
            salesChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: last7.map(d => d.label),
                    datasets: [{
                        label: 'Revenue (₦)',
                        data: last7.map(d => d.revenue),
                        borderColor: '#f9e508',
                        backgroundColor: 'rgba(249, 229, 8, 0.1)',
                        tension: 0.4,
                        fill: true,
                        pointBackgroundColor: '#f9e508',
                        pointBorderColor: '#000',
                        pointRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { labels: { color: '#fff', font: { family: 'Poppins' } } } },
                    scales: {
                        x: { ticks: { color: 'rgba(255,255,255,0.6)' }, grid: { color: 'rgba(255,255,255,0.05)' } },
                        y: { ticks: { color: 'rgba(255,255,255,0.6)', callback: v => '₦' + v.toLocaleString() }, grid: { color: 'rgba(255,255,255,0.05)' } }
                    }
                }
            });
        }
    }
}

// ============================================================
// PRODUCTS — WITH SEARCH + BULK TOOLBAR + CHECKBOXES
// ============================================================
async function renderProducts() {
    $('pageTitle').textContent = 'Products';
    currentSection = 'products';
    const myToken = viewToken;

    if (cachedProducts === null) cachedProducts = [];
    drawProductsSection();

    try {
        const products = await apiGet('products');
        if (!isViewCurrent(myToken)) return;
        cachedProducts = products || [];
        if (currentSection === 'products') drawProductsSection();
    } catch (e) {}
}

function drawProductsSection() {
    const area = $('contentArea');
    area.innerHTML = `
        <div class="admin-card">
            <div class="card-title">
                <span><i class="fas fa-box"></i> All Products (${cachedProducts.length})</span>
                <button class="btn-gold" id="addProductBtn"><i class="fas fa-plus"></i> Add Products</button>
            </div>

            <div class="admin-product-search">
                <input type="text" id="productSearchInput" placeholder="Search by name or code..." />
            </div>

            <div id="bulkToolbar" class="bulk-toolbar hidden">
                <span class="bulk-count"><span id="bulkCount">0</span> selected</span>
                <select id="bulkPriceMode">
                    <option value="set">Set Price To (₦)</option>
                    <option value="add">Add (₦)</option>
                    <option value="subtract">Subtract (₦)</option>
                    <option value="increase_pct">Increase by (%)</option>
                    <option value="decrease_pct">Decrease by (%)</option>
                </select>
                <input type="number" id="bulkPriceValue" placeholder="Value" min="0" />
                <button class="btn-bulk-apply" id="bulkApplyPriceBtn"><i class="fas fa-tag"></i> Apply</button>
                <button class="btn-bulk-delete" id="bulkDeleteBtn"><i class="fas fa-trash"></i> Delete Selected</button>
                <button class="btn-bulk-cancel" id="bulkCancelBtn">Cancel</button>
            </div>

            <div id="productsContainer"></div>
        </div>
    `;

    $('addProductBtn').addEventListener('click', () => renderAddProductForm());

    const searchInput = $('productSearchInput');
    searchInput.value = productSearchQuery;
    searchInput.addEventListener('input', function() {
        productSearchQuery = this.value.trim().toLowerCase();
        renderProductList('all');
    });

    $('bulkApplyPriceBtn').addEventListener('click', bulkApplyPrice);
    $('bulkDeleteBtn').addEventListener('click', bulkDeleteProducts);
    $('bulkCancelBtn').addEventListener('click', () => {
        selectedProductIds.clear();
        updateBulkToolbar();
        renderProductList('all');
    });

    renderProductList('all');
}

function updateBulkToolbar() {
    const toolbar = $('bulkToolbar');
    const countEl = $('bulkCount');
    if (!toolbar || !countEl) return;
    countEl.textContent = selectedProductIds.size;
    toolbar.classList.toggle('hidden', selectedProductIds.size === 0);
}

function renderProductList(filterCountry) {
    const container = $('productsContainer');
    if (!container) return;

    const countries = [...new Set(cachedProducts.map(p => p.country).filter(Boolean))];
    if (!countries.includes('Egypt')) countries.unshift('Egypt');

    let filtered = filterCountry === 'all'
        ? cachedProducts
        : cachedProducts.filter(p => p.country === filterCountry);

    // Apply search filter (client-side)
    if (productSearchQuery) {
        const q = productSearchQuery;
        filtered = filtered.filter(p => {
            const nameMatch = (p.name || '').toLowerCase().includes(q);
            const codeMatch = (p.code || '').toLowerCase().includes(q);
            const variantMatch = (p.variants || []).some(v =>
                (v.colorName || '').toLowerCase().includes(q) ||
                (v.code || '').toLowerCase().includes(q)
            );
            return nameMatch || codeMatch || variantMatch;
        });
    }

    const filterHTML = `
        <div class="filter-buttons" style="margin-bottom:14px;">
            <button class="filter-btn ${filterCountry === 'all' ? 'active' : ''}" data-filter="all">All</button>
            ${countries.map(c => `<button class="filter-btn ${filterCountry === c ? 'active' : ''}" data-filter="${escapeHtml(c)}">${c === 'Egypt' ? '🇪🇬 ' : ''}${escapeHtml(c)}</button>`).join('')}
        </div>
    `;

    if (filtered.length === 0) {
        container.innerHTML = filterHTML + `<div class="empty-state-admin"><i class="fas fa-box-open"></i><h4>No products</h4><p>${productSearchQuery ? 'No match for your search.' : 'Click "Add Products" to start.'}</p></div>`;
    } else {
        container.innerHTML = filterHTML + `
            <div class="admin-product-grid">
                ${filtered.map(p => renderAdminProductCard(p)).join('')}
            </div>
        `;
    }

    container.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => renderProductList(btn.dataset.filter));
    });
    container.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => editProduct(btn.dataset.id));
    });
    container.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteProduct(btn.dataset.id));
    });
    container.querySelectorAll('.card-checkbox').forEach(cb => {
        cb.addEventListener('change', function() {
            const id = this.dataset.id;
            if (this.checked) selectedProductIds.add(id);
            else selectedProductIds.delete(id);
            updateBulkToolbar();
            const card = this.closest('.admin-product-card');
            if (card) card.classList.toggle('selected', this.checked);
        });
    });

    updateBulkToolbar();
}

function renderAdminProductCard(p) {
    const variants = (p.variants && Array.isArray(p.variants)) ? p.variants : [];
    const firstVariant = variants[0] || {
        image: (Array.isArray(p.images) && p.images[0]) || p.images || '',
        price: p.price || 0,
        code: p.code || '',
        colorName: 'Default',
        colorValue: '#D4AF37'
    };
    const hasVideo = (p.videos && Array.isArray(p.videos) && p.videos.length > 0);
    const isSelected = selectedProductIds.has(String(p.id));

    // Color circles for admin card (compact)
    let colorCirclesHTML = '';
    if (variants.length > 0) {
        colorCirclesHTML = `
            <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center;margin:6px 0;">
                ${variants.slice(0, 6).map(v => `
                    <span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:${v.colorValue || '#ccc'};border:1px solid rgba(255,255,255,0.3);" title="${escapeHtml(v.colorName || '')}"></span>
                `).join('')}
                ${variants.length > 6 ? `<span style="font-size:0.7rem;color:rgba(255,255,255,0.5);">+${variants.length - 6}</span>` : ''}
            </div>
        `;
    }

    return `
        <div class="admin-product-card ${isSelected ? 'selected' : ''}">
            <input type="checkbox" class="card-checkbox" data-id="${escapeHtml(p.id)}" ${isSelected ? 'checked' : ''} />
            ${hasVideo
                ? `<video src="${p.videos[0]}" muted autoplay loop playsinline style="width:100%;height:140px;object-fit:cover;border-radius:8px;margin-bottom:10px;" data-autoplay-video></video>`
                : `<img src="${firstVariant.image || DEFAULT_IMG}" alt="${escapeHtml(p.name)}" onerror="imgFallback(this)" />`
            }
            <h4>${escapeHtml(p.name)}</h4>
            <div class="product-meta">Code: <strong>${escapeHtml(firstVariant.code || p.code || '')}</strong></div>
            <div class="product-price" style="text-align:left;margin:4px 0;font-size:0.95rem;">${renderPrice(firstVariant.price || p.price || 0)}</div>
            <div class="product-meta">Stock: <strong>${p.stock || 0}</strong></div>
            <div class="product-meta">Colors: ${variants.length}${hasVideo ? ' · 🎬 Video' : ''}</div>
            ${colorCirclesHTML}
            <div class="admin-actions">
                <button class="edit-btn" data-id="${escapeHtml(p.id)}"><i class="fas fa-edit"></i> Edit</button>
                <button class="delete-btn" data-id="${escapeHtml(p.id)}"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `;
}

// ============================================================
// BULK PRICE UPDATE
// ============================================================
async function bulkApplyPrice() {
    if (selectedProductIds.size === 0) {
        showToast('Select products first', '⚠️');
        return;
    }
    const mode = $('bulkPriceMode').value;
    const value = parseFloat($('bulkPriceValue').value);
    if (isNaN(value) || value < 0) {
        showToast('Enter a valid value', '⚠️');
        return;
    }

    const updates = [];
    selectedProductIds.forEach(id => {
        const p = cachedProducts.find(x => String(x.id) === String(id));
        if (!p) return;
        const variants = p.variants || [];
        let currentPrice = 0;
        if (variants.length > 0) currentPrice = parseFloat(variants[0].price) || 0;
        else currentPrice = parseFloat(p.price) || 0;

        let newPrice = currentPrice;
        switch (mode) {
            case 'set': newPrice = value; break;
            case 'add': newPrice = currentPrice + value; break;
            case 'subtract': newPrice = Math.max(0, currentPrice - value); break;
            case 'increase_pct': newPrice = Math.round(currentPrice * (1 + value / 100)); break;
            case 'decrease_pct': newPrice = Math.round(currentPrice * (1 - value / 100)); break;
        }
        newPrice = Math.max(0, newPrice);

        // Apply to all variants
        const newVariants = variants.map(v => ({ ...v, price: newPrice }));
        updates.push({ id: p.id, newPrice: newPrice, variants: newVariants });
    });

    if (updates.length === 0) return;

    showToast(`Updating ${updates.length} products...`, '⏳');

    try {
        const res = await apiPost('bulkUpdatePrices', {
            token: authToken,
            updates: updates.map(u => ({ id: u.id, newPrice: u.newPrice }))
        });

        if (res.success) {
            // Update local cache immediately
            updates.forEach(u => {
                const idx = cachedProducts.findIndex(p => String(p.id) === String(u.id));
                if (idx >= 0) {
                    cachedProducts[idx].variants = u.variants;
                }
            });
            showToast(`${updates.length} product(s) updated!`, '✅');
            selectedProductIds.clear();
            renderProductList('all');
        } else {
            showToast(res.message || 'Update failed', '❌');
        }
    } catch (err) {
        showToast('Error: ' + err.message, '❌');
    }
}

// ============================================================
// BULK DELETE
// ============================================================
async function bulkDeleteProducts() {
    if (selectedProductIds.size === 0) {
        showToast('Select products first', '⚠️');
        return;
    }
    const count = selectedProductIds.size;
    showConfirm(`Delete ${count} product(s)?`, 'This action cannot be undone.', async () => {
        try {
            const res = await apiPost('bulkDeleteProducts', {
                token: authToken,
                ids: [...selectedProductIds]
            });
            if (res.success) {
                cachedProducts = cachedProducts.filter(p => !selectedProductIds.has(String(p.id)));
                showToast(`${count} product(s) deleted`, '🗑️');
                selectedProductIds.clear();
                renderProductList('all');
                updateBulkToolbar();
            } else {
                showToast(res.message || 'Delete failed', '❌');
            }
        } catch (err) {
            showToast('Error: ' + err.message, '❌');
        }
    });
}

// ============================================================
// ADD PRODUCT — BATCH UPLOAD WITH DRAG REORDER
// ============================================================
function renderAddProductForm() {
    const container = $('productsContainer');
    if (!container) return;

    uploadFiles = [];
    currentVariantIndex = 0;
    currentBatch = [];
    supabaseInitialCount = 0;

    container.innerHTML = `
        <div class="admin-card" id="addProductCard">
            <div class="card-title">
                <span><i class="fas fa-plus"></i> Add New Products</span>
                <button class="btn-outline-gold" id="cancelAddBtn">Cancel</button>
            </div>

            <div id="stepCategory">
                <p style="margin-bottom:12px;color:rgba(255,255,255,0.6);">Step 1: Choose category</p>
                <div class="filter-buttons">
                    <button class="filter-btn active" data-cat="Egypt">🇪🇬 Egypt</button>
                </div>
                <button class="btn-gold" id="toStepMediaBtn" style="margin-top:16px;">Next: Upload Media</button>
            </div>

            <div id="stepMedia" style="display:none;">
                <p style="margin-bottom:12px;color:rgba(255,255,255,0.6);">Step 2: Upload images and/or videos. Drag to reorder (first = main thumbnail).</p>
                <div class="upload-zone" id="uploadZone">
                    <i class="fas fa-cloud-upload-alt"></i>
                    <p>Click to select files</p>
                    <div class="upload-hint">Supports JPG, PNG, WEBP, MP4, MOV, WEBM</div>
                    <input type="file" id="fileInput" accept="image/*,video/*" multiple />
                </div>
                <div class="admin-upload-preview" id="uploadPreview"></div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;">
                    <button class="btn-gold" id="startVariantsBtn" disabled>Start Variant Setup</button>
                    <button class="btn-outline-gold" id="backToCatBtn">Back</button>
                </div>
            </div>

            <div id="stepVariants" style="display:none;">
                <div id="variantStepContainer"></div>
            </div>
        </div>
    `;

    $('cancelAddBtn').addEventListener('click', () => renderProducts());
    $('toStepMediaBtn').addEventListener('click', () => {
        $('stepCategory').style.display = 'none';
        $('stepMedia').style.display = 'block';
    });
    $('backToCatBtn').addEventListener('click', () => {
        $('stepMedia').style.display = 'none';
        $('stepCategory').style.display = 'block';
    });

    const uploadZone = $('uploadZone');
    const fileInput = $('fileInput');
    uploadZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
        handleFileSelection(e.target.files);
        e.target.value = '';
    });

    uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
    uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
    uploadZone.addEventListener('drop', e => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        handleFileSelection(e.dataTransfer.files);
    });

    $('startVariantsBtn').addEventListener('click', startVariantSetup);
}

function handleFileSelection(files) {
    if (!files || files.length === 0) return;
    const incoming = Array.from(files).filter(f => f.type.startsWith('image/') || f.type.startsWith('video/'));

    if (incoming.length + uploadFiles.length > 100) {
        showToast('Maximum 100 files per batch', '⚠️');
        return;
    }

    uploadFiles = [...uploadFiles, ...incoming.map(f => ({
        file: f,
        isVideo: f.type.startsWith('video/'),
        url: null
    }))];

    renderUploadPreview();
}

function renderUploadPreview() {
    const preview = $('uploadPreview');
    if (!preview) return;

    preview.innerHTML = uploadFiles.map((item, i) => {
        const isVideo = item.isVideo;
        return `
            <div class="preview-item" data-idx="${i}" draggable="true">
                ${isVideo
                    ? `<video src="${URL.createObjectURL(item.file)}" muted autoplay loop playsinline data-autoplay-video></video>`
                    : `<img src="${URL.createObjectURL(item.file)}" alt="" />`
                }
                <button class="remove-img" data-remove="${i}">×</button>
            </div>
        `;
    }).join('');

    // Remove buttons
    preview.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const i = parseInt(btn.dataset.remove);
            uploadFiles.splice(i, 1);
            renderUploadPreview();
        });
    });

    // Drag & drop reorder
    setupDragReorder(preview);

    applyVideo10sLoop(preview);

    const btn = $('startVariantsBtn');
    if (btn) btn.disabled = uploadFiles.length === 0;
}

// Drag & drop reorder
function setupDragReorder(container) {
    let dragIdx = null;

    container.querySelectorAll('.preview-item').forEach(item => {
        item.addEventListener('dragstart', function(e) {
            dragIdx = parseInt(this.dataset.idx);
            this.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragend', function() {
            this.classList.remove('dragging');
            container.querySelectorAll('.preview-item').forEach(x => x.classList.remove('drag-over'));
        });

        item.addEventListener('dragover', function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            this.classList.add('drag-over');
        });

        item.addEventListener('dragleave', function() {
            this.classList.remove('drag-over');
        });

        item.addEventListener('drop', function(e) {
            e.preventDefault();
            this.classList.remove('drag-over');
            const dropIdx = parseInt(this.dataset.idx);
            if (dragIdx === null || dragIdx === dropIdx) return;

            const moved = uploadFiles.splice(dragIdx, 1)[0];
            uploadFiles.splice(dropIdx, 0, moved);
            dragIdx = null;
            renderUploadPreview();
        });
    });
}

// ============================================================
// VARIANT SETUP
// ============================================================
function startVariantSetup() {
    if (uploadFiles.length === 0) {
        showToast('Please select files first', '⚠️');
        return;
    }

    currentVariantIndex = 0;
    currentBatch = uploadFiles.map(f => ({
        file: f.file,
        isVideo: f.isVideo,
        url: null,
        price: '',
        code: '',
        colorName: '',
        colorValue: ''
    }));

    $('stepMedia').style.display = 'none';
    $('stepVariants').style.display = 'block';

    getSupabaseImageCount().then(count => {
        supabaseInitialCount = count;
    }).catch(() => {});

    renderVariantStep();
}


// Auto-strip NAK- prefix from code input as user types
function attachCodeInputCleaner(inputId) {
    const el = document.getElementById(inputId);
    if (!el || el._cleanerAttached) return;
    el._cleanerAttached = true;
    el.addEventListener('input', function() {
        const cleaned = this.value.replace(/^NAK-/i, '');
        if (cleaned !== this.value) this.value = cleaned;
    });
}

function renderVariantStep() {
    const container = $('variantStepContainer');
    const v = currentBatch[currentVariantIndex];
    const total = currentBatch.length;
    const idx = currentVariantIndex;
    if (!v) return;

    container.innerHTML = `
        <div class="variant-step-container">
            <div class="variant-step-counter">
                <i class="fas ${v.isVideo ? 'fa-video' : 'fa-image'}"></i>
                ${v.isVideo ? 'Video' : 'Image'} — Variant ${idx + 1} of ${total}
            </div>
            ${v.isVideo
                ? `<video src="${URL.createObjectURL(v.file)}" class="variant-preview" muted autoplay loop playsinline data-autoplay-video></video>`
                : `<img src="${URL.createObjectURL(v.file)}" class="variant-preview" alt="" />`
            }

            <div class="variant-inputs">
                <div>
                    <label>Price (₦) <span style="color:#e74c3c;">*</span></label>
                    <input type="number" id="vPrice" placeholder="e.g. 35000" value="${v.price}" />
                </div>
                <div>
                    <label>Product Code <span style="color:#e74c3c;">*</span></label>
                    <input type="text" id="vCode" inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 001" value="${escapeHtml(v.code || '')}" autocomplete="off" spellcheck="false" />
                </div>
                ${!v.isVideo ? `
                    <div>
                        <label>Color <span style="color:#e74c3c;">*</span></label>
                        <div class="color-picker-grid" id="colorPicker">
                            ${COLOR_PALETTE.map(c => `
                                <button type="button" class="color-picker-circle ${v.colorValue === c.value ? 'selected' : ''}"
                                    data-color-name="${c.name}"
                                    data-color-value="${c.value}"
                                    style="background-color: ${c.value};"
                                    title="${c.name}"></button>
                            `).join('')}
                        </div>
                        <div class="selected-color-display" id="selectedColorDisplay">
                            ${v.colorName ? `<span class="selected-color-swatch" style="background-color:${v.colorValue};"></span> Selected: ${v.colorName}` : 'No color selected yet'}
                        </div>
                    </div>
                ` : ''}
            </div>

            <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:8px;">
                ${idx > 0 ? '<button class="btn-outline-gold" id="prevVariantBtn">← Previous</button>' : ''}
                ${idx < total - 1
                    ? '<button class="btn-gold" id="nextVariantBtn">Next →</button>'
                    : '<button class="btn-gold" id="saveBatchBtn"><i class="fas fa-save"></i> Save All</button>'}
            </div>
        </div>
    `;

    attachCodeInputCleaner('vCode');`n`n    const colorPicker = $('colorPicker');
    if (colorPicker) {
        colorPicker.querySelectorAll('.color-picker-circle').forEach(btn => {
            btn.addEventListener('click', function() {
                colorPicker.querySelectorAll('.color-picker-circle').forEach(b => b.classList.remove('selected'));
                this.classList.add('selected');
                v.colorName = this.dataset.colorName;
                v.colorValue = this.dataset.colorValue;
                $('selectedColorDisplay').innerHTML = `<span class="selected-color-swatch" style="background-color:${v.colorValue};"></span> Selected: ${v.colorName}`;
            });
        });
    }

    const prevBtn = $('prevVariantBtn');
    if (prevBtn) prevBtn.addEventListener('click', () => {
        if (!saveCurrentVariant()) return;
        currentVariantIndex--;
        renderVariantStep();
    });
    const nextBtn = $('nextVariantBtn');
    if (nextBtn) nextBtn.addEventListener('click', () => {
        if (!saveCurrentVariant()) return;
        currentVariantIndex++;
        renderVariantStep();
    });
    const saveBtn = $('saveBatchBtn');
    if (saveBtn) saveBtn.addEventListener('click', () => {
        if (!saveCurrentVariant()) return;
        saveBatch();
    });

    applyVideo10sLoop(container);
}

function saveCurrentVariant() {
    const v = currentBatch[currentVariantIndex];
    const price = parseFloat($('vPrice').value);
    const code = $('vCode').value.trim();

    if (!price || price <= 0) { showToast('Please enter a valid price', '⚠️'); return false; }
    if (!code) { showToast('Please enter a product code', '⚠️'); return false; }
    if (!v.isVideo && !v.colorName) { showToast('Please select a color', '⚠️'); return false; }

    v.price = price;
    v.code = normalizeProductCode(code);
    if (v.isVideo && !v.colorName) { v.colorName = 'Default'; v.colorValue = '#D4AF37'; }
    return true;
}

// ============================================================
// IMAGE COMPRESSION — SIZE-AWARE
// ============================================================
async function compressImage(file, maxWidth = 900, quality = 0.72) {
    // Skip compression for small files (< 200KB)
    if (file.size && file.size < 200 * 1024) {
        return file;
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = e => {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let { width, height } = img;
                if (width > maxWidth) { height = (height * maxWidth) / width; width = maxWidth; }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob(blob => {
                    if (!blob) return reject(new Error('Compression failed'));
                    const newFile = new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
                    resolve(newFile);
                }, 'image/jpeg', quality);
            };
            img.onerror = reject;
        };
        reader.onerror = reject;
    });
}

// ============================================================
// SUPABASE BUCKET RESOLUTION
// ============================================================
function supabaseBucketCandidates() {
    const list = [SUPABASE.bucket, ...(SUPABASE.bucketAliases || [])];
    return [...new Set(list.filter(Boolean))];
}

async function probeSupabaseBucket() {
    const probeName = '_nakowa-bucket-probe.jpg';
    for (const candidate of supabaseBucketCandidates()) {
        try {
            const res = await fetch(`${SUPABASE.url}/storage/v1/object/public/${candidate}/${probeName}`, { cache: 'no-store' });
            let body = null;
            try { body = await res.json(); } catch (e) { body = null; }
            const code = body && body.code;
            if (code !== 'NoSuchBucket') {
                supabaseBucket = candidate;
                supabaseAvailable = true;
                console.log('[Supabase] ✅ Bucket resolved:', candidate);
                return true;
            }
        } catch (e) {}
    }
    supabaseAvailable = false;
    warnOnce('supabase-bucket-missing',
        '[Supabase] No bucket found. Images → Cloudinary.');
    return false;
}

function resolveSupabaseBucket() {
    const now = Date.now();
    if (supabaseProbePromise && (now - supabaseProbeCachedAt) < SUPABASE_PROBE_TTL) {
        return supabaseProbePromise;
    }
    supabaseProbeCachedAt = now;
    supabaseProbePromise = probeSupabaseBucket();
    return supabaseProbePromise;
}

// ============================================================
// SUPABASE UPLOAD
// ============================================================
async function uploadToSupabase(file) {
    const bucket = supabaseBucket;
    const filename = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.jpg`;
    const url = `${SUPABASE.url}/storage/v1/object/${bucket}/${filename}`;

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + SUPABASE.key,
            'apikey': SUPABASE.key,
            'Content-Type': file.type || 'image/jpeg',
            'x-upsert': 'false'
        },
        body: file
    });

    if (!res.ok) {
        const errText = await res.text();
        let hint = '';
        if (res.status === 400 && /NoSuchBucket/.test(errText)) hint = ' — Bucket "' + bucket + '" not found.';
        else if (res.status === 403) hint = ' — RLS policy missing.';
        logOnce('supabase-upload-' + res.status + '-' + bucket,
            '[Supabase] ❌ Upload FAILED (' + res.status + '): ' + errText + hint);
        throw new Error(`Supabase upload failed (${res.status}): ${errText}`);
    }

    return `${SUPABASE.url}/storage/v1/object/public/${bucket}/${filename}`;
}

// ============================================================
// CLOUDINARY UPLOAD
// ============================================================
async function uploadToCloudinary(file, isVideo = false) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY.uploadPreset);
    formData.append('folder', CLOUDINARY.folder);

    const endpoint = isVideo ? CLOUDINARY.videoUrl : CLOUDINARY.imageUrl;
    const res = await fetch(endpoint, { method: 'POST', body: formData });
    const data = await res.json();

    if (data.error) {
        const raw = Array.isArray(data.error) ? data.error[0] : data.error;
        const msg = (raw && raw.message) || 'Cloudinary error';
        if (/unknown api key/i.test(msg)) {
            throw new Error('Cloudinary rejected cloud name. Check Dashboard.');
        }
        if (/whitelisted|preset not found/i.test(msg)) {
            throw new Error('Cloudinary preset "' + CLOUDINARY.uploadPreset + '" must be Unsigned.');
        }
        throw new Error('Cloudinary: ' + msg);
    }
    if (!data.secure_url) throw new Error('Cloudinary: no URL returned');
    return data.secure_url;
}

// ============================================================
// SUPABASE STATS (count + size)
// ============================================================
let supabaseStatsCache = { count: 0, sizeMB: 0, at: 0 };

async function getSupabaseStats() {
    if (!await resolveSupabaseBucket()) return { count: 0, sizeMB: 0 };
    if (Date.now() - supabaseStatsCache.at < 60000) return supabaseStatsCache;

    try {
        const res = await fetch(`${SUPABASE.url}/storage/v1/object/list/${supabaseBucket}`, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + SUPABASE.key,
                'apikey': SUPABASE.key,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ limit: 1000, offset: 0 })
        });
        if (!res.ok) return { count: 0, sizeMB: 0 };
        const files = await res.json();
        let totalSize = 0;
        (files || []).forEach(f => {
            if (f.metadata && f.metadata.size) totalSize += f.metadata.size;
        });
        supabaseStatsCache = { count: files.length || 0, sizeMB: totalSize / (1024 * 1024), at: Date.now() };
        return supabaseStatsCache;
    } catch (e) {
        return { count: 0, sizeMB: 0 };
    }
}

async function getSupabaseImageCount() {
    const stats = await getSupabaseStats();
    return stats.count;
}

// ============================================================
// UPLOAD ONE
// ============================================================
async function uploadOne(file, isVideo, indexInBatch) {
    if (isVideo) return await uploadToCloudinary(file, true);

    const stats = await getSupabaseStats();
    const counterFull = (stats.count + indexInBatch) >= SUPABASE.maxImages;
    const sizeFull = stats.sizeMB >= SUPABASE.maxSizeMB;
    const useSupabase = !counterFull && !sizeFull && await resolveSupabaseBucket();

    const isLargeBatch = currentBatch.length > 20;
    const maxW = isLargeBatch ? 1000 : 1200;
    const quality = isLargeBatch ? 0.7 : 0.8;

    if (useSupabase) {
        try {
            const compressed = await compressImage(file, maxW, quality);
            const url = await uploadToSupabase(compressed);
            supabaseStatsCache.at = 0;
            return url;
        } catch (e) {
            supabaseAvailable = false;
            warnOnce('supabase-upload-fallback',
                '[Supabase] Upload unavailable — using Cloudinary.');
            const compressed = await compressImage(file, maxW, quality);
            return await uploadToCloudinary(compressed, false);
        }
    }
    const compressed = await compressImage(file, maxW, quality);
    return await uploadToCloudinary(compressed, false);
}

// ============================================================
// CONCURRENCY-LIMITED UPLOAD POOL
// ============================================================
async function uploadWithRetry(fn, maxRetries) {
    maxRetries = maxRetries || 2;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            }
        }
    }
    throw lastErr;
}
async function uploadWithConcurrencyLimit(items, uploadFn, concurrency = 6, onProgress) {
    const results = new Array(items.length);
    let nextIndex = 0;
    let completed = 0;

    async function worker() {
        while (nextIndex < items.length) {
            const i = nextIndex++;
            try {
                results[i] = { status: 'fulfilled', value: await uploadFn(items[i], i) };
            } catch (err) {
                results[i] = { status: 'rejected', reason: err };
            }
            completed++;
            if (onProgress) onProgress(completed, items.length);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
    await Promise.all(workers);
    return results;
}

function updateSaveProgress(completed, total) {
    const saveBtn = $('saveBatchBtn');
    if (!saveBtn) return;
    const pct = Math.round((completed / total) * 100);
    saveBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Uploading ${completed}/${total} (${pct}%)`;
}

// ============================================================
// SAVE BATCH — FAST + CONCURRENCY LIMITED
// ============================================================
async function saveBatch() {
    if (!currentBatch.length) { showToast('No files selected', '⚠️'); return; }
    const saveBtn = $('saveBatchBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }

    try {
        const firstCode = (currentBatch[0] && currentBatch[0].code) || '000';
        const productId = generateId('P');

        // Build variants with LOCAL blob URLs (instant display)
        const imageVariants = currentBatch.filter(v => !v.isVideo).map(v => ({
            image: URL.createObjectURL(v.file),
            colorName: v.colorName,
            colorValue: v.colorValue,
            price: v.price,
            code: (v.code || '').toString().trim(),
            _pending: true
        }));

        const videoItems = currentBatch.filter(v => v.isVideo).map(v => ({
            blobUrl: URL.createObjectURL(v.file),
            _pending: true
        }));

        const product = {
            id: productId,
            name: 'NAKOWA ABAYA',
            code: firstCode,
            country: 'Egypt',
            sizes: ['S', 'M', 'L', 'XL', 'XXL'],
            variants: imageVariants,
            images: imageVariants.map(v => v.image),
            videos: videoItems.map(v => v.blobUrl),
            stock: 10,
            status: 'active',
            createdAt: new Date().toISOString().split('T')[0],
            _pending: true
        };

        // Save to admin cache
        if (!cachedProducts) cachedProducts = [];
        cachedProducts.push(product);

        // Save to public cache (instant display on public website)
        try {
            const pub = JSON.parse(localStorage.getItem('nakowa_pending_products') || '[]');
            pub.push(product);
            localStorage.setItem('nakowa_pending_products', JSON.stringify(pub));
        } catch (e) {}

        // ⭐ Show "done" IMMEDIATELY
        showToast('Saved! Uploading in background...', '✅');
        loadSection('products');

        // Start background upload — user doesn't wait
        runBackgroundUpload(productId, currentBatch.slice());
    } catch (err) {
        logOnce('batch-fatal-' + err.message, '[Batch] Failed: ' + err.message);
        showToast('Save failed: ' + err.message.substring(0, 140), '❌');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> Save All'; }
    }
}

async function runBackgroundUpload(productId, batch) {
    try {
        await resolveSupabaseBucket();
        if (!supabaseInitialCount) supabaseInitialCount = await getSupabaseImageCount();

        const settled = await uploadWithConcurrencyLimit(
            batch,
            async (v, i) => {
                const url = await uploadWithRetry(() => uploadOne(v.file, v.isVideo, i), 2);
                return Object.assign({}, v, { url: url });
            },
            6,
            (completed, total) => {
                console.log('[BG Upload] ' + completed + '/' + total);
            }
        );

        const uploaded = settled.filter(r => r.status === 'fulfilled').map(r => r.value);

        // Update product with real URLs
        const idx = cachedProducts.findIndex(p => p.id === productId);
        if (idx < 0) return;

        const imageVariants = uploaded.filter(u => !u.isVideo);
        const videoUrls = uploaded.filter(u => u.isVideo).map(u => u.url).filter(Boolean);

        cachedProducts[idx].variants = imageVariants.map(v => ({
            image: v.url,
            colorName: v.colorName,
            colorValue: v.colorValue,
            price: v.price,
            code: (v.code || '').toString().trim()
        }));
        cachedProducts[idx].images = imageVariants.map(v => v.url);
        cachedProducts[idx].videos = videoUrls;
        delete cachedProducts[idx]._pending;

        // Update pending list — remove if all done
        try {
            const pub = JSON.parse(localStorage.getItem('nakowa_pending_products') || '[]');
            const pIdx = pub.findIndex(p => p.id === productId);
            if (pIdx >= 0) {
                if (uploaded.length === batch.length) {
                    // All uploaded — remove from pending (backend will now handle it)
                    pub.splice(pIdx, 1);
                } else {
                    pub[pIdx] = cachedProducts[idx];
                }
                localStorage.setItem('nakowa_pending_products', JSON.stringify(pub));
            }
        } catch (e) {}

        // Save to backend
        const res = await apiPost('saveProductsBatch', {
            token: authToken,
            products: [cachedProducts[idx]]
        });

        if (res.success) {
            showToast('Background upload complete!', '✅');
            try {
                const pub = JSON.parse(localStorage.getItem('nakowa_pending_products') || '[]');
                const pIdx = pub.findIndex(p => p.id === productId);
                if (pIdx >= 0) {
                    pub.splice(pIdx, 1);
                    localStorage.setItem('nakowa_pending_products', JSON.stringify(pub));
                }
            } catch (e) {}
            const products = await apiGet('products');
            if (products) cachedProducts = products;
        }
    } catch (err) {
        console.error('[BG Upload] Failed:', err);
        showToast('Background upload failed — retry later', '⚠️');
    }
}

// ============================================================
// EDIT PRODUCT
// ============================================================
async function editProduct(id) {
    const p = cachedProducts.find(x => String(x.id) === String(id));
    if (!p) { showToast('Product not found', '❌'); return; }

    const variants = (p.variants && Array.isArray(p.variants)) ? p.variants : [];
    const sizes = Array.isArray(p.sizes) ? p.sizes.join(', ') : (p.sizes || '');

    const container = $('productsContainer');
    container.innerHTML = `
        <div class="admin-card">
            <div class="card-title">
                <span><i class="fas fa-edit"></i> Edit: ${escapeHtml(p.name)}</span>
                <button class="btn-outline-gold" id="cancelEditBtn">Cancel</button>
            </div>
            <form class="admin-form" id="editForm">
                <div class="form-group">
                    <label>Product Name <span class="required">*</span></label>
                    <input type="text" id="editName" value="${escapeHtml(p.name)}" required />
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Code <span class="required">*</span></label>
                        <input type="text" id="editCode" value="${escapeHtml(p.code || '')}" required />
                    </div>
                    <div class="form-group">
                        <label>Sizes (comma-separated)</label>
                        <input type="text" id="editSizes" value="${escapeHtml(sizes)}" />
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Stock</label>
                        <input type="number" id="editStock" value="${parseInt(p.stock || 0)}" min="0" />
                    </div>
                    <div class="form-group">
                        <label>Status</label>
                        <select id="editStatus">
                            <option value="active" ${p.status === 'active' ? 'selected' : ''}>Active</option>
                            <option value="inactive" ${p.status === 'inactive' ? 'selected' : ''}>Inactive</option>
                        </select>
                    </div>
                </div>

                <div class="card-title" style="font-size:1rem;margin-top:12px;">
                    <span>Variants (${variants.length})</span>
                </div>
                <div id="editVariantsList">
                    ${variants.map((v, i) => `
                        <div style="display:flex;gap:10px;align-items:center;padding:10px;background:rgba(255,255,255,0.03);border-radius:10px;margin-bottom:8px;border:1px solid var(--border-gold);">
                            <img src="${v.image}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid var(--border-gold);" onerror="imgFallback(this)" />
                            <div style="flex:1;">
                                <div style="color:var(--gold);font-weight:600;font-size:0.85rem;">
                                    <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${v.colorValue};vertical-align:middle;margin-right:6px;border:1px solid #fff;"></span>
                                    ${escapeHtml(v.colorName)}
                                </div>
                                <div style="font-size:0.75rem;color:rgba(255,255,255,0.6);">Code: ${escapeHtml(v.code)}</div>
                            </div>
                            <div style="display:flex;flex-direction:column;gap:4px;">
                                <input type="number" class="edit-v-price" data-idx="${i}" value="${v.price}" placeholder="Price" style="width:100px;padding:6px 8px;border-radius:6px;border:1px solid var(--border-gold);background:rgba(255,255,255,0.06);color:#fff;font-size:0.8rem;" />
                                <input type="text" class="edit-v-code" data-idx="${i}" value="${escapeHtml(v.code)}" placeholder="Code" style="width:100px;padding:6px 8px;border-radius:6px;border:1px solid var(--border-gold);background:rgba(255,255,255,0.06);color:#fff;font-size:0.8rem;" />
                            </div>
                        </div>
                    `).join('')}
                </div>

                <div class="form-actions">
                    <button type="submit" class="btn-gold"><i class="fas fa-save"></i> Save Changes</button>
                </div>
            </form>
        </div>
    `;

    attachCodeInputCleaner('editCode');`n    document.querySelectorAll('.edit-v-code').forEach(el => { if (!el._cleanerAttached) { el._cleanerAttached = true; el.addEventListener('input', function() { const c = this.value.replace(/^NAK-/i, '' ); if (c !== this.value) this.value = c; }); } });`n`n    $('cancelEditBtn').addEventListener('click', () => renderProductList('all'));

    $('editForm').addEventListener('submit', async e => {
        e.preventDefault();
        const newName = $('editName').value.trim();
        const newCode = $('editCode').value.trim();
        const newSizesStr = $('editSizes').value.trim();
        const newStock = parseInt($('editStock').value) || 0;
        const newStatus = $('editStatus').value;

        if (!newName || !newCode) { showToast('Name and Code are required', '⚠️'); return; }

        const newVariants = variants.map((v, i) => {
            const priceEl = document.querySelector(`.edit-v-price[data-idx="${i}"]`);
            const codeEl = document.querySelector(`.edit-v-code[data-idx="${i}"]`);
            return { ...v, price: parseFloat(priceEl.value) || v.price, code: normalizeProductCode(codeEl.value.trim()) || v.code };
        });

        const updated = {
            ...p,
            name: newName,
            code: normalizeProductCode(newCode),
            sizes: newSizesStr.split(',').map(s => s.trim()).filter(Boolean),
            stock: newStock,
            status: newStatus,
            variants: newVariants
        };

        try {
            const res = await apiPost('updateProduct', { token: authToken, product: updated });
            if (res.success) {
                const idx = cachedProducts.findIndex(x => String(x.id) === String(p.id));
                if (idx >= 0) cachedProducts[idx] = updated;
                showToast('Product updated!', '✅');
                renderProductList('all');
            } else {
                showToast(res.message || 'Failed to update', '❌');
            }
        } catch (err) {
            showToast('Error: ' + err.message, '❌');
        }
    });
}

// ============================================================
// DELETE PRODUCT
// ============================================================
async function deleteProduct(id) {
    showConfirm('Delete this product?', 'This action cannot be undone.', async () => {
        try {
            const res = await apiPost('deleteProduct', { token: authToken, id });
            if (res.success) {
                cachedProducts = cachedProducts.filter(p => String(p.id) !== String(id));
                showToast('Product deleted', '🗑️');
                renderProductList('all');
            } else {
                showToast(res.message || 'Failed', '❌');
            }
        } catch (err) {
            showToast('Error: ' + err.message, '❌');
        }
    });
}

// ============================================================
// ORDERS — WITH WHATSAPP STATUS NOTIFICATION
// ============================================================
async function renderOrders() {
    $('pageTitle').textContent = 'Orders';
    currentSection = 'orders';
    const myToken = viewToken;

    if (cachedOrders === null) cachedOrders = [];
    drawOrdersSection();

    try {
        const orders = await apiGet('orders');
        if (!isViewCurrent(myToken)) return;
        cachedOrders = (orders || []).reverse();
        if (currentSection === 'orders') drawOrdersSection();
    } catch (e) {}
}

function drawOrdersSection() {
    const area = $('contentArea');

    if (cachedOrders.length === 0) {
        area.innerHTML = `<div class="empty-state-admin"><i class="fas fa-shopping-bag"></i><h4>No orders yet</h4><p>Orders will appear here after customers place them.</p></div>`;
        return;
    }

    area.innerHTML = `
        <div class="admin-card">
            <div class="card-title"><span><i class="fas fa-shopping-bag"></i> All Orders (${cachedOrders.length})</span></div>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">
                <input type="text" id="orderSearch" placeholder="Search by ID, name, phone..." style="flex:1;min-width:200px;padding:10px 14px;border-radius:30px;border:1px solid var(--border-gold);background:rgba(255,255,255,0.06);color:#fff;font-size:16px;" />
                <select id="orderStatusFilter" style="padding:10px 14px;border-radius:30px;border:1px solid var(--border-gold);background:rgba(255,255,255,0.06);color:#fff;font-size:16px;">
                    <option value="all">All Statuses</option>
                    <option value="pending">Pending</option>
                    <option value="confirmed">Confirmed</option>
                    <option value="processing">Processing</option>
                    <option value="completed">Completed</option>
                    <option value="cancelled">Cancelled</option>
                </select>
            </div>
            <div class="orders-table-wrap">
                <table class="orders-table">
                    <thead>
                        <tr>
                            <th>Image</th><th>Order ID</th><th>Customer</th><th>Product</th>
                            <th>Color / Size</th><th>Qty</th><th>Total</th><th>Status</th><th>Receipt</th>
                        </tr>
                    </thead>
                    <tbody id="ordersTableBody"></tbody>
                </table>
            </div>
        </div>
    `;

    renderOrdersTable(cachedOrders);
    $('orderSearch').addEventListener('input', filterOrders);
    $('orderStatusFilter').addEventListener('change', filterOrders);
}

function filterOrders() {
    const q = $('orderSearch').value.trim().toLowerCase();
    const status = $('orderStatusFilter').value;
    let filtered = cachedOrders;
    if (q) filtered = filtered.filter(o =>
        String(o.orderId || '').toLowerCase().includes(q) ||
        String(o.customerName || '').toLowerCase().includes(q) ||
        String(o.customerPhone || '').toLowerCase().includes(q)
    );
    if (status !== 'all') filtered = filtered.filter(o => o.status === status);
    renderOrdersTable(filtered);
}

function renderOrdersTable(orders) {
    const tbody = $('ordersTableBody');
    if (!tbody) return;

    if (orders.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:rgba(255,255,255,0.4);">No matching orders</td></tr>`;
        return;
    }

    tbody.innerHTML = orders.map(o => `
        <tr>
            <td><img src="${o.productImage || DEFAULT_IMG}" alt="" onerror="imgFallback(this)" /></td>
            <td><strong style="color:var(--gold);">${escapeHtml(o.orderId)}</strong><br><span style="font-size:0.7rem;opacity:0.6;">${escapeHtml(o.date)} ${escapeHtml(o.time || '')}</span></td>
            <td>${escapeHtml(o.customerName)}<br><span style="font-size:0.75rem;opacity:0.6;">${escapeHtml(o.customerPhone)}</span></td>
            <td>${escapeHtml(o.productName)}<br><span style="font-size:0.75rem;opacity:0.6;">Code: ${escapeHtml(o.productCode)}</span></td>
            <td>${escapeHtml(o.colorName)} / ${escapeHtml(o.size)}</td>
            <td>${o.quantity}</td>
            <td><strong>${formatMoney(o.total)}</strong></td>
            <td>
                <select class="status-select" data-order-id="${escapeHtml(o.orderId)}" data-phone="${escapeHtml(o.customerPhone || '')}">
                    ${['pending', 'confirmed', 'processing', 'completed', 'cancelled'].map(s =>
                        `<option value="${s}" ${o.status === s ? 'selected' : ''}>${s}</option>`
                    ).join('')}
                </select>
            </td>
            <td><button class="btn-outline-gold receipt-btn" data-order-id="${escapeHtml(o.orderId)}" style="padding:6px 10px;font-size:0.7rem;"><i class="fas fa-receipt"></i></button></td>
        </tr>
    `).join('');

    tbody.querySelectorAll('.status-select').forEach(sel => {
        sel.addEventListener('change', async function() {
            const orderId = this.dataset.orderId;
            const customerPhone = this.dataset.phone;
            const newStatus = this.value;
            try {
                const res = await apiPost('updateOrderStatus', { token: authToken, orderId, status: newStatus });
                if (res.success) {
                    const idx = cachedOrders.findIndex(o => o.orderId === orderId);
                    if (idx >= 0) cachedOrders[idx].status = newStatus;

                    // Open WhatsApp to notify customer
                    if (customerPhone) {
                        const cleanPhone = customerPhone.replace(/\D/g, '');
                        if (cleanPhone) {
                            const msg = `🛍️ *NAKOWA ABAYAS COLLECTIONS*\n\nYour order ${orderId} status is now: *${newStatus.toUpperCase()}*\n\nThank you for shopping with us!`;
                            const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`;
                            window.open(waUrl, '_blank');
                            showToast('Status updated — WhatsApp opened to notify customer', '✅');
                        } else {
                            showToast('Status updated', '✅');
                        }
                    } else {
                        showToast('Status updated', '✅');
                    }
                } else {
                    showToast(res.message || 'Failed', '❌');
                }
            } catch (err) { showToast('Error: ' + err.message, '❌'); }
        });
    });

    tbody.querySelectorAll('.receipt-btn').forEach(btn => {
        btn.addEventListener('click', () => generateReceipt(btn.dataset.orderId));
    });
}

// ============================================================
// PDF RECEIPT
// ============================================================
async function generateReceipt(orderId) {
    const o = cachedOrders.find(x => x.orderId === orderId);
    if (!o) { showToast('Order not found', '❌'); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [80, 200] });
    const W = 80, margin = 5, contentW = W - margin * 2;

    doc.setFillColor(0, 0, 0);
    doc.rect(0, 0, W, 22, 'F');
    doc.setTextColor(249, 229, 8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text('NAKOWA ABAYAS', W / 2, 10, { align: 'center' });
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(255, 255, 255);
    doc.text("COLLECTIONS", W / 2, 15, { align: 'center' });
    doc.setFontSize(6);
    doc.text('Order Receipt', W / 2, 19, { align: 'center' });

    doc.setTextColor(0, 0, 0);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    let y = 30;
    doc.text('Order ID:', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    const idParts = formatOrderIdDisplay(o.orderId, o.productCode);
    doc.text(idParts.code || '', margin, y + 4);
    if (idParts.date) doc.text(idParts.date, margin, y + 8);
    y += 14;

    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.2);
    doc.line(margin, y, W - margin, y);
    y += 5;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.text('Customer', margin, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.text(o.customerName || '-', margin, y); y += 4;
    doc.text(o.customerPhone || '-', margin, y); y += 4;
    const addrLines = doc.splitTextToSize(o.customerAddress || '-', contentW);
    doc.text(addrLines, margin, y);
    y += addrLines.length * 4 + 3;

    doc.line(margin, y, W - margin, y);
    y += 5;

    doc.setFont('helvetica', 'bold');
    doc.text('Product', margin, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.text(o.productName || '-', margin, y); y += 4;
    doc.text('Code: ' + (o.productCode || '-'), margin, y); y += 4;
    doc.text('Color: ' + (o.colorName || '-'), margin, y); y += 4;
    doc.text('Size: ' + (o.size || '-'), margin, y); y += 4;
    doc.text('Qty: ' + (o.quantity || 1), margin, y); y += 4;
    doc.text('Price: ' + formatMoney(o.price), margin, y); y += 5;

    doc.line(margin, y, W - margin, y);
    y += 5;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('TOTAL', margin, y);
    doc.text(formatMoney(o.total), W - margin, y, { align: 'right' });
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.text('Date: ' + (o.date || '-') + ' ' + (o.time || ''), margin, y); y += 4;
    doc.text('Status: ' + (o.status || 'pending').toUpperCase(), margin, y); y += 8;

    doc.setDrawColor(212, 175, 55);
    doc.setLineWidth(1.2);
    doc.line(margin, y, W - margin, y);
    y += 6;

    doc.setFontSize(6);
    doc.setTextColor(120, 120, 120);
    doc.text('Thank you for shopping with us!', W / 2, y, { align: 'center' });
    y += 3;
    doc.text('nakowaabayas.com', W / 2, y, { align: 'center' });

    doc.save('receipt-' + o.orderId + '.pdf');
    showToast('Receipt downloaded', '🧾');
}

// ============================================================
// CUSTOMERS
// ============================================================
async function renderCustomers() {
    $('pageTitle').textContent = 'Customers';
    currentSection = 'customers';
    const myToken = viewToken;

    if (cachedCustomers === null) cachedCustomers = [];
    drawCustomersSection();

    try {
        const customers = await apiGet('customers');
        if (!isViewCurrent(myToken)) return;
        cachedCustomers = customers || [];
        if (currentSection === 'customers') drawCustomersSection();
    } catch (e) {}
}

function drawCustomersSection() {
    const area = $('contentArea');
    if (cachedCustomers.length === 0) {
        area.innerHTML = `<div class="empty-state-admin"><i class="fas fa-users"></i><h4>No customers yet</h4></div>`;
        return;
    }
    area.innerHTML = `
        <div class="admin-card">
            <div class="card-title"><span><i class="fas fa-users"></i> All Customers (${cachedCustomers.length})</span></div>
            <div class="data-table-wrap">
                <table class="data-table">
                    <thead><tr><th>Phone</th><th>Name</th><th>Orders</th><th>Spent</th><th>Last Order</th></tr></thead>
                    <tbody>
                        ${cachedCustomers.map(c => `
                            <tr>
                                <td><strong>${escapeHtml(c.phone)}</strong></td>
                                <td>${escapeHtml(c.name || '-')}</td>
                                <td>${c.totalOrders || 0}</td>
                                <td style="color:var(--gold);font-weight:700;">${formatMoney(c.totalSpent)}</td>
                                <td>${escapeHtml(c.lastOrderDate || '-')}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

// ============================================================
// SETTINGS
// ============================================================
async function renderSettings() {
    $('pageTitle').textContent = 'Settings';
    currentSection = 'settings';
    const myToken = viewToken;

    if (cachedSettings === null) cachedSettings = {};
    drawSettingsSection();

    try {
        const settings = await apiGet('settings');
        if (!isViewCurrent(myToken)) return;
        cachedSettings = settings || {};
        if (currentSection === 'settings') drawSettingsSection();
    } catch (e) {}
}

function drawSettingsSection() {
    const s = cachedSettings || {};
    $('contentArea').innerHTML = `
        <div class="admin-card">
            <div class="card-title"><span><i class="fas fa-cog"></i> Website Settings</span></div>
            <form class="admin-form" id="settingsForm">
                <div class="form-group"><label>WhatsApp Number</label><input type="text" id="setWhatsapp" value="${escapeHtml(s.whatsapp || '')}" placeholder="+20 150 076 6295" /></div>
                <div class="form-group"><label>Email</label><input type="email" id="setEmail" value="${escapeHtml(s.email || '')}" placeholder="info@nakowaabayas.com" /></div>
                <div class="form-group"><label>Address</label><input type="text" id="setAddress" value="${escapeHtml(s.address || '')}" placeholder="Cairo, Egypt" /></div>
                <div class="form-group"><label>Low Stock Threshold</label><input type="number" id="setThreshold" value="${s.lowStockThreshold || 3}" min="1" /></div>
                <div class="form-group"><label>Hero Image URL</label><input type="text" id="setHero" value="${escapeHtml(s.hero || '')}" placeholder="https://..." /></div>
                <div class="form-group"><label>Logo URL</label><input type="text" id="setLogo" value="${escapeHtml(s.logo || '')}" placeholder="https://..." /></div>
                <div class="form-actions"><button type="submit" class="btn-gold"><i class="fas fa-save"></i> Save Settings</button></div>
            </form>
        </div>
    `;

    $('settingsForm').addEventListener('submit', async e => {
        e.preventDefault();
        const newSettings = {
            whatsapp: $('setWhatsapp').value.trim(),
            email: $('setEmail').value.trim(),
            address: $('setAddress').value.trim(),
            lowStockThreshold: parseInt($('setThreshold').value) || 3,
            hero: $('setHero').value.trim(),
            logo: $('setLogo').value.trim()
        };
        try {
            const res = await apiPost('updateSettings', { token: authToken, settings: newSettings });
            if (res.success) {
                cachedSettings = { ...cachedSettings, ...newSettings };
                showToast('Settings saved!', '✅');
            } else showToast(res.message || 'Failed', '❌');
        } catch (err) { showToast('Error: ' + err.message, '❌'); }
    });
}

// ============================================================
// USERS
// ============================================================
async function renderUsers() {
    $('pageTitle').textContent = 'Users';
    currentSection = 'users';
    const myToken = viewToken;

    if (cachedUsers === null) cachedUsers = [];
    drawUsersSection();

    try {
        const users = await apiGet('users');
        if (!isViewCurrent(myToken)) return;
        cachedUsers = users || [];
        if (currentSection === 'users') drawUsersSection();
    } catch (e) {}
}

function drawUsersSection() {
    const users = cachedUsers || [];
    $('contentArea').innerHTML = `
        <div class="admin-card">
            <div class="card-title"><span><i class="fas fa-user-shield"></i> Admin Users (${users.length})</span></div>
            <div class="data-table-wrap">
                <table class="data-table">
                    <thead><tr><th>Username</th><th>Role</th><th>Created</th><th>Last Login</th><th></th></tr></thead>
                    <tbody>
                        ${users.map(u => `
                            <tr>
                                <td><strong>${escapeHtml(u.username)}</strong></td>
                                <td>${escapeHtml(u.role || '')}</td>
                                <td>${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}</td>
                                <td>${u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never'}</td>
                                <td>${u.username !== 'umar' ? `<button class="delete-btn" data-user="${escapeHtml(u.username)}" style="padding:5px 10px;border-radius:20px;background:#e74c3c;color:#fff;border:none;cursor:pointer;font-size:0.7rem;">Delete</button>` : '<span style="opacity:0.4;font-size:0.7rem;">Default</span>'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
        <div class="admin-card">
            <div class="card-title"><span><i class="fas fa-plus"></i> Add New User</span></div>
            <form class="admin-form" id="addUserForm">
                <div class="form-row">
                    <div class="form-group"><label>Username <span class="required">*</span></label><input type="text" id="newUsername" required /></div>
                    <div class="form-group"><label>Password <span class="required">*</span></label><input type="text" id="newPassword" required /></div>
                </div>
                <div class="form-group">
                    <label>Role</label>
                    <select id="newRole"><option value="admin">Admin</option><option value="staff">Staff</option></select>
                </div>
                <div class="form-actions"><button type="submit" class="btn-gold"><i class="fas fa-plus"></i> Add User</button></div>
            </form>
        </div>
    `;

    document.querySelectorAll('[data-user]').forEach(btn => {
        btn.addEventListener('click', () => {
            const username = btn.dataset.user;
            showConfirm('Delete user?', `Delete "${username}"?`, async () => {
                try {
                    const res = await apiPost('deleteUser', { token: authToken, username });
                    if (res.success) {
                        cachedUsers = cachedUsers.filter(u => u.username !== username);
                        showToast('User deleted', '🗑️');
                        if (currentSection === 'users') drawUsersSection();
                    } else showToast(res.message || 'Failed', '❌');
                } catch (err) { showToast('Error: ' + err.message, '❌'); }
            });
        });
    });

    $('addUserForm').addEventListener('submit', async e => {
        e.preventDefault();
        const user = {
            username: $('newUsername').value.trim(),
            password: $('newPassword').value,
            role: $('newRole').value
        };
        if (!user.username || !user.password) return;
        try {
            const res = await apiPost('addUser', { token: authToken, user });
            if (res.success) {
                showToast('User added', '✅');
                const fresh = await apiGet('users');
                cachedUsers = fresh || cachedUsers;
                if (currentSection === 'users') drawUsersSection();
            } else showToast(res.message || 'Failed', '❌');
        } catch (err) { showToast('Error: ' + err.message, '❌'); }
    });
}

// ============================================================
// CHANGE PASSWORD
// ============================================================
function renderChangePassword() {
    $('pageTitle').textContent = 'Change Password';
    currentSection = 'changepassword';
    $('contentArea').innerHTML = `
        <div class="admin-card">
            <div class="card-title"><span><i class="fas fa-key"></i> Change Admin Password</span></div>
            <form class="admin-form" id="changePasswordForm">
                <div class="form-group"><label>Current Password <span class="required">*</span></label><input type="password" id="cpOld" required /></div>
                <div class="form-group"><label>New Password <span class="required">*</span></label><input type="password" id="cpNew" required minlength="4" /></div>
                <div class="form-group"><label>Confirm New Password <span class="required">*</span></label><input type="password" id="cpConfirm" required minlength="4" /></div>
                <div class="form-actions"><button type="submit" class="btn-gold"><i class="fas fa-key"></i> Change Password</button></div>
            </form>
        </div>
    `;

    $('changePasswordForm').addEventListener('submit', async e => {
        e.preventDefault();
        const oldPassword = $('cpOld').value;
        const newPassword = $('cpNew').value;
        const confirm = $('cpConfirm').value;

        if (newPassword !== confirm) { showToast('Passwords do not match', '⚠️'); return; }
        if (newPassword.length < 4) { showToast('Password must be at least 4 characters', '⚠️'); return; }

        try {
            const res = await apiPost('changePassword', { token: authToken, oldPassword, newPassword });
            if (res.success) {
                showToast('Password changed! Logging out...', '✅');
                setTimeout(doLogout, 1500);
            } else showToast(res.message || 'Failed', '❌');
        } catch (err) { showToast('Error: ' + err.message, '❌'); }
    });
}

// ============================================================
// HELPERS
// ============================================================
function showConfirm(title, message, onOk) {
    const modal = $('confirmModal');
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    modal.classList.add('open');

    const ok = $('confirmOk');
    const cancel = $('confirmCancel');

    const cleanup = () => {
        modal.classList.remove('open');
        ok.removeEventListener('click', handleOk);
        cancel.removeEventListener('click', cleanup);
    };
    const handleOk = async () => { cleanup(); await onOk(); };

    ok.addEventListener('click', handleOk);
    cancel.addEventListener('click', cleanup);
}

function formatOrderIdDisplay(orderId, adminCode) {
    if (!orderId) return { code: '', date: '', serial: null };
    if (adminCode && orderId.startsWith(adminCode + '-')) {
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
        v.addEventListener('loadeddata', () => {
            v.play().catch(() => {});
        });
        v.play().catch(() => {});
    });
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    const token = checkAuth();
    if (token) {
        authToken = token;
        currentAdmin = localStorage.getItem('nakowa_admin_user') || '';
        $('loginScreen').style.display = 'none';
        $('dashboard').style.display = 'flex';
        warmCache().then(() => {
            loadSection('dashboard');
        });
    }

    $('loginBtn').addEventListener('click', doLogin);
    $('loginPassword').addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); });
    $('loginUsername').addEventListener('keypress', e => { if (e.key === 'Enter') $('loginPassword').focus(); });

    document.querySelectorAll('.sidebar li[data-section]').forEach(li => {
        li.addEventListener('click', () => loadSection(li.dataset.section));
    });

    $('logoutBtn').addEventListener('click', () => {
        showConfirm('Logout?', 'Are you sure you want to logout?', doLogout);
    });

    $('hamburgerAdmin').addEventListener('click', () => $('sidebar').classList.add('open'));
    $('sidebarClose').addEventListener('click', () => $('sidebar').classList.remove('open'));

    $('closeImageViewer').addEventListener('click', () => $('imageViewer').classList.remove('open'));
    $('imageViewer').addEventListener('click', e => { if (e.target === $('imageViewer')) $('imageViewer').classList.remove('open'); });

    $('confirmModal').addEventListener('click', e => { if (e.target === $('confirmModal')) $('confirmModal').classList.remove('open'); });
});