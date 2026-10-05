/**
 * ============================================================
 * NAKOWA ABAYAS COLLECTIONS — BACKEND (Google Apps Script)
 * v6 — Client-side authentication, no ADMIN_API_KEY
 *
 * WHAT CHANGED vs v5
 *   • Removed the ADMIN_API_KEY check. The website login is
 *     entirely client-side now, so no shared key is needed on
 *     the server. Public and admin endpoints are all reachable.
 *   • Login / Change Password / Logout actions still return a
 *     stub message (they are handled in the browser).
 *
 * WHAT DID NOT CHANGE
 *   • Products, Orders, Customers, Settings, SalesLog, Users,
 *     Notifications sheets — all still used exactly as before.
 *   • AppSheet continues to own the data.
 * ============================================================
 */

// ============================================================
// CONFIGURATION
// ============================================================
const SPREADSHEET_ID = '1NgD9Ct2M51RCBL5L1su3PkUvmGLeaqkGOoL1umt-3kA';

const SHEETS = {
  PRODUCTS:      'Products',
  ORDERS:        'Orders',
  SETTINGS:      'Settings',
  NOTIFICATIONS: 'Notifications',
  SALES_LOG:     'SalesLog',
  CUSTOMERS:     'Customers',
  USERS:         'Users'
};

// Kept for legacy compatibility — client-side login only now.
const DEFAULT_ADMIN = {
  username: 'umar',
  password: '0708070',
  role: 'admin'
};

const DEFAULT_TIMEZONE = 'Africa/Cairo';

const CACHE_TTL_PRODUCTS = 30;
const CACHE_TTL_SETTINGS = 60;

// ============================================================
// CACHE HELPERS
// ============================================================
function cacheGet(key) {
  try {
    const val = CacheService.getScriptCache().get(key);
    return val ? JSON.parse(val) : null;
  } catch (e) { return null; }
}
function cachePut(key, value, seconds) {
  try { CacheService.getScriptCache().put(key, JSON.stringify(value), seconds || 60); } catch (e) {}
}
function cacheInvalidate(key) {
  try { CacheService.getScriptCache().remove(key); } catch (e) {}
}

// ============================================================
// JSON RESPONSE HELPER
// ============================================================
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// MAIN ENTRY — GET
// ============================================================
function doGet(e) {
  try {
    const action = e.parameter.action;
    let result;

    switch (action) {
      case 'products':      result = getProducts(); break;
      case 'settings':      result = getSettings(); break;
      case 'ping':          result = { success: true, message: 'NAKOWA ABAYAS backend alive.' }; break;
      case 'init':          result = initializeSheets(); break;

      case 'trackOrder':
        result = trackOrder(e.parameter.orderId || '', e.parameter.phone || '');
        break;

      case 'orders':        result = getOrders(); break;
      case 'notifications': result = getNotifications(); break;
      case 'saleslog':      result = getSalesLog(); break;
      case 'customers':     result = getCustomers(); break;
      case 'users':         result = getUsers(); break;

      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }

    return jsonOut(result);
  } catch (err) {
    return jsonOut({ success: false, error: err.toString() });
  }
}

// ============================================================
// MAIN ENTRY — POST
// ============================================================
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    let result;

    switch (action) {
      // ---- Public ----
      case 'saveOrder':         result = saveOrder(body.order); break;

      // ---- Login / Change Password / Logout handled in browser ----
      case 'login':             result = { success: false, message: 'Login is handled in the browser. Update admin.js.' }; break;
      case 'verifyToken':       result = { success: false, message: 'Token auth removed. Update admin.js.' }; break;
      case 'changePassword':    result = { success: false, message: 'Change password is handled in the browser. Update admin.js.' }; break;
      case 'logout':            result = { success: true }; break;
      case 'getOrderById':      result = getOrderById(body.orderId); break;

      // ---- Admin ----
      case 'saveProductsBatch': result = saveProductsBatch(body.products); break;
      case 'addProduct':        result = addProduct(body.product); break;
      case 'updateProduct':     result = updateProduct(body.product); break;
      case 'deleteProduct':     result = deleteProduct(body.id); break;
      case 'updateStock':       result = updateStock(body.id, body.stock); break;
      case 'bulkUpdatePrices':  result = bulkUpdatePrices(body.updates); break;
      case 'bulkDeleteProducts':result = bulkDeleteProducts(body.ids); break;

      case 'updateOrderStatus': result = updateOrderStatus(body.orderId, body.status); break;

      case 'updateSettings':    result = updateSettings(body.settings); break;

      case 'addUser':           result = addUser(body.user); break;
      case 'deleteUser':        result = deleteUser(body.username); break;
      case 'getUsers':          result = getUsers(); break;

      case 'saveNotification':  result = saveNotification(body.notification); break;
      case 'updateImageCount':  result = updateSetting('supabaseImageCount', body.count); break;
      case 'setupOnce':         result = setupOnce(); break;
  case 'resetOrders':       result = resetOrders(); break;

      default:
        result = { success: false, error: 'Unknown action: ' + action };
    }

    return jsonOut(result);
  } catch (err) {
    return jsonOut({ success: false, error: err.toString() });
  }
}

// ============================================================
// INIT — seeds the Users sheet row (legacy display only)
// ============================================================
function initializeSheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  let usersSheet = ss.getSheetByName(SHEETS.USERS);
  if (!usersSheet) {
    usersSheet = ss.insertSheet(SHEETS.USERS);
    usersSheet.appendRow(['username', 'passwordHash', 'role', 'createdAt', 'lastLogin']);
  }

  const usersData = usersSheet.getDataRange().getValues();
  let adminExists = false;
  for (let i = 1; i < usersData.length; i++) {
    if (usersData[i][0] === DEFAULT_ADMIN.username) { adminExists = true; break; }
  }

  if (!adminExists) {
    usersSheet.appendRow([
      DEFAULT_ADMIN.username,
      '(client-side auth)',
      DEFAULT_ADMIN.role,
      new Date().toISOString(),
      ''
    ]);
    return { success: true, message: 'Users sheet initialised.', adminCreated: true };
  }

  return { success: true, message: 'Users sheet already exists.' };
}

function setupOnce() {
  const result = initializeSheets();
  Logger.log(result);
  return result;
}

// ============================================================
// PUBLIC — TRACKING
// ============================================================
function trackOrder(orderId, phone) {
  if (!orderId || !phone) {
    return { success: false, message: 'Order ID and phone number are required.' };
  }
  const normalized = String(phone).replace(/\D/g, '');
  if (!normalized) return { success: false, message: 'Invalid phone number.' };

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.ORDERS);
  if (!sheet) return { success: false, message: 'Order not found.' };

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return { success: false, message: 'Order not found.' };

  const headers = data[0];
  const idxOrderId = headers.indexOf('orderId');
  const idxPhone   = headers.indexOf('customerPhone');
  if (idxOrderId === -1 || idxPhone === -1) {
    return { success: false, message: 'Order sheet is missing required columns.' };
  }

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[idxOrderId] || '') !== String(orderId)) continue;

    const rowPhone = String(row[idxPhone] || '').replace(/\D/g, '');
    if (rowPhone !== normalized) return { success: false, message: 'Order not found.' };

    const order = {};
    headers.forEach(function (h, k) { order[h] = row[k]; });

    var digits = String(order.customerPhone || '').replace(/\D/g, '');
    var maskedPhone = digits.length > 5
      ? digits.substring(0, 3) + '****' + digits.substring(digits.length - 2)
      : '****';

    return {
      success: true,
      order: {
        orderId:      order.orderId || '',
        status:       order.status || 'pending',
        date:         order.date || '',
        time:         order.time || '',
        productName:  order.productName || '',
        productCode:  order.productCode || '',
        colorName:    order.colorName || '',
        size:         order.size || '',
        quantity:     order.quantity || 1,
        price:        order.price || 0,
        total:        order.total || 0,
        productImage: order.productImage || '',
        maskedPhone:  maskedPhone
      }
    };
  }
  return { success: false, message: 'Order not found.' };
}

// ============================================================
// PRODUCTS — READ (public)
// ============================================================
function getProducts() {
  const cached = cacheGet('products_all');
  if (cached) return cached;

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.PRODUCTS);
  if (!sheet) return [];

  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  const headers = data[0];
  const products = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    const product = {};
    headers.forEach(function (h, idx) { product[h] = row[idx]; });

    if (product.variants && typeof product.variants === 'string') {
      try { product.variants = JSON.parse(product.variants); } catch (e) { product.variants = []; }
    }
    if (product.sizes && typeof product.sizes === 'string') {
      product.sizes = product.sizes.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    if (product.images && typeof product.images === 'string') {
      product.images = product.images.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    if (product.videos && typeof product.videos === 'string') {
      product.videos = product.videos.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }
    products.push(product);
  }
  cachePut('products_all', products, CACHE_TTL_PRODUCTS);
  return products;
}

// ============================================================
// PRODUCTS — BULK SAVE (merges by product id)
// ============================================================
function saveProductsBatch(products) {
  if (!Array.isArray(products)) return { success: false, message: 'products must be an array.' };
  if (products.length === 0) return { success: true, saved: 0, updated: 0 };

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.PRODUCTS);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('id');
  if (idCol === -1) return { success: false, message: 'Products sheet is missing the id column.' };

  var rowIndexById = {};
  for (var i = 1; i < data.length; i++) {
    var existingId = String(data[i][idCol] || '');
    if (existingId) rowIndexById[existingId] = i + 1;
  }

  var toAppend = [];
  var updatedCount = 0;

  products.forEach(function (p) {
    var row = [
      p.id || '', p.name || '', p.code || '', p.country || 'Egypt',
      Array.isArray(p.sizes) ? p.sizes.join(',') : (p.sizes || ''),
      JSON.stringify(p.variants || []),
      Array.isArray(p.images) ? p.images.join(',') : (p.images || ''),
      Array.isArray(p.videos) ? p.videos.join(',') : (p.videos || ''),
      p.stock !== undefined ? p.stock : 0,
      p.status || 'active',
      p.createdAt || new Date().toISOString().split('T')[0]
    ];
    var pid = String(p.id || '');
    if (pid && rowIndexById[pid]) {
      sheet.getRange(rowIndexById[pid], 1, 1, row.length).setValues([row]);
      updatedCount++;
    } else {
      toAppend.push(row);
    }
  });

  if (toAppend.length > 0) {
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, toAppend.length, toAppend[0].length).setValues(toAppend);
  }

  cacheInvalidate('products_all');
  return { success: true, saved: toAppend.length, updated: updatedCount };
}

// ============================================================
// PRODUCTS — ADD / UPDATE / DELETE / STOCK
// ============================================================
function addProduct(product) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.PRODUCTS);
  sheet.appendRow([
    product.id || '', product.name || '', product.code || '', product.country || 'Egypt',
    Array.isArray(product.sizes) ? product.sizes.join(',') : (product.sizes || ''),
    JSON.stringify(product.variants || []),
    Array.isArray(product.images) ? product.images.join(',') : (product.images || ''),
    Array.isArray(product.videos) ? product.videos.join(',') : (product.videos || ''),
    product.stock !== undefined ? product.stock : 0,
    product.status || 'active',
    product.createdAt || new Date().toISOString().split('T')[0]
  ]);
  cacheInvalidate('products_all');
  return { success: true };
}

function updateProduct(product) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.PRODUCTS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === product.id) {
      sheet.getRange(i + 1, 1, 1, 11).setValues([[
        product.id || '', product.name || '', product.code || '', product.country || 'Egypt',
        Array.isArray(product.sizes) ? product.sizes.join(',') : (product.sizes || ''),
        JSON.stringify(product.variants || []),
        Array.isArray(product.images) ? product.images.join(',') : (product.images || ''),
        Array.isArray(product.videos) ? product.videos.join(',') : (product.videos || ''),
        product.stock !== undefined ? product.stock : 0,
        product.status || 'active',
        product.createdAt || new Date().toISOString().split('T')[0]
      ]]);
      cacheInvalidate('products_all');
      return { success: true };
    }
  }
  return { success: false, message: 'Product not found.' };
}

function deleteProduct(id) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.PRODUCTS);
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === id) {
      sheet.deleteRow(i + 1);
      cacheInvalidate('products_all');
      return { success: true };
    }
  }
  return { success: false, message: 'Product not found.' };
}

function updateStock(id, stock) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.PRODUCTS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      sheet.getRange(i + 1, 9).setValue(stock);
      cacheInvalidate('products_all');
      return { success: true };
    }
  }
  return { success: false, message: 'Product not found.' };
}

// ============================================================
// PRODUCTS — BULK UPDATE PRICES
// ============================================================
function bulkUpdatePrices(updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { success: false, message: 'updates array required.' };
  }
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.PRODUCTS);
  const data = sheet.getDataRange().getValues();

  var priceMap = {};
  updates.forEach(function (u) {
    if (u && u.id) priceMap[String(u.id)] = parseFloat(u.newPrice) || 0;
  });

  const headers = data[0];
  const idCol = headers.indexOf('id');
  const variantsCol = headers.indexOf('variants');

  var updated = 0;
  var rowsToUpdate = [];
  for (var i = 1; i < data.length; i++) {
    var rowId = String(data[i][idCol] || '');
    if (!priceMap.hasOwnProperty(rowId)) continue;
    var newPrice = priceMap[rowId];
    var variants = [];
    try { variants = JSON.parse(data[i][variantsCol] || '[]'); } catch (e) { variants = []; }
    var newVariants = variants.map(function (v) {
      return Object.assign({}, v, { price: newPrice });
    });
    rowsToUpdate.push({ rowIndex: i + 1, variantsJson: JSON.stringify(newVariants) });
    updated++;
  }
  rowsToUpdate.forEach(function (r) {
    sheet.getRange(r.rowIndex, variantsCol + 1).setValue(r.variantsJson);
  });
  cacheInvalidate('products_all');
  return { success: true, updated: updated };
}

// ============================================================
// PRODUCTS — BULK DELETE
// ============================================================
function bulkDeleteProducts(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { success: false, message: 'ids array required.' };
  }
  var idSet = {};
  ids.forEach(function (x) { idSet[String(x)] = true; });

  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.PRODUCTS);
  const data = sheet.getDataRange().getValues();
  var deleted = 0;
  for (var i = data.length - 1; i >= 1; i--) {
    var rowId = String(data[i][0] || '');
    if (idSet[rowId]) { sheet.deleteRow(i + 1); deleted++; }
  }
  cacheInvalidate('products_all');
  return { success: true, deleted: deleted };
}

// ============================================================
// ORDERS
// ============================================================
function getOrders() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.ORDERS);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  const orders = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    const order = {};
    headers.forEach(function (h, idx) { order[h] = row[idx]; });
    orders.push(order);
  }
  return orders;
}

function getOrderById(orderId) {
  const orders = getOrders();
  const order = orders.find(function (o) { return o.orderId === orderId; });
  return order ? { success: true, order: order } : { success: false, message: 'Order not found.' };
}

function generateOrderId(adminCode, dateStr) {
  if (!adminCode) adminCode = 'UNKNOWN';
  if (!dateStr) dateStr = formatDateForId(new Date());
  const flatBase = adminCode + '-' + dateStr;
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.ORDERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return flatBase;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return String(r[0] || ''); });
  var count = 0;
  ids.forEach(function (id) {
    if (id === flatBase) count++;
    else if (id.indexOf(flatBase + '-') === 0) count++;
  });
  if (count === 0) return flatBase;
  return flatBase + '-' + (count + 1);
}

function formatOrderIdDisplay(orderId, adminCode) {
  if (adminCode && orderId.indexOf(adminCode + '-') === 0) {
    const rest = orderId.substring(adminCode.length + 1);
    const parts = rest.split('-');
    if (parts.length >= 3) {
      return { code: adminCode, date: parts.slice(0, 3).join('-'), serial: parts.slice(3).join('-') || null };
    }
  }
  return { code: adminCode || '', date: '', serial: null };
}

function saveOrder(order) {
  if (!order) return { success: false, message: 'No order data.' };
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.ORDERS);
  const now = new Date();
  const dateStr = order.date || Utilities.formatDate(now, DEFAULT_TIMEZONE, 'd-M-yyyy');
  const timeStr = order.time || Utilities.formatDate(now, DEFAULT_TIMEZONE, 'HH:mm');

  if (!order.orderId) {
    order.orderId = generateOrderId(order.productCode || 'UNKNOWN', dateStr);
  } else {
    const data = sheet.getDataRange().getValues();
    var exists = false;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0] || '') === String(order.orderId)) { exists = true; break; }
    }
    if (exists) order.orderId = order.orderId + '-' + new Date().getTime().toString(36);
  }

  sheet.appendRow([
    order.orderId,
    order.customerName || '', order.customerPhone || '', order.customerAddress || '',
    order.productName || '', order.productCode || '',
    order.colorName || '', order.colorValue || '',
    order.size || '', order.quantity || 1,
    order.price || 0, order.total || 0,
    order.productImage || '', order.status || 'pending', order.notes || '',
    dateStr, timeStr, new Date().toISOString()
  ]);

  updateSalesLog(dateStr, order.total || 0);
  updateCustomerRecord(order);
  return { success: true, orderId: order.orderId };
}

function updateOrderStatus(orderId, status) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.ORDERS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === orderId) {
      sheet.getRange(i + 1, 14).setValue(status);
      sheet.getRange(i + 1, 18).setValue(new Date().toISOString());
      return { success: true };
    }
  }
  return { success: false, message: 'Order not found.' };
}

function formatDateForId(date) {
  return date.getDate() + '-' + (date.getMonth() + 1) + '-' + date.getFullYear();
}

// ============================================================
// SALES LOG / CUSTOMERS
// ============================================================
function updateSalesLog(dateStr, amount) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.SALES_LOG);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === dateStr) {
      const currentOrders = parseInt(data[i][1]) || 0;
      const currentRevenue = parseFloat(data[i][2]) || 0;
      sheet.getRange(i + 1, 2).setValue(currentOrders + 1);
      sheet.getRange(i + 1, 3).setValue(currentRevenue + amount);
      return;
    }
  }
  sheet.appendRow([dateStr, 1, amount]);
}

function updateCustomerRecord(order) {
  if (!order.customerPhone) return;
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.CUSTOMERS);
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === order.customerPhone) {
      const totalOrders = (parseInt(data[i][2]) || 0) + 1;
      const totalSpent = (parseFloat(data[i][3]) || 0) + (order.total || 0);
      const addresses = data[i][5] || '';
      const newAddr = order.customerAddress || '';
      const addrList = addresses.split(';').map(function (a) { return a.trim(); }).filter(Boolean);
      if (newAddr && addrList.indexOf(newAddr) === -1) addrList.push(newAddr);
      sheet.getRange(i + 1, 3).setValue(totalOrders);
      sheet.getRange(i + 1, 4).setValue(totalSpent);
      sheet.getRange(i + 1, 5).setValue(order.date || new Date().toISOString().split('T')[0]);
      sheet.getRange(i + 1, 6).setValue(addrList.join('; '));
      return;
    }
  }
  sheet.appendRow([
    order.customerPhone, order.customerName || '', 1, order.total || 0,
    order.date || new Date().toISOString().split('T')[0],
    order.customerAddress || ''
  ]);
}

function getCustomers() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.CUSTOMERS);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).filter(function (r) { return r[0]; }).map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

function getSalesLog() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.SALES_LOG);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).filter(function (r) { return r[0]; }).map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

// ============================================================
// SETTINGS
// ============================================================
function getSettings() {
  const cached = cacheGet('settings_all');
  if (cached) return cached;
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  const settings = {};
  for (let i = 1; i < data.length; i++) {
    const key = data[i][0];
    if (key && key.toString().indexOf('activeToken_') !== 0) {
      settings[key] = data[i][1];
    }
  }
  cachePut('settings_all', settings, CACHE_TTL_SETTINGS);
  return settings;
}

function updateSettings(newSettings) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  const data = sheet.getDataRange().getValues();
  Object.keys(newSettings).forEach(function (key) {
    var found = false;
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === key) {
        sheet.getRange(i + 1, 2).setValue(newSettings[key]);
        found = true;
        break;
      }
    }
    if (!found) sheet.appendRow([key, newSettings[key]]);
  });
  cacheInvalidate('settings_all');
  return { success: true };
}

function saveSetting(key, value) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.SETTINGS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      cacheInvalidate('settings_all');
      return;
    }
  }
  sheet.appendRow([key, value]);
  cacheInvalidate('settings_all');
}

function updateSetting(key, value) {
  saveSetting(key, value);
  return { success: true };
}

// ============================================================
// USERS (display only — login is client-side now)
// ============================================================
function getUsers() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEETS.USERS);
  if (!sheet) { initializeSheets(); sheet = ss.getSheetByName(SHEETS.USERS); }
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  return data.slice(1).filter(function (r) { return r[0]; }).map(function (row) {
    return {
      username: row[0],
      role: row[2],
      createdAt: row[3],
      lastLogin: row[4]
    };
  });
}

function addUser(user) {
  if (!user.username || !user.password) {
    return { success: false, message: 'Username and password required.' };
  }
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.USERS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === user.username) return { success: false, message: 'Username already exists.' };
  }
  sheet.appendRow([
    user.username,
    '(client-side auth)',
    user.role || 'staff',
    new Date().toISOString(),
    ''
  ]);
  return { success: true };
}

function deleteUser(username) {
  if (username === DEFAULT_ADMIN.username) {
    return { success: false, message: 'Cannot delete default admin.' };
  }
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.USERS);
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][0] === username) {
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { success: false, message: 'User not found.' };
}

// ============================================================
// NOTIFICATIONS
// ============================================================
function getNotifications() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.NOTIFICATIONS);
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  return data.slice(1).filter(function (r) { return r[0]; }).map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
}

function saveNotification(notification) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEETS.NOTIFICATIONS);
  const id = 'NOT-' + new Date().getTime();
  sheet.appendRow([
    id, notification.type || 'info',
    notification.message || '',
    new Date().toISOString()
  ]);
  return { success: true, id: id };
}

/**
 * Clears Orders, SalesLog, and Customers sheets, keeping headers.
 * Does NOT touch Products or Settings.
 */
function resetOrders() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  const ordersSheet = ss.getSheetByName(SHEETS.ORDERS);
  if (ordersSheet && ordersSheet.getLastRow() > 1) {
    ordersSheet.deleteRows(2, ordersSheet.getLastRow() - 1);
  }

  const salesSheet = ss.getSheetByName(SHEETS.SALES_LOG);
  if (salesSheet && salesSheet.getLastRow() > 1) {
    salesSheet.deleteRows(2, salesSheet.getLastRow() - 1);
  }

  const custSheet = ss.getSheetByName(SHEETS.CUSTOMERS);
  if (custSheet && custSheet.getLastRow() > 1) {
    custSheet.deleteRows(2, custSheet.getLastRow() - 1);
  }

  cacheInvalidate('products_all');
  cacheInvalidate('settings_all');

  return {
    success: true,
    message: 'Orders, sales log, and customers have been cleared.'
  };
}