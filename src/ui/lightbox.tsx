import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Icon } from "./icon";
import { useL10n } from "./l10n";
import appWindowIcon from "@tabler/icons/outline/app-window.svg";
import arrowBackIcon from "@tabler/icons/outline/arrow-back-up.svg";
import arrowForwardIcon from "@tabler/icons/outline/arrow-forward-up.svg";
import arrowIcon from "@tabler/icons/outline/arrow-narrow-right.svg";
import checkIcon from "@tabler/icons/outline/check.svg";
import pencilIcon from "@tabler/icons/outline/pencil.svg";
import rectangleIcon from "@tabler/icons/outline/rectangle.svg";
import scribbleIcon from "@tabler/icons/outline/scribble.svg";
import typographyIcon from "@tabler/icons/outline/typography.svg";
import trashIcon from "@tabler/icons/outline/trash.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import zoomInIcon from "@tabler/icons/outline/zoom-in.svg";
import zoomOutIcon from "@tabler/icons/outline/zoom-out.svg";
import zoomResetIcon from "@tabler/icons/outline/zoom-reset.svg";

const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
const STEP = 1.25;
const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#ffffff"];

interface View {
  scale: number;
  x: number;
  y: number;
}
const FIT: View = { scale: 1, x: 0, y: 0 };

type Tool = "pen" | "arrow" | "rect" | "text";
const TOOLS: Array<{ tool: Tool; icon: string; label: "lightbox.pen" | "lightbox.arrow" | "lightbox.rect" | "lightbox.text" }> = [
  { tool: "pen", icon: scribbleIcon, label: "lightbox.pen" },
  { tool: "arrow", icon: arrowIcon, label: "lightbox.arrow" },
  { tool: "rect", icon: rectangleIcon, label: "lightbox.rect" },
  { tool: "text", icon: typographyIcon, label: "lightbox.text" },
];
/** Text line height and first baseline, in font sizes; the editor's CSS uses the same line height. */
const LINE_HEIGHT = 1.2;
const BASELINE = 1;

/**
 * A mark in image pixels: every point for the pen, start and end for arrows and boxes,
 * the top-left corner for text, whose `width` is its font size.
 */
interface Shape {
  tool: Tool;
  color: string;
  width: number;
  points: Array<[number, number]>;
  text?: string;
}

/** Text typed at an image point, not yet a shape. */
interface Typing {
  at: [number, number];
  size: number;
  color: string;
}

/** Bold, in the webview's font, outlined so it reads on any background. */
const textFont = (size: number) => `600 ${size}px ${getComputedStyle(document.body).fontFamily}`;

/** SVG path data for a shape; the same string strokes the overlay and, via Path2D, the exported canvas. */
function pathOf({ tool, width, points }: Shape): string {
  const [x1, y1] = points[0]!;
  const [x2, y2] = points[points.length - 1]!;
  switch (tool) {
    case "pen":
      // A lone point still shows as a dot.
      return points.length === 1 ? `M${x1} ${y1}l0.01 0` : `M${points.map(([x, y]) => `${x} ${y}`).join("L")}`;
    case "rect":
      return `M${x1} ${y1}H${x2}V${y2}H${x1}Z`;
    case "arrow": {
      const a = Math.atan2(y2 - y1, x2 - x1);
      const h = width * 4;
      const head = (d: number) => `${x2 - h * Math.cos(a + d)} ${y2 - h * Math.sin(a + d)}`;
      return `M${x1} ${y1}L${x2} ${y2}M${head(Math.PI / 6)}L${x2} ${y2}L${head(-Math.PI / 6)}`;
    }
    case "text":
      return "";
  }
}

/**
 * Full-screen image preview: wheel / buttons / keys to zoom, drag to pan, Esc or backdrop click to close.
 * `onPopOut` opens the image in a window of its own. With `onSave`, the image can be drawn on;
 * saving hands back a PNG data URI of the image with the drawing burned in.
 */
export function Lightbox({
  src,
  alt,
  onClose,
  onPopOut,
  onSave,
  saveLabel,
}: {
  src: string;
  alt: string;
  onClose: () => void;
  onPopOut?: () => void;
  onSave?: (src: string) => void;
  saveLabel?: string;
}) {
  const { t } = useL10n();
  const [view, setView] = useState(FIT);
  const [dragging, setDragging] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const overlay = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean }>(undefined);
  /** The image's own size, and the size it is shown at when not zoomed. */
  const [natural, setNatural] = useState<{ w: number; h: number }>();
  const [box, setBox] = useState<{ w: number; h: number }>();

  const [editing, setEditing] = useState(false);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(COLORS[0]!);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [undone, setUndone] = useState<Shape[]>([]);
  /** The shape being drawn, by pointer. */
  const stroke = useRef<{ id: number; shape: Shape }>(undefined);
  const [current, setCurrent] = useState<Shape>();
  const [typing, setTyping] = useState<Typing>();
  const typingRef = useRef<Typing>(undefined);
  typingRef.current = typing;
  const field = useRef<HTMLTextAreaElement>(null);
  /** Space held: drag pans even while drawing. */
  const space = useRef(false);

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

  /** Pointer position in image pixels. */
  const imagePoint = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = overlay.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * natural!.w), Math.round(((e.clientY - r.top) / r.height) * natural!.h)];
  };

  /** Turns the text being typed into a shape; empty text is dropped. */
  const commitText = () => {
    const x = typingRef.current;
    const text = field.current?.value.replace(/\s+$/, "");
    typingRef.current = undefined;
    setTyping(undefined);
    if (!x || !text) return;
    setShapes((list) => [...list, { tool: "text", color: x.color, width: x.size, points: [x.at], text }]);
    setUndone([]);
  };

  const undo = () => {
    const last = shapes.at(-1);
    if (!last) return;
    setShapes(shapes.slice(0, -1));
    setUndone([...undone, last]);
  };
  const redo = () => {
    const next = undone.at(-1);
    if (!next) return;
    setUndone(undone.slice(0, -1));
    setShapes([...shapes, next]);
  };

  /** The image with the drawing burned in, at full resolution. */
  const save = () => {
    const img = image.current;
    if (!onSave || !img || !natural || shapes.length === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = natural.w;
    canvas.height = natural.h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const shape of shapes) {
      if (shape.tool === "text") {
        const [x, y] = shape.points[0]!;
        ctx.font = textFont(shape.width);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
        ctx.lineWidth = shape.width / 6;
        ctx.fillStyle = shape.color;
        shape.text!.split("\n").forEach((line, i) => {
          const ly = y + shape.width * (BASELINE + i * LINE_HEIGHT);
          ctx.strokeText(line, x, ly);
          ctx.fillText(line, x, ly);
        });
        continue;
      }
      ctx.strokeStyle = shape.color;
      ctx.lineWidth = shape.width;
      ctx.stroke(new Path2D(pathOf(shape)));
    }
    onSave(canvas.toDataURL("image/png"));
  };

  // Read by the key listener, which is registered once.
  const onKey = useRef<(e: KeyboardEvent) => boolean>(undefined);
  onKey.current = (e) => {
    if (typingRef.current) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === " ") space.current = true;
    if (e.key === "Escape") editing ? setEditing(false) : onClose();
    else if (mod && e.key.toLowerCase() === "z") e.shiftKey ? redo() : undo();
    else if (mod && e.key.toLowerCase() === "y") redo();
    else if (mod) return false;
    else if (e.key === "+" || e.key === "=") zoom(STEP);
    else if (e.key === "-") zoom(1 / STEP);
    else if (e.key === "0") setView(FIT);
    else if (onSave && e.key.toLowerCase() === "e") setEditing(!editing);
    else if (e.key === "Enter" && shapes.length > 0) save();
    else return e.key === " ";
    return true;
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!onKey.current!(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === " ") space.current = false;
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, []);

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

  useLayoutEffect(() => {
    const el = stage.current!;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Shown size at 100%: fits the stage, never upscaled. */
  const fit = natural && box ? Math.min(1, box.w / natural.w, box.h / natural.h) : undefined;

  const onPointerDown = (e: PointerEvent) => {
    const pan = e.button === 1 || (e.button === 0 && (!editing || space.current));
    if (editing && e.button === 0 && !pan && natural && tool === "text") {
      e.preventDefault();
      // A click elsewhere first ends the text being typed (on blur); the next one places new text.
      if (typingRef.current) return field.current?.blur();
      const size = Math.max(14, Math.round(Math.max(natural.w, natural.h) / 40));
      setTyping({ at: imagePoint(e), size, color });
      return;
    } else if (editing && e.button === 0 && !pan && natural) {
      const width = Math.max(2, Math.round(Math.max(natural.w, natural.h) / 300));
      const p = imagePoint(e);
      const shape: Shape = { tool, color, width, points: tool === "pen" ? [p] : [p, p] };
      stroke.current = { id: e.pointerId, shape };
      setCurrent(shape);
    } else if (pan) {
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    } else return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    const s = stroke.current;
    if (s && s.id === e.pointerId) {
      const p = imagePoint(e);
      const { shape } = s;
      const points = shape.tool === "pen" ? [...shape.points, p] : [shape.points[0]!, p];
      s.shape = { ...shape, points };
      setCurrent(s.shape);
      return;
    }
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
    const s = stroke.current;
    if (s && s.id === e.pointerId) {
      stroke.current = undefined;
      setCurrent(undefined);
      setShapes((list) => [...list, s.shape]);
      setUndone([]);
      return;
    }
    const d = drag.current;
    drag.current = undefined;
    setDragging(false);
    // A click on the backdrop (not a drag, not on the image) closes.
    if (d && !d.moved && !editing && e.target === e.currentTarget) onClose();
  };

  const drawn = current ? [...shapes, current] : shapes;

  return (
    <div className="lightbox" role="dialog" aria-label={alt}>
      <div
        ref={stage}
        className="lightbox-stage"
        data-dragging={dragging || undefined}
        data-editing={editing || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = undefined;
          stroke.current = undefined;
          setCurrent(undefined);
          setDragging(false);
        }}
        onDoubleClick={(e) => !editing && (view.scale === 1 ? zoom(2, ...center(e)) : setView(FIT))}
      >
        <div
          className="lightbox-canvas"
          style={{
            width: natural && fit !== undefined ? natural.w * fit : undefined,
            height: natural && fit !== undefined ? natural.h * fit : undefined,
            visibility: fit === undefined ? "hidden" : undefined,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          <img
            ref={image}
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          />
          {natural && (
            <svg ref={overlay} viewBox={`0 0 ${natural.w} ${natural.h}`} preserveAspectRatio="none">
              {drawn.map((shape, i) =>
                shape.tool === "text" ? (
                  <text
                    key={i}
                    x={shape.points[0]![0]}
                    y={shape.points[0]![1]}
                    fill={shape.color}
                    stroke="rgba(0, 0, 0, 0.7)"
                    strokeWidth={shape.width / 6}
                    style={{ font: textFont(shape.width), paintOrder: "stroke" }}
                  >
                    {shape.text!.split("\n").map((line, j) => (
                      <tspan key={j} x={shape.points[0]![0]} dy={shape.width * (j === 0 ? BASELINE : LINE_HEIGHT)}>
                        {line || " "}
                      </tspan>
                    ))}
                  </text>
                ) : (
                  <path key={i} d={pathOf(shape)} stroke={shape.color} strokeWidth={shape.width} />
                ),
              )}
            </svg>
          )}
          {natural && fit !== undefined && typing && (
            <textarea
              ref={(el) => {
                // Focus once the click that placed it is over.
                if (el && el !== field.current) requestAnimationFrame(() => el.focus());
                field.current = el;
              }}
              className="lightbox-text"
              rows={1}
              placeholder={t("lightbox.textPlaceholder")}
              style={{
                left: `${(typing.at[0] / natural.w) * 100}%`,
                top: `${(typing.at[1] / natural.h) * 100}%`,
                font: textFont(typing.size * fit),
                color: typing.color,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onBlur={commitText}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.currentTarget.value = "";
                  commitText();
                } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  commitText();
                }
              }}
            />
          )}
        </div>
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
        {onSave && (
          <button
            type="button"
            className="icon-btn"
            title={t("lightbox.edit")}
            aria-label={t("lightbox.edit")}
            aria-pressed={editing}
            onClick={() => setEditing(!editing)}
          >
            <Icon svg={pencilIcon} />
          </button>
        )}
        {onPopOut && (
          <button type="button" className="icon-btn" title={t("lightbox.popOut")} aria-label={t("lightbox.popOut")} onClick={onPopOut}>
            <Icon svg={appWindowIcon} />
          </button>
        )}
        <button type="button" className="icon-btn" title={t("lightbox.close")} aria-label={t("lightbox.close")} onClick={onClose}>
          <Icon svg={xIcon} />
        </button>
      </div>
      {onSave && (editing || shapes.length > 0) && (
        <div className="lightbox-toolbar lightbox-tools">
          {editing && (
            <>
              {TOOLS.map((x) => (
                <button
                  key={x.tool}
                  type="button"
                  className="icon-btn"
                  title={t(x.label)}
                  aria-label={t(x.label)}
                  aria-pressed={tool === x.tool}
                  onClick={() => setTool(x.tool)}
                >
                  <Icon svg={x.icon} />
                </button>
              ))}
              <span className="lightbox-sep" />
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="lightbox-swatch"
                  title={t("lightbox.color")}
                  aria-label={t("lightbox.color")}
                  aria-pressed={color === c}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                />
              ))}
              <span className="lightbox-sep" />
            </>
          )}
          <button type="button" className="icon-btn" title={t("lightbox.undo")} aria-label={t("lightbox.undo")} disabled={shapes.length === 0} onClick={undo}>
            <Icon svg={arrowBackIcon} />
          </button>
          <button type="button" className="icon-btn" title={t("lightbox.redo")} aria-label={t("lightbox.redo")} disabled={undone.length === 0} onClick={redo}>
            <Icon svg={arrowForwardIcon} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t("lightbox.clear")}
            aria-label={t("lightbox.clear")}
            disabled={shapes.length === 0}
            onClick={() => {
              setShapes([]);
              setUndone([]);
            }}
          >
            <Icon svg={trashIcon} />
          </button>
          <span className="lightbox-spacer" />
          <button type="button" className="lightbox-save" title={`${saveLabel} (Enter)`} disabled={shapes.length === 0} onClick={save}>
            <Icon svg={checkIcon} />
            <span>{saveLabel}</span>
          </button>
        </div>
      )}
    </div>
  );
}
