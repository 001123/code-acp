import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { TabInfo } from "../../chat/protocol";

/** Longer than the `tab-enter` and `tab-leave` animations in `media/chat/tabs.css`. */
const MOTION_MS = 260;

type Leaving = { readonly tab: TabInfo; readonly index: number };

/** `tabs` with the ones closed a moment ago back at their place, so that they can animate out. */
export function withLeaving(tabs: ReadonlyArray<TabInfo>, leaving: ReadonlyArray<Leaving>): TabInfo[] {
  const shown = [...tabs];
  for (const each of [...leaving].sort((a, b) => a.index - b.index)) {
    shown.splice(Math.min(each.index, shown.length), 0, each.tab);
  }
  return shown;
}

/**
 * The tabs opened (`entering`) and closed (`leaving`) since the last update, for a moment. The first tabs to arrive
 * don't count as opened. Only tabs outside a group leave: a group's row may be gone with them.
 */
export function useTabMotion(tabs: ReadonlyArray<TabInfo>) {
  const previous = useRef<ReadonlyArray<TabInfo>>([]);
  const [entering, setEntering] = useState<ReadonlySet<number>>(() => new Set());
  const [leaving, setLeaving] = useState<ReadonlyArray<Leaving>>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const later = (f: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      f();
    }, MOTION_MS);
    timers.current.add(timer);
  };
  // Before paint: a closed tab never blinks out, an opened one never shows at full height first.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = tabs;
    if (before.length === 0) return;
    const ids = new Set(tabs.map((tab) => tab.id));
    const old = new Set(before.map((tab) => tab.id));
    const added = tabs.flatMap((tab) => (old.has(tab.id) ? [] : [tab.id]));
    const removed = before.flatMap((tab, index) =>
      ids.has(tab.id) || tab.group !== undefined ? [] : [{ tab, index }],
    );
    if (added.length > 0) {
      setEntering((now) => new Set([...now, ...added]));
      later(() => setEntering((now) => new Set([...now].filter((id) => !added.includes(id)))));
    }
    // A tab that comes back (e.g. reopened at once) no longer leaves.
    setLeaving((now) => {
      const staying = now.filter((each) => !ids.has(each.tab.id));
      return removed.length === 0 && staying.length === now.length ? now : [...staying, ...removed];
    });
    if (removed.length > 0) {
      later(() => setLeaving((now) => now.filter((each) => !removed.includes(each))));
    }
  }, [tabs]);
  useEffect(
    () => () => {
      for (const timer of timers.current) clearTimeout(timer);
    },
    [],
  );
  return { entering, leaving };
}

/** Where each row (`data-row`) sits in `list`, whatever it is scrolled to. */
function rowTops(list: HTMLElement | null): Map<string, number> {
  const tops = new Map<string, number>();
  if (!list) return tops;
  const base = list.getBoundingClientRect().top;
  for (const row of list.querySelectorAll<HTMLElement>(":scope > [data-row]")) {
    tops.set(row.dataset.row!, row.getBoundingClientRect().top - base);
  }
  return tops;
}

/**
 * Slides `list`'s rows from their old places to their new ones when only their order changes (a sort, a drag); rows
 * that come or go have their own animations. `order` holds the rows' `data-row` keys.
 */
export function useReorderMotion(list: RefObject<HTMLElement | null>, order: ReadonlyArray<string>) {
  const key = order.join("\n");
  const lastKey = useRef(key);
  const before = useRef<Map<string, number>>(undefined);
  // Rendering still sees the old DOM: the last moment to measure where the rows were.
  if (key !== lastKey.current && before.current === undefined) before.current = rowTops(list.current);
  useLayoutEffect(() => {
    const old = before.current;
    before.current = undefined;
    lastKey.current = key;
    if (!old || old.size !== order.length || !order.every((row) => old.has(row))) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const now = rowTops(list.current);
    for (const row of list.current?.querySelectorAll<HTMLElement>(":scope > [data-row]") ?? []) {
      const dy = old.get(row.dataset.row!)! - now.get(row.dataset.row!)!;
      if (Math.abs(dy) < 1) continue;
      row.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration: 260,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      });
    }
  }, [key]);
}
