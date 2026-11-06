/** Splits a command line into arguments at spaces, keeping what is in "double" or 'single' quotes together. */
export function parseArgs(text: string): string[] {
  const args: string[] = [];
  let current: string | undefined;
  let quote: string | undefined;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current ??= "";
    } else if (/\s/.test(ch)) {
      if (current !== undefined) args.push(current);
      current = undefined;
    } else {
      current = (current ?? "") + ch;
    }
  }
  if (current !== undefined) args.push(current);
  return args;
}

/** Arguments as one line that `parseArgs` reads back: those with a space or quote are quoted. */
export function formatArgs(args: ReadonlyArray<string>): string {
  return args
    .map((arg) => (arg === "" || /[\s"']/.test(arg) ? (arg.includes('"') ? `'${arg}'` : `"${arg}"`) : arg))
    .join(" ");
}
