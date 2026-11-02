import { useEffect, useRef, useState } from "react";
import { isTabDrag } from "./tabs";

/** Takes drops anywhere in the view, leaving tab drags to the tab strip. Gives whether something is dragged over it. */
export function useFileDrop(onDrop: (dt: DataTransfer) => void): boolean {
  const [dragging, setDragging] = useState(false);
  /** For the listeners, registered once. */
  const latest = useRef(onDrop);
  latest.current = onDrop;
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      e.preventDefault();
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      if (--depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const over = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const drop = (e: DragEvent) => {
      if (isTabDrag(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (e.dataTransfer) latest.current(e.dataTransfer);
    };
    window.addEventListener("dragenter", enter, true);
    window.addEventListener("dragleave", leave, true);
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", drop, true);
    return () => {
      window.removeEventListener("dragenter", enter, true);
      window.removeEventListener("dragleave", leave, true);
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", drop, true);
    };
  }, []);
  return dragging;
}
