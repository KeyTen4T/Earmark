// Tiny template language used by scraper .json files.
//   {path.to.value}            value lookup (dot path, array index allowed: {files.0.name})
//   {value|filter|filter:arg}  filters, see FILTERS below
//   {a||b}                     fallback: first non-empty of a, b
export type Vars = Record<string, unknown>;

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isNaN(n) ? m : String.fromCodePoint(n);
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function formatBytes(n: number) {
  if (!isFinite(n) || n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i >= 3 ? 2 : i === 0 ? 0 : 1)} ${u[i]}`;
}

function resolveUrl(url: string, base: string) {
  if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const m = /^([a-z]+:\/\/[^/]+)(\/[^?#]*)?/i.exec(base);
  if (!m) return url;
  if (url.startsWith('//')) return base.split(':')[0] + ':' + url;
  if (url.startsWith('/')) return m[1] + url;
  const dir = (m[2] || '/').replace(/[^/]*$/, '');
  return m[1] + dir + url;
}

type Filter = (v: unknown, arg: string | undefined, ctx: { baseUrl: string }) => unknown;
const asStr = (v: unknown): string => (v == null ? '' : Array.isArray(v) ? v.map(asStr).join(', ') : String(v));

export const FILTERS: Record<string, Filter> = {
  urlencode: (v) => encodeURIComponent(asStr(v)),
  trim: (v) => asStr(v).trim(),
  lower: (v) => asStr(v).toLowerCase(),
  upper: (v) => asStr(v).toUpperCase(),
  striptags: (v) => asStr(v).replace(/<[^>]*>/g, ''),
  decode: (v) => decodeEntities(asStr(v)),
  clean: (v) => decodeEntities(asStr(v).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim(),
  bytes: (v) => formatBytes(Number(v)),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  join: (v, arg) => (Array.isArray(v) ? v.map(asStr).join(arg ?? ', ') : asStr(v)),
  abs: (v, _a, ctx) => resolveUrl(asStr(v), ctx.baseUrl),
  default: (v, arg) => (asStr(v) === '' ? arg ?? '' : v),
  replace: (v, arg) => {
    const [from, to = ''] = (arg ?? '').split('=>');
    return from ? asStr(v).split(from).join(to) : asStr(v);
  },
  // escapes a value for use inside a JSON string, e.g. a POST body: "{query|json}"
  json: (v) => JSON.stringify(asStr(v)).slice(1, -1),
  // archive.org file or item URL → that item's torrent (every archive.org item has one)
  iatorrent: (v) => {
    const m = /^https?:\/\/(?:www\.)?archive\.org\/(?:download|details)\/([^/?#]+)/i.exec(asStr(v));
    return m ? `https://archive.org/download/${m[1]}/${m[1]}_archive.torrent` : '';
  },
  // regex:<pattern>  → first capture group (or whole match) of pattern
  regex: (v, arg) => {
    if (!arg) return v;
    const m = new RegExp(arg, 'i').exec(asStr(v));
    return m ? (m[1] ?? m[0]) : '';
  },
};

function evalExpr(expr: string, vars: Vars, ctx: { baseUrl: string }): string {
  for (const alt of expr.split('||')) {
    const [path, ...filters] = alt.split('|');
    const p = path.trim();
    let v: unknown = p.startsWith("'") && p.endsWith("'") ? p.slice(1, -1) : getPath(vars, p);
    for (const f of filters) {
      const idx = f.indexOf(':');
      const name = (idx < 0 ? f : f.slice(0, idx)).trim();
      const arg = idx < 0 ? undefined : f.slice(idx + 1);
      const fn = FILTERS[name];
      if (!fn) throw new Error(`Unknown filter "${name}"`);
      v = fn(v, arg, ctx);
    }
    const s = asStr(v);
    if (s !== '') return s;
  }
  return '';
}

// Placeholders are {...}; a literal brace is written as {{ or }}.
export function render(tpl: string | undefined, vars: Vars, baseUrl = ''): string {
  if (!tpl) return '';
  const ctx = { baseUrl };
  return tpl
    .replace(/\{\{/g, '\u0000').replace(/\}\}/g, '\u0001')
    .replace(/\{([^{}]+)\}/g, (_m, expr: string) => evalExpr(expr, vars, ctx))
    .replace(/\u0000/g, '{').replace(/\u0001/g, '}');
}
