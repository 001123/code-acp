import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "../icon";
import checkIcon from "@tabler/icons/outline/check.svg";
import chevronIcon from "@tabler/icons/outline/chevron-right.svg";

/** An entry of a sub-menu: a pickable value, a group heading, or a separator. */
export type SubMenuEntry =
  | { value: string; label: ReactNode; title?: string }
  | { heading: string }
  | "separator";

export interface SubMenus {
  open: string | undefined;
  /** Opens a sub-menu (or closes them all), cancelling a pending change. */
  set: (id: string | undefined) => void;
  /** Does the same after `ms`, unless another change comes first. */
  later: (id: string | undefined, ms: number) => void;
}

/** Which sub-menu of a popup menu is open: only one at a time. */
export const SubMenuContext = createContext<SubMenus>({ open: undefined, set: () => {}, later: () => {} });

/**
 * State for the sub-menus of a popup menu, closed with it. One timer for all rows, so leaving a row cannot close the
 * sub-menu of the row entered after it.
 */
export function useSubMenus(menuOpen: boolean): SubMenus {
  const [open, setOpen] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!menuOpen) {
      clearTimeout(timer.current);
      setOpen(undefined);
    }
  }, [menuOpen]);
  return {
    open,
    set: (id) => {
      clearTimeout(timer.current);
      setOpen(id);
    },
    later: (id, ms) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setOpen(id), ms);
    },
  };
}

/** Where a sub-menu goes: beside the menu (right, else left), else over it; its top at its row, kept in the viewport. */
function placeSubMenu(row: DOMRect, menu: DOMRect, width: number, height: number): CSSProperties {
  const gap = 4;
  const margin = 4;
  const left =
    menu.right + gap + width <= window.innerWidth - margin
      ? menu.right + gap
      : menu.left - gap - width >= margin
        ? menu.left - gap - width
        : Math.max(margin, window.innerWidth - margin - width);
  const top = Math.max(margin, Math.min(row.top - 5, window.innerHeight - margin - height));
  return { left, top };
}

/**
 * A row of a popup menu that opens a list of values beside it on hover, click, Enter or ArrowRight. A pick closes it;
 * Escape or ArrowLeft goes back to the row.
 */
export function SubMenu({
  id,
  className,
  title,
  trigger,
  entries,
  current,
  onPick,
}: {
  id: string;
  className: string;
  title?: string;
  trigger: ReactNode;
  entries: ReadonlyArray<SubMenuEntry>;
  current: string;
  onPick: (value: string) => void;
}) {
  const ctx = useContext(SubMenuContext);
  const open = ctx.open === id;
  const row = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const focusOnOpen = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: "hidden" });
      return;
    }
    const menu = row.current?.closest(".popup-menu");
    const el = list.current;
    if (!row.current || !menu || !el) return;
    setStyle(placeSubMenu(row.current.getBoundingClientRect(), menu.getBoundingClientRect(), el.offsetWidth, el.offsetHeight));
    const selected = el.querySelector<HTMLElement>('[aria-checked="true"]');
    selected?.scrollIntoView({ block: "nearest" });
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      (selected ?? el.querySelector<HTMLElement>("[role=menuitemradio]"))?.focus();
    }
  }, [open]);
  const openNow = (focus: boolean) => {
    focusOnOpen.current = focus;
    ctx.set(id);
  };
  const close = () => {
    ctx.set(undefined);
    button.current?.focus();
  };
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => items[(to + items.length) % items.length]?.focus();
    switch (e.key) {
      case "ArrowDown":
        move(at + 1);
        break;
      case "ArrowUp":
        move(at < 0 ? -1 : at - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(-1);
        break;
      case "Escape":
      case "ArrowLeft":
        close();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      ref={row}
      className={`submenu-row ${className}`}
      onMouseEnter={() => {
        // Right away when no other sub-menu is open; after a beat otherwise, so the pointer can cross rows on its way.
        if (ctx.open === undefined || open) ctx.set(id);
        else ctx.later(id, 150);
      }}
      onMouseLeave={() => ctx.later(undefined, 250)}
    >
      <button
        ref={button}
        type="button"
        className="submenu-trigger"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? ctx.set(undefined) : openNow(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            openNow(true);
          }
        }}
      >
        {trigger}
        <span className="submenu-chevron" aria-hidden="true">
          <Icon svg={chevronIcon} />
        </span>
      </button>
      {open && (
        <div ref={list} className="popup-menu submenu" role="menu" style={style} onKeyDown={onListKey}>
          {entries.map((entry, i) =>
            entry === "separator" ? (
              <div key={`sep-${i}`} className="menu-separator" role="separator" />
            ) : "heading" in entry ? (
              <div key={`head-${i}`} className="menu-heading" role="presentation">
                {entry.heading}
              </div>
            ) : (
              <button
                key={entry.value}
                type="button"
                role="menuitemradio"
                aria-checked={entry.value === current}
                title={entry.title}
                onClick={() => {
                  onPick(entry.value);
                  close();
                }}
              >
                <span className="menu-label">{entry.label}</span>
                <span className="menu-check" aria-hidden="true">
                  <Icon svg={checkIcon} />
                </span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Open state of a menu that closes on Escape or a click outside `root`. */
function useDismissedMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, root };
}

/** A menu opened by clicks alone: it stays while the pointer leaves, as native selects in it open outside it. */
export function useClickMenu() {
  const { open, setOpen, root } = useDismissedMenu();
  return { open, set: setOpen, toggle: () => setOpen(!open), root };
}

/** Open state of a menu that opens on hover or click and closes on Escape, a click outside, or a moment after the pointer leaves (so it can cross the gap between the button and the menu). */
export function useHoverMenu() {
  const { open, setOpen, root } = useDismissedMenu();
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  return {
    open,
    toggle: () => setOpen(!open),
    rootProps: {
      ref: root,
      onMouseEnter: () => {
        clearTimeout(closeTimer.current);
        setOpen(true);
      },
      onMouseLeave: () => {
        clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(() => setOpen(false), 200);
      },
    },
  };
}
