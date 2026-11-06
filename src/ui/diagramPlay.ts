/**
 * Replays a pele sequence diagram: one message at a time, in time order, a pulse running from sender to receiver
 * while the messages already sent stay visible and the frames (`loop`, `alt`, …) around the current one light up.
 * The styles live in `media/shared/pele.css`.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { addHitPaths, clear, markSequence, messages } from "./diagramHover";

/** How long each message stays the current one. */
const STEP_MS = 1100;
const TRACE = "pele-trace";

/** The frames drawn around height `y`; frames aren't the parents of their messages in the DOM. */
function framesAt(svg: SVGSVGElement, y: number): Element[] {
  return [...svg.querySelectorAll(".pele-frame")].filter((frame) => {
    const box = frame.querySelector("rect");
    if (!box) return false;
    const top = Number(box.getAttribute("y"));
    return y >= top && y <= top + Number(box.getAttribute("height"));
  });
}

/**
 * Plays the sequence diagram inside `root` once; `onEnd` runs when it finishes on its own.
 * Returns a function that stops it early. Nothing happens (and `onEnd` runs) when there is no diagram to play.
 */
export function playSequence(root: HTMLElement, onEnd: () => void): () => void {
  const svg = root.querySelector<SVGSVGElement>("svg.pele-sequence");
  const steps = svg ? messages(svg) : [];
  if (!svg || steps.length === 0) {
    onEnd();
    return () => {};
  }
  addHitPaths(svg);
  root.dataset.playing = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    clearTimeout(timer);
    for (const el of svg.querySelectorAll(`.${TRACE}`)) el.remove();
    delete root.dataset.playing;
    clear(root);
  };
  const show = (i: number) => {
    const step = steps[i];
    if (!step) {
      cleanup();
      onEnd();
      return;
    }
    const done = new Set(steps.slice(0, i).map((m) => m.id));
    markSequence(root, svg, new Set([step.from, step.to]), new Set([step.id]), done);
    for (const frame of framesAt(svg, step.y)) frame.setAttribute("data-hot", "");
    for (const el of svg.querySelectorAll(`.${TRACE}`)) el.remove();
    // A short dash on a path of length 100 travels from the sender's end to the receiver's.
    const trace = step.line.cloneNode() as SVGPathElement;
    trace.setAttribute("class", TRACE);
    trace.setAttribute("pathLength", "100");
    trace.removeAttribute("stroke-dasharray");
    step.line.after(trace);
    timer = setTimeout(() => show(i + 1), STEP_MS);
  };
  show(0);
  return cleanup;
}

/** Play/stop state for the sequence diagram inside `root`; stops on unmount. */
export function useSequencePlayer(root: RefObject<HTMLElement | null>) {
  const [playing, setPlaying] = useState(false);
  const stopRef = useRef<() => void>(undefined);
  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = undefined;
    setPlaying(false);
  }, []);
  const toggle = useCallback(() => {
    if (stopRef.current) return stop();
    if (!root.current) return;
    let ended = false;
    const stopPlay = playSequence(root.current, () => {
      ended = true;
      stopRef.current = undefined;
      setPlaying(false);
    });
    if (ended) return;
    stopRef.current = stopPlay;
    setPlaying(true);
  }, [root, stop]);
  useEffect(() => stop, [stop]);
  return { playing, toggle, stop };
}
