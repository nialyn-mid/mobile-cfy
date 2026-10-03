import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths, ensureDir, config } from './config.js';

const INDEX = () => path.join(paths().uploads, 'index.json');

function readIndex() {
  try {
    const data = JSON.parse(fs.readFileSync(INDEX(), 'utf8'));
    return Array.isArray(data?.uploads) ? data.uploads : [];
  } catch {
    return [];
  }
}

function writeIndex(rows) {
  ensureDir(paths().uploads);
  const tmp = `${INDEX()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ uploads: rows }, null, 2), 'utf8');
  fs.renameSync(tmp, INDEX());
}

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/avif': '.avif',
};

/**
 * The bytes know what they are, and a phone browser's Content-Type often does
 * not (Android's picker sends `application/octet-stream` plenty often). LoadImage
 * on the ComfyUI side dispatches on the extension, so a wrong one means a broken
 * run - hence sniff first, and only then believe the header or the filename.
 */
export function sniffImage(buffer) {
  const b = buffer;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return '.webp';
  }
  if (b.length > 6 && b.subarray(0, 6).toString('latin1').startsWith('GIF8')) return '.gif';
  if (b.length > 2 && b[0] === 0x42 && b[1] === 0x4d) return '.bmp';
  // ISO-BMFF: look for an 'avif' or 'avis' brand in the first box.
  if (b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = b.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return '.avif';
  }
  return null;
}

export function extFor(mime, originalName = '', buffer = null) {
  const sniffed = buffer ? sniffImage(buffer) : null;
  if (sniffed) return sniffed;
  const fromName = path.extname(originalName || '').toLowerCase();
  if (/^\.[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  return EXT_BY_MIME[String(mime || '').split(';')[0].trim().toLowerCase()] || '.png';
}

/** Store a picked file locally so it can be reused as a reference later. */
export function saveUpload(buffer, originalName = '', mime = '') {
  const id = crypto.randomBytes(9).toString('hex');
  const ext = extFor(mime, originalName, buffer);
  const file = `${id}${ext}`;
  ensureDir(paths().uploads);
  fs.writeFileSync(path.join(paths().uploads, file), buffer);
  const row = {
    id,
    file,
    ext,
    mime: mime || '',
    size: buffer.length,
    original: path.basename(originalName || ''),
    at: new Date().toISOString(),
  };
  writeIndex([...readIndex(), row]);
  return row;
}

export function findUpload(id) {
  const safe = String(id ?? '');
  if (!/^[a-f0-9]{6,64}$/i.test(safe)) return null;
  return readIndex().find((r) => r.id === safe) ?? null;
}

export function readUpload(id) {
  const row = findUpload(id);
  if (!row) return null;
  try {
    return fs.readFileSync(path.join(paths().uploads, row.file));
  } catch {
    return null;
  }
}

export function listUploads() {
  return readIndex().slice(-100).reverse();
}

/**
 * Push bytes to ComfyUI's input directory and return the name LoadImage wants.
 * Generated images live in the output dir, which LoadImage cannot see, so
 * reuse-from-gallery must go through here every time.
 */
export async function pushToComfyInput(client, buffer, filename) {
  const prefix = config().uploadPrefix || 'mobilecfy';
  const stamp = `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const safeExt = path.extname(filename || '') || '.png';
  const name = `${stamp}${safeExt}`;
  const res = await client.uploadImage(buffer, name, { type: 'input', overwrite: true });
  return res?.name ?? name;
}