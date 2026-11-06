/**
 * Hover highlighting for pele flowcharts: pointing at a node lights up its edges and neighbours, at a subgraph the
 * same for everything inside it, at an edge (or its label) it and its two ends; everything else fades.
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

/**
 * Edges are hairlines; a wide transparent copy under each one makes them easy to point at.
 * Each edge is also tagged with its direction, which picks its animation.
 */
function addHitPaths(svg: SVGSVGElement) {
  if (svg.dataset.hit) return;
  svg.dataset.hit = "1";
  for (const edge of svg.querySelectorAll(".pele-edge")) {
    const line = edge.querySelector("path:not(.pele-marker)");
    if (!line) continue;
    // One arrowhead: flows from tail to head. Two: pulses both ways. None: a plain link, lit but still.
    const heads = edge.querySelectorAll(".pele-marker").length;
    if (heads !== 1) edge.setAttribute("data-flow", heads === 0 ? "none" : "both");
    const hit = line.cloneNode() as SVGPathElement;
    hit.setAttribute("class", HIT);
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "12");
    hit.setAttribute("stroke-dasharray", "none");
    hit.setAttribute("pointer-events", "stroke");
    edge.insertBefore(hit, line);
  }
}

function clear(root: HTMLElement) {
  delete root.dataset.hover;
  for (const el of root.querySelectorAll("[data-hot]")) el.removeAttribute("data-hot");
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
  const hotNodes = new Set(picked);
  const hotEdges = new Set<string>();
  if (isEdge) hotEdges.add(id);
  for (const edge of svg.querySelectorAll(".pele-edge[data-id]")) {
    const edgeId = edge.getAttribute("data-id")!;
    const ends = edgeEnds(edgeId, ids);
    if (!ends) continue;
    if (isEdge ? edgeId === id : ends.some((end) => picked.has(end))) {
      hotEdges.add(edgeId);
      for (const end of ends) hotNodes.add(end);
    }
  }
  clear(root);
  root.dataset.hover = "";
  for (const el of svg.querySelectorAll(ITEM)) {
    const elId = el.getAttribute("data-id")!;
    const hot = el.matches(".pele-edge, .pele-edge-label") ? hotEdges.has(elId) : hotNodes.has(elId);
    if (hot) el.setAttribute("data-hot", "");
  }
}

/** Starts hover highlighting for the diagram(s) drawn inside `root`; returns a function that stops it. */
export function hoverDiagram(root: HTMLElement): () => void {
  const onOver = (e: PointerEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    const svg = target?.closest<SVGSVGElement>("svg.pele-flowchart");
    if (!svg || !root.contains(svg)) return clear(root);
    addHitPaths(svg);
    const item = target!.closest(ITEM);
    if (item) highlight(root, svg, item);
    else clear(root);
  };
  const onLeave = () => clear(root);
  root.addEventListener("pointerover", onOver);
  root.addEventListener("pointerleave", onLeave);
  return () => {
    root.removeEventListener("pointerover", onOver);
    root.removeEventListener("pointerleave", onLeave);
    clear(root);
  };
}
