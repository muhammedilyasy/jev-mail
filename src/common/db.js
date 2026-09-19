import { matchKey } from './key.js';

// One IndexedDB record per email. Writing a 2000-row array back into
// chrome.storage.local on every classification would be O(n) per email;
// IndexedDB gives us per-row writes and a cheap full read on page load.

const DB_NAME = 'jev-mail';
const DB_VERSION = 2;
const STORE = 'emails';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const store = db.objectStoreNames.contains(STORE)
        ? req.transaction.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: 'id' });

      if (!store.indexNames.contains('internalDate')) store.createIndex('internalDate', 'internalDate');

      // v2 adds the sender+subject key that lets the Gmail overlay and the
      // dashboard recognise the same email. Backfill it for rows stored by v1.
      if (!store.indexNames.contains('matchKey')) {
        store.createIndex('matchKey', 'matchKey');
        if (event.oldVersion >= 1) {
          store.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const row = cursor.value;
            if (!row.matchKey) {
              row.matchKey = matchKey(row.fromEmail, row.subject);
              cursor.update(row);
            }
            cursor.continue();
          };
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export async function getAllEmails() {
  const rows = await tx('readonly', (store) => {
    const req = store.getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
  rows.sort((a, b) => (b.internalDate || 0) - (a.internalDate || 0));
  return rows;
}

export async function getEmailIds() {
  const keys = await tx('readonly', (store) => {
    const req = store.getAllKeys();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  });
  return new Set(keys);
}

export async function putEmails(rows) {
  if (!rows.length) return;
  await tx('readwrite', (store) => {
    for (const row of rows) store.put(row);
  });
}

export async function putEmail(row) {
  return putEmails([row]);
}

/** Look up stored rows by sender+subject key. Returns a Map of key -> row. */
export async function getByMatchKeys(keys) {
  const wanted = [...new Set(keys)].filter(Boolean);
  if (!wanted.length) return new Map();

  return tx('readonly', (store) => {
    const index = store.index('matchKey');
    const found = new Map();
    return new Promise((resolve, reject) => {
      let pending = wanted.length;
      for (const key of wanted) {
        const req = index.get(key);
        req.onsuccess = () => {
          if (req.result) found.set(key, req.result);
          if (--pending === 0) resolve(found);
        };
        req.onerror = () => reject(req.error);
      }
    });
  });
}

export async function deleteEmails(ids) {
  if (!ids.length) return;
  await tx('readwrite', (store) => {
    for (const id of ids) store.delete(id);
  });
}

export async function clearEmails() {
  await tx('readwrite', (store) => store.clear());
}
