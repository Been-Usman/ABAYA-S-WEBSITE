/* NAKOWA ABAYAS — shared config (config.js)
   Loaded BEFORE queue.js and admin.js / script.js.
   Provides every constant that admin.js and script.js expect. */

var API_URL = 'https://script.google.com/macros/s/AKfycbxGcW2xkagjfp9Dr3Jz_1sflwM-JRbjPV1LUF4UoWzhAGJU2epWVDhXoQH9TgkevU5D/exec';

var CLOUDINARY = {
    cloudName: 'Idtixrva',           /* double-check capital-I vs lowercase-l */
    uploadPreset: 'NAKOWA-ABAYAS',
    folder: 'ABAYAS-VIDEO-IMGS'
};
CLOUDINARY.imageUrl = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY.cloudName + '/image/upload';
CLOUDINARY.videoUrl = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY.cloudName + '/video/upload';
CLOUDINARY.baseUrl  = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY.cloudName;

var SUPABASE = {
    url: 'https://yntkbjzvmizssrxwzuoi.supabase.co',
    key: 'sb_publishable_CFyA2zonltT81jFRMyAQpg_kx5vLA_u',
    bucket: 'Product-images',
    bucketAliases: ['product-images', 'PRODUCT-IMAGES', 'Product-Images', 'products-images', 'nakowa-images'],
    maxImages: 200,
    maxSizeMB: 900,
    threshold: 200
};

var DEFAULT_WHATSAPP = '201500766295';

var COLOR_PALETTE = [
    { name: 'Black', value: '#000000' }, { name: 'White', value: '#FFFFFF' },
    { name: 'Red', value: '#E74C3C' },   { name: 'Blue', value: '#2563EB' },
    { name: 'Green', value: '#22C55E' }, { name: 'Navy', value: '#1E3A8A' },
    { name: 'Brown', value: '#8B4513' }, { name: 'Beige', value: '#D4B896' },
    { name: 'Cream', value: '#F5E6C8' }, { name: 'Pink', value: '#EC4899' },
    { name: 'Purple', value: '#7C3AED' },{ name: 'Yellow', value: '#FACC15' },
    { name: 'Orange', value: '#F97316' },{ name: 'Grey', value: '#6B7280' },
    { name: 'Gold', value: '#D4AF37' },  { name: 'Silver', value: '#C0C0C0' },
    { name: 'Maroon', value: '#7F1D1D' },{ name: 'Teal', value: '#14B8A6' },
    { name: 'Lavender', value: '#B0A5D6' }, { name: 'Olive', value: '#808000' }
];

var DEFAULT_IMG = (typeof window !== 'undefined' && window.FALLBACK_IMG) ? window.FALLBACK_IMG : '';

var TOKEN_LIFETIME_MS = 5 * 60 * 60 * 1000;
var TOKEN_KEY         = 'nakowa_admin_token';
var TOKEN_TIME_KEY    = 'nakowa_admin_token_time';
var USER_KEY          = 'nakowa_admin_user';
var SESSION_IDLE_MS   = 30 * 60 * 1000;
var AUTH_CONFIG_KEY   = 'nakowa_admin_auth';

var QUEUE_DB_NAME            = 'nakowa_queue';
var QUEUE_DB_VERSION         = 1;
var QUEUE_STORE              = 'jobs';
var QUEUE_META_STORE         = 'meta';
var QUEUE_CHANNEL            = 'nakowa-queue';
var QUEUE_UPLOAD_CONCURRENCY = 6;
var QUEUE_MAX_ATTEMPTS       = 3;
var QUEUE_LOCK_NAME          = 'nakowa-queue-worker';
var QUEUE_HEARTBEAT_MS       = 15000;
var QUEUE_SAVE_CHUNK         = 20;