import { useRef, useLayoutEffect } from 'react';

/**
 * FLIP animation hook for list reordering.
 * Pass a stable key per item (e.g. pitcher_id+pitch_type) and the current sort state.
 * On sort change, items slide from their old positions to new ones.
 *
 * @param {Array} items   - The sorted data array
 * @param {Function} getKey - (item) => string — unique stable key per row
 * @param {any} sortState  - Any value that changes when sort changes (e.g. `sortKey + sortDir`)
 * @returns {Function} getRowRef - call as ref={getRowRef(key)} on each <tr>
 */
export function useFlipAnimation(items, getKey, sortState) {
  const rowRefs = useRef({});
  const positions = useRef({});

  const snapshotPositions = () => {
    const snap = {};
    for (const [key, el] of Object.entries(rowRefs.current)) {
      if (el) snap[key] = el.getBoundingClientRect().top;
    }
    positions.current = snap;
  };

  useLayoutEffect(() => {
    const prev = positions.current;
    const DURATION = 150;
    const EASING = 'cubic-bezier(0.2, 0, 0, 1)';

    for (const [key, el] of Object.entries(rowRefs.current)) {
      if (!el || prev[key] == null) continue;
      const last = el.getBoundingClientRect().top;
      const first = prev[key];
      const delta = first - last;
      if (Math.abs(delta) < 1) continue;

      el.style.transition = 'none';
      el.style.transform = `translateY(${delta}px)`;
      el.style.opacity = '0.6';

      requestAnimationFrame(() => {
        el.style.transition = `transform ${DURATION}ms ${EASING}, opacity ${DURATION}ms ease`;
        el.style.transform = 'translateY(0)';
        el.style.opacity = '1';
      });
    }

    snapshotPositions();
  }, [sortState]);

  useLayoutEffect(() => {
    snapshotPositions();
  }, []);

  const getRowRef = (key) => (el) => {
    rowRefs.current[key] = el;
  };

  return getRowRef;
}
