import { useLayoutEffect, type RefObject } from 'react';

/** Keeps an open menu or popover inside the viewport (8 px margin) by shifting it horizontally: a menu anchored to a
 *  button near either edge of a phone screen never opens off-screen. */
export function useInViewport(ref: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    el.style.transform = '';
    const r = el.getBoundingClientRect(), m = 8, w = document.documentElement.clientWidth;
    const dx = r.width > w - 2 * m ? m - r.left : r.right > w - m ? w - m - r.right : r.left < m ? m - r.left : 0;
    if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
  }, [ref, open]);
}
