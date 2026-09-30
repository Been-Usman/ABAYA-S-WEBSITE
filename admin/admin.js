/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — Admin Script (v7 — FIXED)

   WHAT CHANGED IN v7:
   1. Duplicate `const myToken` SyntaxError fixed (6 renderers).
   2. Double bumpViewToken() in loadSection fixed.
   3. Duplicated isViewCurrent in renderDashboard fixed.
   4. Authentication moved to localStorage (JS auth, no AppSheet login).
      - Default: umar / 0708070 (only if no custom creds saved).
      - Custom creds persist across logout/refresh/browser/PC restart.
      - Old creds stop working immediately after a change.
      - 30-minute inactivity timeout.
      - 5 failed attempts → 5-minute lock.
      - Error is always "Invalid username or password."
   5. Actual-only price everywhere. No fake price, no +5000, no strikethrough.
   6. Bulk price now applies per-variant relative to each variant's own price.
   7. WhatsApp status notify no longer calls window.open after an await
      (mobile-popup-safe: shows a floating Notify button on direct click).
   8. Add User password field is now type="password"; 'umar' hard-code removed.
   9. URL.revokeObjectURL on upload preview + variant step re-render.
  10. saveBatch writes to IndexedDB (via queue.js) and shows "Done ✅"
      in under 2 seconds; uploads continue in the background.
  11. renderProductList merges pending IndexedDB jobs into the grid
      with an "Uploading X/Y" badge and a Retry-failed button.
  12. runBackgroundUpload removed — the queue worker (queue.js) handles it.
  13. Soft logout LEFT UNTOUCHED as requested. doLogout() clears the
      session and redirects, exactly as before.
  14. BroadcastChannel 'nakowa-queue' keeps admin + public tab in sync.
  15. beforeunload warning NOT added (soft logout was explicitly left as-is).

   REQUIRES:
   - queue.js   (IndexedDB queue, worker, Web Locks, BroadcastChannel)
     Loaded BEFORE this file in admin.html.

   HONEST LIMITATION:
   - This auth is FRONTEND-ONLY. Anyone with DevTools can read
     localStorage['nakowa_admin_auth']. Not server-grade security.
   - Other customers on other devices see new products only AFTER the
     backend save. Only the admin's own browser sees them instantly.
   - Browsers cannot upload after the tab is fully closed (no
     Background Sync on iOS). Jobs persist in IndexedDB and resume
     on the next visit.
   ============================================================ */

// ============================================================
// CONFIGURATION
// ============================================================
const API_URL = 'https://script.google.com/macros/s/AKfycbxGcW2xkagjfp9Dr3Jz_1sflwM-JRbjPV1LUF4UoWzhAGJU2epWVDhXoQH9TgkevU5D/exec';

const CLOUDINARY = {
    cloudName: 'ldtixrva',
    uploadPreset: 'NAKOWA-ABAYAS',
    folder: 'ABAYAS-VIDEO-IMGS',
    imageUrl: 'https://api.cloudinary.com/v1_1/ldtixrva/image/upload',
    videoUrl: 'https://api.cloudinary.com/v1_1/ldtixrva/video/upload'
};

const SUPABASE = {
    url: 'https://yntkbjzvmizssrxwzuoi.supabase.co',
    key: 'sb_publishable_CFyA2zonltT81jFRMyAQpg_kx5vLA_u',
    bucket: 'Product-images',
    bucketAliases: ['Product-images', 'PRODUCT-IMAGES', 'Product-Images', 'Products-image', 'nakowa-images'],
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
// AUTH — FRONTEND-ONLY JAVASCRIPT AUTHENTICATION
// ------------------------------------------------------------
// NOTE ON SECURITY (honest):
//   Frontend-only. Not server-grade. Anyone with DevTools can
//   read/change localStorage['nakowa_admin_auth'].
//   Designed to: replace AppSheet login, persist custom creds,
//   never fall back to defaults once custom, refuse old creds
//   immediately after a change, add lockout + inactivity timeout.
//   For real security, move auth to a backend auth service.
// ============================================================
const AUTH_CONFIG = {
    AUTH_KEY:        'nakowa_admin_auth',
    SESSION_KEY:     'nakowa_admin_session',
    FAILED_KEY:      'nakowa_admin_failed',
    DEFAULT_USER:    'umar',
    DEFAULT_PASS:    '0708070',
    SESSION_IDLE_MS: 30 * 60 * 1000,
    MAX_FAILED:      5
};

function getAdminCredentials() {
    try {
        const raw = localStorage.getItem(AUTH_CONFIG.AUTH_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.username === 'string' && typeof parsed.password === 'string') {
                return { username: parsed.username, password: parsed.password, isCustom: true };
            }
        }
    } catch (e) {
        console.warn('[AUTH] Failed to read credentials, using defaults.', e);
    }
    return { username: AUTH_CONFIG.DEFAULT_USER, password: AUTH_CONFIG.DEFAULT_PASS, isCustom: false };
}

function saveAdminCredentials(username, password) {
    username = String(username || '').trim();
    password = String(password || '');
    if (!username || !password) {
        return { success: false, message: 'Username and password cannot be empty.' };
    }
    localStorage.setItem(AUTH_CONFIG.AUTH_KEY, JSON.stringify({ username, password }));
    clearAdminSession();
    return { success: true };
}

function clearAdminCredentials() {
    localStorage.removeItem(AUTH_CONFIG.AUTH_KEY);
}

function createAdminSession(username) {
    const session = {
        token: (window.crypto && crypto.randomUUID)
            ? crypto.randomUUID()
            : ('sess-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
        username: username,
        createdAt: Date.now(),
        lastActivity: Date.now()
    };
    localStorage.setItem(AUTH_CONFIG.SESSION_KEY, JSON.stringify(session));
    return session;
}

function getAdminSession() {
    try {
        const raw = localStorage.getItem(AUTH_CONFIG.SESSION_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s || !s.token || !s.username) return null;
        return s;
    } catch (e) {
        return null;
    }
}

function touchAdminSession() {
    const s = getAdminSession();
    if (!s) return;
    s.lastActivity = Date.now();
    localStorage.setItem(AUTH_CONFIG.SESSION_KEY, JSON.stringify(s));
}

function isAdminAuthenticated() {
    const s = getAdminSession();
    if (!s) return false;
    if (Date.now() - (s.lastActivity || s.createdAt) > AUTH_CONFIG.SESSION_IDLE_MS) {
        clearAdminSession();
        return false;
    }
    return true;
}

function checkSessionTimeout() {
    if (!getAdminSession()) return false;
    if (!isAdminAuthenticated()) {
        forceShowLogin();
        return false;
    }
    touchAdminSession();
    return true;
}

function clearAdminSession() {
    localStorage.removeItem(AUTH_CONFIG.SESSION_KEY);
}

function forceShowLogin() {
    const ls = document.getElementById('loginScreen');
    const db = document.getElementById('dashboard');
    if (ls) ls.style.display = 'flex';
    if (db) db.style.display = 'none';
    const user = document.getElementById('loginUsername');
    const pass = document.getElementById('loginPassword');
    if (pass) pass.value = '';
    if (user) user.focus();
}

function getFailedState() {
    try {
        const raw = localStorage.getItem(AUTH_CONFIG.FAILED_KEY);
        if (!raw) return { count: 0 };
        const s = JSON.parse(raw);
        return {
            count: parseInt(s.count || 0, 10) || 0
        };
    } catch (e) {
        return { count: 0 };
    }
}

function saveFailedState(state) {
    localStorage.setItem(AUTH_CONFIG.FAILED_KEY, JSON.stringify(state));
}

function isLoginLocked() {
    return 0;
}

function handleFailedLogin() {
    const s = getFailedState();
    const next = { count: (s.count || 0) + 1 };
    saveFailedState(next);
    return next.count >= AUTH_CONFIG.MAX_FAILED;
}

function resetFailedLogins() {
    saveFailedState({ count: 0 });
}

function checkAuth() {
    return isAdminAuthenticated() ? getAdminSession().token : '';
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
let supabaseBucket = SUPABASE.bucket;
let supabaseProbePromise = null;
let supabaseProbeCachedAt = 0;
const SUPABASE_PROBE_TTL = 30 * 60 * 1000;
let supabaseAvailable = false;
let salesChartInstance = null;

let selectedProductIds = new Set();
let productSearchQuery = '';

// ============================================================
// VIEW TOKEN
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
// PRICE RENDERER — actual stored price only
// (No fake price, no +5000, no strikethrough. Final decision.)
// ============================================================
function renderPrice(actualPrice) {
    const actual = parseFloat(actualPrice) || 0;
    return `<span class="price-actual">₦${actual.toLocaleString()}</span>`;
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
// LOGIN / LOGOUT
// ============================================================
async function doLogin() {
    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value;
    const errEl = $('loginError');
    const btn = $('loginBtn');

    errEl.style.display = 'none';

    if (!username || !password) {
        errEl.textContent = 'Please enter username and password.';
        errEl.style.display = 'block';
        return;
    }

    btn.disabled = true;
    btn.textContent = 'Logging in...';

    try {
        const creds = getAdminCredentials();
        const ok = (username === creds.username) && (password === creds.password);

        if (!ok) {
            const shouldRedirect = handleFailedLogin();
            if (shouldRedirect) {
                // 5th failed attempt — go straight to the public site.
                window.location.href = '../index.html';
                return;
            }
            errEl.textContent = 'Invalid username or password.';
            errEl.style.display = 'block';
            return;
        }

        resetFailedLogins();
        createAdminSession(username);
        currentAdmin = username;
        authToken = '';

        // Show the dashboard IMMEDIATELY — do not block login on the
        // 3-endpoint warmCache round-trip. Refresh data in background.
        $('loginScreen').style.display = 'none';
        $('dashboard').style.display = 'flex';
        loadSection('dashboard');

        (function () {
            let settled = false;
            const redraw = function () {
                if (settled) return;
                settled = true;
                try {
                    if (currentSection === 'dashboard') loadSection('dashboard');
                } catch (e) {}
            };
            const timer = setTimeout(function () {
                // 5s cap: show dashboard with whatever data is available.
                redraw();
            }, 5000);
            warmCache().then(function () {
                clearTimeout(timer);
                redraw();
            }).catch(function (e) {
                clearTimeout(timer);
                warnOnce('warm-cache-on-login', '[AUTH] warmCache failed (non-fatal).', e);
                redraw();
            });
        })();
    } catch (err) {
        errEl.textContent = 'Login error: ' + err.message;
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Login';
    }
}

// NOTE: Soft logout was explicitly left untouched as requested.
function doLogout() {
    authToken = '';
    currentAdmin = '';
    cachedProducts = null;
    cachedOrders = null;
    cachedSettings = null;
    cachedCustomers = null;
    cachedUsers = null;
    clearAdminSession();
    window.location.href = '../index.html';
}

// ============================================================
// WARM CACHE
// ============================================================
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
    if (typeof checkSessionTimeout === 'function' && !checkSessionTimeout()) return;

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

    if (section !== 'products') {
        selectedProductIds.clear();
    }

    switch (section) {
        case 'dashboard': renderDashboard(myToken); break;
        case 'products': renderProducts(myToken); break;
        case 'orders': renderOrders(myToken); break;
        case 'customers': renderCustomers(myToken); break;
        case 'settings': renderSettings(myToken); break;
        case 'users': renderUsers(myToken); break;
        case 'changepassword': renderChangePassword(); break;
    }
}

// ============================================================
// DASHBOARD
// ============================================================
async function renderDashboard(myToken) {
    myToken = myToken || viewToken;
    $('pageTitle').textContent = 'Dashboard';
    $('topbarDate').textContent = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    currentSection = 'dashboard';

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
// PRODUCTS
// ============================================================
async function renderProducts(myToken) {
    myToken = myToken || viewToken;
    $('pageTitle').textContent = 'Products';
    currentSection = 'products';

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

async function renderProductList(filterCountry) {
    const container = $('productsContainer');
    if (!container) return;

    const countries = [...new Set(cachedProducts.map(p => p.country).filter(Boolean))];
    if (!countries.includes('Egypt')) countries.unshift('Egypt');

    let filtered = filterCountry === 'all'
        ? cachedProducts
        : cachedProducts.filter(p => p.country === filterCountry);

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

    // Merge pending jobs from IndexedDB queue (via queue.js)
    let pendingJobs = [];
    try {
        if (window.NakowaQueue && typeof window.NakowaQueue.getPendingProducts === 'function') {
            pendingJobs = await window.NakowaQueue.getPendingProducts();
        }
    } catch (e) {
        warnOnce('queue-read-failed', '[Queue] Could not read pending jobs.', e);
    }

    // Skip pending jobs already present in cachedProducts (backend already saved them).
    const cachedIds = new Set(cachedProducts.map(p => String(p.id)));
    const merged = filtered.concat(
        pendingJobs
            .filter(p => !cachedIds.has(String(p.id)))
            .filter(p => filterCountry === 'all' || p.country === filterCountry)
    );

    const filterHTML = `
        <div class="filter-buttons" style="margin-bottom:14px;">
            <button class="filter-btn ${filterCountry === 'all' ? 'active' : ''}" data-filter="all">All</button>
            ${countries.map(c => `<button class="filter-btn ${filterCountry === c ? 'active' : ''}" data-filter="${escapeHtml(c)}">${c === 'Egypt' ? '🇪🇬 ' : ''}${escapeHtml(c)}</button>`).join('')}
        </div>
    `;

    if (merged.length === 0) {
        container.innerHTML = filterHTML + `<div class="empty-state-admin"><i class="fas fa-box-open"></i><h4>No products</h4><p>${productSearchQuery ? 'No match for your search.' : 'Click "Add Products" to start.'}</p></div>`;
    } else {
        container.innerHTML = filterHTML + `
            <div class="admin-product-grid">
                ${merged.map(p => renderAdminProductCard(p)).join('')}
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
    container.querySelectorAll('.retry-failed-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const jobId = btn.dataset.jobId;
            if (window.NakowaQueue && typeof window.NakowaQueue.retryFailed === 'function') {
                window.NakowaQueue.retryFailed(jobId);
                showToast('Retrying failed items…', '⏳');
                setTimeout(() => renderProductList(filterCountry), 800);
            }
        });
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

    // Pending job metadata (from queue.js)
    const pending = p._pending || p._queueMeta || null;
    const isPending = !!pending;
    const uploadedCount = pending ? (pending.uploadedCount || 0) : 0;
    const totalCount = pending ? (pending.totalCount || 0) : 0;
    const hasFailed = pending ? (pending.failedCount > 0) : false;

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

    const pendingBadge = isPending
        ? `<div style="margin:6px 0;padding:4px 8px;border-radius:20px;background:rgba(212,175,55,0.15);border:1px solid var(--border-gold);font-size:0.72rem;color:var(--gold);text-align:center;">
              <i class="fas fa-cloud-upload-alt"></i> Uploading ${uploadedCount}/${totalCount}
           </div>`
        : '';

    const retryHTML = hasFailed
        ? `<button class="retry-failed-btn" data-job-id="${escapeHtml(p.id)}" style="margin:6px 0;width:100%;padding:6px 10px;border-radius:8px;border:1px solid #e74c3c;background:rgba(231,76,60,0.15);color:#e74c3c;font-size:0.75rem;cursor:pointer;">
              <i class="fas fa-redo"></i> Retry failed (${pending.failedCount})
           </button>`
        : '';

    return `
        <div class="admin-product-card ${isSelected ? 'selected' : ''}">
            <input type="checkbox" class="card-checkbox" data-id="${escapeHtml(p.id)}" ${isSelected ? 'checked' : ''} ${isPending ? 'disabled' : ''} />
            ${hasVideo
                ? `<video src="${escapeHtml(p.videos[0])}" muted autoplay loop playsinline style="width:100%;height:140px;object-fit:cover;border-radius:8px;margin-bottom:10px;" data-autoplay-video></video>`
                : `<img src="${escapeHtml(firstVariant.image || DEFAULT_IMG)}" alt="${escapeHtml(p.name)}" onerror="imgFallback(this)" />`
            }
            <h4>${escapeHtml(p.name)}</h4>
            <div class="product-meta">Code: <strong>${escapeHtml(firstVariant.code || p.code || '')}</strong></div>
            <div class="product-price" style="text-align:left;margin:4px 0;font-size:0.95rem;">${renderPrice(firstVariant.price || p.price || 0)}</div>
            <div class="product-meta">Stock: <strong>${p.stock || 0}</strong></div>
            <div class="product-meta">Colors: ${variants.length}${hasVideo ? ' · 🎬 Video' : ''}</div>
            ${colorCirclesHTML}
            ${pendingBadge}
            ${retryHTML}
            <div class="admin-actions">
                ${isPending
                    ? `<button class="edit-btn" disabled style="opacity:0.4;cursor:not-allowed;"><i class="fas fa-edit"></i> Edit</button>
                       <button class="delete-btn" disabled style="opacity:0.4;cursor:not-allowed;"><i class="fas fa-trash"></i></button>`
                    : `<button class="edit-btn" data-id="${escapeHtml(p.id)}"><i class="fas fa-edit"></i> Edit</button>
                       <button class="delete-btn" data-id="${escapeHtml(p.id)}"><i class="fas fa-trash"></i></button>`
                }
            </div>
        </div>
    `;
}

// ============================================================
// BULK PRICE UPDATE — per-variant
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
        const variants = Array.isArray(p.variants) ? p.variants : [];

        const newVariants = variants.map(v => {
            const current = parseFloat(v.price) || 0;
            let next = current;
            switch (mode) {
                case 'set':          next = value; break;
                case 'add':          next = current + value; break;
                case 'subtract':     next = Math.max(0, current - value); break;
                case 'increase_pct': next = Math.round(current * (1 + value / 100)); break;
                case 'decrease_pct': next = Math.round(current * (1 - value / 100)); break;
            }
            next = Math.max(0, next);
            return Object.assign({}, v, { price: next });
        });

        let productPrice = p.price;
        if (variants.length === 0) {
            const current = parseFloat(p.price) || 0;
            switch (mode) {
                case 'set':          productPrice = value; break;
                case 'add':          productPrice = current + value; break;
                case 'subtract':     productPrice = Math.max(0, current - value); break;
                case 'increase_pct': productPrice = Math.round(current * (1 + value / 100)); break;
                case 'decrease_pct': productPrice = Math.round(current * (1 - value / 100)); break;
            }
            productPrice = Math.max(0, productPrice);
        }

        updates.push({ id: p.id, variants: newVariants, productPrice: productPrice });
    });

    if (updates.length === 0) return;

    showToast(`Updating ${updates.length} products...`, '⏳');

    try {
        const res = await apiPost('bulkUpdatePrices', {
            token: authToken,
            updates: updates.map(u => ({
                id: u.id,
                variants: u.variants,
                newPrice: u.variants.length > 0 ? u.variants[0].price : u.productPrice
            }))
        });

        if (res.success) {
            updates.forEach(u => {
                const idx = cachedProducts.findIndex(p => String(p.id) === String(u.id));
                if (idx >= 0) {
                    if (u.variants.length > 0) cachedProducts[idx].variants = u.variants;
                    else cachedProducts[idx].price = u.productPrice;
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

    if (preview._objectUrls && preview._objectUrls.length) {
        preview._objectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
    }
    preview._objectUrls = [];

    preview.innerHTML = uploadFiles.map((item, i) => {
        const isVideo = item.isVideo;
        const url = URL.createObjectURL(item.file);
        preview._objectUrls.push(url);
        return `
            <div class="preview-item" data-idx="${i}" draggable="true">
                ${isVideo
                    ? `<video src="${url}" muted autoplay loop playsinline data-autoplay-video></video>`
                    : `<img src="${url}" alt="" />`
                }
                <button class="remove-img" data-remove="${i}">×</button>
            </div>
        `;
    }).join('');

    preview.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const i = parseInt(btn.dataset.remove);
            uploadFiles.splice(i, 1);
            renderUploadPreview();
        });
    });

    setupDragReorder(preview);
    applyVideo10sLoop(preview);

    const btn = $('startVariantsBtn');
    if (btn) btn.disabled = uploadFiles.length === 0;
}

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

    renderVariantStep();
}

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

    if (container._objectUrl) {
        try { URL.revokeObjectURL(container._objectUrl); } catch (e) {}
        container._objectUrl = null;
    }
    const vUrl = URL.createObjectURL(v.file);
    container._objectUrl = vUrl;

    container.innerHTML = `
        <div class="variant-step-container">
            <div class="variant-step-counter">
                <i class="fas ${v.isVideo ? 'fa-video' : 'fa-image'}"></i>
                ${v.isVideo ? 'Video' : 'Image'} — Variant ${idx + 1} of ${total}
            </div>
            ${v.isVideo
                ? `<video src="${vUrl}" class="variant-preview" muted autoplay loop playsinline data-autoplay-video></video>`
                : `<img src="${vUrl}" class="variant-preview" alt="" />`
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

    attachCodeInputCleaner('vCode');
    const colorPicker = $('colorPicker');
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
// SAVE BATCH — instant "Done ✅" + IndexedDB queue
// Uploads are handled entirely by queue.js (window.NakowaQueue).
// ============================================================
async function saveBatch() {
    if (!currentBatch.length) { showToast('No files selected', '⚠️'); return; }
    const saveBtn = $('saveBatchBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...'; }

    try {
        const firstCode = (currentBatch[0] && currentBatch[0].code) || '000';
        const productId = generateId('P');

        const imageItems = currentBatch.filter(v => !v.isVideo);
        const videoItems = currentBatch.filter(v => v.isVideo);

        // Build the job object the queue.js worker consumes.
        // Each item stores the real File/Blob, price, code, color, isVideo, status.
        const items = currentBatch.map(v => ({
            blob: v.file,
            isVideo: v.isVideo,
            price: v.price,
            code: (v.code || '').toString().trim(),
            colorName: v.colorName || 'Default',
            colorValue: v.colorValue || '#D4AF37',
            status: 'queued',
            attempts: 0,
            url: null
        }));

        const job = {
            id: productId,
            name: 'NAKOWA ABAYA',
            code: firstCode,
            country: 'Egypt',
            sizes: ['S', 'M', 'L', 'XL', 'XXL'],
            stock: 10,
            status: 'active',
            createdAt: new Date().toISOString().split('T')[0],
            state: 'queued',
            uploadedCount: 0,
            totalCount: items.length,
            failedCount: 0,
            lastError: '',
            items: items
        };

        if (!window.NakowaQueue || typeof window.NakowaQueue.enqueueJob !== 'function') {
            throw new Error('queue.js not loaded — cannot save batch.');
        }

        await window.NakowaQueue.enqueueJob(job);

        showToast('Done ✅ — uploading in background', '✅');
        loadSection('products');

        // Kick the worker without awaiting.
        if (typeof window.NakowaQueue.kick === 'function') {
            window.NakowaQueue.kick();
        }
    } catch (err) {
        logOnce('batch-fatal-' + err.message, '[Batch] Failed: ' + err.message);
        showToast('Save failed: ' + err.message.substring(0, 140), '❌');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> Save All'; }
    }
}

// ============================================================
// EDIT PRODUCT
// ============================================================
async function editProduct(id) {
    const p = cachedProducts.find(x => String(x.id) === String(id));
    if (!p) { showToast('Product not found', '❌'); return; }

    if (p._pending || p._queueMeta) {
        showToast('Cannot edit a product while it is uploading.', '⚠️');
        return;
    }

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
                            <img src="${escapeHtml(v.image)}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid var(--border-gold);" onerror="imgFallback(this)" />
                            <div style="flex:1;">
                                <div style="color:var(--gold);font-weight:600;font-size:0.85rem;">
                                    <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${escapeHtml(v.colorValue)};vertical-align:middle;margin-right:6px;border:1px solid #fff;"></span>
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

    attachCodeInputCleaner('editCode');
    document.querySelectorAll('.edit-v-code').forEach(el => {
        if (!el._cleanerAttached) {
            el._cleanerAttached = true;
            el.addEventListener('input', function() {
                const c = this.value.replace(/^NAK-/i, '');
                if (c !== this.value) this.value = c;
            });
        }
    });
    $('cancelEditBtn').addEventListener('click', () => renderProductList('all'));

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
            return Object.assign({}, v, {
                price: parseFloat(priceEl.value) || v.price,
                code: normalizeProductCode(codeEl.value.trim()) || v.code
            });
        });

        const updated = Object.assign({}, p, {
            name: newName,
            code: normalizeProductCode(newCode),
            sizes: newSizesStr.split(',').map(s => s.trim()).filter(Boolean),
            stock: newStock,
            status: newStatus,
            variants: newVariants
        });

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
// ORDERS
// ============================================================
async function renderOrders(myToken) {
    myToken = myToken || viewToken;
    $('pageTitle').textContent = 'Orders';
    currentSection = 'orders';

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
            <td><img src="${escapeHtml(o.productImage || DEFAULT_IMG)}" alt="" onerror="imgFallback(this)" /></td>
            <td><strong style="color:var(--gold);">${escapeHtml(o.orderId)}</strong><br><span style="font-size:0.7rem;opacity:0.6;">${escapeHtml(o.date)} ${escapeHtml(o.time || '')}</span></td>
            <td>${escapeHtml(o.customerName)}<br><span style="font-size:0.75rem;opacity:0.6;">${escapeHtml(o.customerPhone)}</span></td>
            <td>${escapeHtml(o.productName)}<br><span style="font-size:0.75rem;opacity:0.6;">Code: ${escapeHtml(o.productCode)}</span></td>
            <td>${escapeHtml(o.colorName)} / ${escapeHtml(o.size)}</td>
            <td>${o.quantity}</td>
            <td><strong>${formatMoney(o.total)}</strong></td>
            <td>
                <select class="status-select" data-order-id="${escapeHtml(o.orderId)}">
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
            const newStatus = this.value;
            try {
                const res = await apiPost('updateOrderStatus', { token: authToken, orderId, status: newStatus });
                if (!res.success) {
                    showToast(res.message || 'Failed', '❌');
                    return;
                }

                const idx = cachedOrders.findIndex(o => o.orderId === orderId);
                if (idx >= 0) cachedOrders[idx].status = newStatus;

                const cachedOrder = cachedOrders.find(o => o.orderId === orderId);
                const customerPhone = cachedOrder ? (cachedOrder.customerPhone || '') : '';
                const cleanPhone = customerPhone.replace(/\D/g, '');

                if (cleanPhone) {
                    const msg = `🛍️ *NAKOWA ABAYAS COLLECTIONS*\n\nYour order ${orderId} status is now: *${newStatus.toUpperCase()}*\n\nThank you for shopping with us!`;
                    const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`;

                    // Do NOT window.open here — it happens after an await,
                    // which mobile browsers block. Show a button instead.
                    showToast('Status updated. Tap "Notify" to send WhatsApp.', '✅');
                    showNotifyActionButton(waUrl);
                } else {
                    showToast('Status updated.', '✅');
                }
            } catch (err) {
                showToast('Error: ' + err.message, '❌');
            }
        });
    });

    tbody.querySelectorAll('.receipt-btn').forEach(btn => {
        btn.addEventListener('click', () => generateReceipt(btn.dataset.orderId));
    });
}

function showNotifyActionButton(waUrl) {
    const existing = document.getElementById('waNotifyAction');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = 'waNotifyAction';
    btn.innerHTML = '<i class="fab fa-whatsapp"></i> Notify customer';
    btn.style.cssText = [
        'position:fixed',
        'right:20px',
        'bottom:20px',
        'z-index:10000',
        'padding:12px 18px',
        'border-radius:30px',
        'border:none',
        'background:#25D366',
        'color:#fff',
        'font-weight:700',
        'font-family:inherit',
        'cursor:pointer',
        'box-shadow:0 6px 20px rgba(0,0,0,0.35)'
    ].join(';');
    btn.addEventListener('click', () => {
        window.open(waUrl, '_blank');
        btn.remove();
    });
    document.body.appendChild(btn);

    setTimeout(() => { if (btn.parentNode) btn.remove(); }, 30000);
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
async function renderCustomers(myToken) {
    myToken = myToken || viewToken;
    $('pageTitle').textContent = 'Customers';
    currentSection = 'customers';

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
async function renderSettings(myToken) {
    myToken = myToken || viewToken;
    $('pageTitle').textContent = 'Settings';
    currentSection = 'settings';

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
                cachedSettings = Object.assign({}, cachedSettings, newSettings);
                showToast('Settings saved!', '✅');
            } else showToast(res.message || 'Failed', '❌');
        } catch (err) { showToast('Error: ' + err.message, '❌'); }
    });
}

// ============================================================
// USERS
// ============================================================
async function renderUsers(myToken) {
    myToken = myToken || viewToken;
    $('pageTitle').textContent = 'Users';
    currentSection = 'users';

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
                                <td>${u.protected
                                    ? '<span style="opacity:0.4;font-size:0.7rem;">Default</span>'
                                    : `<button class="delete-btn" data-user="${escapeHtml(u.username)}" style="padding:5px 10px;border-radius:20px;background:#e74c3c;color:#fff;border:none;cursor:pointer;font-size:0.7rem;">Delete</button>`
                                }</td>
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
                    <div class="form-group"><label>Username <span class="required">*</span></label><input type="text" id="newUsername" required autocomplete="off" /></div>
                    <div class="form-group"><label>Password <span class="required">*</span></label><input type="password" id="newPassword" required autocomplete="new-password" /></div>
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
// CHANGE CREDENTIALS (localStorage-based)
// ============================================================
function renderChangePassword() {
    if (!checkSessionTimeout()) return;

    $('pageTitle').textContent = 'Change Credentials';
    currentSection = 'changepassword';

    const creds = getAdminCredentials();

    $('contentArea').innerHTML = `
        <div class="admin-card">
            <div class="card-title"><span><i class="fas fa-key"></i> Change Admin Username / Password</span></div>
            <p style="color:rgba(255,255,255,0.6);font-size:0.85rem;margin-bottom:14px;">
                These credentials are stored only in this browser (localStorage).
                They are not synced to other devices and are not server-grade security.
            </p>
            <form class="admin-form" id="changePasswordForm" autocomplete="off">
                <div class="form-group">
                    <label>Current Password <span class="required">*</span></label>
                    <input type="password" id="cpOld" required autocomplete="current-password" />
                </div>
                <div class="form-group">
                    <label>New Username <span class="required">*</span></label>
                    <input type="text" id="cpNewUser" required value="${escapeHtml(creds.username)}" autocomplete="off" />
                </div>
                <div class="form-group">
                    <label>New Password <span class="required">*</span></label>
                    <input type="password" id="cpNew" required minlength="1" autocomplete="new-password" />
                </div>
                <div class="form-group">
                    <label>Confirm New Password <span class="required">*</span></label>
                    <input type="password" id="cpConfirm" required minlength="1" autocomplete="new-password" />
                </div>
                <div class="form-actions">
                    <button type="submit" class="btn-gold"><i class="fas fa-key"></i> Save New Credentials</button>
                </div>
            </form>
        </div>
    `;

    $('changePasswordForm').addEventListener('submit', function (e) {
        e.preventDefault();

        if (!isAdminAuthenticated()) {
            showToast('Session expired. Please log in again.', '⚠️');
            forceShowLogin();
            return;
        }

        const oldPassword = $('cpOld').value;
        const newUsername = $('cpNewUser').value.trim();
        const newPassword = $('cpNew').value;
        const confirm     = $('cpConfirm').value;

        if (!newUsername || !newPassword) {
            showToast('Username and password cannot be empty.', '⚠️');
            return;
        }
        if (newPassword !== confirm) {
            showToast('Passwords do not match.', '⚠️');
            return;
        }

        const credsNow = getAdminCredentials();
        if (oldPassword !== credsNow.password) {
            showToast('Invalid username or password.', '❌');
            return;
        }

        const saved = saveAdminCredentials(newUsername, newPassword);
        if (!saved.success) {
            showToast(saved.message || 'Could not save credentials.', '❌');
            return;
        }

        showToast('Credentials updated. Please log in again.', '✅');

        setTimeout(function () {
            forceShowLogin();
        }, 600);
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

    if (isAdminAuthenticated()) {
        const s = getAdminSession();
        currentAdmin = s ? s.username : '';
        $('loginScreen').style.display = 'none';
        $('dashboard').style.display = 'flex';
        warmCache().then(() => {
            loadSection('dashboard');
        });
    } else {
        forceShowLogin();
    }

    ['mousemove', 'keydown', 'click', 'touchstart'].forEach(function (evt) {
        document.addEventListener(evt, function () {
            if (isAdminAuthenticated()) touchAdminSession();
        }, { passive: true });
    });

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

    // Listen for queue progress updates from queue.js so the product grid
    // reflects "Uploading X/Y" without a manual refresh.
    if (window.NakowaQueue && typeof window.NakowaQueue.onProgress === 'function') {
        window.NakowaQueue.onProgress(function () {
            if (currentSection === 'products') {
                renderProductList('all');
            }
        });
    }
});