/* NAKOWA ABAYAS — queue.js (minimal working version)
   Provides the API surface that admin.js and script.js call.
   isAvailable() returns false, so admin.js falls back to direct upload.
   Replace this file with the full queue.js when you want instant
   display + IndexedDB background upload. */
(function (global) {
    'use strict';

    function isAvailable() { return false; }
    function supportsBroadcastChannel() { return false; }
    function supportsWebLocks() { return false; }

    function newJobId(prefix) {
        prefix = prefix || 'P';
        var ts = Date.now().toString(36).toUpperCase();
        var rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        return prefix + '-' + ts + '-' + rand;
    }
    function noop() { return Promise.resolve(); }
    function emptyList() { return Promise.resolve([]); }
    function nullPromise() { return Promise.resolve(null); }

    function getSupabaseStats() {
        return fetch(SUPABASE.url + '/storage/v1/object/list/' + SUPABASE.bucket, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + SUPABASE.key,
                'apikey': SUPABASE.key,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ limit: 1000, offset: 0 })
        }).then(function (res) {
            if (!res.ok) return { count: 0, sizeMB: 0 };
            return res.json().then(function (files) {
                var total = 0;
                (files || []).forEach(function (f) { if (f.metadata && f.metadata.size) total += f.metadata.size; });
                return { count: files ? files.length : 0, sizeMB: total / (1024 * 1024) };
            });
        }).catch(function () { return { count: 0, sizeMB: 0 }; });
    }

    function compressImage(file, maxWidth, quality) {
        if (!file || (file.size && file.size < 200 * 1024)) return Promise.resolve(file);
        maxWidth = maxWidth || 900; quality = quality || 0.72;
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
                    canvas.width = w; canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    canvas.toBlob(function (blob) {
                        if (!blob) return reject(new Error('Compression failed'));
                        var nf;
                        try { nf = new File([blob], (file.name || 'image.jpg').replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }); }
                        catch (e2) { nf = blob; }
                        resolve(nf);
                    }, 'image/jpeg', quality);
                };
                img.onerror = function () { reject(new Error('Image load failed')); };
            };
            reader.onerror = function () { reject(new Error('FileReader failed')); };
        });
    }

    function uploadToCloudinary(file, isVideo) {
        var form = new FormData();
        form.append('file', file);
        form.append('upload_preset', CLOUDINARY.uploadPreset);
        form.append('folder', CLOUDINARY.folder);
        var endpoint = isVideo ? CLOUDINARY.videoUrl : CLOUDINARY.imageUrl;
        return fetch(endpoint, { method: 'POST', body: form }).then(function (res) {
            return res.json().then(function (data) {
                if (data.error) throw new Error('Cloudinary: ' + ((data.error.message) || 'error'));
                if (!data.secure_url) throw new Error('Cloudinary: no URL');
                return data.secure_url;
            });
        });
    }

    function uploadToSupabase(file) {
        var filename = Date.now() + '-' + Math.random().toString(36).substring(2, 8) + '.jpg';
        var url = SUPABASE.url + '/storage/v1/object/' + SUPABASE.bucket + '/' + filename;
        return fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + SUPABASE.key,
                'apikey': SUPABASE.key,
                'Content-Type': file.type || 'image/jpeg',
                'x-upsert': 'false'
            },
            body: file
        }).then(function (res) {
            if (!res.ok) return res.text().then(function (t) { throw new Error('Supabase ' + res.status + ': ' + t); });
            return SUPABASE.url + '/storage/v1/object/public/' + SUPABASE.bucket + '/' + filename;
        });
    }

    function uploadWithRetry(fn, max) {
        max = max || 3;
        var n = 0;
        function go() {
            n++;
            return fn().catch(function (e) {
                if (n >= max) throw e;
                return new Promise(function (r) { setTimeout(r, 500 * n); }).then(go);
            });
        }
        return go();
    }

    function uploadOne(file, isVideo, indexInBatch, batchLength, stats) {
        stats = stats || { count: 0, sizeMB: 0 };
        if (isVideo) return uploadWithRetry(function () { return uploadToCloudinary(file, true); });
        var large = (batchLength || 1) > 20;
        return compressImage(file, large ? 1000 : 1200, large ? 0.70 : 0.80)
            .then(function (c) { return uploadWithRetry(function () { return uploadToCloudinary(c, false); }); });
    }

    var api = {
        isAvailable: isAvailable,
        supportsBroadcastChannel: supportsBroadcastChannel,
        supportsWebLocks: supportsWebLocks,
        currentTabId: function () { return 'tab-' + Math.random().toString(36).slice(2, 10); },
        newJobId: newJobId,
        openDb: nullPromise,
        putJob: noop,
        getJob: nullPromise,
        getAllJobs: emptyList,
        getJobMeta: nullPromise,
        getAllJobMetas: emptyList,
        deleteJob: noop,
        clearAllJobs: noop,
        putMeta: noop,
        getMeta: nullPromise,
        compressImage: compressImage,
        resolveSupabaseBucket: function () { return Promise.resolve(true); },
        getResolvedSupabaseBucket: function () { return SUPABASE.bucket; },
        getSupabaseStats: getSupabaseStats,
        uploadToSupabase: uploadToSupabase,
        uploadToCloudinary: uploadToCloudinary,
        uploadWithRetry: uploadWithRetry,
        uploadOne: uploadOne,
        startWorker: noop,
        stopWorker: noop,
        isWorkerRunning: function () { return false; },
        processJob: noop,
        retryFailedItems: function () { return Promise.resolve({ ok: false, reason: 'queue not active' }); },
        jobToProduct: function (j) { return j; },
        jobToPendingProduct: function () { return null; },
        revokePendingObjectUrls: noop,
        revokeAllPendingObjectUrls: noop,
        getPendingProducts: emptyList,
        getQueueStats: function () { return Promise.resolve({ totalJobs: 0, activeJobs: 0, uploaded: 0, total: 0, isIdle: true }); },
        anyActiveJobs: function () { return Promise.resolve(false); },
        onEvent: function () { return function () {}; },
        removeLegacyLocalStorageKey: function () { try { localStorage.removeItem('nakowa_pending_products'); } catch (e) {} },
        readTokenFromSession: function () { return ''; }
    };
    global.NakowaQueue = api;
})(typeof window !== 'undefined' ? window : this);