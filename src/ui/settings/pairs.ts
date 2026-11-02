/** "KEY=VALUE" lines (or another separator) → object; returns the 1-based number of the first bad line instead. */
export function parsePairs(text: string, separator = "="): Record<string, string> | number {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    if (at <= 0) return i + 1;
    result[line.slice(0, at).trim()] = line.slice(at + separator.length).trim();
  }
  return result;
}

export function formatPairs(record: Readonly<Record<string, string>> | undefined, separator = "="): string {
  return Object.entries(record ?? {})
    .map(([k, val]) => `${k}${separator}${val}`)
    .join("\n");
}
