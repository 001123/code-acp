import { render } from "pele";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { DiagramFromWebview, DiagramState, DiagramToWebview } from "../diagramPanel";
import { hoverDiagram } from "./diagramHover";
import { useSequencePlayer } from "./diagramPlay";
import { Icon } from "./icon";
import { useL10n } from "./l10n";
import { mount } from "./mount";
import { poster, setState, useMessages } from "./vscode";
import codeIcon from "@tabler/icons/outline/code.svg";
import hoverIcon from "@tabler/icons/outline/bulb.svg";
import hoverOffIcon from "@tabler/icons/outline/bulb-off.svg";
import playIcon from "@tabler/icons/outline/player-play.svg";
import stopIcon from "@tabler/icons/outline/player-stop.svg";
import schemaIcon from "@tabler/icons/outline/schema.svg";
import zoomInIcon from "@tabler/icons/outline/zoom-in.svg";
import zoomOutIcon from "@tabler/icons/outline/zoom-out.svg";
import zoomResetIcon from "@tabler/icons/outline/zoom-reset.svg";

const post = poster<DiagramFromWebview>();

const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
const STEP = 1.25;
/** At 100% a small diagram is enlarged to fill the page, up to this. */
const MAX_FIT = 2;
/** Room left around the diagram at 100%. */
const MARGIN = 24;

interface View {
  scale: number;
  x: number;
  y: number;
}
const FIT: View = { scale: 1, x: 0, y: 0 };

/** The SVG markup and its own size, or the error that kept it from rendering. */
function draw(code: string): { svg: string; w: number; h: number } | { error: string } {
  try {
    const { svg, width, height } = render(code);
    return { svg, w: width, h: height };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A Mermaid diagram filling the page: wheel / buttons / keys to zoom, drag to pan, double-click to zoom in or back.
 * The SVG is resized rather than scaled, so it stays sharp at any zoom; its colors follow the theme.
 */
function DiagramPage() {
  const { t } = useL10n();
  const [code, setCode] = useState<string>();
  const [view, setView] = useState(FIT);
  const [dragging, setDragging] = useState(false);
  const [source, setSource] = useState(false);
  const [hover, setHover] = useState(true);
  const [box, setBox] = useState<{ w: number; h: number }>();
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean }>(undefined);
  const player = useSequencePlayer(stage);

  useMessages((msg: DiagramToWebview) => {
    if (msg.type === "diagram") {
      // Kept for the host, which reopens the tab from it after a window reload.
      setState({ code: msg.code } satisfies DiagramState);
      player.stop();
      setCode(msg.code);
      setHover(msg.hover);
      setView(FIT);
      setSource(false);
    }
  });
  useEffect(() => post({ type: "ready" }), []);

  const drawn = code === undefined ? undefined : draw(code);
  const size = drawn && "svg" in drawn ? drawn : undefined;
  const sequence = !!size && /^<svg[^>]*\bclass="[^"]*\bpele-sequence\b/.test(size.svg);

  /** Zoom by `factor`, keeping the stage point (cx, cy) — relative to its center — fixed on screen. */
  const zoom = (factor: number, cx = 0, cy = 0) =>
    setView((v) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  const center = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return [e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2] as const;
  };

  useLayoutEffect(() => {
    const el = stage.current!;
    const observer = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => (hover ? hoverDiagram(stage.current!) : undefined), [hover]);

  useEffect(() => {
    const el = stage.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * 0.002), ...center(e));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (source) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "+" || e.key === "=") zoom(STEP);
      else if (e.key === "-") zoom(1 / STEP);
      else if (e.key === "0") setView(FIT);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [source]);

  const fit = size && box ? Math.min(MAX_FIT, (box.w - MARGIN * 2) / size.w, (box.h - MARGIN * 2) / size.h) : undefined;
  const shown = size && fit !== undefined ? { w: size.w * fit * view.scale, h: size.h * fit * view.scale } : undefined;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
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
  const endDrag = () => {
    drag.current = undefined;
    setDragging(false);
  };

  const sourceLabel = t(source ? "chat.mermaidShowDiagram" : "chat.mermaidShowCode");
  const hoverLabel = t(hover ? "chat.mermaidHoverOff" : "chat.mermaidHoverOn");
  const playLabel = t(player.playing ? "chat.mermaidStop" : "chat.mermaidPlay");

  return (
    <div className="diagram">
      <div className="diagram-toolbar">
        <span className="diagram-spacer" />
        <div className="diagram-zoom" hidden={source}>
          <button
            type="button"
            className="icon-btn"
            title={t("lightbox.zoomOut")}
            aria-label={t("lightbox.zoomOut")}
            onClick={() => zoom(1 / STEP)}
          >
            <Icon svg={zoomOutIcon} />
          </button>
          <button type="button" className="diagram-scale" title={t("lightbox.reset")} onClick={() => setView(FIT)}>
            {Math.round(view.scale * 100)}%
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t("lightbox.zoomIn")}
            aria-label={t("lightbox.zoomIn")}
            onClick={() => zoom(STEP)}
          >
            <Icon svg={zoomInIcon} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={t("lightbox.reset")}
            aria-label={t("lightbox.reset")}
            onClick={() => setView(FIT)}
          >
            <Icon svg={zoomResetIcon} />
          </button>
        </div>
        {!source && (
          <button
            type="button"
            className="icon-btn"
            title={hoverLabel}
            aria-label={hoverLabel}
            aria-pressed={hover}
            onClick={() => {
              post({ type: "hover", on: !hover });
              setHover(!hover);
            }}
          >
            <Icon svg={hover ? hoverIcon : hoverOffIcon} />
          </button>
        )}
        {sequence && !source && (
          <button
            type="button"
            className="icon-btn"
            title={playLabel}
            aria-label={playLabel}
            aria-pressed={player.playing}
            onClick={player.toggle}
          >
            <Icon svg={player.playing ? stopIcon : playIcon} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          title={sourceLabel}
          aria-label={sourceLabel}
          aria-pressed={source}
          onClick={() => {
            player.stop();
            setSource(!source);
          }}
        >
          <Icon svg={source ? schemaIcon : codeIcon} />
        </button>
      </div>
      {source && (
        <pre className="diagram-source">
          <code>{code}</code>
        </pre>
      )}
      <div
        ref={stage}
        className="diagram-stage"
        hidden={source}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => (view.scale === 1 ? zoom(2, ...center(e)) : setView(FIT))}
      >
        {drawn && "error" in drawn && <pre className="diagram-error">{drawn.error}</pre>}
        {size && (
          <div
            className="diagram-canvas mermaid"
            style={{
              width: shown?.w,
              height: shown?.h,
              visibility: shown ? undefined : "hidden",
              transform: `translate(${view.x}px, ${view.y}px)`,
            }}
            dangerouslySetInnerHTML={{ __html: size.svg }}
          />
        )}
      </div>
    </div>
  );
}

mount(<DiagramPage />);
