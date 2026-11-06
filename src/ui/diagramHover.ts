/**
 * Hover highlighting for pele flowcharts: pointing at a node lights up the whole flow through it (see `reach`), at a
 * subgraph the same for everything inside it, at an edge (or its label) the flow through it; everything else fades.
 * The styles live in `media/shared/pele.css`.
 */

const ITEM = ".pele-node[data-id], .pele-cluster[data-id], .pele-edge[data-id], .pele-edge-label[data-id]";
const HIT = "pele-edge-hit";

/** The two ends of the edge `L_<from>_<to>_<n>`; ids may contain `_`, so they are matched against the known ones. */
export function edgeEnds(edgeId: string, ids: ReadonlySet<string>): [string, string] | undefined {
  const m = /^L_(.+)_\d+$/.exec(edgeId);
  if (!m) return undefined;
  const rest = m[1]!;
  for (const from of ids) {
    if (!rest.startsWith(`${from}_`)) continue;
    const to = rest.slice(from.length + 1);
    if (ids.has(to)) return [from, to];
  }
  return undefined;
}

/** An edge between two known nodes; `oneWay` when it has a single arrowhead, so it flows from `from` to `to`. */
export interface Link {
  id: string;
  from: string;
  to: string;
  oneWay: boolean;
}

/**
 * What lights up for the picked nodes (or the picked edge): the whole flow through them — every node upstream and
 * downstream, and the links on the way. One-way links are followed along their arrow; two-way and plain links either
 * way, so a two-way hop in the middle of a chain (a request/response pair) doesn't cut the flow short.
 */
export function reach(
  links: readonly Link[],
  picked: ReadonlySet<string>,
  pickedEdge?: string,
): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set(picked);
  const edges = new Set<string>();
  const walk = (starts: Iterable<string>, forward: boolean) => {
    const seen = new Set(starts);
    const queue = [...seen];
    for (let node = queue.shift(); node !== undefined; node = queue.shift()) {
      for (const link of links) {
        const next =
          (forward || !link.oneWay) && link.from === node
            ? link.to
            : (!forward || !link.oneWay) && link.to === node
              ? link.from
              : undefined;
        if (next === undefined) continue;
        edges.add(link.id);
        nodes.add(next);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  };
  if (pickedEdge === undefined) {
    walk(picked, false);
    walk(picked, true);
    return { nodes, edges };
  }
  edges.add(pickedEdge);
  const edge = links.find((l) => l.id === pickedEdge);
  if (edge) {
    nodes.add(edge.from).add(edge.to);
    walk(edge.oneWay ? [edge.from] : [edge.from, edge.to], false);
    walk(edge.oneWay ? [edge.to] : [edge.from, edge.to], true);
  }
  return { nodes, edges };
}

/** Start and end points of an SVG path's `d`; enough of the grammar for the paths pele draws. */
export function pathEnds(d: string): { start: [number, number]; end: [number, number] } | undefined {
  const ARITY: Record<string, number> = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let start: [number, number] | undefined;
  let cmd = "";
  for (let i = 0; i < tokens.length;) {
    if (/[a-zA-Z]/.test(tokens[i]!)) cmd = tokens[i++]!;
    else if (cmd === "Z" || cmd === "z") return undefined;
    const up = cmd.toUpperCase();
    const n = ARITY[up];
    if (n === undefined) return undefined;
    const rel = cmd !== up;
    const args = tokens.slice(i, i + n).map(Number);
    if (args.length < n || args.some(Number.isNaN)) return undefined;
    i += n;
    if (up === "Z") {
      [x, y] = [sx, sy];
    } else if (up === "H") {
      x = rel ? x + args[0]! : args[0]!;
    } else if (up === "V") {
      y = rel ? y + args[0]! : args[0]!;
    } else {
      const [ax, ay] = args.slice(-2) as [number, number];
      x = rel ? x + ax : ax;
      y = rel ? y + ay : ay;
    }
    if (up === "M") {
      [sx, sy] = [x, y];
      // Further pairs after a moveto are linetos.
      cmd = rel ? "l" : "L";
    }
    start ??= [x, y];
  }
  return start && { start, end: [x, y] };
}

export interface Lifeline {
  id: string;
  x: number;
}

/** The participant whose lifeline is nearest `x`: messages end at activation bars or a created participant's box. */
export function nearest(x: number, lifelines: readonly Lifeline[]): string | undefined {
  let best: Lifeline | undefined;
  for (const l of lifelines) if (!best || Math.abs(l.x - x) < Math.abs(best.x - x)) best = l;
  return best?.id;
}

/** A message of a sequence diagram, from sender to receiver, at height `y`. */
export interface Message {
  id: string;
  from: string;
  to: string;
  y: number;
  line: SVGPathElement;
}

/** The messages of a pele sequence diagram, in time order. */
export function messages(svg: SVGSVGElement): Message[] {
  const lifelines: Lifeline[] = [];
  for (const el of svg.querySelectorAll(".pele-lifeline[data-id]")) {
    const ends = pathEnds(el.getAttribute("d") ?? "");
    if (ends) lifelines.push({ id: el.getAttribute("data-id")!, x: ends.start[0] });
  }
  const out: Message[] = [];
  for (const el of svg.querySelectorAll(".pele-message[data-id]")) {
    const line = el.querySelector<SVGPathElement>(`path:not(.pele-marker, .${HIT}, .pele-trace)`);
    const ends = line && pathEnds(line.getAttribute("d") ?? "");
    const from = ends && nearest(ends.start[0], lifelines);
    const to = ends && nearest(ends.end[0], lifelines);
    if (from && to) out.push({ id: el.getAttribute("data-id")!, from, to, y: ends.start[1], line });
  }
  return out.sort((a, b) => a.y - b.y);
}

const SEQ_PARTICIPANT =
  ".pele-actor[data-id], .pele-lifeline[data-id], .pele-activation[data-id], .pele-destroy[data-id]";
const SEQ_MESSAGE = ".pele-message[data-id], .pele-edge-label[data-id]";
const SEQ_ITEM = `${SEQ_PARTICIPANT}, ${SEQ_MESSAGE}`;

/**
 * Edges are hairlines; a wide transparent copy under each one makes them easy to point at.
 * Each edge is also tagged with its direction, which picks its animation.
 */
export function addHitPaths(svg: SVGSVGElement) {
  if (svg.dataset.hit) return;
  svg.dataset.hit = "1";
  const hitCopy = (line: Element) => {
    const hit = line.cloneNode() as SVGPathElement;
    hit.setAttribute("class", HIT);
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "12");
    hit.setAttribute("stroke-dasharray", "none");
    hit.setAttribute("pointer-events", "stroke");
    line.parentNode!.insertBefore(hit, line);
    return hit;
  };
  for (const edge of svg.querySelectorAll(".pele-edge")) {
    const line = edge.querySelector("path:not(.pele-marker)");
    if (!line) continue;
    // One arrowhead: flows from tail to head; a dashed message is a reply. Two: pulses both ways. None: a plain
    // link, lit but still.
    const heads = edge.querySelectorAll(".pele-marker").length;
    if (heads !== 1) edge.setAttribute("data-flow", heads === 0 ? "none" : "both");
    else if (edge.matches(".pele-message") && line.hasAttribute("stroke-dasharray")) {
      edge.setAttribute("data-flow", "reply");
    }
    hitCopy(line);
  }
  // Lifelines too: pointing anywhere along one picks its participant.
  for (const line of svg.querySelectorAll(".pele-lifeline[data-id]")) hitCopy(line);
}

/** Removes every highlight inside `root`. */
export function clear(root: HTMLElement) {
  delete root.dataset.hover;
  for (const el of root.querySelectorAll("[data-hot], [data-done]")) {
    el.removeAttribute("data-hot");
    el.removeAttribute("data-done");
  }
}

/** Lights up the given participants and messages of a sequence diagram; everything else fades. */
export function markSequence(
  root: HTMLElement,
  svg: SVGSVGElement,
  participants: ReadonlySet<string>,
  hot: ReadonlySet<string>,
  done: ReadonlySet<string> = new Set(),
) {
  clear(root);
  root.dataset.hover = "";
  for (const el of svg.querySelectorAll(SEQ_PARTICIPANT)) {
    if (participants.has(el.getAttribute("data-id")!)) el.setAttribute("data-hot", "");
  }
  for (const el of svg.querySelectorAll(SEQ_MESSAGE)) {
    const id = el.getAttribute("data-id")!;
    if (hot.has(id)) el.setAttribute("data-hot", "");
    else if (done.has(id)) el.setAttribute("data-done", "");
  }
}

/** Pointing at a message lights it and its two ends; at a participant, every message it sends or receives. */
function highlightSequence(root: HTMLElement, svg: SVGSVGElement, item: Element) {
  const id = item.getAttribute("data-id")!;
  const all = messages(svg);
  const picked = item.matches(SEQ_MESSAGE)
    ? all.filter((m) => m.id === id)
    : all.filter((m) => m.from === id || m.to === id);
  const participants = new Set(item.matches(SEQ_MESSAGE) ? [] : [id]);
  for (const m of picked) participants.add(m.from).add(m.to);
  markSequence(root, svg, participants, new Set(picked.map((m) => m.id)));
}

const within = (inner: DOMRect, outer: DOMRect) =>
  inner.left >= outer.left && inner.right <= outer.right && inner.top >= outer.top && inner.bottom <= outer.bottom;

/** The ids of `cluster` and of every node and subgraph drawn inside it (clusters aren't their parents in the DOM). */
function members(svg: SVGSVGElement, cluster: Element): Set<string> {
  const box = (cluster.querySelector("rect") ?? cluster).getBoundingClientRect();
  const ids = new Set([cluster.getAttribute("data-id")!]);
  for (const el of svg.querySelectorAll(".pele-node[data-id], .pele-cluster[data-id]")) {
    if (within((el.querySelector("rect") ?? el).getBoundingClientRect(), box)) ids.add(el.getAttribute("data-id")!);
  }
  return ids;
}

function highlight(root: HTMLElement, svg: SVGSVGElement, item: Element) {
  const id = item.getAttribute("data-id")!;
  const nodes = svg.querySelectorAll(".pele-node[data-id], .pele-cluster[data-id]");
  const ids = new Set([...nodes].map((n) => n.getAttribute("data-id")!));
  const isEdge = item.matches(".pele-edge, .pele-edge-label");
  // What was pointed at: an edge, a node, or a subgraph with everything in it.
  const picked = isEdge ? new Set<string>() : item.matches(".pele-cluster") ? members(svg, item) : new Set([id]);
  const links: Link[] = [];
  for (const edge of svg.querySelectorAll(".pele-edge[data-id]")) {
    const edgeId = edge.getAttribute("data-id")!;
    const ends = edgeEnds(edgeId, ids);
    if (ends) links.push({ id: edgeId, from: ends[0], to: ends[1], oneWay: !edge.hasAttribute("data-flow") });
  }
  const { nodes: hotNodes, edges: hotEdges } = reach(links, picked, isEdge ? id : undefined);
  clear(root);
  root.dataset.hover = "";
  for (const el of svg.querySelectorAll(ITEM)) {
    const elId = el.getAttribute("data-id")!;
    const hot = el.matches(".pele-edge, .pele-edge-label") ? hotEdges.has(elId) : hotNodes.has(elId);
    if (hot) el.setAttribute("data-hot", "");
  }
}

/**
 * Starts hover highlighting for the diagram(s) drawn inside `root`; returns a function that stops it.
 * While a sequence plays (`data-playing` on `root`, see `diagramPlay.ts`) the player owns the highlight.
 */
export function hoverDiagram(root: HTMLElement): () => void {
  const playing = () => root.dataset.playing !== undefined;
  const onOver = (e: PointerEvent) => {
    if (playing()) return;
    const target = e.target instanceof Element ? e.target : null;
    const svg = target?.closest<SVGSVGElement>("svg.pele-flowchart, svg.pele-sequence");
    if (!svg || !root.contains(svg)) return clear(root);
    addHitPaths(svg);
    const sequence = svg.matches(".pele-sequence");
    const item = sequence ? (lifelineHit(target!) ?? target!.closest(SEQ_ITEM)) : target!.closest(ITEM);
    if (!item) clear(root);
    else if (sequence) highlightSequence(root, svg, item);
    else highlight(root, svg, item);
  };
  const onLeave = () => {
    if (!playing()) clear(root);
  };
  root.addEventListener("pointerover", onOver);
  root.addEventListener("pointerleave", onLeave);
  return () => {
    root.removeEventListener("pointerover", onOver);
    root.removeEventListener("pointerleave", onLeave);
    if (!playing()) clear(root);
  };
}

/** The hit copy of a lifeline stands for its participant. */
function lifelineHit(target: Element): Element | undefined {
  return target.matches(`path.${HIT}[data-id]`) && target.closest(".pele-lifelines") ? target : undefined;
}
