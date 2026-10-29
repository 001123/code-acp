import { mount, render, type Mounted } from "pele";
import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * A ```mermaid block drawn by pele. Text that does not parse (a block still streaming in, or a
 * broken diagram) keeps the last good drawing, or shows the source until there is one.
 */
function Mermaid({ code }: { code: string }) {
  const host = useRef<HTMLDivElement>(null);
  const mounted = useRef<Mounted>(null);
  const [drawn, setDrawn] = useState(false);
  let valid = true;
  try {
    render(code);
  } catch {
    valid = false;
  }

  useLayoutEffect(() => {
    if (!valid || !host.current) return;
    if (mounted.current) mounted.current.update(code);
    else mounted.current = mount(host.current, code);
    setDrawn(true);
  }, [code, valid]);
  useLayoutEffect(() => () => mounted.current?.destroy(), []);

  return (
    <>
      <div ref={host} className="mermaid" hidden={!drawn && !valid} />
      {!drawn && !valid && (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </>
  );
}

export interface FileRef {
  path: string;
  /** 1-based. */
  line?: number;
}

// Inline code only counts as a file when it looks unambiguous: a dotfile or a known extension.
const FILE_EXTENSIONS = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs json jsonc md mdx css scss less html vue svelte py rb go rs java kt swift " +
    "c h cc cpp hpp cs php sh zsh bash fish yml yaml toml xml ini cfg conf env txt lock sql gradle png jpg svg"
  ).split(" "),
);

/** `src/a.ts`, `.gitignore`, `src/a.ts:12`, `src/a.ts#L12`, `file:///abs/a.ts`; undefined for anything else. */
function fileRef(text: string, strict: boolean): FileRef | undefined {
  let raw = text.trim();
  if (raw.startsWith("file://")) {
    raw = decodeURIComponent(raw.slice("file://".length));
  } else if (/^[a-z][\w+.-]+:/i.test(raw) || raw.startsWith("#")) {
    return undefined;
  }
  const m = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/.exec(raw);
  if (!m || /[\s*?<>|"'`]/.test(m[1]!)) return undefined;
  const path = m[1]!;
  const lineText = m[2] ?? m[3];
  const line = lineText ? Number(lineText) : undefined;
  if (strict) {
    const base = path.replace(/\/$/, "").split("/").pop() ?? "";
    const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
    const dotfile = /^\.[\w-][\w.-]*$/.test(base);
    if (path.startsWith("@") || !(dotfile || (base.indexOf(".") > 0 && FILE_EXTENSIONS.has(ext)))) return undefined;
  }
  return { path, line };
}

const fileData = (ref: FileRef | undefined) =>
  ref ? { "data-file": ref.path, "data-line": ref.line, className: "file-link" } : {};

// Raw HTML in agent output is never rendered: react-markdown escapes it unless rehype-raw is added.
const components: Components = {
  a: ({ node: _, ...props }) => (
    <a {...props} title={props.href} {...fileData(props.href ? fileRef(props.href, false) : undefined)} />
  ),
  // Only inline code: a fenced block's <code> sits inside <pre>, rendered below.
  code: ({ node: _, className, children, ...props }) => {
    const text = typeof children === "string" ? children : undefined;
    const ref = !className && text && !text.includes("\n") ? fileRef(text, true) : undefined;
    return (
      <code {...props} className={className} {...fileData(ref)}>
        {children}
      </code>
    );
  },
  pre: ({ node, children, ...props }) => {
    const code = node?.children[0];
    if (code?.type === "element" && code.tagName === "code") {
      const classes = code.properties.className;
      if (Array.isArray(classes) && classes.includes("language-mermaid")) {
        const text = code.children.map((c) => (c.type === "text" ? c.value : "")).join("");
        return <Mermaid code={text.replace(/\n$/, "")} />;
      }
    }
    return <pre {...props}>{children}</pre>;
  },
};

/**
 * Agent text rendered as GitHub-flavored Markdown; ```mermaid blocks become diagrams. Local links and
 * inline code that names a file call `onOpenFile`.
 */
export function MarkdownView({
  text,
  className,
  onOpenFile,
}: {
  text: string;
  className?: string;
  onOpenFile?: (ref: FileRef) => void;
}) {
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = (e.target as Element).closest<HTMLElement>("[data-file]");
    if (!target || !onOpenFile) return;
    e.preventDefault();
    const line = target.dataset.line ? Number(target.dataset.line) : undefined;
    onOpenFile({ path: target.dataset.file!, line });
  };
  return (
    <div className={className} onClick={onClick}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
