import { useEffect, useRef } from "react";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const api = acquireVsCodeApi();

/** Typed `postMessage` to the extension host. */
export function poster<T>(): (message: T) => void {
  return (message) => api.postMessage(message);
}

/** The webview's saved state (kept while the panel is hidden or reloaded); untyped, so check it. */
export function getState(): unknown {
  return api.getState();
}

export function setState(state: unknown): void {
  api.setState(state);
}

/** Calls `handler` for every message the extension posts; the latest handler is always used. */
export function useMessages(handler: (message: any) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (e: MessageEvent) => ref.current(e.data);
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);
}
