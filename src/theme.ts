export const C = {
  bg: '#0A0A0F',
  surface: '#14141C',
  elevated: '#1C1C27',
  hover: 'rgba(255,255,255,0.06)',
  line: '#26263A',
  text: '#F5F4F7',
  sub: '#A3A2B3',
  faint: '#6B6A7D',
  accent: '#FFB547',
  accentDeep: '#FF7A3D',
  accentInk: '#1A1205',
  good: '#4ADE80',
  danger: '#FF6B6B',
};

export const R = { sm: 8, md: 14, lg: 22, xl: 30, pill: 999 };

export const T = {
  hero: { fontSize: 34, fontWeight: '800' as const, letterSpacing: -0.8, color: C.text },
  h2: { fontSize: 20, fontWeight: '700' as const, letterSpacing: -0.3, color: C.text },
  title: { fontSize: 16, fontWeight: '600' as const, color: C.text },
  body: { fontSize: 14, color: C.sub },
  small: { fontSize: 12, color: C.faint },
  label: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 1.2, color: C.faint, textTransform: 'uppercase' as const },
};

// Cover gradients for books with no artwork; picked deterministically from the title.
const PALETTES: [string, string][] = [
  ['#FF7A3D', '#7C2D92'], ['#3D7BFF', '#1B1F6B'], ['#22C3A6', '#0B4F6C'], ['#FF4D8D', '#4A1B6B'],
  ['#F5B400', '#B23A00'], ['#7C5CFF', '#21124F'], ['#00B4D8', '#3A0CA3'], ['#E76F51', '#264653'],
];
export function paletteFor(seed: string): [string, string] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return PALETTES[Math.abs(h) % PALETTES.length];
}

export function fmtTime(s: number) {
  const t = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Coarse duration for an estimate, e.g. "6 h 40 m" or "40 m". */
export function fmtApprox(s: number) {
  const mins = Math.max(0, Math.round((s || 0) / 60));
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return `${h} h ${m} m`;
  if (h) return `${h} h`;
  return `${m} m`;
}

// The title/format logic is pure so it runs under the Node test runner; see src/titles.ts.
export { prettyName, audioTags } from './titles';

/** Percentage string typed for React Native's DimensionValue. */
export const pct = (fraction: number) => `${Math.max(0, Math.min(1, fraction || 0)) * 100}%` as `${number}%`;
