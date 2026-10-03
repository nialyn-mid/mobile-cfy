/**
 * A part's filename, tolerating the three shapes clients actually send:
 *   filename="cat.png"              - every browser
 *   filename=cat.png                - unquoted token (some HTTP clients)
 *   filename*=utf-8''cat%20copy.png - RFC 5987, when the name needs encoding
 * `filename*` wins over `filename` when both are present, as the RFC says.
 */
function partFilename(headers) {
  const star = /\bfilename\*\s*=\s*(?:"([^"]*)"|([^;\r\n]*))/i.exec(headers);
  const plain = /\bfilename\s*=\s*(?:"([^"]*)"|([^;\r\n]*))/i.exec(headers);

  const decode = (raw = '') => {
    const m = /^[^']*'[^']*'(.*)$/.exec(raw.trim()); // charset'lang'value
    const value = m ? m[1] : raw.trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  if (star) return decode(star[1] ?? star[2] ?? '');
  if (plain) return decode(plain[1] ?? plain[2] ?? '');
  return '';
}

// Minimal multipart/form-data reader - enough for the phone's file picker,
// which posts one `file` part (or up to four) and nothing else.
export function parseMultipart(buf, contentType = '') {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('multipart request has no boundary');
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  if (boundary.length < 4) throw new Error('multipart boundary is too short');

  const parts = [];
  let pos = buf.indexOf(boundary);
  if (pos < 0) throw new Error('multipart body has no opening boundary');
  pos += boundary.length;

  for (let guard = 0; guard < 64; guard++) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break; // closing "--boundary--"
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;

    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) break;
    const headers = buf.subarray(pos, headerEnd).toString('utf8');

    const next = buf.indexOf(boundary, headerEnd);
    if (next < 0) break;
    let dataEnd = next;
    if (buf[dataEnd - 1] === 0x0a && buf[dataEnd - 2] === 0x0d) dataEnd -= 2;

    const nameM = /\bname\s*=\s*(?:"([^"]*)"|([^;\r\n]*))/i.exec(headers);
    const fileM = partFilename(headers);
    const typeM = /content-type:\s*([^\r\n]+)/i.exec(headers);

    parts.push({
      name: (nameM?.[1] ?? nameM?.[2] ?? '').trim(),
      filename: fileM,
      contentType: (typeM?.[1] ?? '').trim(),
      data: buf.subarray(headerEnd + 4, dataEnd),
    });
    pos = next + boundary.length;
  }
  return parts;
}