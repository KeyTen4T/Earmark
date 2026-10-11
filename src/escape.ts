// One Escape key closes the top-most open layer on desktop. Layers (a Sheet, the SourceEditor,
// the full player) register here while they are visible; the most recent one wins. react-native-web
// handles its own Escape on keyup and only for the modal its internal stack calls active,
// which our nested sheets do not reliably satisfy, so we keep our own stack.
import { useEffect, useRef } from 'react';

type Handler = () => void;
const stack: Handler[] = [];
let bound = false;

const onKeyDown = (e: any) => {
  if (e.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top();
};

const bind = () => {
  const doc = (globalThis as any).document;
  if (!doc) return false;
  if (!bound) {
    bound = true;
    doc.addEventListener('keydown', onKeyDown, false);
  }
  return true;
};

/** While `active`, Escape calls `onClose` — but only if this is the top-most registered layer. */
export function useEscape(onClose: () => void, active: boolean) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!active || !bind()) return;
    const handler = () => ref.current();
    stack.push(handler);
    return () => {
      const i = stack.lastIndexOf(handler);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [active]);
}
