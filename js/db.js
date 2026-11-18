// Tiny IndexedDB wrapper. Everything lives on the phone; nothing is uploaded.
const DB_NAME = 'hairline-tracker';
const VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('doses', { keyPath: 'date' });
      const photos = db.createObjectStore('photos', { keyPath: 'id' });
      photos.createIndex('date', 'date');
      db.createObjectStore('impressions', { keyPath: 'week' });
      db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const put = (store, value, key) => run(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));
export const clear = (store) => run(store, 'readwrite', (s) => s.clear());

// ---- settings ----
export const DEFAULT_SETTINGS = {
  startDate: '2026-11-14',
  photoWeekday: 0, // Sunday
  angles: ['front', 'crown'],
};

export async function getSettings() {
  const s = await get('kv', 'settings');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
export const saveSettings = (s) => put('kv', s, 'settings');
