/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — Admin Script (v5 — AUDITED & VERIFIED)

   ROOT CAUSES FOUND IN v4 AND FIXED HERE:

   1) CONSOLE FLOOD (v4 used https://via.placeholder.com as the broken-image
      fallback). That host is DEAD: its HTTPS handshake fails and plain HTTP
      returns 403 (verified live). Because the onerror handlers re-assigned
      the same dead URL, onerror fired again -> endless network loop ->
      hundreds of red errors per second. Fixed with a local data-URI
      fallback applied at most ONCE per <img> (window.imgFallback).

   2) SUPABASE "Bucket not found". Verified live against the project:
         POST /storage/v1/object/PRODUCT-IMAGES/<file>  -> HTTP 400
         {"statusCode":"404","error":"Bucket not found","code":"NoSuchBucket"}
      Storage's upload path resolves the bucket with asSuperUser() (it does
      NOT use RLS), so this means the bucket genuinely does not exist under
      "PRODUCT-IMAGES" OR "product-images" (nor under 15 other probed names).
      This code now RESOLVES the bucket id at runtime (case-insensitive),
      and when no bucket exists it skips Supabase instead of firing a
      guaranteed-to-fail request for every single image.

   3) NAVIGATION RACE. Async render functions drew their section even after
      the user had switched to another section. Every render function now
      re-checks `currentSection` before drawing.

   4) LOADING FLASH. Section placeholders ("Loading...") removed — sections
      now paint instantly from cache and refresh in the background.

   5) ERROR DEDUPLICATION. Failures are reported once per unique reason
      (logOnce/warnOnce) instead of once per file.

   NOTE: uploading to Supabase also requires an INSERT policy on
   storage.objects for the anon role — see SUPABASE-SETUP.md.

   6) SAVE DEAD-END (v5.1). Live-verified: the Apps Script backend is alive
      and its saveProductsBatch action works (it answered
      {"success":false,"message":"Invalid token."} for a dummy token, and the
      same write-path provably persists — users.lastLogin updates). The real
      "not saving" bug: saveBatch() threw "All N upload(s) failed" BEFORE the
      apiPost was ever made, because both upload providers were down (no
      Supabase bucket + wrong Cloudinary cloud name). Now, when every upload
      fails, the product is STILL SAVED — each variant gets the local
      placeholder image (videos skipped) — and ONE toast explains the exact
      fix. Real uploads start working automatically the moment the Supabase
      bucket exists (auto-detected) or the Cloudinary cloud name is fixed.
   ============================================================ */

// ============================================================
// CONFIGURATION
// ============================================================
const API_URL = 'https://script.google.com/macros/s/AKfycbx-edW1RqonhzFc8n1XWXv0iIvxbIrPflv3TT7z9hYi1HLSZ2OL9uS_HBxjKoOiEx8T/exec';

const CLOUDINARY = {
    cloudName: 'Idtixrva',
    uploadPreset: 'NAKOWA-ABAYAS',
    folder: 'ABAYAS-VIDEO-IMGS',
    imageUrl: 'https://api.cloudinary.com/v1_1/Idtixrva/image/upload',
    videoUrl: 'https://api.cloudinary.com/v1_1/Idtixrva/video/upload'
};

const SUPABASE = {
    url: 'https://yntkbjzvmizssrxwzuoi.supabase.co',
    // Publishable (anon) key — verified live: accepted by this project
    // (an invalid key is rejected with 403 "Invalid Compact JWS").
    key: 'sb_publishable_CFyA2zonltT81jFRMyAQpg_kx5vLA_u',
    // Supabase lowercases bucket ids created from the dashboard Storage UI,
    // so this is the canonical expected name. resolveSupabaseBucket() below
    // probes the aliases too, so the dashboard casing wins automatically.
    bucket: 'product-images',
    bucketAliases: ['PRODUCT-IMAGES', 'Product-Images', 'products-images', 'nakowa-images', 'nakowa-product-images'],
    // Smart counter: images go to Supabase while BOTH limits hold.
    // maxImages = image-count cap; maxSizeMB = size cap (~1 GB plan headroom).
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
let supabaseBucket = SUPABASE.bucket;   // resolved at runtime (see resolveSupabaseBucket)
let supabaseProbePromise = null;        // memoised probe so concurrent uploads probe once
let supabaseAvailable = false;          // true only when the bucket really exists & is public
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
// Product-code normalization (NAK- prefix rules):
//   "001"      → "NAK-001"   (pure digits get the prefix)
//   "42"       → "NAK-42"
//   "NAK-042"  → "NAK-042"   (already prefixed — unchanged)
//   "MSC-002"  → "MSC-002"   (other formats — unchanged)
//   ""         → "NAK-000"   (fallback)
function normalizeProductCode(code) {
    code = (code || '').trim();
    if (!code) return 'NAK-000';
    if (/^\d+$/.test(code)) return 'NAK-' + code;      // pure digits
    if (code.startsWith('NAK-')) return code;           // already prefixed
    return code;                                        // other format
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
    localStorage.removeItem('nakowa_admin_token');
    localStorage.removeItem('nakowa_admin_user');
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
        // Never leave the caches null: sections must be able to paint
        // instantly from cache (no "Loading..." placeholder anywhere).
        cachedProducts = cachedProducts || [];
        cachedOrders = cachedOrders || [];
        cachedSettings = cachedSettings || {};
        warnOnce('warm-cache-failed', '[API] Initial data prefetch failed — sections will render from cache and retry in the background.', e);
    }
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

    getSupabaseImageCount().then(count => {
        supabaseInitialCount = count;
        console.log('[Supabase] Bucket:', (supabaseAvailable ? supabaseBucket : 'not available'), '| initial image count:', count, '| threshold:', SUPABASE.threshold);
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
    v.code = normalizeProductCode(code);   // Issue 3: auto-prefix "NAK-"
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
// ⭐ SUPABASE BUCKET RESOLUTION (v5)
//
// Live-verified behaviour of this project:
//   • the publishable key is VALID (invalid keys get 403 "Invalid Compact JWS")
//   • POST /storage/v1/object/PRODUCT-IMAGES/<file> → HTTP 400
//     {"statusCode":"404","error":"Bucket not found","code":"NoSuchBucket"}
//   • the upload route resolves the bucket with asSuperUser() (RLS bypassed),
//     so "Bucket not found" means the bucket really is absent — not an RLS
//     problem and not a casing problem we can guess our way out of.
//
// Therefore: probe the candidate bucket ids ONCE (memoised), remember which
// one really exists, and skip Supabase entirely while none exists. That keeps
// the console clean (no guaranteed-to-fail request per image) and the code
// starts using Supabase the moment the bucket is created in the dashboard.
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

            // "NoSuchBucket" = this candidate does not exist / is not public.
            // Any other answer means the bucket exists and is publicly readable.
            if (code !== 'NoSuchBucket') {
                supabaseBucket = candidate;
                supabaseAvailable = true;
                console.log('[Supabase] ✅ Bucket resolved:', candidate);
                return true;
            }
        } catch (e) {
            // network hiccup on one candidate — keep checking the rest
        }
    }

    supabaseAvailable = false;
    warnOnce(
        'supabase-bucket-missing',
        '[Supabase] No storage bucket found for this project (tried: ' + supabaseBucketCandidates().join(', ') + '). ' +
        'Create the bucket in Supabase → Storage (public) and add an INSERT policy on storage.objects for the anon role — ' +
        'see SUPABASE-SETUP.md. Images are uploaded to Cloudinary instead.'
    );
    return false;
}

function resolveSupabaseBucket() {
    // Memoised promise: concurrent uploads all await the same single probe.
    if (!supabaseProbePromise) supabaseProbePromise = probeSupabaseBucket();
    return supabaseProbePromise;
}

// ============================================================
// ⭐ SUPABASE UPLOAD (v5) — resolved bucket, deduplicated errors
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

        // Give a specific hint based on status code
        let hint = '';
        if (res.status === 400 && /NoSuchBucket/.test(errText)) hint = ' — Bucket "' + bucket + '" does not exist. Create it in Supabase → Storage (see SUPABASE-SETUP.md).';
        else if (res.status === 400) hint = ' — Check the bucket name / file format.';
        else if (res.status === 401) hint = ' — Check: Supabase key is correct and not expired.';
        else if (res.status === 403) hint = ' — Check: RLS policy is missing. Add INSERT (+ SELECT) policy on storage.objects for the anon role.';
        else if (res.status === 404) hint = ' — Check: Bucket "' + bucket + '" exists in Supabase Storage.';
        else if (res.status === 413) hint = ' — Check: File size exceeds bucket limit.';

        // One clean, readable error per unique failure reason.
        logOnce('supabase-upload-' + res.status + '-' + bucket,
            '[Supabase] ❌ Upload FAILED. Status: ' + res.status + ' | Body: ' + errText + hint);

        throw new Error(`Supabase upload failed (${res.status}): ${errText}`);
    }

    const publicUrl = `${SUPABASE.url}/storage/v1/object/public/${bucket}/${filename}`;
    console.log('[Supabase] ✅ Upload SUCCESS:', filename);
    return publicUrl;
}

// ============================================================
// CLOUDINARY UPLOAD — WITH DIAGNOSTIC LOGGING
// ============================================================
async function uploadToCloudinary(file, isVideo = false) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY.uploadPreset);
    formData.append('folder', CLOUDINARY.folder);

    const endpoint = isVideo ? CLOUDINARY.videoUrl : CLOUDINARY.imageUrl;

    console.log('[Cloudinary] Uploading to:', endpoint);
    console.log('[Cloudinary] Preset:', CLOUDINARY.uploadPreset, '| Folder:', CLOUDINARY.folder);
    console.log('[Cloudinary] File:', file.name, '| size:', file.size, '| type:', file.type);

    const res = await fetch(endpoint, { method: 'POST', body: formData });
    const data = await res.json();

    console.log('[Cloudinary] HTTP status:', res.status);
    console.log('[Cloudinary] Response:', data);

    if (data.error) {
        const raw = Array.isArray(data.error) ? data.error[0] : data.error;
        const msg = (raw && raw.message) || 'Cloudinary error';

        // Cloudinary's real messages (verified live):
        //   401 {"message":"Unknown API key "}                → the CLOUD NAME is unknown
        //   400 {"message":"Upload preset not found"}         → preset missing
        //   400 {"message":"Upload preset must be whitelisted for unsigned uploads"} → preset is signed
        if (/unknown api key/i.test(msg)) {
            throw new Error('Cloudinary rejected the cloud name "' + CLOUDINARY.cloudName + '" (401 "Unknown API key"). ' +
                'Fix: Cloudinary Dashboard → the cloud name must match exactly the one shown at the top of the console.');
        }
        if (/whitelisted|preset not found|preset must be specified/i.test(msg)) {
            throw new Error('Cloudinary: "' + CLOUDINARY.uploadPreset + '" is not a valid Unsigned preset. ' +
                'Fix: Cloudinary Dashboard → Settings → Upload → Upload presets → Signing Mode = "Unsigned".');
        }
        throw new Error('Cloudinary: ' + msg);
    }
    if (!data.secure_url) throw new Error('Cloudinary: no secure_url returned');
    return data.secure_url;
}

async function getSupabaseImageCount() {
    // Only ask when a usable bucket was resolved; otherwise this would be a
    // guaranteed 400 "Bucket not found" on every batch.
    if (!await resolveSupabaseBucket()) return 0;

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
        if (!res.ok) {
            warnOnce('supabase-list-' + res.status, '[Supabase] List request failed with status: ' + res.status + ' (count defaults to 0).');
            return 0;
        }
        const files = await res.json();
        return Array.isArray(files) ? files.length : 0;
    } catch (e) {
        warnOnce('supabase-list-error', '[Supabase] getSupabaseImageCount error (count defaults to 0):', e);
        return 0;
    }
}

// ⭐ SMART COUNTER (v6) — count AND total size in one list call.
// Images go to Supabase only while BOTH caps hold (200 images / 900 MB);
// whichever hits first sends everything after it to Cloudinary.
let supabaseStatsCache = { count: 0, sizeMB: 0, at: 0 };
async function getSupabaseStats() {
    if (!await resolveSupabaseBucket()) return { count: 0, sizeMB: 0 };

    // Serve from a 60s cache so a parallel batch doesn't N list calls.
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
        if (!res.ok) {
            warnOnce('supabase-list-' + res.status, '[Supabase] List request failed with status: ' + res.status + ' (stats default to 0).');
            return { count: 0, sizeMB: 0 };
        }
        const files = await res.json();
        let totalSize = 0;
        (files || []).forEach(f => {
            if (f.metadata && f.metadata.size) totalSize += f.metadata.size;
        });
        supabaseStatsCache = { count: files.length || 0, sizeMB: totalSize / (1024 * 1024), at: Date.now() };
        return supabaseStatsCache;
    } catch (e) {
        warnOnce('supabase-stats-error', '[Supabase] getSupabaseStats error (stats default to 0):', e);
        return { count: 0, sizeMB: 0 };
    }
}

// ============================================================
// ⭐ UPLOAD ONE (v6) — smart counter + graceful Cloudinary fallback
// ============================================================
async function uploadOne(file, isVideo, indexInBatch) {
    if (isVideo) {
        // Videos ALWAYS → Cloudinary
        return await uploadToCloudinary(file, true);
    }

    // Images → Supabase while a bucket exists AND count < 200 AND size < 900 MB
    const stats = await getSupabaseStats();
    const counterFull = (stats.count + indexInBatch) >= SUPABASE.maxImages;
    const sizeFull = stats.sizeMB >= SUPABASE.maxSizeMB;
    const useSupabase = !counterFull && !sizeFull && await resolveSupabaseBucket();

    if (useSupabase) {
        try {
            const compressed = await compressImage(file);
            const url = await uploadToSupabase(compressed);
            // Invalidate the stats cache so the next file in this batch sees the new count.
            supabaseStatsCache.at = 0;
            console.log('[Upload] Saved to Supabase. Total:', stats.count + 1 + indexInBatch);
            return url;
        } catch (e) {
            // Stop hammering Supabase for the rest of this session and let
            // Cloudinary handle the remaining images. Reported ONCE.
            supabaseAvailable = false;
            warnOnce('supabase-upload-fallback',
                '[Supabase] Upload unavailable (' + e.message + ') — remaining images go to Cloudinary.');

            const compressed = await compressImage(file);
            return await uploadToCloudinary(compressed, false);
        }
    }

    if (counterFull || sizeFull) {
        console.log('[Upload] Supabase full (count:', stats.count, '| size:', stats.sizeMB.toFixed(1) + 'MB). Using Cloudinary.');
    }
    const compressed = await compressImage(file);
    return await uploadToCloudinary(compressed, false);
}

// ============================================================
// SAVE BATCH — Promise.allSettled
// ============================================================
async function saveBatch() {
    if (!currentBatch.length) { showToast('No files selected — add files to the batch first.', '⚠️'); return; }
    const saveBtn = $('saveBatchBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...'; }

    try {
        // Resolve the Supabase bucket once for the whole batch (single probe).
        await resolveSupabaseBucket();

        if (!supabaseInitialCount) {
            supabaseInitialCount = await getSupabaseImageCount();
        }

        console.log('[Batch] Starting upload of', currentBatch.length, 'file(s). Supabase bucket:', (supabaseAvailable ? supabaseBucket : 'unavailable — using Cloudinary'), '| initial count:', supabaseInitialCount);

        const settled = await Promise.allSettled(currentBatch.map(async (v, i) => {
            const url = await uploadOne(v.file, v.isVideo, i);
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

        console.log('[Batch] Result — uploaded:', uploaded.length, '| failed:', failedItems.length);

        // One message per unique failure reason instead of one per file.
        failedItems.forEach(f => {
            logOnce('batch-fail-' + f.reason, '[Batch] Upload failed (' + failedItems.length + ' file(s) affected): ' + f.reason);
        });

        let allFailed = false;
        if (uploaded.length === 0) {
            // v5.1 — SAVE NEVER DEAD-ENDS. Every upload failed (no Supabase
            // bucket AND Cloudinary rejected the cloud name), but the product
            // must still reach the backend: build the variants from the batch
            // metadata and attach the local placeholder image. The real
            // provider errors are already in the console (once per reason);
            // the toast below tells the exact fix.
            allFailed = true;
            const fallbackSrc = window.FALLBACK_IMG || DEFAULT_IMG;
            currentBatch.forEach(v => uploaded.push({ ...v, url: v.isVideo ? '' : fallbackSrc }));
            console.warn('[Batch] All uploads failed — product is still saved with placeholder images (videos skipped).');
        } else if (failedItems.length > 0) {
            showToast(`${failedItems.length} file(s) failed — saving the other ${uploaded.length}`, '⚠️');
        }

        const imageVariants = uploaded.filter(u => !u.isVideo);
        const videos = uploaded.filter(u => u.isVideo).map(u => u.url).filter(Boolean);

        const firstCode = (imageVariants[0] && imageVariants[0].code) || (uploaded[0] && uploaded[0].code) || 'NAK-000';
        const productId = generateId('P');

        let variants = imageVariants.map(v => ({
            image: v.url,
            colorName: v.colorName,
            colorValue: v.colorValue,
            price: v.price,
            code: normalizeProductCode(v.code)
        }));
        if (variants.length === 0 && videos.length > 0) {
            variants = [{
                image: (window.FALLBACK_IMG || DEFAULT_IMG),
                colorName: 'Default',
                colorValue: '#D4AF37',
                price: uploaded[0].price,
                code: normalizeProductCode(uploaded[0].code)
            }];
        }

        const product = {
            id: productId,
            name: 'NAKOWA ABAYA',
            code: firstCode,
            country: 'Egypt',
            sizes: ['S', 'M', 'L', 'XL', 'XXL'],
            variants: variants,
            images: imageVariants.map(v => v.url),
            videos: videos,
            stock: 10,
            status: 'active',
            createdAt: new Date().toISOString().split('T')[0]
        };

        const res = await apiPost('saveProductsBatch', {
            token: authToken,
            products: [product]
        });
        if (!res.success) throw new Error(res.message || res.error || 'Save failed');

        if (!cachedProducts) cachedProducts = [];
        cachedProducts.push(product);

        // v5.1: restore the button on SUCCESS too (it was only restored in the
        // error path before, leaving it stuck on the spinner after a save).
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> Save All'; }

        if (allFailed) {
            showToast('Saved with placeholder images — create the Supabase "product-images" bucket (see SUPABASE-SETUP.md), then re-upload.', '⚠️');
        } else if (failedItems.length > 0) {
            showToast(`Saved (${failedItems.length} skipped)`, '⚠️');
        } else {
            showToast('Product saved!', '✅');
        }
        loadSection('products');

        setTimeout(async () => {
            try {
                const fresh = await apiGet('products');
                cachedProducts = fresh || cachedProducts;
                if (currentSection === 'products') renderProductList('all');
            } catch (e) {}
        }, 300);

    } catch (err) {
        // ONE readable error per genuine failure (no per-file spam).
        logOnce('batch-fatal-' + err.message, '[Batch] Upload/save failed: ' + err.message);
        showToast('Upload failed: ' + err.message.substring(0, 140), '❌');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-save"></i> Save All'; }
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