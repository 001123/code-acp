import { useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "../icon";
import { useL10n } from "../l10n";
import chevronDownIcon from "@tabler/icons/outline/chevron-down.svg";
import chevronUpIcon from "@tabler/icons/outline/chevron-up.svg";
import messagesIcon from "@tabler/icons/outline/messages.svg";
import searchIcon from "@tabler/icons/outline/search.svg";
import xIcon from "@tabler/icons/outline/x.svg";
import { findMatches, MAX_MATCHES } from "./search";

const MATCHES = "transcript-search";
const CURRENT = "transcript-search-current";
const LAID_OUT = "data-search-current";
/** Frames to keep a match in view while what is above and around it gets laid out. */
const SETTLE_FRAMES = 30;
/** After a keystroke, before searching. */
const TYPING_MS = 100;
/** Least time between searches while the transcript changes (a reply streaming in). */
const REFRESH_MS = 250;

/** Text the user does not read as part of the conversation. */
const SKIPPED = "button, svg, [hidden], .empty, .waiting, .mermaid";
/** A question or an answer: a subagent's messages are part of the work of the tool call that holds them. */
const isMessage = (el: Element) => !!el.closest(".msg") && !el.closest(".activity, .tool");
/** A match never goes from one of these into the next. */
const BLOCK = "p, li, pre, blockquote, h1, h2, h3, h4, h5, h6, td, th, summary, div";

/** The ranges of the matches in one block; `nodes` are its text nodes, each with where it starts in `text`. */
function blockRanges(nodes: { node: Text; start: number }[], text: string, query: string, limit: number): Range[] {
  let at = 0;
  // Matches come in order, so the walk over the nodes only goes forward.
  const locate = (offset: number, isEnd: boolean) => {
    while (at + 1 < nodes.length && (isEnd ? offset > nodes[at + 1]!.start : offset >= nodes[at + 1]!.start)) at++;
    return nodes[at]!;
  };
  return findMatches(text, query, limit).map(({ start, end }) => {
    const range = document.createRange();
    const first = locate(start, false);
    range.setStart(first.node, start - first.start);
    const last = locate(end, true);
    range.setEnd(last.node, end - last.start);
    return range;
  });
}

/** Where `query` is in the text under `root`, across the inline elements that split it (code highlighting). */
export function findRanges(root: Element, query: string, limit = MAX_MATCHES, messagesOnly = false): Range[] {
  const ranges: Range[] = [];
  if (!query) return ranges;
  let block: Element | null = null;
  let nodes: { node: Text; start: number }[] = [];
  let text = "";
  const flush = () => {
    if (nodes.length > 0) ranges.push(...blockRanges(nodes, text, query, limit - ranges.length));
    nodes = [];
    text = "";
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && ranges.length < limit) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement!;
    if (parent.closest(SKIPPED) || (messagesOnly && !isMessage(parent))) continue;
    const owner = parent.closest(BLOCK);
    if (owner !== block) {
      flush();
      block = owner;
    }
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  flush();
  return ranges;
}

/** The transcript entry that holds `range`. */
function entryOf(range: Range, root: Element): Element | null {
  let el = range.startContainer.parentElement;
  while (el && el.parentElement !== root) el = el.parentElement;
  return el;
}

/** The first match not above the top of the view, else the last one: a long chat is usually read from the end. */
export function nearestMatch(ranges: Range[], root: Element): number {
  const top = root.getBoundingClientRect().top;
  // Entries off screen skip layout: their own box is cheap and good enough, unlike the range's.
  const found = ranges.findIndex((range) => (entryOf(range, root)?.getBoundingClientRect().bottom ?? 0) > top);
  return found < 0 ? ranges.length - 1 : found;
}

/**
 * Opens the collapsed sections around `range`. Those opened for an earlier match close again, so walking through the
 * matches leaves the transcript as it was. Returns the sections that are open because of the search now.
 */
export function openAround(range: Range, opened: HTMLDetailsElement[]): HTMLDetailsElement[] {
  const start = range.startContainer.parentElement!;
  const around: HTMLDetailsElement[] = [];
  for (let details = start.closest("details"); details; details = details.parentElement?.closest("details") ?? null) {
    // A section's summary shows while it is closed.
    if (!details.querySelector(":scope > summary")?.contains(start)) around.push(details);
  }
  const kept = opened.filter((details) => {
    if (around.includes(details)) return true;
    details.open = false;
    return false;
  });
  for (const details of around) {
    if (!details.open) {
      details.open = true;
      kept.push(details);
    }
  }
  return kept;
}

/** Scrolls `range` to the middle of each box it scrolls in; a long output has a scroll bar of its own. */
function scrollToRange(range: Range, root: Element): void {
  const center = (box: Element) => {
    const target = range.getBoundingClientRect();
    const outer = box.getBoundingClientRect();
    box.scrollTop += target.top + target.height / 2 - (outer.top + box.clientHeight / 2);
    box.scrollLeft += target.left + target.width / 2 - (outer.left + box.clientWidth / 2);
  };
  for (let el = range.startContainer.parentElement; el && el !== root; el = el.parentElement) {
    if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) continue;
    const style = getComputedStyle(el);
    if (/auto|scroll/.test(style.overflowX + style.overflowY)) center(el);
  }
  center(root);
}

function inView(range: Range, root: Element): boolean {
  const target = range.getBoundingClientRect();
  const box = root.getBoundingClientRect();
  return target.top >= box.top && target.bottom <= box.bottom;
}

function paint(ranges: Range[], current: Range | undefined): void {
  const matches = new Highlight();
  for (const range of ranges) matches.add(range);
  CSS.highlights.set(MATCHES, matches);
  if (current) {
    const shown = new Highlight(current);
    shown.priority = 1;
    CSS.highlights.set(CURRENT, shown);
  } else {
    CSS.highlights.delete(CURRENT);
  }
}

function clearPaint(): void {
  CSS.highlights.delete(MATCHES);
  CSS.highlights.delete(CURRENT);
}

interface TranscriptSearchProps {
  /** The element whose text is searched. */
  root: RefObject<HTMLElement | null>;
  /** What is shown there changed for good (another tab): the search starts over. */
  resetKey: unknown;
  /** Changes each time the user asks for the search box. */
  request: number;
  /** Search only the questions and answers. It belongs to the caller, so it outlives this box. */
  messagesOnly: boolean;
  onMessagesOnlyChange: (messagesOnly: boolean) => void;
  /** A match is about to be scrolled to: the view must stop following the end. */
  onReveal: () => void;
  onClose: () => void;
}

/** The find box above the transcript. It only marks the text (CSS highlights), so React's DOM stays untouched. */
export function TranscriptSearch({ root, resetKey, request, messagesOnly, onMessagesOnlyChange, onReveal, onClose }: TranscriptSearchProps) {
  const { t } = useL10n();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState({ current: -1, count: 0 });
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const current = useRef(-1);
  const opened = useRef<HTMLDetailsElement[]>([]);
  const frame = useRef(0);
  /** The entry of the match scrolled to; it must not skip layout, or the match has no position to scroll to. */
  const shownEntry = useRef<Element | null>(null);

  const show = (index: number, reveal: boolean) => {
    const range = ranges.current[index];
    current.current = index;
    setFound({ current: index, count: ranges.current.length });
    paint(ranges.current, range);
    const el = root.current;
    if (!reveal || !range || !el) return;
    onReveal();
    opened.current = openAround(range, opened.current);
    keepLaidOut(entryOf(range, el));
    // Entries around the match skip layout until they are near the view, a frame or more later; then they move it.
    cancelAnimationFrame(frame.current);
    let frames = SETTLE_FRAMES;
    let settled = 0;
    const settle = () => {
      const before = el.scrollTop;
      scrollToRange(range, el);
      // Stable for a few frames in a row: the user's own scrolling must not be fought for longer than it takes.
      settled = Math.abs(el.scrollTop - before) < 1 && inView(range, el) ? settled + 1 : 0;
      if (settled < 2 && --frames > 0) frame.current = requestAnimationFrame(settle);
    };
    settle();
  };

  const keepLaidOut = (entry: Element | null) => {
    shownEntry.current?.removeAttribute(LAID_OUT);
    entry?.setAttribute(LAID_OUT, "");
    shownEntry.current = entry;
  };

  const closeOpened = () => {
    for (const details of opened.current) details.open = false;
    opened.current = [];
  };

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [request]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const search = () => (ranges.current = findRanges(el, query, MAX_MATCHES, messagesOnly));
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => {
        timer = undefined;
        search();
        closeOpened();
        show(ranges.current.length > 0 ? nearestMatch(ranges.current, el) : -1, true);
      },
      query ? TYPING_MS : 0,
    );
    // Only what the text is made of: opening a section is no reason to search again.
    const changes = new MutationObserver(() => {
      timer ??= setTimeout(() => {
        timer = undefined;
        search();
        // The matches found before keep their numbers while a reply grows below them.
        show(Math.min(Math.max(current.current, 0), ranges.current.length - 1), false);
      }, REFRESH_MS);
    });
    changes.observe(el, { childList: true, characterData: true, subtree: true });
    return () => {
      clearTimeout(timer);
      changes.disconnect();
    };
  }, [query, resetKey, messagesOnly]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      keepLaidOut(null);
      closeOpened();
      clearPaint();
    },
    [],
  );

  const step = (by: number) => {
    const { count } = found;
    if (count > 0) show((found.current + by + count) % count, true);
  };

  return (
    <div
      id="transcript-search"
      role="search"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter" && e.target === input.current) {
          e.preventDefault();
          step(e.shiftKey ? -1 : 1);
        }
      }}
    >
      <Icon svg={searchIcon} />
      <input
        ref={input}
        type="text"
        placeholder={t("chat.findPlaceholder")}
        aria-label={t("chat.findPlaceholder")}
        spellCheck={false}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query && (
        <span className="transcript-search-count" aria-live="polite">
          {found.count === 0
            ? t("chat.findNone")
            : t("chat.findCount", found.current + 1, found.count >= MAX_MATCHES ? `${MAX_MATCHES}+` : found.count)}
        </span>
      )}
      <button
        className="icon-btn small"
        title={t("chat.findMessagesOnly")}
        aria-label={t("chat.findMessagesOnly")}
        aria-pressed={messagesOnly}
        // A click must leave the caret in the input: Enter goes on to the next match.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onMessagesOnlyChange(!messagesOnly)}
      >
        <Icon svg={messagesIcon} />
      </button>
      <button className="icon-btn small" title={t("chat.findPrevious")} aria-label={t("chat.findPrevious")} disabled={found.count === 0} onClick={() => step(-1)}>
        <Icon svg={chevronUpIcon} />
      </button>
      <button className="icon-btn small" title={t("chat.findNext")} aria-label={t("chat.findNext")} disabled={found.count === 0} onClick={() => step(1)}>
        <Icon svg={chevronDownIcon} />
      </button>
      <button className="icon-btn small" title={t("chat.findClose")} aria-label={t("chat.findClose")} onClick={onClose}>
        <Icon svg={xIcon} />
      </button>
    </div>
  );
}
