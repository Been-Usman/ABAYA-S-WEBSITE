/* ============================================================
   NAKOWA ABAYAS COLLECTIONS — SHARED CONFIG (config.js)
   ------------------------------------------------------------
   Loaded by index.html and admin/admin.html, BEFORE script.js
   and admin.js respectively. Also loaded before queue.js.

   This file contains ONLY shared constants. No logic, no side
   effects, no DOM access. Safe to load first.
   ============================================================ */

// ------------------------------------------------------------
// Backend — Google Apps Script Web App URL
// ------------------------------------------------------------
var API_URL = 'https://script.google.com/macros/s/AKfycbxGcW2xkagjfp9Dr3Jz_1sflwM-JRbjPV1LUF4UoWzhAGJU2epWVDhXoQH9TgkevU5D/exec';

// ------------------------------------------------------------
// Cloudinary
// ------------------------------------------------------------
// NOTE: cloudName is written exactly as provided: 'Idtixrva'.
// If the real value begins with a lowercase L ('ldtixrva'),
// change ONLY the cloudName string below. imageUrl / videoUrl /
// baseUrl are derived from it automatically — nothing else to edit.
// ------------------------------------------------------------
var CLOUDINARY = {
    cloudName: 'Idtixrva',
    uploadPreset: 'NAKOWA-ABAYAS',
    folder: 'ABAYAS-VIDEO-IMGS'
};
CLOUDINARY.imageUrl = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY.cloudName + '/image/upload';
CLOUDINARY.videoUrl = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY.cloudName + '/video/upload';
CLOUDINARY.baseUrl  = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY.cloudName;

// ------------------------------------------------------------
// Supabase Storage
// ------------------------------------------------------------
var SUPABASE = {
    url: 'https://yntkbjzvmizssrxwzuoi.supabase.co',
    key: 'sb_publishable_CFyA2zonltT81jFRMyAQpg_kx5vLA_u',
    bucket: 'Product-images',
    bucketAliases: ['product-images', 'PRODUCT-IMAGES', 'Product-Images', 'products-images', 'nakowa-images'],
    maxImages: 200,
    maxSizeMB: 900,
    threshold: 200
};

// ------------------------------------------------------------
// Shared UI constants
// ------------------------------------------------------------
var DEFAULT_WHATSAPP = '201500766295';

var COLOR_PALETTE = [
    { name: 'Black',    value: '#000000' },
    { name: 'White',    value: '#FFFFFF' },
    { name: 'Red',      value: '#E74C3C' },
    { name: 'Blue',     value: '#2563EB' },
    { name: 'Green',    value: '#22C55E' },
    { name: 'Navy',     value: '#1E3A8A' },
    { name: 'Brown',    value: '#8B4513' },
    { name: 'Beige',    value: '#D4B896' },
    { name: 'Cream',    value: '#F5E6C8' },
    { name: 'Pink',     value: '#EC4899' },
    { name: 'Purple',   value: '#7C3AED' },
    { name: 'Yellow',   value: '#FACC15' },
    { name: 'Orange',   value: '#F97316' },
    { name: 'Grey',     value: '#6B7280' },
    { name: 'Gold',     value: '#D4AF37' },
    { name: 'Silver',   value: '#C0C0C0' },
    { name: 'Maroon',   value: '#7F1D1D' },
    { name: 'Teal',     value: '#14B8A6' },
    { name: 'Lavender', value: '#B0A5D6' },
    { name: 'Olive',    value: '#808000' }
];

// Image fallback (kept in sync with the inline FALLBACK_IMG in the HTML files)
var DEFAULT_IMG = (typeof window !== 'undefined' && window.FALLBACK_IMG)
    ? window.FALLBACK_IMG
    : 'data:image/svg+xml;charset=UTF-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22400%22%20height%3D%22400%22%20viewBox%3D%220%200%20400%20400%22%3E%3Crect%20width%3D%22400%22%20height%3D%22400%22%20fill%3D%22%23000000%22%2F%3E%3Ctext%20x%3D%22200%22%20y%3D%22200%22%20fill%3D%22%23d4af37%22%20font-family%3D%22Poppins%2CArial%2Csans-serif%22%20font-size%3D%2256%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20dominant-baseline%3D%22central%22%3ENAKOWA%3C%2Ftext%3E%3C%2Fsvg%3E';

// ------------------------------------------------------------
// Token constants (used by admin.js — kept here so the value
// is defined in ONE place)
// ------------------------------------------------------------
var TOKEN_LIFETIME_MS = 5 * 60 * 60 * 1000; // 5 hours
var TOKEN_KEY      = 'nakowa_admin_token';
var TOKEN_TIME_KEY = 'nakowa_admin_token_time';
var USER_KEY       = 'nakowa_admin_user';

// ------------------------------------------------------------
// Queue constants (used by queue.js — Part 2)
// ------------------------------------------------------------
var QUEUE_DB_NAME        = 'nakowa_queue';
var QUEUE_DB_VERSION     = 1;
var QUEUE_STORE          = 'jobs';
var QUEUE_CHANNEL        = 'nakowa-queue';
var QUEUE_UPLOAD_CONCURRENCY = 6;
var QUEUE_MAX_ATTEMPTS   = 3;
var QUEUE_LOCK_NAME      = 'nakowa-queue-worker';
var QUEUE_HEARTBEAT_MS   = 15000;
var QUEUE_SAVE_CHUNK     = 20;