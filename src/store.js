// Encrypted storage in the phone's own browser storage (IndexedDB). Nothing is sent anywhere.

import { deriveKey, encryptJson, decryptJson, newSalt, ITERATIONS } from './crypto.js';

const DB = 'finance-app';
const STORE = 'vault';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

const get = (k) => tx('readonly', (s) => s.get(k));
const put = (k, v) => tx('readwrite', (s) => s.put(v, k));

let key = null;
let meta = null;

export async function hasVault() {
  return Boolean(await get('meta'));
}

export async function create(passcode, state) {
  meta = { salt: newSalt(), iterations: ITERATIONS, createdAt: new Date().toISOString() };
  key = await deriveKey(passcode, meta.salt, meta.iterations);
  await put('meta', meta);
  await save(state);
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

// Returns the decrypted state, or null when the passcode is wrong.
export async function unlock(passcode) {
  meta = await get('meta');
  const box = await get('data');
  const k = await deriveKey(passcode, meta.salt, meta.iterations);
  try {
    const state = await decryptJson(k, box);
    key = k;
    return state;
  } catch {
    return null;
  }
}

export function lock() {
  key = null;
}

export async function save(state) {
  if (!key) throw new Error('locked');
  await put('data', await encryptJson(key, state));
}

// Fingerprint unlock data (an encrypted copy of the passcode; see biometric.js).
export const getBio = () => get('bio');
export const setBio = (bio) => put('bio', bio);
export const clearBio = () => tx('readwrite', (s) => s.delete('bio'));

// True when the passcode opens the data, without changing what is unlocked.
export async function checkPasscode(passcode) {
  const m = await get('meta');
  const k = await deriveKey(passcode, m.salt, m.iterations);
  try { await decryptJson(k, await get('data')); return true; } catch { return false; }
}

export async function changePasscode(state, passcode) {
  meta = { ...meta, salt: newSalt(), iterations: ITERATIONS };
  key = await deriveKey(passcode, meta.salt, meta.iterations);
  await save(state);
  await put('meta', meta);
}

// A backup file is encrypted with the passcode, like the data on the phone.
export async function backupBlob(state) {
  const box = await encryptJson(key, state);
  const file = { format: 'finance-app-backup', version: 1, salt: meta.salt, iterations: meta.iterations, ...box, exportedAt: new Date().toISOString() };
  return new Blob([JSON.stringify(file)], { type: 'application/json' });
}

// Returns the state inside a backup file, or null when the passcode doesn't open it.
export async function readBackup(text, passcode) {
  const file = JSON.parse(text);
  if (file.format !== 'finance-app-backup') throw new Error('not a backup');
  const k = await deriveKey(passcode, file.salt, file.iterations);
  try {
    return await decryptJson(k, file);
  } catch {
    return null;
  }
}

export async function wipe() {
  key = null;
  await tx('readwrite', (s) => s.clear());
}
