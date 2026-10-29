import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Icon } from "./icon";
import { useL10n } from "./l10n";
import xIcon from "@tabler/icons/outline/x.svg";
import zoomInIcon from "@tabler/icons/outline/zoom-in.svg";
import zoomOutIcon from "@tabler/icons/outline/zoom-out.svg";
import zoomResetIcon from "@tabler/icons/outline/zoom-reset.svg";

const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
const STEP = 1.25;

interface View {
  scale: number;
  x: number;
  y: number;
}
const FIT: View = { scale: 1, x: 0, y: 0 };

/** Full-screen image preview: wheel / buttons / keys to zoom, drag to pan, Esc or backdrop click to close. */
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const { t } = useL10n();
  const [view, setView] = useState(FIT);
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean }>(undefined);

  /** Zoom by `factor`, keeping the stage point (cx, cy) — relative to its center — fixed on screen. */
  const zoom = (factor: number, cx = 0, cy = 0) =>
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });

  /** Pointer position relative to the stage center. */
  const center = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2] as const;
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoom(STEP);
      else if (e.key === "-") zoom(1 / STEP);
      else if (e.key === "0") setView(FIT);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // Non-passive so the transcript underneath doesn't scroll.
  useEffect(() => {
    const el = stage.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * 0.002), ...center(e));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    if (!d.moved) setDragging(true);
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = undefined;
    setDragging(false);
    // A click on the backdrop (not a drag, not on the image) closes.
    if (d && !d.moved && e.target === e.currentTarget) onClose();
  };

  return (
    <div className="lightbox" role="dialog" aria-label={alt}>
      <div
        ref={stage}
        className="lightbox-stage"
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = undefined;
          setDragging(false);
        }}
        onDoubleClick={(e) => (view.scale === 1 ? zoom(2, ...center(e)) : setView(FIT))}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
      <div className="lightbox-toolbar">
        <span className="lightbox-name" title={alt}>
          {alt}
        </span>
        <button type="button" className="icon-btn" title={t("lightbox.zoomOut")} aria-label={t("lightbox.zoomOut")} onClick={() => zoom(1 / STEP)}>
          <Icon svg={zoomOutIcon} />
        </button>
        <button type="button" className="lightbox-scale" title={t("lightbox.reset")} onClick={() => setView(FIT)}>
          {Math.round(view.scale * 100)}%
        </button>
        <button type="button" className="icon-btn" title={t("lightbox.zoomIn")} aria-label={t("lightbox.zoomIn")} onClick={() => zoom(STEP)}>
          <Icon svg={zoomInIcon} />
        </button>
        <button type="button" className="icon-btn" title={t("lightbox.reset")} aria-label={t("lightbox.reset")} onClick={() => setView(FIT)}>
          <Icon svg={zoomResetIcon} />
        </button>
        <button type="button" className="icon-btn" title={t("lightbox.close")} aria-label={t("lightbox.close")} onClick={onClose}>
          <Icon svg={xIcon} />
        </button>
      </div>
    </div>
  );
}
