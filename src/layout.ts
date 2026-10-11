// One place that decides between the phone layout and the desktop one (sidebar, wide grids, dialogs).
import { Platform, useWindowDimensions } from 'react-native';

export const SIDEBAR_WIDTH = 236;
/** Side padding the desktop shell puts around each screen. */
export const DESKTOP_GUTTER = 16;

export function useLayout() {
  const { width, height } = useWindowDimensions();
  // A narrow desktop window falls back to the phone layout rather than squeezing the sidebar in.
  const wide = Platform.OS === 'web' && width >= 900;
  return {
    wide,
    width,
    height,
    /** Width a screen has to lay itself out in. */
    contentWidth: wide ? width - SIDEBAR_WIDTH - DESKTOP_GUTTER * 2 : width,
    /** Width of a sheet: the full screen on a phone, a centred dialog on desktop. */
    dialogWidth: wide ? Math.min(560, width - 80) : width,
  };
}

/** Dark scrollbars and no focus rings, so the desktop window doesn't look like a web page. */
export function applyDesktopStyles() {
  if (Platform.OS !== 'web') return;
  const doc = (globalThis as any).document;
  if (!doc || doc.getElementById('earmark-desktop-css')) return;
  const el = doc.createElement('style');
  el.id = 'earmark-desktop-css';
  el.textContent = `
    html, body { background: #0A0A0F; }
    * { scrollbar-width: thin; scrollbar-color: #26263A transparent; }
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-thumb { background: #26263A; border-radius: 5px; }
    ::-webkit-scrollbar-thumb:hover { background: #3A3A55; }
    ::-webkit-scrollbar-track { background: transparent; }
    input, textarea { outline: none; }
    :focus-visible { outline: 2px solid #FFB547; outline-offset: 2px; }
    input:focus-visible, textarea:focus-visible { outline: none; }
    ::selection { background: rgba(255,181,71,0.35); }
  `;
  doc.head.appendChild(el);
}
