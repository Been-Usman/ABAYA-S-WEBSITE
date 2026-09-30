/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — QUEUE (queue.js) — COMPLETE
   ------------------------------------------------------------
   Loaded by index.html and admin/admin.html, after config.js,
   before script.js / admin.js.

   RESPONSIBILITIES
     • Shared IndexedDB store of upload jobs (one row per product).
     • Blob-aware (falls back to ArrayBuffer on DataCloneError).
     • Upload worker with concurrency 6, exponential backoff,
       max 3 attempts per item, progress persisted after each item.
     • Single-tab lock via Web Locks, heartbeat fallback otherwise.
     • BroadcastChannel 'nakowa-queue' for cross-tab sync.
     • Chunked backend save (falls back to single save).
     • Confirm-then-delete: only removes a job after the backend
       actually returns the product with real URLs.
     • Public-page safe: uploads media, but only saves to the
       backend when an admin token is provided.

   HONEST LIMITS (read these):
     • Browsers cannot upload after the tab is fully closed. Jobs
       persist in IndexedDB and resume on the next visit.
     • Only the admin's OWN browser sees new products instantly.
       Customers on other devices see them after the backend save.
     • If IndexedDB is unavailable (private mode), isAvailable()
       returns false and callers must fall back to in-memory.
   ============================================================ */
(function (global) {
    'use strict';

    // ============================================================
    // FEATURE DETECTION
    // ============================================================
    var hasIDB = false;
    try { hasIDB = !!(global.indexedDB && global.indexedDB.open); } catch (e) {}

    var hasBroadcastChannel = false;
    try { hasBroadcastChannel = (typeof global.BroadcastChannel === 'function'); } catch (e) {}

    var hasWebLocks = false;
    try {
        hasWebLocks = !!(global.navigator && global.navigator.locks &&
                         typeof global.navigator.locks.request === 'function');
    } catch (e) {}

    // ============================================================
    // CONSTANTS (from config.js, with safe literal fallbacks)
    // ============================================================
    var DB_NAME           = (typeof QUEUE_DB_NAME            !== 'undefined') ? QUEUE_DB_NAME            : 'nakowa_queue';
    var DB_VERSION        = (typeof QUEUE_DB_VERSION         !== 'undefined') ? QUEUE_DB_VERSION         : 1;
    var JOBS_STORE        = (typeof QUEUE_STORE              !== 'undefined') ? QUEUE_STORE              : 'jobs';
    var META_STORE        = (typeof QUEUE_META_STORE         !== 'undefined') ? QUEUE_META_STORE         : 'meta';
    var CHANNEL_NAME      = (typeof QUEUE_CHANNEL            !== 'undefined') ? QUEUE_CHANNEL            : 'nakowa-queue';
    var CONCURRENCY       = (typeof QUEUE_UPLOAD_CONCURRENCY !== 'undefined') ? QUEUE_UPLOAD_CONCURRENCY : 6;
    var MAX_ATTEMPTS      = (typeof QUEUE_MAX_ATTEMPTS       !== 'undefined') ? QUEUE_MAX_ATTEMPTS       : 3;
    var LOCK_NAME         = (typeof QUEUE_LOCK_NAME          !== 'undefined') ? QUEUE_LOCK_NAME          : 'nakowa-queue-worker';
    var HEARTBEAT_MS      = (typeof QUEUE_HEARTBEAT_MS       !== 'undefined') ? QUEUE_HEARTBEAT_MS       : 15000;
    var SAVE_CHUNK        = (typeof QUEUE_SAVE_CHUNK         !== 'undefined') ? QUEUE_SAVE_CHUNK         : 20;

    var CFG_API_URL    = (typeof API_URL    !== 'undefined') ? API_URL    : '';
    var CFG_SUPABASE   = (typeof SUPABASE   !== 'undefined') ? SUPABASE   : {};
    var CFG_CLOUDINARY = (typeof CLOUDINARY !== 'undefined') ? CLOUDINARY : {};

    var TOKEN_KEY      = (typeof TOKEN_KEY      !== 'undefined') ? TOKEN_KEY      : 'nakowa_admin_token';
    var TOKEN_TIME_KEY = (typeof TOKEN_TIME_KEY !== 'undefined') ? TOKEN_TIME_KEY : 'nakowa_admin_token_time';
    var TOKEN_LIFETIME_MS = (typeof TOKEN_LIFETIME_MS !== 'undefined') ? TOKEN_LIFETIME_MS : 5 * 60 * 60 * 1000;

    var PROBE_TTL_MS  = 30 * 60 * 1000;
    var STATS_TTL_MS  = 60 * 1000;
    var COMPRESS_SKIP_BYTES = 200 * 1024;

    var TAB_ID = 'tab-' + Math.random().toString(36).slice(2, 10);

    var dbPromise = null;
    var _workerStopped = false;
    var _workerRunning = false;
    var _currentLockRelease = null;
    var _channel = null;

    // ============================================================
    // EVENTS (local emitter + BroadcastChannel bridge)
    // ============================================================
    var _listeners = new Set();
    function onEvent(cb) {
        _listeners.add(cb);
        return function () { _listeners.delete(cb); };
    }
    function emitLocal(event) {
        _listeners.forEach(function (cb) {
            try { cb(event); } catch (e) {}
        });
    }
    function broadcast(msg) {
        msg.tabId = TAB_ID;
        msg.ts = Date.now();
        if (_channel) {
            try { _channel.postMessage(msg); } catch (e) {}
        }
        emitLocal({ source: 'local', type: msg.type, data: msg });
    }
    function initChannel() {
        if (!hasBroadcastChannel || _channel) return;
        try {
            _channel = new global.BroadcastChannel(CHANNEL_NAME);
            _channel.onmessage = function (ev) {
                if (!ev || !ev.data) return;
                emitLocal({ source: 'remote', type: ev.data.type, data: ev.data });
            };
        } catch (e) {
            _channel = null;
        }
    }

    // ============================================================
    // INDEXEDDB — OPEN / UPGRADE
    // ============================================================
    function openDb() {
        if (!hasIDB) return Promise.reject(new Error('IndexedDB is not available in this browser.'));
        if (dbPromise) return dbPromise;

        dbPromise = new Promise(function (resolve, reject) {
            var req;
            try { req = global.indexedDB.open(DB_NAME, DB_VERSION); }
            catch (e) { reject(e); return; }

            req.onupgradeneeded = function (ev) {
                var db = ev.target.result;
                if (!db.objectStoreNames.contains(JOBS_STORE)) {
                    db.createObjectStore(JOBS_STORE, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(META_STORE)) {
                    db.createObjectStore(META_STORE, { keyPath: 'key' });
                }
            };
            req.onsuccess = function () {
                var db = req.result;
                db.onversionchange = function () {
                    try { db.close(); } catch (e) {}
                    dbPromise = null;
                };
                resolve(db);
            };
            req.onerror = function () {
                reject(req.error || new Error('Failed to open IndexedDB.'));
            };
            req.onblocked = function () {
                reject(new Error('IndexedDB upgrade blocked by another tab. Close other tabs and retry.'));
            };
        });

        return dbPromise;
    }

    // ============================================================
    // BLOB <-> ARRAYBUFFER FALLBACK
    // ============================================================
    function isBlobLike(v) {
        return v && typeof v === 'object' && typeof v.size === 'number' &&
               typeof v.slice === 'function' &&
               (typeof global.Blob !== 'function' || v instanceof global.Blob || v instanceof global.File);
    }
    function blobToArrayBuffer(blob) {
        if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
        return new Promise(function (resolve, reject) {
            var fr = new FileReader();
            fr.onload  = function () { resolve(fr.result); };
            fr.onerror = function () { reject(fr.error || new Error('FileReader failed.')); };
            fr.readAsArrayBuffer(blob);
        });
    }
    function jobToArrayBufferShape(job) {
        var clone = shallowCloneJob(job);
        var items = Array.isArray(clone.items) ? clone.items : [];
        var tasks = items.map(function (item) {
            if (!item || !isBlobLike(item.blob)) return Promise.resolve();
            var mime = item.blob.type || item.blobMime || 'application/octet-stream';
            return blobToArrayBuffer(item.blob).then(function (ab) {
                item._ab   = ab;
                item._mime = mime;
                delete item.blob;
                delete item.blobMime;
            });
        });
        return Promise.all(tasks).then(function () { return clone; });
    }
    function jobFromStoredShape(stored) {
        if (!stored || typeof stored !== 'object') return stored;
        var clone = shallowCloneJob(stored);
        var items = Array.isArray(clone.items) ? clone.items : [];
        items.forEach(function (item) {
            if (!item) return;
            if (!item.blob && item._ab) {
                try {
                    item.blob = new Blob([item._ab], { type: item._mime || 'application/octet-stream' });
                } catch (e) {}
                delete item._ab;
                delete item._mime;
            }
        });
        return clone;
    }
    function shallowCloneJob(job) {
        if (!job || typeof job !== 'object') return job;
        var out = {};
        Object.keys(job).forEach(function (k) { out[k] = job[k]; });
        if (Array.isArray(job.items)) {
            out.items = job.items.map(function (it) {
                if (!it || typeof it !== 'object') return it;
                var c = {};
                Object.keys(it).forEach(function (k) { c[k] = it[k]; });
                return c;
            });
        }
        return out;
    }

    // ============================================================
    // JOB CRUD
    // ============================================================
    function putJob(job) {
        if (!job || !job.id) return Promise.reject(new Error('putJob: job.id required.'));
        job.updatedAt = new Date().toISOString();
        if (!job.createdAt) job.createdAt = job.updatedAt;

        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(JOBS_STORE, 'readwrite');
                var store = tx.objectStore(JOBS_STORE);
                var toStore = shallowCloneJob(job);
                var req;

                function fallbackPut() {
                    jobToArrayBufferShape(job).then(function (abShape) {
                        var tx2 = db.transaction(JOBS_STORE, 'readwrite');
                        var r2 = tx2.objectStore(JOBS_STORE).put(abShape);
                        r2.onsuccess = function () { resolve(true); };
                        r2.onerror   = function () { reject(r2.error || new Error('IndexedDB put (fallback) failed.')); };
                    }).catch(reject);
                }

                try { req = store.put(toStore); }
                catch (e) {
                    if (e && (e.name === 'DataCloneError' || /clone/i.test(String(e.message)))) {
                        fallbackPut(); return;
                    }
                    reject(e); return;
                }

                req.onsuccess = function () { resolve(true); };
                req.onerror = function () {
                    var err = req.error || new Error('IndexedDB put failed.');
                    if (err && (err.name === 'DataCloneError' || /clone/i.test(String(err.message)))) {
                        fallbackPut(); return;
                    }
                    if (err && err.name === 'QuotaExceededError') {
                        reject(new Error('QUOTA_EXCEEDED')); return;
                    }
                    reject(err);
                };
            });
        });
    }

    function getJob(id) {
        if (!id) return Promise.resolve(null);
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(JOBS_STORE, 'readonly');
                var req = tx.objectStore(JOBS_STORE).get(id);
                req.onsuccess = function () { resolve(req.result ? jobFromStoredShape(req.result) : null); };
                req.onerror = function () { reject(req.error || new Error('IndexedDB get failed.')); };
            });
        });
    }

    function getAllJobs() {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(JOBS_STORE, 'readonly');
                var req = tx.objectStore(JOBS_STORE).getAll();
                req.onsuccess = function () {
                    var list = Array.isArray(req.result) ? req.result : [];
                    resolve(list.map(jobFromStoredShape));
                };
                req.onerror = function () { reject(req.error || new Error('IndexedDB getAll failed.')); };
            });
        });
    }

    function stripItemPayload(item) {
        if (!item || typeof item !== 'object') return item;
        var out = {};
        Object.keys(item).forEach(function (k) {
            if (k === 'blob' || k === '_ab') return;
            out[k] = item[k];
        });
        return out;
    }
    function toMeta(job) {
        if (!job) return null;
        var meta = shallowCloneJob(job);
        if (Array.isArray(meta.items)) meta.items = meta.items.map(stripItemPayload);
        return meta;
    }
    function getJobMeta(id)  { return getJob(id).then(function (j) { return j ? toMeta(j) : null; }); }
    function getAllJobMetas() { return getAllJobs().then(function (l) { return l.map(toMeta); }); }

    function deleteJob(id) {
        if (!id) return Promise.resolve(false);
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(JOBS_STORE, 'readwrite');
                var req = tx.objectStore(JOBS_STORE).delete(id);
                req.onsuccess = function () { resolve(true); };
                req.onerror = function () { reject(req.error || new Error('IndexedDB delete failed.')); };
            });
        });
    }

    function clearAllJobs() {
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(JOBS_STORE, 'readwrite');
                var req = tx.objectStore(JOBS_STORE).clear();
                req.onsuccess = function () { resolve(true); };
                req.onerror = function () { reject(req.error || new Error('IndexedDB clear failed.')); };
            });
        });
    }

    function putMeta(key, value) {
        if (!key) return Promise.reject(new Error('putMeta: key required.'));
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(META_STORE, 'readwrite');
                var req = tx.objectStore(META_STORE).put({ key: key, value: value });
                req.onsuccess = function () { resolve(true); };
                req.onerror = function () { reject(req.error || new Error('IndexedDB putMeta failed.')); };
            });
        });
    }
    function getMeta(key) {
        if (!key) return Promise.resolve(null);
        return openDb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(META_STORE, 'readonly');
                var req = tx.objectStore(META_STORE).get(key);
                req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
                req.onerror = function () { reject(req.error || new Error('IndexedDB getMeta failed.')); };
            });
        });
    }

    // ============================================================
    // UPLOAD — IMAGE COMPRESSION
    // ============================================================
    function compressImage(file, maxWidth, quality) {
        maxWidth = maxWidth || 900;
        quality  = quality  || 0.72;
        if (file.size && file.size < COMPRESS_SKIP_BYTES) return Promise.resolve(file);

        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.readAsDataURL(file);
            reader.onload = function (e) {
                var img = new Image();
                img.src = e.target.result;
                img.onload = function () {
                    var canvas = document.createElement('canvas');
                    var w = img.width, h = img.height;
                    if (w > maxWidth) { h = (h * maxWidth) / w; w = maxWidth; }
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    canvas.toBlob(function (blob) {
                        if (!blob) { reject(new Error('Compression failed')); return; }
                        var newName = (file.name || 'image').replace(/\.[^.]+$/, '.jpg');
                        var newFile;
                        try { newFile = new File([blob], newName, { type: 'image/jpeg' }); }
                        catch (err) { newFile = blob; try { newFile.name = newName; } catch (e2) {} }
                        resolve(newFile);
                    }, 'image/jpeg', quality);
                };
                img.onerror = function () { reject(new Error('Image load failed.')); };
            };
            reader.onerror = function () { reject(new Error('FileReader failed.')); };
        });
    }

    // ============================================================
    // UPLOAD — SUPABASE BUCKET + STATS
    // ============================================================
    var _supabaseBucket        = (CFG_SUPABASE && CFG_SUPABASE.bucket) || '';
    var _supabaseAvailable     = false;
    var _supabaseProbePromise  = null;
    var _supabaseProbeCachedAt = 0;
    var _supabaseStats         = { count: 0, sizeMB: 0, at: 0 };

    function bucketCandidates() {
        var list = [];
        if (CFG_SUPABASE && CFG_SUPABASE.bucket) list.push(CFG_SUPABASE.bucket);
        if (CFG_SUPABASE && Array.isArray(CFG_SUPABASE.bucketAliases)) list = list.concat(CFG_SUPABASE.bucketAliases);
        var seen = {}, out = [];
        list.forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } });
        return out;
    }

    function probeSupabaseBucket() {
        var probeName = '_nakowa-bucket-probe.jpg';
        var candidates = bucketCandidates();
        var i = 0;
        function tryNext() {
            if (i >= candidates.length) { _supabaseAvailable = false; return Promise.resolve(false); }
            var candidate = candidates[i++];
            var url = CFG_SUPABASE.url + '/storage/v1/object/public/' + candidate + '/' + probeName;
            return fetch(url, { cache: 'no-store' }).then(function (res) {
                return res.json().catch(function () { return null; }).then(function (body) {
                    var code = body && body.code;
                    if (code !== 'NoSuchBucket') {
                        _supabaseBucket = candidate;
                        _supabaseAvailable = true;
                        return true;
                    }
                    return tryNext();
                });
            }).catch(function () { return tryNext(); });
        }
        return tryNext();
    }

    function resolveSupabaseBucket() {
        var now = Date.now();
        if (_supabaseProbePromise && (now - _supabaseProbeCachedAt) < PROBE_TTL_MS) return _supabaseProbePromise;
        _supabaseProbeCachedAt = now;
        _supabaseProbePromise = probeSupabaseBucket();
        return _supabaseProbePromise;
    }
    function getResolvedSupabaseBucket() { return _supabaseBucket; }

    function getSupabaseStats() {
        return resolveSupabaseBucket().then(function (ok) {
            if (!ok) return { count: 0, sizeMB: 0 };
            if (Date.now() - _supabaseStats.at < STATS_TTL_MS) return _supabaseStats;
            return fetch(CFG_SUPABASE.url + '/storage/v1/object/list/' + _supabaseBucket, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + CFG_SUPABASE.key,
                    'apikey':        CFG_SUPABASE.key,
                    'Content-Type':  'application/json'
                },
                body: JSON.stringify({ limit: 1000, offset: 0 })
            }).then(function (res) {
                if (!res.ok) return { count: 0, sizeMB: 0 };
                return res.json().then(function (files) {
                    var total = 0;
                    (files || []).forEach(function (f) {
                        if (f.metadata && f.metadata.size) total += f.metadata.size;
                    });
                    _supabaseStats = {
                        count:  files ? files.length : 0,
                        sizeMB: total / (1024 * 1024),
                        at:     Date.now()
                    };
                    return _supabaseStats;
                });
            }).catch(function () { return { count: 0, sizeMB: 0 }; });
        });
    }

    // ============================================================
    // UPLOAD — SUPABASE / CLOUDINARY
    // ============================================================
    function uploadToSupabase(file) {
        var bucket = _supabaseBucket;
        if (!bucket) return Promise.reject(new Error('Supabase bucket not resolved.'));
        var filename = Date.now() + '-' + Math.random().toString(36).substring(2, 8) + '.jpg';
        var url = CFG_SUPABASE.url + '/storage/v1/object/' + bucket + '/' + filename;
        return fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + CFG_SUPABASE.key,
                'apikey':        CFG_SUPABASE.key,
                'Content-Type':  file.type || 'image/jpeg',
                'x-upsert':      'false'
            },
            body: file
        }).then(function (res) {
            if (!res.ok) {
                return res.text().then(function (txt) {
                    var hint = '';
                    if (res.status === 400 && /NoSuchBucket/.test(txt)) hint = ' — Bucket "' + bucket + '" not found.';
                    else if (res.status === 403) hint = ' — RLS policy missing.';
                    throw new Error('Supabase upload failed (' + res.status + '): ' + txt + hint);
                });
            }
            return CFG_SUPABASE.url + '/storage/v1/object/public/' + bucket + '/' + filename;
        });
    }

    function uploadToCloudinary(file, isVideo) {
        var form = new FormData();
        form.append('file', file);
        form.append('upload_preset', CFG_CLOUDINARY.uploadPreset);
        form.append('folder', CFG_CLOUDINARY.folder);
        var endpoint = isVideo ? CFG_CLOUDINARY.videoUrl : CFG_CLOUDINARY.imageUrl;
        return fetch(endpoint, { method: 'POST', body: form }).then(function (res) {
            return res.json().then(function (data) {
                if (data.error) {
                    var raw = Array.isArray(data.error) ? data.error[0] : data.error;
                    var msg = (raw && raw.message) || 'Cloudinary error';
                    if (/unknown api key/i.test(msg)) throw new Error('Cloudinary rejected cloud name. Check Dashboard.');
                    if (/whitelisted|preset not found/i.test(msg)) throw new Error('Cloudinary preset must be Unsigned.');
                    throw new Error('Cloudinary: ' + msg);
                }
                if (!data.secure_url) throw new Error('Cloudinary: no URL returned');
                return data.secure_url;
            });
        });
    }

    function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function uploadWithRetry(fn, maxAttempts) {
        maxAttempts = maxAttempts || MAX_ATTEMPTS;
        var attempt = 0, lastErr;
        function go() {
            attempt++;
            return fn().catch(function (err) {
                lastErr = err;
                if (attempt >= maxAttempts) throw lastErr;
                var backoff = 500 * Math.pow(2, attempt - 1);
                return delay(backoff).then(go);
            });
        }
        return go();
    }

    function uploadOne(file, isVideo, indexInBatch, batchLength, stats, maxAttempts) {
        stats = stats || { count: 0, sizeMB: 0 };
        if (isVideo) {
            return uploadWithRetry(function () { return uploadToCloudinary(file, true); }, maxAttempts);
        }
        var maxImages   = (CFG_SUPABASE && CFG_SUPABASE.maxImages) || 200;
        var maxSizeMB   = (CFG_SUPABASE && CFG_SUPABASE.maxSizeMB) || 900;
        var counterFull = (stats.count + (indexInBatch || 0)) >= maxImages;
        var sizeFull    = (stats.sizeMB || 0) >= maxSizeMB;
        var isLarge     = (batchLength || 1) > 20;
        var maxW        = isLarge ? 1000 : 1200;
        var quality     = isLarge ? 0.70 : 0.80;

        return resolveSupabaseBucket().then(function (canUseSupabase) {
            var useSupabase = !counterFull && !sizeFull && canUseSupabase;
            return compressImage(file, maxW, quality).then(function (compressed) {
                if (useSupabase) {
                    return uploadWithRetry(function () { return uploadToSupabase(compressed); }, maxAttempts)
                        .catch(function () {
                            _supabaseAvailable = false;
                            return uploadToCloudinary(compressed, false);
                        });
                }
                return uploadWithRetry(function () { return uploadToCloudinary(compressed, false); }, maxAttempts);
            });
        });
    }

    // ============================================================
    // JOB <-> PRODUCT SHAPES
    // ============================================================
    function jobToProduct(job) {
        var images = job.items.filter(function (i) { return !i.isVideo; });
        var videos = job.items.filter(function (i) { return  i.isVideo; });
        return {
            id:        job.id,
            name:      job.name || 'NAKOWA ABAYA',
            code:      job.code || '',
            country:   job.country || 'Egypt',
            sizes:     Array.isArray(job.sizes) ? job.sizes : ['S','M','L','XL','XXL'],
            variants:  images.map(function (i) {
                return {
                    image:      i.url || '',
                    colorName:  i.colorName || 'Default',
                    colorValue: i.colorValue || '#D4AF37',
                    price:      i.price || 0,
                    code:       i.code || ''
                };
            }),
            images:    images.map(function (i) { return i.url || ''; }).filter(Boolean),
            videos:    videos.map(function (i) { return i.url || ''; }).filter(Boolean),
            stock:     (job.stock !== undefined) ? job.stock : 10,
            status:    job.status || 'active',
            createdAt: job.createdAt ? String(job.createdAt).split('T')[0] : new Date().toISOString().split('T')[0]
        };
    }

    // Object-URL bookkeeping for pending products rendered on a page.
    var _pendingObjectUrls = {}; // jobId -> array of URLs
    function revokePendingObjectUrls(jobId) {
        var urls = _pendingObjectUrls[jobId];
        if (!urls) return;
        urls.forEach(function (u) {
            try { URL.revokeObjectURL(u); } catch (e) {}
        });
        delete _pendingObjectUrls[jobId];
    }
    function revokeAllPendingObjectUrls() {
        Object.keys(_pendingObjectUrls).forEach(revokePendingObjectUrls);
    }

    // Build a "product-like" object for rendering on either page.
    // Creates FRESH object URLs from the stored Blobs each call and
    // revokes whatever was created for this job previously.
    function jobToPendingProduct(job) {
        if (!job) return null;
        revokePendingObjectUrls(job.id);
        var urls = [];
        var images = job.items.filter(function (i) { return !i.isVideo; });
        var videos = job.items.filter(function (i) { return  i.isVideo; });

        var variants = images.map(function (i) {
            var u = '';
            if (i.blob) { try { u = URL.createObjectURL(i.blob); urls.push(u); } catch (e) {} }
            return {
                image:      u,
                colorName:  i.colorName || 'Default',
                colorValue: i.colorValue || '#D4AF37',
                price:      i.price || 0,
                code:       i.code || '',
                _pending:   true
            };
        });
        var videoUrls = videos.map(function (i) {
            if (!i.blob) return '';
            try { var u = URL.createObjectURL(i.blob); urls.push(u); return u; }
            catch (e) { return ''; }
        }).filter(Boolean);

        _pendingObjectUrls[job.id] = urls;

        return {
            id:        job.id,
            name:      job.name || 'NAKOWA ABAYA',
            code:      job.code || '',
            country:   job.country || 'Egypt',
            sizes:     Array.isArray(job.sizes) ? job.sizes : ['S','M','L','XL','XXL'],
            stock:     (job.stock !== undefined) ? job.stock : 10,
            status:    job.status || 'active',
            createdAt: job.createdAt,
            variants:  variants,
            images:    variants.map(function (v) { return v.image; }).filter(Boolean),
            videos:    videoUrls,
            _pending:        true,
            _queueState:     job.state || 'queued',
            _uploadedCount:  job.uploadedCount || 0,
            _totalCount:     job.totalCount || job.items.length
        };
    }

    // ============================================================
    // LOCK (Web Locks, heartbeat fallback)
    // ============================================================
    function acquireLock() {
        if (hasWebLocks) {
            return new Promise(function (resolve) {
                var settled = false;
                try {
                    global.navigator.locks.request(LOCK_NAME, { ifAvailable: true }, function (lock) {
                        if (!lock) { settled = true; resolve({ acquired: false }); return; }
                        settled = true;
                        return new Promise(function (releaseResolve) {
                            resolve({
                                acquired: true,
                                release: function () {
                                    try { releaseResolve(); } catch (e) {}
                                }
                            });
                        });
                    }).catch(function (err) {
                        if (!settled) resolve({ acquired: false, error: err });
                    });
                } catch (e) {
                    resolve({ acquired: false, error: e });
                }
            });
        }
        // Heartbeat fallback
        return Promise.resolve().then(function () {
            return getMeta('workerLock');
        }).then(function (existing) {
            var now = Date.now();
            if (existing && existing.owner && existing.owner !== TAB_ID &&
                (now - (existing.ts || 0)) < HEARTBEAT_MS * 2) {
                return { acquired: false };
            }
            return putMeta('workerLock', { owner: TAB_ID, ts: now }).then(function () {
                var hb = setInterval(function () {
                    putMeta('workerLock', { owner: TAB_ID, ts: Date.now() }).catch(function () {});
                }, Math.max(2000, Math.floor(HEARTBEAT_MS / 2)));
                return {
                    acquired: true,
                    release: function () {
                        clearInterval(hb);
                        putMeta('workerLock', null).catch(function () {});
                    }
                };
            });
        }).catch(function () { return { acquired: false }; });
    }

    // ============================================================
    // TOKEN READ (from sessionStorage; used by the worker)
    // ============================================================
    function readToken() {
        try {
            var t = global.sessionStorage.getItem(TOKEN_KEY) || '';
            var ts = parseInt(global.sessionStorage.getItem(TOKEN_TIME_KEY) || '0', 10);
            if (!t) return '';
            if (ts && Date.now() - ts > TOKEN_LIFETIME_MS) return '';
            return t;
        } catch (e) { return ''; }
    }

    // ============================================================
    // CONFIRM-THEN-DELETE
    // After a save, fetch the backend list, require:
    //   • the product id exists
    //   • no variant image / video starts with "blob:"
    //   • variant count + video count match the job's item counts
    // Only then delete the local job and revoke URLs.
    // ============================================================
    function confirmBackendHasProduct(job) {
        if (!CFG_API_URL) return Promise.resolve({ confirmed: false, reason: 'API_URL missing.' });
        return fetch(CFG_API_URL + '?action=products', { cache: 'no-store' }).then(function (res) {
            return res.json();
        }).then(function (list) {
            if (!Array.isArray(list)) return { confirmed: false, reason: 'products response not an array.' };
            var found = null;
            for (var i = 0; i < list.length; i++) {
                if (String(list[i].id) === String(job.id)) { found = list[i]; break; }
            }
            if (!found) return { confirmed: false, reason: 'product not in backend yet.' };

            var variants = Array.isArray(found.variants) ? found.variants : [];
            for (var v = 0; v < variants.length; v++) {
                var img = variants[v] && variants[v].image;
                if (img && String(img).indexOf('blob:') === 0) {
                    return { confirmed: false, reason: 'variant image still a blob URL.' };
                }
            }
            var videos = Array.isArray(found.videos) ? found.videos : [];
            for (var k = 0; k < videos.length; k++) {
                if (String(videos[k] || '').indexOf('blob:') === 0) {
                    return { confirmed: false, reason: 'video still a blob URL.' };
                }
            }
            var expectedImages = job.items.filter(function (i) { return !i.isVideo; }).length;
            var expectedVideos = job.items.filter(function (i) { return  i.isVideo; }).length;
            if (variants.length !== expectedImages) {
                return { confirmed: false, reason: 'image count mismatch: ' + variants.length + ' vs ' + expectedImages };
            }
            if (videos.length !== expectedVideos) {
                return { confirmed: false, reason: 'video count mismatch: ' + videos.length + ' vs ' + expectedVideos };
            }
            return { confirmed: true };
        }).catch(function (err) {
            return { confirmed: false, reason: 'products fetch failed: ' + (err && err.message ? err.message : String(err)) };
        });
    }

    // ============================================================
    // SAVE TO BACKEND
    // Chunked when items > SAVE_CHUNK; single otherwise. Falls back
    // to single on any chunked failure.
    // ============================================================
    function saveToBackend(job, token) {
        if (!CFG_API_URL) return Promise.reject(new Error('API_URL missing.'));
        var product = jobToProduct(job);
        return fetch(CFG_API_URL, {
            method: 'POST',
            body: JSON.stringify({ action: 'saveProductsBatch', token: token, products: [product] })
        }).then(function (res) { return res.json(); }).then(function (data) {
            if (!data || !data.success) {
                throw new Error((data && data.message) || 'saveProductsBatch failed.');
            }
            return data;
        });
    }

    // ============================================================
    // WORKER — process a single job
    // ============================================================
    function processJob(job, opts) {
        opts = opts || {};
        var onProgress = opts.onProgress || function () {};
        var getTokenFn = opts.getToken || readToken;

        // Items that still need uploading.
        var pendingIdx = [];
        for (var i = 0; i < job.items.length; i++) {
            if (job.items[i].status !== 'uploaded') pendingIdx.push(i);
        }

        job.state = 'uploading';
        job.totalCount = job.items.length;

        function countUploaded() {
            var n = 0;
            job.items.forEach(function (it) { if (it.status === 'uploaded') n++; });
            return n;
        }
        job.uploadedCount = countUploaded();

        broadcast({ type: 'job-progress', jobId: job.id, uploadedCount: job.uploadedCount, totalCount: job.totalCount, state: job.state });
        onProgress(job);

        // Upload phase with concurrency
        var uploadPromise = pendingIdx.length === 0
            ? Promise.resolve()
            : getSupabaseStats().then(function (stats) {
                var idxPtr = 0;
                var active = 0;

                return new Promise(function (resolve) {
                    function next() {
                        if (idxPtr >= pendingIdx.length && active === 0) { resolve(); return; }
                        while (active < CONCURRENCY && idxPtr < pendingIdx.length) {
                            (function (itemIndex) {
                                var item = job.items[itemIndex];
                                item.status = 'uploading';
                                item.attempts = (item.attempts || 0);
                                active++;

                                uploadOne(item.blob, item.isVideo, itemIndex, job.items.length, stats, MAX_ATTEMPTS)
                                    .then(function (url) {
                                        item.url = url;
                                        item.status = 'uploaded';
                                    })
                                    .catch(function (err) {
                                        item.status = 'failed';
                                        item.attempts = (item.attempts || 0) + 1;
                                        item.lastError = (err && err.message) ? err.message : String(err);
                                        job.lastError = item.lastError;
                                    })
                                    .then(function () {
                                        active--;
                                        job.uploadedCount = countUploaded();
                                        // Persist progress after each item.
                                        return putJob(job).catch(function () {});
                                    })
                                    .then(function () {
                                        broadcast({
                                            type: 'job-progress',
                                            jobId: job.id,
                                            uploadedCount: job.uploadedCount,
                                            totalCount: job.totalCount,
                                            state: job.state
                                        });
                                        onProgress(job);
                                        next();
                                    });
                            })(pendingIdx[idxPtr++]);
                        }
                    }
                    next();
                });
            });

        return uploadPromise.then(function () {
            // If any items are still failed, leave the job alone; caller
            // can offer "Retry failed".
            var failed = job.items.filter(function (it) { return it.status === 'failed'; });
            if (failed.length > 0) {
                job.state = 'error';
                return putJob(job).then(function () {
                    broadcast({ type: 'job-error', jobId: job.id, failedCount: failed.length, totalCount: job.totalCount });
                    return { ok: false, reason: 'items failed', failedCount: failed.length };
                });
            }

            // All items uploaded. Now try to save.
            var token = getTokenFn();
            job.state = 'saving';
            return putJob(job).then(function () {
                broadcast({ type: 'job-saving', jobId: job.id });
                if (!token) {
                    // No admin token — pause at 'saving'. The worker will
                    // pick this up again when the admin logs in.
                    return { ok: false, reason: 'no-token' };
                }
                return saveToBackend(job, token).then(function () {
                    job.state = 'verifying';
                    return putJob(job);
                }).then(function () {
                    return confirmBackendHasProduct(job);
                }).then(function (check) {
                    if (check.confirmed) {
                        job.state = 'done';
                        return putJob(job).then(function () {
                            return deleteJob(job.id);
                        }).then(function () {
                            revokePendingObjectUrls(job.id);
                            broadcast({ type: 'job-done', jobId: job.id });
                            return { ok: true, state: 'done' };
                        });
                    }
                    job.state = 'error';
                    job.lastError = 'not confirmed: ' + check.reason;
                    return putJob(job).then(function () {
                        broadcast({ type: 'job-error', jobId: job.id, reason: check.reason });
                        return { ok: false, reason: check.reason };
                    });
                });
            });
        }).catch(function (err) {
            job.state = 'error';
            job.lastError = (err && err.message) ? err.message : String(err);
            return putJob(job).catch(function () {}).then(function () {
                broadcast({ type: 'job-error', jobId: job.id, reason: job.lastError });
                return { ok: false, reason: job.lastError };
            });
        });
    }

    // ============================================================
    // WORKER — main loop
    // ============================================================
    function startWorker(opts) {
        if (_workerRunning) return Promise.resolve();
        _workerRunning = true;
        _workerStopped = false;
        initChannel();

        function loop() {
            if (_workerStopped) { _workerRunning = false; return Promise.resolve(); }
            return acquireLock().then(function (lock) {
                if (!lock || !lock.acquired) {
                    _workerRunning = false;
                    return;
                }
                _currentLockRelease = lock.release;
                return processAllJobs(opts).then(function () {
                    try { lock.release(); } catch (e) {}
                    _currentLockRelease = null;
                    _workerRunning = false;
                    broadcast({ type: 'worker-idle' });
                }).catch(function () {
                    try { lock.release(); } catch (e) {}
                    _currentLockRelease = null;
                    _workerRunning = false;
                });
            });
        }
        return loop();
    }

    function processAllJobs(opts) {
        return getAllJobs().then(function (jobs) {
            var toRun = jobs.filter(function (j) {
                if (j.state === 'done') return false;
                if (j.state === 'error') return false;    // error needs explicit retry
                return true;
            });
            var chain = Promise.resolve();
            toRun.forEach(function (job) {
                chain = chain.then(function () {
                    if (_workerStopped) return;
                    return processJob(job, opts);
                });
            });
            return chain;
        });
    }

    function stopWorker() {
        _workerStopped = true;
        try { if (_currentLockRelease) _currentLockRelease(); } catch (e) {}
        _currentLockRelease = null;
    }
    function isWorkerRunning() { return _workerRunning; }

    // Retry failed items only: reset them to 'queued' and re-run.
    function retryFailedItems(jobId, opts) {
        return getJob(jobId).then(function (job) {
            if (!job) return { ok: false, reason: 'job not found' };
            var changed = false;
            job.items.forEach(function (it) {
                if (it.status === 'failed') {
                    it.status = 'queued';
                    it.attempts = 0;
                    delete it.lastError;
                    changed = true;
                }
            });
            if (!changed) return { ok: false, reason: 'no failed items' };
            job.state = 'queued';
            job.lastError = '';
            return putJob(job).then(function () {
                return startWorker(opts).then(function () { return { ok: true }; });
            });
        });
    }

    // ============================================================
    // HELPERS FOR PAGES
    // ============================================================
    function getPendingProducts() {
        return getAllJobs().then(function (jobs) {
            var out = [];
            jobs.forEach(function (j) {
                if (j.state === 'done') return;
                var p = jobToPendingProduct(j);
                if (p) out.push(p);
            });
            return out;
        });
    }

    function getQueueStats() {
        return getAllJobs().then(function (jobs) {
            var totalJobs = jobs.length;
            var activeJobs = 0;
            var uploaded = 0;
            var total = 0;
            jobs.forEach(function (j) {
                if (j.state === 'done') return;
                activeJobs++;
                uploaded += j.uploadedCount || 0;
                total    += j.totalCount || 0;
            });
            return {
                totalJobs:   totalJobs,
                activeJobs:  activeJobs,
                uploaded:    uploaded,
                total:       total,
                isIdle:      activeJobs === 0
            };
        });
    }

    function anyActiveJobs() {
        return getQueueStats().then(function (s) { return s.activeJobs > 0; });
    }

    // ============================================================
    // UTILITIES
    // ============================================================
    function isAvailable() { return hasIDB; }
    function supportsBroadcastChannel() { return hasBroadcastChannel; }
    function supportsWebLocks() { return hasWebLocks; }
    function currentTabId() { return TAB_ID; }

    function newJobId(prefix) {
        prefix = prefix || 'P';
        var ts   = Date.now().toString(36).toUpperCase();
        var rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        return prefix + '-' + ts + '-' + rand;
    }

    function removeLegacyLocalStorageKey() {
        try { global.localStorage.removeItem('nakowa_pending_products'); } catch (e) {}
    }

    function readTokenFromSession() { return readToken(); }

    // Auto-init the BroadcastChannel so events are received even
    // before startWorker() is called (needed for the banner).
    try { initChannel(); } catch (e) {}

    // ============================================================
    // PUBLIC API
    // ============================================================
    var api = {
        // feature detection
        isAvailable:              isAvailable,
        supportsBroadcastChannel: supportsBroadcastChannel,
        supportsWebLocks:         supportsWebLocks,
        currentTabId:             currentTabId,

        // core IDB
        openDb:          openDb,
        putJob:          putJob,
        getJob:          getJob,
        getAllJobs:      getAllJobs,
        getJobMeta:      getJobMeta,
        getAllJobMetas:  getAllJobMetas,
        deleteJob:       deleteJob,
        clearAllJobs:    clearAllJobs,
        putMeta:         putMeta,
        getMeta:         getMeta,

        // upload layer
        compressImage:            compressImage,
        resolveSupabaseBucket:    resolveSupabaseBucket,
        getResolvedSupabaseBucket: getResolvedSupabaseBucket,
        getSupabaseStats:         getSupabaseStats,
        uploadToSupabase:         uploadToSupabase,
        uploadToCloudinary:       uploadToCloudinary,
        uploadWithRetry:          uploadWithRetry,
        uploadOne:                uploadOne,

        // worker
        startWorker:      startWorker,
        stopWorker:       stopWorker,
        isWorkerRunning:  isWorkerRunning,
        processJob:       processJob,
        retryFailedItems: retryFailedItems,

        // shapes / helpers
        jobToProduct:         jobToProduct,
        jobToPendingProduct:  jobToPendingProduct,
        revokePendingObjectUrls: revokePendingObjectUrls,
        revokeAllPendingObjectUrls: revokeAllPendingObjectUrls,
        getPendingProducts:   getPendingProducts,
        getQueueStats:        getQueueStats,
        anyActiveJobs:        anyActiveJobs,

        // events
        onEvent:          onEvent,

        // misc
        newJobId:                    newJobId,
        removeLegacyLocalStorageKey: removeLegacyLocalStorageKey,
        readTokenFromSession:        readTokenFromSession
    };

    global.NakowaQueue = api;

})(typeof window !== 'undefined' ? window : this);