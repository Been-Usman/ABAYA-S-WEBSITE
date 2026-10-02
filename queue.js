/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — Shared Upload Queue (queue.js)
   ------------------------------------------------------------
   Loaded by BOTH admin.html and index.html, BEFORE admin.js
   or script.js. Exposes window.NakowaQueue.

   Responsibilities:
     • IndexedDB open/upgrade ('nakowa-queue' → store 'jobs')
     • Job CRUD: enqueue, get, list, update, remove
     • Upload worker with concurrency 6, retry/backoff (max 3)
     • Web Locks so only one tab runs the worker at a time
     • BroadcastChannel 'nakowa-queue' for cross-tab sync
     • Backend save (saveProductsBatch) + confirm-then-delete
     • getPendingProducts() for public + admin rendering
     • onProgress(cb) + onDrain(cb) callbacks
     • purgeLegacyLocalStorage() — one-time migration cleanup
     • Auto-resume on load if unfinished jobs exist
     • Upload banner helper (fixed bottom-right)

   Honest limitation:
     Browsers cannot upload after the tab is fully closed
     (no Background Sync on iOS). Jobs persist in IndexedDB
     and resume on the next visit to either page.

   Depends on globals (with fallbacks):
     API_URL, CLOUDINARY, SUPABASE — set by admin.js/script.js.
   ============================================================ */

(function () {
    'use strict';

    // ------------------------------------------------------------
    // CONSTANTS
    // ------------------------------------------------------------
    const DB_NAME = 'nakowa-queue';
    const DB_VERSION = 1;
    const STORE = 'jobs';
    const BC_NAME = 'nakowa-queue';
    const LOCK_NAME = 'nakowa-queue-worker';
    const CONCURRENCY = 6;
    const MAX_ATTEMPTS = 3;

    // Fallback config (used only if admin.js/script.js haven't set globals).
    const FB_API_URL = 'https://script.google.com/macros/s/AKfycbxGcW2xkagjfp9Dr3Jz_1sflwM-JRbjPV1LUF4UoWzhAGJU2epWVDhXoQH9TgkevU5D/exec';
    const FB_CLOUDINARY = {
        cloudName: 'ldtixrva',
        uploadPreset: 'NAKOWA-ABAYAS',
        folder: 'ABAYAS-VIDEO-IMGS',
        imageUrl: 'https://api.cloudinary.com/v1_1/ldtixrva/image/upload',
        videoUrl: 'https://api.cloudinary.com/v1_1/ldtixrva/video/upload'
    };
    const FB_SUPABASE = {
        url: 'https://yntkbjzvmizssrxwzuoi.supabase.co',
        key: 'sb_publishable_CFyA2zonltT81jFRMyAQpg_kx5vLA_u',
        bucket: 'Product-images',
        bucketAliases: ['Product-images', 'product-images', 'PRODUCT-IMAGES', 'Product-Images', 'products-images', 'nakowa-images'],
        maxImages: 200,
        maxSizeMB: 900
    };

    function cfg() {
        return {
            API_URL:    window.API_URL    || FB_API_URL,
            CLOUDINARY: window.CLOUDINARY || FB_CLOUDINARY,
            SUPABASE:   window.SUPABASE   || FB_SUPABASE
        };
    }

    // ------------------------------------------------------------
    // INDEXEDDB
    // ------------------------------------------------------------
    let _dbPromise = null;
    let idbUnavailable = false;

    function openDB() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                idbUnavailable = true;
                reject(new Error('IndexedDB unavailable'));
                return;
            }
            let req;
            try {
                req = indexedDB.open(DB_NAME, DB_VERSION);
            } catch (e) {
                idbUnavailable = true;
                reject(e);
                return;
            }
            req.onupgradeneeded = function (ev) {
                const db = ev.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'id' });
                    store.createIndex('state', 'state', { unique: false });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error); };
        });
        return _dbPromise;
    }

    async function withStore(mode, fn) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const store = tx.objectStore(STORE);
            let result;
            try {
                result = fn(store);
            } catch (e) {
                reject(e);
                return;
            }
            tx.oncomplete = () => {
                if (result && typeof result.then === 'function') {
                    result.then(resolve).catch(reject);
                } else {
                    resolve(result);
                }
            };
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('tx aborted'));
        });
    }

    async function idbPut(job) { return withStore('readwrite', s => s.put(job)); }
    async function idbGet(id) { return withStore('readonly', s => new Promise((res, rej) => {
        const r = s.get(id);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
    })); }
    async function idbDelete(id) { return withStore('readwrite', s => s.delete(id)); }
    async function idbAll() { return withStore('readonly', s => new Promise((res, rej) => {
        const r = s.getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
    })); }

    // ------------------------------------------------------------
    // IN-MEMORY FALLBACK (private mode / no IDB)
    // ------------------------------------------------------------
    const _mem = new Map();

    async function put(job) {
        try {
            if (idbUnavailable) { _mem.set(job.id, job); return; }
            await idbPut(job);
        } catch (e) {
            idbUnavailable = true;
            warnQuotaOnce(e);
            _mem.set(job.id, job);
        }
    }
    async function get(id) {
        if (idbUnavailable) return _mem.get(id) || null;
        try { return await idbGet(id); } catch (e) { return _mem.get(id) || null; }
    }
    async function del(id) {
        _mem.delete(id);
        if (idbUnavailable) return;
        try { await idbDelete(id); } catch (e) {}
    }
    async function all() {
        let dbJobs = [];
        if (!idbUnavailable) {
            try { dbJobs = await idbAll(); } catch (e) { idbUnavailable = true; }
        }
        const map = new Map();
        dbJobs.forEach(j => map.set(j.id, j));
        _mem.forEach((v, k) => map.set(k, v));
        return Array.from(map.values());
    }

    let _quotaWarned = false;
    function warnQuotaOnce(err) {
        if (_quotaWarned) return;
        _quotaWarned = true;
        if (err && err.name === 'QuotaExceededError') {
            showToast('Storage full — clear some pending uploads or free space.', '⚠️');
        } else if (idbUnavailable) {
            showToast('IndexedDB unavailable — pending products will only live in memory.', '⚠️');
        }
    }

    // ------------------------------------------------------------
    // BROADCASTCHANNEL
    // ------------------------------------------------------------
    let bc = null;
    try {
        if ('BroadcastChannel' in window) {
            bc = new BroadcastChannel(BC_NAME);
        }
    } catch (e) { bc = null; }

    function broadcast(msg) {
        if (!bc) return;
        try { bc.postMessage(msg); } catch (e) {}
    }

    // Listeners registered by admin.js / script.js
    const progressCbs = [];
    const drainCbs = [];
    function onProgress(cb) { if (typeof cb === 'function') progressCbs.push(cb); }
    function onDrain(cb)    { if (typeof cb === 'function') drainCbs.push(cb); }

    function emitProgress(job) {
        progressCbs.forEach(cb => { try { cb(job); } catch (e) {} });
        broadcast({ type: 'progress', jobId: job.id, uploadedCount: job.uploadedCount, totalCount: job.totalCount });
    }
    function emitDrain() {
        drainCbs.forEach(cb => { try { cb(); } catch (e) {} });
        broadcast({ type: 'drain' });
    }

    // Also react to messages broadcast by other tabs.
    if (bc) {
        bc.onmessage = function (ev) {
            const msg = ev.data || {};
            if (msg.type === 'progress') {
                progressCbs.forEach(cb => { try { cb({ id: msg.jobId, uploadedCount: msg.uploadedCount, totalCount: msg.totalCount }); } catch (e) {} });
            } else if (msg.type === 'drain') {
                drainCbs.forEach(cb => { try { cb(); } catch (e) {} });
            } else if (msg.type === 'kick') {
                // Another tab asked the worker to run.
                runWorker().catch(() => {});
            }
        };
    }

    // ------------------------------------------------------------
    // SUPABASE BUCKET RESOLUTION (lightweight, per-worker)
    // ------------------------------------------------------------
    let supabaseBucket = null;
    let supabaseBucketCheckedAt = 0;
    const BUCKET_TTL = 30 * 60 * 1000;

    function bucketCandidates() {
        const c = cfg().SUPABASE;
        const list = [c.bucket].concat(c.bucketAliases || []);
        return Array.from(new Set(list.filter(Boolean)));
    }

    async function probeSupabaseBucket() {
        const probeName = '_nakowa-bucket-probe.jpg';
        const S = cfg().SUPABASE;
        for (const candidate of bucketCandidates()) {
            try {
                const res = await fetch(S.url + '/storage/v1/object/public/' + candidate + '/' + probeName, { cache: 'no-store' });
                let body = null;
                try { body = await res.json(); } catch (e) { body = null; }
                const code = body && body.code;
                // Success if the bucket exists (any response other than NoSuchBucket).
                if (code !== 'NoSuchBucket') {
                    supabaseBucket = candidate;
                    return true;
                }
            } catch (e) { /* try next */ }
        }
        supabaseBucket = null;
        return false;
    }

    async function resolveBucket() {
        if (supabaseBucket && (Date.now() - supabaseBucketCheckedAt) < BUCKET_TTL) return true;
        supabaseBucketCheckedAt = Date.now();
        return probeSupabaseBucket();
    }

    // ------------------------------------------------------------
    // SUPABASE STATS
    // ------------------------------------------------------------
    async function getSupabaseStats() {
        const S = cfg().SUPABASE;
        if (!(await resolveBucket())) return { count: 0, sizeMB: 0 };
        try {
            const res = await fetch(S.url + '/storage/v1/object/list/' + supabaseBucket, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + S.key,
                    'apikey': S.key,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ limit: 1000, offset: 0 })
            });
            if (!res.ok) return { count: 0, sizeMB: 0 };
            const files = await res.json();
            let totalSize = 0;
            (files || []).forEach(f => { if (f.metadata && f.metadata.size) totalSize += f.metadata.size; });
            return { count: files.length || 0, sizeMB: totalSize / (1024 * 1024) };
        } catch (e) {
            return { count: 0, sizeMB: 0 };
        }
    }

    // ------------------------------------------------------------
    // IMAGE COMPRESSION (same algorithm as admin.js)
    // ------------------------------------------------------------
    async function compressImage(file, maxWidth, quality) {
        maxWidth = maxWidth || 1000;
        quality = quality || 0.75;
        if (file.size && file.size < 200 * 1024) return file;
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
                        const newFile = new File([blob], (file.name || 'img').replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
                        resolve(newFile);
                    }, 'image/jpeg', quality);
                };
                img.onerror = reject;
            };
            reader.onerror = reject;
        });
    }

    // ------------------------------------------------------------
    // UPLOAD: SUPABASE + CLOUDINARY
    // ------------------------------------------------------------
    async function uploadToSupabase(file) {
        const S = cfg().SUPABASE;
        const filename = Date.now() + '-' + Math.random().toString(36).substring(2, 8) + '.jpg';
        const url = S.url + '/storage/v1/object/' + supabaseBucket + '/' + filename;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + S.key,
                'apikey': S.key,
                'Content-Type': file.type || 'image/jpeg',
                'x-upsert': 'false'
            },
            body: file
        });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error('Supabase upload failed (' + res.status + '): ' + errText);
        }
        return S.url + '/storage/v1/object/public/' + supabaseBucket + '/' + filename;
    }

    async function uploadToCloudinary(file, isVideo) {
        const C = cfg().CLOUDINARY;
        const formData = new FormData();
        formData.append('file', file);
        formData.append('upload_preset', C.uploadPreset);
        formData.append('folder', C.folder);
        const endpoint = isVideo ? C.videoUrl : C.imageUrl;
        const res = await fetch(endpoint, { method: 'POST', body: formData });
        const data = await res.json();
        if (data.error) {
            const raw = Array.isArray(data.error) ? data.error[0] : data.error;
            const msg = (raw && raw.message) || 'Cloudinary error';
            throw new Error('Cloudinary: ' + msg);
        }
        if (!data.secure_url) throw new Error('Cloudinary: no URL returned');
        return data.secure_url;
    }

    // Per-job stats: fetched ONCE per job, not per file.
    async function uploadOne(item, jobStats) {
        if (item.isVideo) {
            return await uploadToCloudinary(item.blob, true);
        }

        const S = cfg().SUPABASE;
        const counterFull = (jobStats.count + (item._idx || 0)) >= S.maxImages;
        const sizeFull = jobStats.sizeMB >= S.maxSizeMB;
        const useSupabase = !counterFull && !sizeFull && (await resolveBucket());

        const big = (jobStats.total >= 20);
        const maxW = big ? 1000 : 1200;
        const q    = big ? 0.70 : 0.80;

        if (useSupabase) {
            try {
                const compressed = await compressImage(item.blob, maxW, q);
                return await uploadToSupabase(compressed);
            } catch (e) {
                // Fall back to Cloudinary on any Supabase error.
                const compressed = await compressImage(item.blob, maxW, q);
                return await uploadToCloudinary(compressed, false);
            }
        }
        const compressed = await compressImage(item.blob, maxW, q);
        return await uploadToCloudinary(compressed, false);
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ------------------------------------------------------------
    // WORKER — concurrency-limited upload with per-item retry
    // ------------------------------------------------------------
    async function processJob(job) {
        const S = cfg().SUPABASE;

        // Ensure the job object is up to date (in case another tab updated it).
        const fresh = await get(job.id);
        if (!fresh) return; // removed while we were starting
        job = fresh;

        if (job.state === 'done') return;

        job.state = 'uploading';
        await put(job);
        emitProgress(job);

        // Fetch Supabase stats ONCE for the whole job.
        const stats = await getSupabaseStats();
        const jobStats = { count: stats.count, sizeMB: stats.sizeMB, total: job.totalCount };

        // Build a list of indices that still need uploading.
        const todo = [];
        job.items.forEach((item, idx) => {
            if (item.status !== 'uploaded' || !item.url) todo.push(idx);
        });

        let cursor = 0;

        async function worker() {
            while (cursor < todo.length) {
                const i = todo[cursor++];
                const item = job.items[i];
                item._idx = i;

                if (item.status === 'uploaded' && item.url) {
                    continue;
                }

                let attempt = 0;
                while (attempt < MAX_ATTEMPTS) {
                    try {
                        const url = await uploadOne(item, jobStats);
                        item.url = url;
                        item.status = 'uploaded';
                        item.attempts = attempt + 1;
                        delete item.blob; // free memory: the Blob is no longer needed
                        job.uploadedCount = job.items.filter(x => x.status === 'uploaded').length;
                        job.failedCount = job.items.filter(x => x.status === 'failed').length;
                        await put(job);
                        emitProgress(job);
                        break;
                    } catch (err) {
                        attempt++;
                        item.attempts = attempt;
                        if (attempt >= MAX_ATTEMPTS) {
                            item.status = 'failed';
                            item.lastError = String(err && err.message || err);
                            job.failedCount = job.items.filter(x => x.status === 'failed').length;
                            job.lastError = item.lastError;
                            await put(job);
                            emitProgress(job);
                        } else {
                            await sleep(500 * Math.pow(3, attempt - 1));
                        }
                    }
                }
            }
        }

        const workers = [];
        const n = Math.min(CONCURRENCY, todo.length || 1);
        for (let w = 0; w < n; w++) workers.push(worker());
        await Promise.all(workers);

        // Reload job (in case other workers wrote to it)
        job = await get(job.id);
        if (!job) return;

        const uploadedCount = job.items.filter(x => x.status === 'uploaded').length;
        job.uploadedCount = uploadedCount;
        job.failedCount = job.items.filter(x => x.status === 'failed').length;

        if (job.failedCount > 0) {
            job.state = 'error';
            job.lastError = job.failedCount + '/' + job.items.length + ' items failed. Tap Retry to try again.';
            await put(job);
            emitProgress(job);
            refreshBanner().catch(function () {});
            return;
        }

        // Save to backend
        job.state = 'saving';
        await put(job);
        emitProgress(job);

        // Read admin token: try localStorage session first (admin.js stores it
        // there), then sessionStorage (legacy), then memory.
        let token = '';
        try {
            const raw = localStorage.getItem('nakowa_admin_session');
            if (raw) {
                const s = JSON.parse(raw);
                if (s && s.token) token = s.token;
            }
        } catch (e) {}
        if (!token) {
            try { token = sessionStorage.getItem('nakowa_admin_token') || ''; } catch (e) {}
        }
        if (!token) {
            // No token available — leave the job at 'saving' and exit quietly.
            // A future visit (with admin logged in) will finish it.
            job.lastError = 'Waiting for admin token…';
            await put(job);
            emitProgress(job);
            return;
        }

        const product = buildProductFromJob(job);

        let saveRes;
        try {
            saveRes = await fetch(cfg().API_URL, {
                method: 'POST',
                body: JSON.stringify({ action: 'saveProductsBatch', token: token, products: [product] })
            }).then(r => r.json());
        } catch (e) {
            job.state = 'error';
            job.lastError = 'Network error saving: ' + (e && e.message || e);
            await put(job);
            emitProgress(job);
            return;
        }

        if (!saveRes || !saveRes.success) {
            job.state = 'error';
            job.lastError = (saveRes && (saveRes.message || saveRes.error)) || 'Backend save failed';
            await put(job);
            emitProgress(job);
            return;
        }

        // Verify: fetch products and confirm the id exists with real URLs.
        job.state = 'verifying';
        await put(job);
        emitProgress(job);

        let verified = false;
        try {
            const products = await fetch(cfg().API_URL + '?action=products').then(r => r.json());
            const found = Array.isArray(products) && products.find(p => String(p.id) === String(job.id));
            if (found) {
                const variants = Array.isArray(found.variants) ? found.variants : [];
                const hasBlob = variants.some(v => typeof v.image === 'string' && v.image.startsWith('blob:'));
                const urlsOk = variants.length === job.totalCount && !hasBlob;
                if (urlsOk) verified = true;
            }
        } catch (e) { /* retry later */ }

        if (!verified) {
            job.state = 'verifying';
            job.lastError = 'Backend save not verified yet.';
            await put(job);
            emitProgress(job);
            return;
        }

        // Confirmed. Delete the job.
        job.state = 'done';
        await put(job);
        emitProgress(job);
        await del(job.id);
    }

    function buildProductFromJob(job) {
        const variants = [];
        const videos = [];
        job.items.forEach((it, i) => {
            if (it.isVideo) {
                if (it.url) videos.push(it.url);
            } else if (it.url) {
                variants.push({
                    image: it.url,
                    colorName: it.colorName || 'Default',
                    colorValue: it.colorValue || '#D4AF37',
                    price: it.price,
                    code: it.code
                });
            }
        });
        return {
            id: job.id,
            name: job.name,
            code: job.code,
            country: job.country || 'Egypt',
            sizes: job.sizes || ['S', 'M', 'L', 'XL', 'XXL'],
            variants: variants,
            images: variants.map(v => v.image),
            videos: videos,
            stock: job.stock || 10,
            status: job.status || 'active',
            createdAt: job.createdAt
        };
    }

    // ------------------------------------------------------------
    // WE LOCKS — only one tab runs the worker at a time
    // ------------------------------------------------------------
    let workerRunning = false;

    async function runWorker() {
        if (workerRunning) return;
        workerRunning = true;
        try {
            if (navigator.locks && typeof navigator.locks.request === 'function') {
                await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async lock => {
                    if (!lock) return; // another tab is running the worker
                    await runWorkerInner();
                });
            } else {
                // Fallback: simple in-memory lock + short heartbeat write.
                await runWorkerInner();
            }
        } finally {
            workerRunning = false;
        }
    }

    async function runWorkerInner() {
        const jobs = await all();
        // Only pick up unfinished jobs.
        const unfinished = jobs.filter(j => j.state !== 'done');
        if (unfinished.length === 0) {
            emitDrain();
            return;
        }
        for (const job of unfinished) {
            try { await processJob(job); } catch (e) { console.warn('[Queue] job error:', e); }
        }
        // After processing, check if everything is done and emit drain.
        const after = await all();
        if (after.filter(j => j.state !== 'done').length === 0) emitDrain();
    }

    // Public "kick" — admin.js calls this after Save All.
    function kick() {
        broadcast({ type: 'kick' });
        runWorker().catch(() => {});
    }

    // ------------------------------------------------------------
    // RETRY FAILED — resets failed items to 'queued' and kicks worker
    // ------------------------------------------------------------
    async function retryFailed(jobId) {
        const job = await get(jobId);
        if (!job || !Array.isArray(job.items)) return;
        const failed = job.items.filter(function (it) { return it && it.status === 'failed'; });
        if (failed.length === 0) {
            // Nothing to retry — job may already be done/saving. Refresh UI only.
            emitProgress(job);
            refreshBanner().catch(function () {});
            return;
        }
        failed.forEach(function (it) {
            it.status = 'queued';
            it.attempts = 0;
            it.lastError = '';
        });
        job.failedCount = 0;
        job.state = 'queued';
        job.lastError = '';
        await put(job);
        broadcast({ type: 'kick' });
        kick();
    }

    // ------------------------------------------------------------
    // PUBLIC HELPERS — used by admin.js and script.js
    // ------------------------------------------------------------
    async function enqueueJob(job) {
        // Ensure the job has the correct shape.
        job.state = job.state || 'queued';
        job.uploadedCount = job.uploadedCount || 0;
        job.totalCount = job.totalCount || (job.items ? job.items.length : 0);
        job.failedCount = job.failedCount || 0;
        await put(job);
        broadcast({ type: 'progress', jobId: job.id, uploadedCount: job.uploadedCount, totalCount: job.totalCount });
    }

    async function getPendingCount() {
        try {
            const jobs = await all();
            return jobs.filter(j => j.state !== 'done').length;
        } catch (e) { return 0; }
    }

    async function getJobs() {
        try { return await all(); } catch (e) { return []; }
    }

    async function getJob(id) {
        return await get(id);
    }

    async function removeJob(id) {
        await del(id);
    }

    // Merge job ɗin da ke IndexedDB zuwa "products" shape ɗin da
    // admin.js / script.js suke amfani da shi don rendering.
    async function getPendingProducts() {
        const jobs = await all();
        const products = [];
        for (const job of jobs) {
            if (job.state === 'done') continue;

            // Build variants from whatever has a URL so far, otherwise use
            // an in-page object URL from the still-local Blob.
            const variants = [];
            const videos = [];
            const uploadedCount = job.items.filter(x => x.status === 'uploaded').length;

            for (const it of job.items) {
                if (it.isVideo) {
                    const url = it.url || (it.blob ? URL.createObjectURL(it.blob) : '');
                    if (url) videos.push(url);
                } else {
                    const url = it.url || (it.blob ? URL.createObjectURL(it.blob) : '');
                    if (url) {
                        variants.push({
                            image: url,
                            colorName: it.colorName || 'Default',
                            colorValue: it.colorValue || '#D4AF37',
                            price: it.price,
                            code: it.code
                        });
                    }
                }
            }

            products.push({
                id: job.id,
                name: job.name,
                code: job.code,
                country: job.country || 'Egypt',
                sizes: job.sizes || ['S', 'M', 'L', 'XL', 'XXL'],
                variants: variants,
                images: variants.map(v => v.image),
                videos: videos,
                stock: job.stock || 10,
                status: job.status || 'active',
                createdAt: job.createdAt,
                _pending: {
                    state: job.state,
                    uploadedCount: uploadedCount,
                    totalCount: job.totalCount,
                    failedCount: job.failedCount || 0
                },
                _queueMeta: {
                    uploadedCount: uploadedCount,
                    totalCount: job.totalCount,
                    failedCount: job.failedCount || 0
                }
            });
        }
        return products;
    }

    // ------------------------------------------------------------
    // LEGACY MIGRATION
    // ------------------------------------------------------------
    function purgeLegacyLocalStorage() {
        try {
            if (localStorage.getItem('nakowa_pending_products')) {
                localStorage.removeItem('nakowa_pending_products');
                console.log('[Queue] Legacy nakowa_pending_products cleared.');
            }
        } catch (e) {}
    }

    // ------------------------------------------------------------
    // UPLOAD BANNER
    // ------------------------------------------------------------
    function ensureBanner() {
        let el = document.getElementById('nakowaQueueBanner');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'nakowaQueueBanner';
        el.style.cssText = [
            'position:fixed',
            'right:16px',
            'bottom:16px',
            'z-index:9999',
            'padding:10px 16px',
            'border-radius:30px',
            'background:rgba(0,0,0,0.85)',
            'color:#f9e508',
            'font-family:Poppins,system-ui,sans-serif',
            'font-size:0.8rem',
            'font-weight:600',
            'box-shadow:0 6px 20px rgba(0,0,0,0.4)',
            'border:1px solid rgba(249,229,8,0.4)',
            'display:none'
        ].join(';');
        el.innerHTML = '<i class="fas fa-cloud-upload-alt"></i> <span id="nakowaQueueBannerText">Uploading…</span>';
        document.body.appendChild(el);
        return el;
    }

    async function refreshBanner() {
        const el = ensureBanner();
        const jobs = await all();
        const active = jobs.filter(j => j.state !== 'done');
        if (active.length === 0) {
            el.style.display = 'none';
            return;
        }
        let uploaded = 0, total = 0;
        active.forEach(j => { uploaded += (j.uploadedCount || 0); total += (j.totalCount || 0); });
        const txt = document.getElementById('nakowaQueueBannerText');
        if (txt) txt.textContent = 'Uploading ' + uploaded + '/' + total + ' in background';
        el.style.display = 'block';
    }

    // ------------------------------------------------------------
    // TOAST (fallback if the page has no toast system)
    // ------------------------------------------------------------
    function showToast(msg, icon) {
        // Try the page's own toast first.
        const t = document.getElementById('toast');
        if (t && document.getElementById('toastMessage')) {
            document.getElementById('toastMessage').textContent = msg;
            const ic = t.querySelector('.toast-icon');
            if (ic) ic.textContent = icon || '✅';
            t.classList.add('show');
            clearTimeout(t._timer);
            t._timer = setTimeout(() => t.classList.remove('show'), 4000);
            return;
        }
        console.log('[Queue]', icon || '', msg);
    }

    // ------------------------------------------------------------
    // AUTO RESUME
    // ------------------------------------------------------------
    function autoResume() {
        purgeLegacyLocalStorage();
        // Kick the worker without awaiting.
        runWorker().catch(() => {});
        refreshBanner().catch(() => {});
        // Refresh the banner on every progress event.
        onProgress(() => { refreshBanner().catch(() => {}); });
        onDrain(() => { refreshBanner().catch(() => {}); });
    }

    // Auto-resume on page load.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoResume);
    } else {
        autoResume();
    }

    // ------------------------------------------------------------
    // PUBLIC API
    // ------------------------------------------------------------
    window.NakowaQueue = {
        // Job CRUD
        enqueueJob: enqueueJob,
        getJobs: getJobs,
        getJob: getJob,
        removeJob: removeJob,
        getPendingCount: getPendingCount,
        getPendingProducts: getPendingProducts,
        retryFailed: retryFailed,
        // Worker control
        kick: kick,
        // Event hooks
        onProgress: onProgress,
        onDrain: onDrain,
        // Utilities
        purgeLegacyLocalStorage: purgeLegacyLocalStorage,
        refreshBanner: refreshBanner
    };

    console.log('[Queue] NakowaQueue ready.');
})();