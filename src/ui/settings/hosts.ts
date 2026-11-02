/**
 * One host per line → their names as a URL has them, without repeats; returns the 1-based number of the first line that
 * is more than a host instead (a scheme, port or path, or a wildcard, none of which would ever match).
 */
export function parseHosts(text: string): string[] | number {
  const hosts = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Only an IPv6 address, in its brackets, may hold what would otherwise separate a host from a port or path.
    const url = /[/?#@*\\]|^[^[].*:/.test(line) ? null : URL.parse(`http://${line}`);
    if (!url || url.port) return i + 1;
    hosts.add(url.hostname);
  }
  return [...hosts];
}
