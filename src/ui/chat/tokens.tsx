import { useContext } from "react";
import { useL10n } from "../l10n";
import { tokenImages } from "./clipboard";
import { HoverPreview, OpenPreview } from "./context";
import { openFile } from "./post";

/** An inline token; `src` is set for images, which open in the lightbox, `path` for files, which open in an editor. */
export interface Token {
  token: string;
  src?: string;
  path?: string;
}

/** One highlighted token: images open in the lightbox, files in an editor. */
export function TokenMark({ token }: { token: Token }) {
  const { t } = useL10n();
  const open = useContext(OpenPreview);
  const hover = useContext(HoverPreview);
  if (token.src) {
    const src = token.src;
    return (
      <mark
        className="token image"
        data-token={token.token}
        ref={(el) => {
          if (el) tokenImages.set(el, src);
        }}
        aria-label={t("chat.previewImage")}
        onMouseEnter={(e) => hover({ src, rect: e.currentTarget.getBoundingClientRect() })}
        onMouseLeave={() => hover(undefined)}
        onClick={() => {
          hover(undefined);
          open({ src, name: token.token.slice(1) });
        }}
      >
        {token.token}
      </mark>
    );
  }
  if (token.path) {
    const path = token.path;
    return (
      <mark className="token file" title={path} onClick={() => openFile({ path })}>
        {token.token}
      </mark>
    );
  }
  return <mark className="token">{token.token}</mark>;
}
