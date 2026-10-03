import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart } from '../lib/multipart.js';
import { sniffImage, extFor } from '../lib/uploads.js';

const B = '----mobcfytest';

/** Build a multipart body the way a given client would. */
function body(parts) {
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${B}\r\n${p.headers}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${B}--\r\n`));
  return Buffer.concat(chunks);
}

const CONTENT_TYPE = `multipart/form-data; boundary=${B}`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(9)]);
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(10)]);
const AVIF = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(4)]);

const part = (headers, data) => ({ headers, data });

// ---------------------------------------------------------- filename shapes

test('a browser style quoted filename parses', () => {
  const buf = body([
    part('Content-Disposition: form-data; name="file"; filename="cat.png"\r\nContent-Type: image/png', PNG),
  ]);
  const [p] = parseMultipart(buf, CONTENT_TYPE);
  assert.equal(p.name, 'file');
  assert.equal(p.filename, 'cat.png');
  assert.equal(p.contentType, 'image/png');
  assert.deepEqual(p.data, PNG);
});

test('an unquoted filename token parses - PowerShell and friends send this', () => {
  const buf = body([
    part(
      'Content-Disposition: form-data; name=file; filename=cat.png\r\nContent-Type: application/octet-stream',
      PNG,
    ),
  ]);
  const [p] = parseMultipart(buf, CONTENT_TYPE);
  assert.equal(p.filename, 'cat.png');
  assert.equal(p.name, 'file');
});

test('filename* wins over filename=, and is percent-decoded', () => {
  const buf = body([
    part(
      "Content-Disposition: form-data; name=file; filename=cat.png; filename*=utf-8''my%20cat%20copy.png",
      PNG,
    ),
  ]);
  assert.equal(parseMultipart(buf, CONTENT_TYPE)[0].filename, 'my cat copy.png');
});

test('a part with no filename at all parses as an empty name', () => {
  const buf = body([part('Content-Disposition: form-data; name="note"', 'hello')]);
  const [p] = parseMultipart(buf, CONTENT_TYPE);
  assert.equal(p.filename, '');
  assert.equal(p.name, 'note');
  assert.equal(p.data.toString(), 'hello');
});

test('several parts keep their order and bodies', () => {
  const buf = body([
    part('Content-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png', PNG),
    part('Content-Disposition: form-data; name="file"; filename="b.jpg"\r\nContent-Type: image/jpeg', JPEG),
  ]);
  const parts = parseMultipart(buf, CONTENT_TYPE);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.filename), ['a.png', 'b.jpg']);
  assert.deepEqual(parts[1].data, JPEG);
});

test('binary bodies survive intact, even ones full of boundary lookalikes', () => {
  const tricky = Buffer.from([0x2d, 0x2d, 0x0d, 0x0a, 0x00, 0xff, 0x2d, 0x2d]);
  const buf = body([
    part('Content-Disposition: form-data; name="file"; filename="x.png"\r\nContent-Type: image/png', tricky),
  ]);
  assert.deepEqual(parseMultipart(buf, CONTENT_TYPE)[0].data, tricky);
});

test('a missing, too-short, or unmatched boundary is an error, not a hang', () => {
  assert.throws(() => parseMultipart(Buffer.from(''), 'multipart/form-data'), /no boundary/);
  // `--x` is under the 4-byte minimum, so nothing could ever match it.
  assert.throws(() => parseMultipart(Buffer.from(''), 'multipart/form-data; boundary=x'), /too short/);
  assert.throws(() => parseMultipart(Buffer.from('garbage'), CONTENT_TYPE), /no opening boundary/);
});

// -------------------------------------------------------------------- sniffing

test('sniffImage identifies the formats a phone actually sends', () => {
  assert.equal(sniffImage(PNG), '.png');
  assert.equal(sniffImage(JPEG), '.jpg');
  assert.equal(sniffImage(GIF), '.gif');
  assert.equal(sniffImage(WEBP), '.webp');
  assert.equal(sniffImage(BMP), '.bmp');
  assert.equal(sniffImage(AVIF), '.avif');
});

test('sniffImage returns null for something that is not an image', () => {
  assert.equal(sniffImage(Buffer.from('not an image at all')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test('extFor prefers the bytes over a lying header and filename', () => {
  // Android's picker regularly labels a PNG as application/octet-stream .jpg.
  assert.equal(extFor('application/octet-stream', 'photo.jpg', PNG), '.png');
});

test('extFor falls back to the filename, then the header, then png', () => {
  assert.equal(extFor('application/octet-stream', 'photo.webp'), '.webp');
  assert.equal(extFor('image/jpeg', ''), '.jpg');
  assert.equal(extFor('', ''), '.png');
});