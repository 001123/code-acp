import { createContext } from "react";
import type { Attachment, TerminalSnapshot } from "../../chat/protocol";

export interface Preview {
  src: string;
  name: string;
  /** Takes the drawn-on copy of a composer image; without it, the copy is attached as a new image. */
  replace?: (a: Attachment) => void;
}
/** Opens an image in the lightbox; provided by the app. */
export const OpenPreview = createContext<(preview: Preview) => void>(() => {});

/** An image token under the pointer: `rect` is the box to place the thumbnail next to. */
export interface Hover {
  src: string;
  rect: DOMRect;
}
/** Shows (or, with undefined, hides) the hover thumbnail; provided by the app. */
export const HoverPreview = createContext<(hover: Hover | undefined) => void>(() => {});

/** The shown tab, for transcript entries that act on it. */
export interface ShownTab {
  id?: number;
  busy: boolean;
  /** Turns whose user message can restore the files the agent changed from then on. */
  checkpoints: ReadonlySet<number>;
}
export const ShownTab = createContext<ShownTab>({ busy: false, checkpoints: new Set() });

/** The shown tab's agent terminals by id; their own context, so output only re-renders the terminal views. */
export const Terminals = createContext<Readonly<Record<string, TerminalSnapshot>>>({});
