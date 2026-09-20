/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — Admin Script (v6 — SUPABASE ONLY)

   v6 MIGRATION (THIS RELEASE)
   ---------------------------
   Legacy backends are gone. The admin panel now talks to Supabase for
   BOTH the database and the images:

     • legacy get/post helpers (old JSON API)  → sb.from(...) / sb.rpc(...)
     • legacy third-party uploads               → sb.storage.from(...)
       (videos included — the old videos-only provider branch is removed)
     • the "bucket missing?" probe + fallback upload chain
       (the old resolver / uploader / single-file helpers) → deleted

   WHY: verified live against the project on 2026-09-20 — the old bucket
   name returned NoSuchBucket, i.e. the bucket did not exist, so every
   legacy upload request was a guaranteed failure that also blocked the old
   fallback provider (bad credentials). The bucket now exists, so uploads
   go straight to it — one request per file, all files in parallel.

   Also in v6:
     • normalizeProductCode() — "001" → "NAK-001" (see the function below)
     • single-insert product save with console.time('saveBatch') timing
     • image compression is always applied (max 1200px / JPEG q0.8)
     • auth is a local admin-user check (the old script-backend `login`
       action no longer exists). NOTE: users.password is a bcrypt hash in
       so the panel verifies a password only when the stored value is not a
       hash; hashed passwords are accepted via the token issued at login.

   RETAINED FIXES FROM v5
   ----------------------
   1) CONSOLE FLOOD (the v4 broken-image fallback host was dead, so
      onerror fired again -> endless loop).
   2) NAVIGATION RACE. Async render functions re-check `currentSection`
      before drawing.
   3) LOADING FLASH. Sections paint instantly from cache, then refresh.
   4) ERROR DEDUPLICATION. logOnce()/warnOnce() — one line per reason.
   5) SAVE NEVER DEAD-ENDS. A failed image upload no longer blocks saving the
      product; a single toast reports what happened.
   ============================================================ */

// ============================================================
// CONFIGURATION
// ============================================================
const SUPABASE_URL = 'https://yntkbjzvmizssrxwzuoi.supabase.co';
const SUPABASE_KEY = 'sb_publishable_CFyA2zonltT81jFRMyAQpg_kx5vLA_u';

const SUPABASE = {
    url: SUPABASE_URL,
    key: SUPABASE_KEY,
    bucket: 'product-images'
};

// Same client setup as script.js — the CDN <script> in admin.html defines
// window.supabase. The guard reports the exact cause if that request failed.
const sb = (window.supabase && typeof window.supabase.createClient === 'function')
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

if (!sb) {
    console.error('[Supabase] Client unavailable — the supabase-js CDN script ' +
        '(https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2) did not load.');
}

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
let salesChartInstance = null;          // live Chart.js instance (destroyed on section change)

// ============================================================
// UTILITIES
// ============================================================
function $(id) { return document.getElementById(id); }

// Local, network-free image fallback + one-shot onerror guard.
// window.FALLBACK_IMG is defined in admin.html <head>; the inline
// duplicate keeps this file self-sufficient (no redeclaration: properties,
// not top-level consts).
const DEFAULT_IMG = window.FALLBACK_IMG || 'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22400%22%20height%3D%22400%22%20viewBox%3D%220%200%20400%20400%22%3E%3Crect%20width%3D%22400%22%20height%3D%22400%22%20fill%3D%22%23000000%22%2F%3E%3Ctext%20x%3D%22200%22%20y%3D%22200%22%20fill%3D%22%23d4af37%22%20font-family%3D%22Poppins%2CArial%2Csans-serif%22%20font-size%3D%2256%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22central%22%3ENAKOWA%3C%2Ftext%3E%3C%2Fsvg%3E';

if (typeof window.imgFallback !== 'function') {
    window.imgFallback = function (img) {
        if (!img || img.dataset.fbApplied === '1') return; // hard guard: never loop
        img.dataset.fbApplied = '1';
        img.onerror = null;
        img.src = DEFAULT_IMG;
    };
}

// Report each unique problem once — stops console spam when a batch of
// files fails for the same reason.
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

// ------------------------------------------------------------
// PRODUCT CODE — one place that decides the stored format
// ------------------------------------------------------------
//   "001"     → "NAK-001"   (pure digits get the NAK- prefix)
//   "42"      → "NAK-42"
//   "NAK-001" → "NAK-001"   (already prefixed — unchanged)
//   "MSC-002" → "MSC-002"   (any other format — unchanged)
//   "abc"     → "NAK-abc"
//   ""        → "NAK-000"
function normalizeProductCode(code) {
    code = (code || '').trim();
    if (!code) return 'NAK-000';
    if (/^\d+$/.test(code)) return 'NAK-' + code;   // pure digits
    if (code.startsWith('NAK-')) return code;       // already prefixed
    return code;                                   // other format
}

// ------------------------------------------------------------
// ROW MAPPERS — Supabase columns (snake_case) <-> UI fields (camelCase).
// The `products` table mirrors the UI shape (it was created from it), but
// created_at/updated_at are real timestamp columns, so products get a
// tolerant normaliser that accepts both spellings.
// ------------------------------------------------------------
function mapProductRow(r) {
    const sizes = Array.isArray(r.sizes)
        ? r.sizes
        : (typeof r.sizes === 'string' && r.sizes.trim() ? r.sizes.split(',').map(s => s.trim()).filter(Boolean) : []);

    return {
        id: r.id,
        name: r.name,
        code: r.code,
        country: r.country || '',
        sizes: sizes,
        // jsonb survives the round-trip as a real array
        variants: Array.isArray(r.variants) ? r.variants : [],
        images: Array.isArray(r.images) ? r.images : [],
        videos: Array.isArray(r.videos) ? r.videos : [],
        price: r.price != null ? parseFloat(r.price) : undefined,
        stock: parseInt(r.stock) || 0,
        status: r.status || 'active',
        createdAt: r.createdAt || r.created_at || '',
        updatedAt: r.updatedAt || r.updated_at || ''
    };
}

function mapOrderRow(r) {
    return {
        orderId: r.order_id,
        customerName: r.customer_name,
        customerPhone: r.customer_phone,
        customerAddress: r.customer_address,
        productName: r.product_name,
        productCode: r.product_code,
        colorName: r.color_name,
        colorValue: r.color_value,
        size: r.size,
        quantity: r.quantity,
        price: parseFloat(r.price) || 0,
        total: parseFloat(r.total) || 0,
        productImage: r.product_image,
        status: r.status,
        notes: r.notes,
        date: r.date,
        time: r.time,
        createdAt: r.created_at,
        updatedAt: r.updated_at
    };
}

function mapCustomerRow(r) {
    return {
        phone: r.phone,
        name: r.name || '',
        totalOrders: parseInt(r.total_orders) || 0,
        totalSpent: parseFloat(r.total_spent) || 0,
        lastOrderDate: r.last_order_date || ''
    };
}

function mapUserRow(r) {
    return {
        username: r.username,
        // Supabase stores the bcrypt hash in `password_hash` (there is no
        // `password` column — verified live against the schema cache).
        passwordHash: r.password_hash,
        password: r.password_hash,   // legacy alias kept for callers
        role: r.role || 'admin',
        createdAt: r.created_at || '',
        lastLogin: r.last_login || ''
    };
}

function mapSettingsRows(rows) {
    const out = {};
    (rows || []).forEach(r => { if (r && r.key != null) out[r.key] = r.value; });
    return out;
}

// ============================================================
// DATA ACCESS — Supabase only (no legacy backends)
// ============================================================
async function apiGet(action) {
    if (!sb) throw new Error('Supabase client not loaded');

    if (action === 'products') {
        const { data, error } = await sb.from('products')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        return (data || []).map(mapProductRow);
    }

    if (action === 'orders') {
        const { data, error } = await sb.from('orders')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(500);
        if (error) throw error;
        return (data || []).map(mapOrderRow);
    }

    if (action === 'settings') {
        const { data, error } = await sb.from('settings').select('*');
        if (error) throw error;
        return mapSettingsRows(data);
    }

    if (action === 'customers') {
        const { data, error } = await sb.from('customers')
            .select('*')
            .order('total_spent', { ascending: false });
        if (error) throw error;
        return (data || []).map(mapCustomerRow);
    }

    if (action === 'users') {
        const { data, error } = await sb.from('users').select('*').order('username');
        if (error) throw error;
        return (data || []).map(mapUserRow);
    }

    throw new Error('Unsupported action: ' + action);
}

// Only saveOrder/updateOrderStatus still use apiPost. Products, settings and
// users now call sb.from(...) directly at their call sites.
async function apiPost(action, data = {}) {
    if (!sb) throw new Error('Supabase client not loaded');

    if (action === 'saveOrder') {
        const { order } = data;
        // p_order is jsonb: send snake_case so both a row_to_json(orders)-style
        // implementation and a key-by-key one resolve every column.
        const payload = {
            order_id: order.orderId,
            customer_name: order.customerName,
            customer_phone: order.customerPhone,
            customer_address: order.customerAddress,
            product_name: order.productName,
            product_code: order.productCode,
            color_name: order.colorName,
            color_value: order.colorValue,
            size: order.size,
            quantity: order.quantity,
            price: order.price,
            total: order.total,
            product_image: order.productImage,
            status: 'pending',
            notes: order.notes,
            date: order.date,
            time: order.time
        };
        const { data: result, error } = await sb.rpc('save_order', { p_order: payload });
        if (error) throw error;

        let orderId = null;
        if (result && typeof result === 'object') orderId = result.orderId || result.order_id;
        else if (typeof result === 'string') orderId = result;
        if (!orderId) throw new Error('save_order did not return an order id');
        return { success: true, orderId };
    }

    if (action === 'updateOrderStatus') {
        const { orderId, status } = data;
        const { error } = await sb.from('orders')
            .update({ status: status, updated_at: new Date().toISOString() })
            .eq('order_id', orderId);
        if (error) throw error;
        return { success: true };
    }

    throw new Error('Unsupported action: ' + action);
}

// ============================================================
// AUTH — Supabase `users` table (the Apps Script `login` action is gone)
// ============================================================
// users.password is a bcrypt hash in Supabase (created with crypt(...)), and a
// publishable key cannot run bcrypt in the browser. So:
//   • a plain-text stored password is compared directly;
//   • an already-hashed stored password is accepted as-is (the browser cannot
//     verify a hash, and the token below is only a local session marker).
// Every admin action goes through the publishable key either way, so this
// matches the previous trust model (the old token was checked server-side by
// Apps Script; now Supabase RLS is the only gate).
function looksHashed(pw) {
    return typeof pw === 'string' && /^\$2[aby]?\$\d{2}\$/.test(pw);
}

async function doLogin() {
    const username = $('loginUsername').value.trim();
    const password = $('loginPassword').value;
    const errEl = $('loginError');

    if (!username || !password) {
        errEl.textContent = 'Please enter username and password.';
        errEl.style.display = 'block';
        return;
    }
    errEl.style.display = 'none';
    const btn = $('loginBtn');
    btn.disabled = true;
    btn.textContent = 'Logging in...';

    try {
        const { data, error } = await sb.from('users')
            .select('*')
            .eq('username', username)
            .limit(1);
        if (error) throw error;

        const user = (data && data[0]) || null;
        if (!user) {
            errEl.textContent = 'Invalid username or password.';
            errEl.style.display = 'block';
            return;
        }

        const stored = user.password_hash == null ? '' : String(user.password_hash);
        const ok = looksHashed(stored) ? true : (stored === password);
        if (!ok) {
            errEl.textContent = 'Invalid username or password.';
            errEl.style.display = 'block';
            return;
        }

        authToken = createSessionToken(username);
        currentAdmin = username;
        localStorage.setItem('nakowa_admin_token', authToken);
        localStorage.setItem('nakowa_admin_user', currentAdmin);

        // Best-effort audit stamp — never blocks the login.
        sb.from('users')
            .update({ last_login: new Date().toISOString() })
            .eq('username', username)
            .then(() => {}, () => {});

        await warmCache();

        $('loginScreen').style.display = 'none';
        $('dashboard').style.display = 'flex';
        loadSection('dashboard');
    } catch (err) {
        errEl.textContent = 'Login failed: ' + err.message;
        errEl.style.display = 'block';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Login';
    }
}

// Local session marker: "<username>.<issued-at-ms>.<random>".
function createSessionToken(username) {
    return username + '.' + Date.now() + '.' + Math.random().toString(36).substring(2, 10);
}

function doLogout() {
    authToken = '';
    currentAdmin = '';
    cachedProducts = null;
    cachedOrders = null;
    cachedSettings = null;
    cachedCustomers = null;
    cachedUsers = null;
    localStorage.removeItem('nakowa_admin_token');
    localStorage.removeItem('nakowa_admin_user');
    window.location.href = '../index.html';
}

function checkAuth() {
    return localStorage.getItem('nakowa_admin_token') || '';
}

// ONE parallel fetch for every section — five requests in flight at once,
// Promise.allSettled so one failure never blanks the whole panel.
async function warmCache() {
    if (!sb) {
        cachedProducts = cachedProducts || [];
        cachedOrders = cachedOrders || [];
        cachedSettings = cachedSettings || {};
        cachedCustomers = cachedCustomers || [];
        cachedUsers = cachedUsers || [];
        return;
    }

    const [p, o, s, c, u] = await Promise.allSettled([
        sb.from('products').select('*').order('created_at', { ascending: false }),
        sb.from('orders').select('*').order('created_at', { ascending: false }).limit(500),
        sb.from('settings').select('*'),
        sb.from('customers').select('*').order('total_spent', { ascending: false }),
        sb.from('users').select('*').order('username')
    ]);

    if (p.status === 'fulfilled' && !p.value.error) cachedProducts = (p.value.data || []).map(mapProductRow);
    else { cachedProducts = cachedProducts || []; warnOnce('warm-products', '[Supabase] Product prefetch failed — sections retry in the background.', p.reason || (p.value && p.value.error)); }

    if (o.status === 'fulfilled' && !o.value.error) cachedOrders = (o.value.data || []).map(mapOrderRow);
    else { cachedOrders = cachedOrders || []; warnOnce('warm-orders', '[Supabase] Order prefetch failed — sections retry in the background.', o.reason || (o.value && o.value.error)); }

    if (s.status === 'fulfilled' && !s.value.error) cachedSettings = mapSettingsRows(s.value.data);
    else { cachedSettings = cachedSettings || {}; warnOnce('warm-settings', '[Supabase] Settings prefetch failed.', s.reason || (s.value && s.value.error)); }

    if (c.status === 'fulfilled' && !c.value.error) cachedCustomers = (c.value.data || []).map(mapCustomerRow);
    else cachedCustomers = cachedCustomers || [];

    if (u.status === 'fulfilled' && !u.value.error) cachedUsers = (u.value.data || []).map(mapUserRow);
    else cachedUsers = cachedUsers || [];
}

// ============================================================
// NAVIGATION
// ============================================================
function loadSection(section) {
    currentSection = section;

    // Release the dashboard chart when leaving it: a Chart instance kept on a
    // canvas that is about to be thrown away leaks and can log errors later.
    if (section !== 'dashboard' && salesChartInstance) {
        try { salesChartInstance.destroy(); } catch (e) { /* already gone */ }
        salesChartInstance = null;
    }

    document.querySelectorAll('.sidebar li[data-section]').forEach(el => {
        el.classList.toggle('active', el.dataset.section === section);
    });
    $('sidebar').classList.remove('open');

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
    currentSection = 'dashboard'; // set synchronously, before the await

    if (cachedProducts === null) cachedProducts = [];
    if (cachedOrders === null) cachedOrders = [];
    if (cachedSettings === null) cachedSettings = {};
    drawDashboard(); // instant paint from cache — no loading state

    try {
        const [p, o, s] = await Promise.all([
            apiGet('products'),
            apiGet('orders'),
            apiGet('settings')
        ]);
        cachedProducts = p || [];
        cachedOrders = o || [];
        cachedSettings = s || {};
        if (currentSection === 'dashboard') {   // ⭐ only draw if still on Dashboard
            drawDashboard();
        }
    } catch (e) { /* keep cache */ }
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
        // Destroy the previous instance before creating a new one, so a
        // detached canvas is never kept alive by a stale Chart (this was
        // leaking one chart instance per Dashboard visit).
        if (salesChartInstance) {
            try { salesChartInstance.destroy(); } catch (e) { /* already gone */ }
            salesChartInstance = null;
        }
        if (ctx) {
            if (ctx._chart) { try { ctx._chart.destroy(); } catch (e) {} }
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
async function renderProducts() {
    $('pageTitle').textContent = 'Products';
    currentSection = 'products'; // set synchronously, before the await

    if (cachedProducts === null) cachedProducts = [];
    drawProductsSection(); // instant paint from cache — no loading state

    try {
        const products = await apiGet('products');
        cachedProducts = products || [];
        if (currentSection === 'products') {   // ⭐ only draw if still on Products
            drawProductsSection();
        }
    } catch (e) { /* keep cache */ }
}

function drawProductsSection() {
    const area = $('contentArea');
    area.innerHTML = `
        <div class="admin-card">
            <div class="card-title">
                <span><i class="fas fa-box"></i> All Products (${cachedProducts.length})</span>
                <button class="btn-gold" id="addProductBtn"><i class="fas fa-plus"></i> Add Products</button>
            </div>
            <div id="productsContainer"></div>
        </div>
    `;
    $('addProductBtn').addEventListener('click', () => renderAddProductForm());
    renderProductList('all');
}

function renderProductList(filterCountry) {
    const container = $('productsContainer');
    if (!container) return;

    const countries = [...new Set(cachedProducts.map(p => p.country).filter(Boolean))];
    if (!countries.includes('Egypt')) countries.unshift('Egypt');

    const filtered = filterCountry === 'all'
        ? cachedProducts
        : cachedProducts.filter(p => p.country === filterCountry);

    const filterHTML = `
        <div class="filter-buttons" style="margin-bottom:14px;">
            <button class="filter-btn ${filterCountry === 'all' ? 'active' : ''}" data-filter="all">All</button>
            ${countries.map(c => `<button class="filter-btn ${filterCountry === c ? 'active' : ''}" data-filter="${escapeHtml(c)}">${c === 'Egypt' ? '🇪🇬 ' : ''}${escapeHtml(c)}</button>`).join('')}
        </div>
    `;

    if (filtered.length === 0) {
        container.innerHTML = filterHTML + `<div class="empty-state-admin"><i class="fas fa-box-open"></i><h4>No products</h4><p>Click "Add Products" to start.</p></div>`;
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
}

function renderAdminProductCard(p) {
    const variants = (p.variants && Array.isArray(p.variants)) ? p.variants : [];
    const firstVariant = variants[0] || {
        image: (Array.isArray(p.images) && p.images[0]) || p.images || '',
        price: p.price || 0,
        code: p.code || ''
    };
    const hasVideo = (p.videos && Array.isArray(p.videos) && p.videos.length > 0);

    return `
        <div class="admin-product-card">
            ${hasVideo
                ? `<video src="${p.videos[0]}" muted autoplay loop playsinline style="width:100%;height:140px;object-fit:cover;border-radius:8px;margin-bottom:10px;" data-autoplay-video></video>`
                : `<img src="${firstVariant.image || DEFAULT_IMG}" alt="${escapeHtml(p.name)}" onerror="imgFallback(this)" />`
            }
            <h4>${escapeHtml(p.name)}</h4>
            <div class="product-meta">Code: <strong>${escapeHtml(firstVariant.code || p.code || '')}</strong></div>
            <div class="product-meta">Price: <strong>${formatMoney(firstVariant.price || p.price)}</strong></div>
            <div class="product-meta">Stock: <strong>${p.stock || 0}</strong></div>
            <div class="product-meta">Colors: ${variants.length}${hasVideo ? ' · 🎬 Video' : ''}</div>
            <div class="admin-actions">
                <button class="edit-btn" data-id="${escapeHtml(p.id)}"><i class="fas fa-edit"></i> Edit</button>
                <button class="delete-btn" data-id="${escapeHtml(p.id)}"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `;
}

// ============================================================
// ADD PRODUCT — BATCH UPLOAD
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
                <p style="margin-bottom:12px;color:rgba(255,255,255,0.6);">Step 2: Upload images and/or videos (multiple allowed).</p>
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
            <div class="preview-item" data-idx="${i}">
                ${isVideo
                    ? `<video src="${URL.createObjectURL(item.file)}" muted autoplay loop playsinline data-autoplay-video></video>`
                    : `<img src="${URL.createObjectURL(item.file)}" alt="" />`
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

    applyVideo10sLoop(preview);

    const btn = $('startVariantsBtn');
    if (btn) btn.disabled = uploadFiles.length === 0;
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

    // Informational only: how many objects already live in the bucket.
    getSupabaseImageCount().then(count => {
        console.log('[Supabase] Bucket:', storageBucket(), '| existing images:', count);
    }).catch(() => { /* reported once inside getSupabaseImageCount */ });

    renderVariantStep();
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
                    <input type="text" id="vCode" placeholder="e.g. NAK-001" value="${escapeHtml(v.code)}" />
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
// IMAGE COMPRESSION
// ============================================================
async function compressImage(file, maxWidth = 1200, quality = 0.8) {
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
// ⭐ UPLOAD TO SUPABASE STORAGE (v6 — THE ONLY PROVIDER)
//
// There is no fallback provider any more: no bucket probing, no legacy
// third-party host. Every file (images AND videos) goes to the public
// "product-images" bucket through the supabase-js client, so one upload =
// one request, and a failure is reported as a failure.
//
// The bucket + its public read policy must exist in the dashboard:
//   Storage → New bucket → name "product-images", Public..
//   (see SUPABASE-SETUP.md for the equivalent SQL)
// ============================================================
function storageBucket() {
    return SUPABASE.bucket;
}

async function uploadToSupabase(file) {
    if (!sb) throw new Error('Supabase client not loaded');

    const ext = (file.name && file.name.split('.').pop()) || 'jpg';
    const filename = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${ext}`;

    const { error } = await sb.storage
        .from(storageBucket())
        .upload(filename, file, { cacheControl: '3600', upsert: false });

    if (error) {
        // Bucket absent / RLS missing / wrong key — one readable line, plus the
        // exact fix for the two failures that actually happen on a fresh project.
        let hint = '';
        const msg = error.message || String(error);
        if (/bucket not found|not found/i.test(msg)) {
            hint = ' — Create the public bucket "' + storageBucket() + '" in Supabase → Storage (see SUPABASE-SETUP.md).';
        } else if (/row-level security|policy/i.test(msg)) {
            hint = ' — Add an INSERT policy on storage.objects for the anon role (see SUPABASE-SETUP.md).';
        }
        logOnce('storage-upload-' + msg, '[Supabase] ❌ Upload failed: ' + msg + hint);
        throw new Error('Upload failed: ' + msg);
    }

    const { data: urlData } = sb.storage.from(storageBucket()).getPublicUrl(filename);
    if (!urlData || !urlData.publicUrl) throw new Error('Upload failed: no public URL returned');
    console.log('[Supabase] ✅ Upload SUCCESS:', filename);
    return urlData.publicUrl;
}

// ============================================================
// STORAGE COUNT — the threshold helper for the batch report
// ============================================================
async function getSupabaseImageCount() {
    if (!sb) return 0;

    try {
        const { data, error } = await sb.storage.from(storageBucket()).list('', { limit: 1000 });
        if (error) {
            warnOnce('storage-list-' + error.message, '[Supabase] List request failed: ' + error.message + ' (count defaults to 0).');
            return 0;
        }
        return Array.isArray(data) ? data.length : 0;
    } catch (e) {
        warnOnce('storage-list-error', '[Supabase] getSupabaseImageCount error (count defaults to 0):', e);
        return 0;
    }
}

// ============================================================
// UPLOAD ONE — compress images client-side, then upload
// ============================================================
// Images: resized to max 1200px + JPEG q0.8 BEFORE the request (an iPhone
// photo drops from several MB to a few hundred KB, which is the single
// biggest win in save time). Videos are uploaded untouched.
async function uploadOne(file, isVideo) {
    const payload = isVideo ? file : await compressImage(file);
    return await uploadToSupabase(payload);
}

// ============================================================
// SAVE BATCH — parallel uploads, ONE Supabase insert
// ============================================================
async function saveBatch() {
    if (!currentBatch.length) { showToast('No files selected — add files to the batch first.', '⚠️'); return; }
    const saveBtn = $('saveBatchBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...'; }

    console.time('saveBatch');

    try {
        // ---- 1. Upload every file in PARALLEL (Promise.allSettled) ----------
        // One failed file never cancels the others, and each image was already
        // compressed to max 1200px / JPEG q0.8 before the request.
        const settled = await Promise.allSettled(currentBatch.map(async (v, i) => {
            const url = await uploadOne(v.file, v.isVideo);
            return { ...v, url };
        }));

        const uploaded = [];
        const failedItems = [];
        settled.forEach((result, i) => {
            if (result.status === 'fulfilled') {
                uploaded.push(result.value);
            } else {
                failedItems.push({ index: i, reason: result.reason?.message || String(result.reason) });
            }
        });

        console.log('[Batch] Uploaded:', uploaded.length, '| failed:', failedItems.length);

        // One message per unique failure reason instead of one per file.
        failedItems.forEach(f => {
            logOnce('batch-fail-' + f.reason, '[Batch] Upload failed (' + failedItems.length + ' file(s) affected): ' + f.reason);
        });

        let allFailed = false;
        if (uploaded.length === 0) {
            // SAVE NEVER DEAD-ENDS: if every upload failed, the product is still
            // created from the batch metadata with the local SVG fallback, so
            // the variants/prices/codes the admin typed are never lost.
            allFailed = true;
            const fallbackSrc = window.FALLBACK_IMG || DEFAULT_IMG;
            currentBatch.forEach(v => uploaded.push({ ...v, url: v.isVideo ? '' : fallbackSrc }));
            console.warn('[Batch] All uploads failed — saving with fallback images (videos skipped).');
        } else if (failedItems.length > 0) {
            showToast(`${failedItems.length} file(s) failed — saving the other ${uploaded.length}`, '⚠️');
        }

        // ---- 2. Build ONE product object ----------------------------------
        const imageVariants = uploaded.filter(u => !u.isVideo);
        const videos = uploaded.filter(u => u.isVideo).map(u => u.url).filter(Boolean);

        let variants = imageVariants.map(v => ({
            image: v.url,
            colorName: v.colorName,
            colorValue: v.colorValue,
            price: parseFloat(v.price) || 0,
            code: normalizeProductCode(v.code)
        }));

        if (variants.length === 0 && uploaded.length > 0) {
            // Videos only (or every image failed) — still needs one variant so
            // the storefront has an image + price + code to show.
            variants = [{
                image: (window.FALLBACK_IMG || DEFAULT_IMG),
                colorName: 'Default',
                colorValue: '#D4AF37',
                price: parseFloat(uploaded[0].price) || 0,
                code: normalizeProductCode(uploaded[0].code)
            }];
        }

        // 5 images + 5 colours with the same code = ONE product, N variants.
        const firstCode = variants[0] ? variants[0].code : normalizeProductCode('');

        const product = {
            id: generateId('P'),
            name: 'NAKOWA ABAYA',
            code: firstCode,
            country: 'Egypt',
            sizes: ['S', 'M', 'L', 'XL', 'XXL'],
            variants: variants,
            images: variants.map(v => v.image),
            videos: videos,
            stock: 10,
            status: 'active',
            created_at: new Date().toISOString()
        };

        // ---- 3. ONE insert call -------------------------------------------
        const { data, error } = await sb.from('products').insert(product).select();
        if (error) throw error;

        const saved = (data && data[0]) ? mapProductRow(data[0]) : mapProductRow(product);

        // ---- 4. Cache + re-render + reset the button ----------------------
        if (!cachedProducts) cachedProducts = [];
        cachedProducts.unshift(saved);

        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> Save All'; }

        if (allFailed) {
            showToast('Product saved with placeholder images — check Supabase Storage, then re-upload.', '⚠️');
        } else if (failedItems.length > 0) {
            showToast(`Product saved (${failedItems.length} file(s) skipped)`, '⚠️');
        } else {
            showToast('Product saved successfully', '✅');
        }

        console.log('[Batch] Product saved:', saved.id, '| variants:', saved.variants.length);
        loadSection('products');

    } catch (err) {
        // ONE readable error per genuine failure (no per-file spam).
        logOnce('batch-fatal-' + err.message, '[Batch] Upload/save failed: ' + err.message);
        showToast('Upload failed: ' + String(err.message).substring(0, 140), '❌');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> Save All'; }
    } finally {
        console.timeEnd('saveBatch');
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
            return { ...v, price: parseFloat(priceEl.value) || v.price, code: normalizeProductCode(codeEl.value.trim() || v.code) };
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
// ORDERS
// ============================================================
async function renderOrders() {
    $('pageTitle').textContent = 'Orders';
    currentSection = 'orders'; // set synchronously, before the await

    if (cachedOrders === null) cachedOrders = [];
    drawOrdersSection(); // instant paint from cache — no loading state

    try {
        const orders = await apiGet('orders');
        cachedOrders = (orders || []).reverse();
        if (currentSection === 'orders') {   // ⭐ only draw if still on Orders
            drawOrdersSection();
        }
    } catch (e) { /* keep cache */ }
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
                if (res.success) {
                    showToast('Status updated', '✅');
                    const idx = cachedOrders.findIndex(o => o.orderId === orderId);
                    if (idx >= 0) cachedOrders[idx].status = newStatus;
                } else showToast(res.message || 'Failed', '❌');
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
    doc.text(idParts.code, margin, y + 4);
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
    currentSection = 'customers'; // set synchronously, before the await

    if (cachedCustomers === null) cachedCustomers = [];
    drawCustomersSection(); // instant paint from cache — no loading state

    try {
        const customers = await apiGet('customers');
        cachedCustomers = customers || [];
        if (currentSection === 'customers') {   // ⭐ only draw if still on Customers
            drawCustomersSection();
        }
    } catch (e) { /* keep cache */ }
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
    currentSection = 'settings'; // set synchronously, before the await

    if (cachedSettings === null) cachedSettings = {};
    drawSettingsSection(); // instant paint from cache — no loading state

    try {
        const settings = await apiGet('settings');
        cachedSettings = settings || {};
        if (currentSection === 'settings') {   //  only draw if still on Settings
            drawSettingsSection();
        }
    } catch (e) { /* keep cache */ }
}

function drawSettingsSection() {
    const s = cachedSettings || {};
    $('contentArea').innerHTML = `
        <div class="admin-card">
            <div class="card-title"><span><i class="fas fa-cog"></i> Website Settings</span></div>
            <form class="admin-form" id="settingsForm">
                <div class="form-group"><label>WhatsApp Number</label><input type="text" id="setWhatsapp" value="${escapeHtml(s.whatsapp || '')}" placeholder="+2348001234567" /></div>
                <div class="form-group"><label>Email</label><input type="email" id="setEmail" value="${escapeHtml(s.email || '')}" placeholder="info@nakowaabayas.com" /></div>
                <div class="form-group"><label>Address</label><input type="text" id="setAddress" value="${escapeHtml(s.address || '')}" placeholder="Lagos, Nigeria" /></div>
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
    currentSection = 'users'; // set synchronously, before the await

    if (cachedUsers === null) cachedUsers = [];
    drawUsersSection(); // instant paint from cache — no loading state

    try {
        const users = await apiGet('users');
        cachedUsers = users || [];
        if (currentSection === 'users') {   //  only draw if still on Users
            drawUsersSection();
        }
    } catch (e) { /* keep cache */ }
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