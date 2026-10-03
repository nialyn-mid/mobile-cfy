import fs from 'node:fs';
import path from 'node:path';

/** The bash script did `tr '/' '_'`; keep that, plus strip Windows-hostile chars. */
export function sanitizeFilename(fn = '') {
  let out = String(fn)
    .replace(/[/\\]+/g, '_')
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  // "." and ".." are the only names that escape the download folder once
  // path.join() gets hold of them.
  if (!out || /^\.+$/.test(out)) out = `_${out || 'image'}`;
  return out;
}

/** `name.png` -> `name_1.png`, `name_2.png`, ... exactly as the script did. */
export function uniquePath(dir, filename) {
  let out = path.join(dir, sanitizeFilename(filename));
  if (!fs.existsSync(out)) return out;
  const ext = path.extname(out);
  const base = out.slice(0, out.length - ext.length);
  for (let n = 1; n < 100000; n++) {
    const candidate = `${base}_${n}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot find a free filename for ${filename}`);
}

export function slugify(text = '', max = 40) {
  const s = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'prompt';
}

export function twoDigit(n) {
  return String(n).padStart(2, '0');
}

export function timestamp(date = new Date()) {
  return (
    `${String(date.getFullYear()).slice(2)}${twoDigit(date.getMonth() + 1)}${twoDigit(date.getDate())}` +
    `-${twoDigit(date.getHours())}${twoDigit(date.getMinutes())}${twoDigit(date.getSeconds())}`
  );
}

/**
 * Filename template tokens:
 *   {stamp} {prompt} {variant} {seed} {index} {node} {group}
 * {variant} falls back to the SaveImage node id when the name has no S7/S8 hint.
 */
export function renderTemplate(tpl, ctx = {}) {
  const name = ctx.filename ?? '';
  const variant =
    ctx.variant ??
    name.match(/_(S\d+)_/i)?.[1]?.toUpperCase() ??
    `N${ctx.node ?? '?'}`;
  const map = {
    stamp: timestamp(),
    prompt: slugify(ctx.prompt ?? ''),
    variant,
    seed: String(ctx.seed ?? 'seed'),
    index: String(ctx.index ?? 0),
    node: String(ctx.node ?? ''),
    group: String(ctx.group ?? 0),
  };
  const out = String(tpl || '{stamp}_{prompt}_{variant}_{seed}')
    .replace(/\{(\w+)\}/g, (m, k) => (k in map ? map[k] : m))
    .replace(/[\\/]+/g, '_')
    .replace(/[<>:"|?*\x00-\x1f]/g, '_');
  return sanitizeFilename(out);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fetch one image from ComfyUI's /view and write it to disk.
 * Returns the written path so the caller can record it in the gallery.
 */
export async function downloadImage(client, image, { dir, template, ctx = {} } = {}) {
  const buf = await client.viewImage(image);
  ensureDir(dir);
  // Keep the extension ComfyUI gave us. Without it Android's gallery app
  // refuses the file and the server cannot guess a Content-Type for it.
  const ext = path.extname(image.filename ?? '');
  let name = renderTemplate(template, { ...ctx, filename: image.filename });
  if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
  const out = uniquePath(dir, name);
  await fs.promises.writeFile(out, buf);
  return { path: out, bytes: buf.length, name: path.basename(out) };
}