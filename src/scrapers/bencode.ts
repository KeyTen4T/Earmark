import { sha1Hex } from './sha1';

type BVal = number | Uint8Array | BVal[] | { [k: string]: BVal };

// Hermes (React Native) may lack TextDecoder, so decode UTF-8 by hand.
export function utf8(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let cp = c;
    if (c >= 0xf0) cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else if (c >= 0xe0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
    else if (c >= 0xc0) cp = ((c & 31) << 6) | (b[i++] & 63);
    out += String.fromCodePoint(cp);
  }
  return out;
}
const td = { decode: utf8 };
const str = (v: BVal | undefined) => (v instanceof Uint8Array ? td.decode(v) : undefined);

// Decodes bencode and records the byte span of the top-level "info" dict.
function decode(b: Uint8Array) {
  let i = 0;
  let infoSpan: [number, number] | null = null;
  const readInt = (end: number) => {
    const s = td.decode(b.subarray(i, end));
    i = end + 1;
    return parseInt(s, 10);
  };
  const next = (depth: number): BVal => {
    const c = b[i];
    if (c === 0x69) { // i
      i++;
      return readInt(b.indexOf(0x65, i));
    }
    if (c === 0x6c) { // l
      i++;
      const out: BVal[] = [];
      while (b[i] !== 0x65) out.push(next(depth + 1));
      i++;
      return out;
    }
    if (c === 0x64) { // d
      i++;
      const out: { [k: string]: BVal } = {};
      while (b[i] !== 0x65) {
        const key = td.decode(next(depth + 1) as Uint8Array);
        const start = i;
        out[key] = next(depth + 1);
        if (depth === 0 && key === 'info') infoSpan = [start, i];
      }
      i++;
      return out;
    }
    if (c >= 0x30 && c <= 0x39) {
      const len = readInt(b.indexOf(0x3a, i));
      const v = b.subarray(i, i + len);
      i += len;
      return v;
    }
    throw new Error(`Invalid torrent data at byte ${i}`);
  };
  const root = next(0);
  return { root: root as { [k: string]: BVal }, infoSpan: infoSpan as [number, number] | null };
}

export type TorrentInfo = { infoHash: string; name?: string; magnet: string; totalSize: number };

export function torrentToMagnet(bytes: Uint8Array): TorrentInfo {
  const { root, infoSpan } = decode(bytes);
  if (!infoSpan) throw new Error('Torrent has no info dictionary');
  const infoHash = sha1Hex(bytes.subarray(infoSpan[0], infoSpan[1]));
  const info = root.info as { [k: string]: BVal };
  const name = str(info.name);

  let totalSize = typeof info.length === 'number' ? info.length : 0;
  if (Array.isArray(info.files)) {
    for (const f of info.files as { [k: string]: BVal }[]) totalSize += (f.length as number) || 0;
  }

  const trackers = new Set<string>();
  const ann = str(root.announce);
  if (ann) trackers.add(ann);
  if (Array.isArray(root['announce-list'])) {
    for (const tier of root['announce-list'] as BVal[][]) for (const t of tier) { const s = str(t); if (s) trackers.add(s); }
  }
  const webSeeds: string[] = [];
  const ul = root['url-list'];
  if (ul instanceof Uint8Array) webSeeds.push(td.decode(ul));
  else if (Array.isArray(ul)) for (const u of ul) { const s = str(u); if (s) webSeeds.push(s); }

  let magnet = `magnet:?xt=urn:btih:${infoHash}`;
  if (name) magnet += `&dn=${encodeURIComponent(name)}`;
  for (const t of trackers) magnet += `&tr=${encodeURIComponent(t)}`;
  for (const w of webSeeds) magnet += `&ws=${encodeURIComponent(w)}`;
  return { infoHash, name, magnet, totalSize };
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
// Extracts a lowercase hex info-hash from a magnet (handles base32 hashes too).
export function hashFromMagnet(magnet: string): string | null {
  const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet);
  if (!m) return null;
  const h = m[1].toLowerCase();
  if (/^[0-9a-f]{40}$/.test(h)) return h;
  if (h.length === 32) {
    let bits = '';
    for (const ch of h) {
      const v = B32.indexOf(ch);
      if (v < 0) return null;
      bits += v.toString(2).padStart(5, '0');
    }
    let hex = '';
    for (let i = 0; i < 160; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }
  return null;
}
