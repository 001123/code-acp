import { Fragment, useContext } from "react";
import { useL10n } from "../l10n";
import { HoverPreview, OpenPreview } from "./context";

/**
 * Splits `text` at the first occurrence of each item's token; an item whose token is gone from the text is left out.
 * At the same position the longer token wins, so "@a.ts (2)" isn't read as "@a.ts".
 */
export function splitTokens<T extends { token: string }>(text: string, items: Iterable<T>): Array<string | T> {
  const left = [...items].sort((a, b) => b.token.length - a.token.length);
  const out: Array<string | T> = [];
  let from = 0;
  for (;;) {
    let next: { at: number; item: T } | undefined;
    for (const item of left) {
      const at = text.indexOf(item.token, from);
      if (at >= 0 && (!next || at < next.at)) next = { at, item };
    }
    if (!next) break;
    if (next.at > from) out.push(text.slice(from, next.at));
    out.push(next.item);
    left.splice(left.indexOf(next.item), 1);
    from = next.at + next.item.token.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

/** An inline token; `src` is set for images, which open in the lightbox. */
export interface Token {
  token: string;
  src?: string;
}

/** `text` with its attachment tokens highlighted. */
export function Tokens({ text, tokens }: { text: string; tokens: Token[] }) {
  const { t } = useL10n();
  const open = useContext(OpenPreview);
  const hover = useContext(HoverPreview);
  return splitTokens(text, tokens).map((part, i) =>
    typeof part === "string" ? (
      <Fragment key={i}>{part}</Fragment>
    ) : part.src ? (
      <mark
        key={i}
        className="token image"
        data-token={part.token}
        aria-label={t("chat.previewImage")}
        onMouseEnter={(e) => hover({ src: part.src!, rect: e.currentTarget.getBoundingClientRect() })}
        onMouseLeave={() => hover(undefined)}
        onClick={() => {
          hover(undefined);
          open({ src: part.src!, name: part.token.slice(1) });
        }}
      >
        {part.token}
      </mark>
    ) : (
      <mark key={i} className="token">
        {part.token}
      </mark>
    ),
  );
}
