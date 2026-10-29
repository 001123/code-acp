/** The "@", "$" or "/" word being typed before the caret; `start` is the sigil, `end` the caret. */
export interface Trigger {
  sigil: "@" | "$" | "/";
  start: number;
  end: number;
  query: string;
}

/** The trigger before the caret, if any: "@" and "$" start a word, "/" only the whole message. */
export function triggerIn(el: HTMLTextAreaElement): Trigger | undefined {
  if (el.selectionStart !== el.selectionEnd) return undefined;
  const end = el.selectionStart;
  const before = el.value.slice(0, end);
  const m = /(^|\s)([@$])([^\s@$]*)$/.exec(before) ?? /^(\s*)(\/)(\S*)$/.exec(before);
  if (!m) return undefined;
  return { sigil: m[2] as Trigger["sigil"], start: m.index + m[1]!.length, end, query: m[3]! };
}

/** Names containing `query`, those starting with it first. */
export function byName<T>(items: T[], name: (item: T) => string, query: string): T[] {
  const q = query.toLowerCase();
  return items
    .map((item) => ({ item, at: name(item).toLowerCase().indexOf(q) }))
    .filter((x) => x.at >= 0)
    .sort((a, b) => Number(a.at > 0) - Number(b.at > 0))
    .map((x) => x.item);
}

/** One row of the "@" / "$" / "/" popup. */
export interface Suggestion {
  key: string;
  label: string;
  detail?: string;
  pick: () => void;
}
