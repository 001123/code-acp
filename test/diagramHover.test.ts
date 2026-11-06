import { assert, describe, it } from "@effect/vitest";
import { edgeEnds, nearest, pathEnds, reach, type Link } from "../src/ui/diagramHover";

describe("edgeEnds", () => {
  it("splits an edge id at known node ids, even ones with underscores", () => {
    const ids = new Set(["a_b", "c", "S"]);
    assert.deepStrictEqual(edgeEnds("L_a_b_c_0", ids), ["a_b", "c"]);
    assert.deepStrictEqual(edgeEnds("L_a_b_S_12", ids), ["a_b", "S"]);
  });

  it("gives up on ids it can't place", () => {
    assert.strictEqual(edgeEnds("L_x_y_0", new Set(["a"])), undefined);
    assert.strictEqual(edgeEnds("other", new Set(["a"])), undefined);
  });
});

describe("reach", () => {
  const one = (from: string, to: string): Link => ({ id: `${from}${to}`, from, to, oneWay: true });
  const two = (from: string, to: string): Link => ({ id: `${from}${to}`, from, to, oneWay: false });
  // u → r → b → o → t → x, b → s, o → s, o ↔ p, p ↔ q
  const links = [
    one("u", "r"),
    one("r", "b"),
    one("b", "o"),
    one("o", "t"),
    one("t", "x"),
    one("b", "s"),
    one("o", "s"),
    two("o", "p"),
    two("p", "q"),
  ];
  const sorted = (s: Set<string>) => [...s].sort();

  it("lights the whole flow through a node, upstream and downstream", () => {
    const { nodes, edges } = reach(links, new Set(["o"]));
    assert.deepStrictEqual(sorted(nodes), ["b", "o", "p", "q", "r", "s", "t", "u", "x"]);
    assert.deepStrictEqual(sorted(edges), ["bo", "op", "os", "ot", "pq", "rb", "tx", "ur"]);
  });

  it("doesn't take a side branch of an upstream node", () => {
    assert.isFalse(reach(links, new Set(["t"])).edges.has("bs"));
  });

  it("carries the flow on through a two-way link in a chain", () => {
    const chain = [one("u", "r"), two("r", "b"), one("b", "o"), one("b", "k")];
    const { nodes, edges } = reach(chain, new Set(["o"]));
    assert.deepStrictEqual(sorted(nodes), ["b", "o", "r", "u"]);
    assert.deepStrictEqual(sorted(edges), ["bo", "rb", "ur"]);
  });

  it("lights the flow through a picked edge", () => {
    const { nodes, edges } = reach(links, new Set(), "tx");
    assert.deepStrictEqual(sorted(nodes), ["b", "o", "p", "q", "r", "t", "u", "x"]);
    assert.deepStrictEqual(sorted(edges), ["bo", "op", "ot", "pq", "rb", "tx", "ur"]);
  });

  it("stops at cycles", () => {
    const { nodes } = reach([one("a", "b"), one("b", "a")], new Set(["a"]));
    assert.deepStrictEqual(sorted(nodes), ["a", "b"]);
  });
});

describe("pathEnds", () => {
  it("follows straight, vertical and arc segments", () => {
    assert.deepStrictEqual(pathEnds("M114.95,343H7"), { start: [114.95, 343], end: [7, 343] });
    assert.deepStrictEqual(pathEnds("M0,62V293"), { start: [0, 62], end: [0, 293] });
    assert.deepStrictEqual(pathEnds("M0,64H22A6,6 0 0 1 28,70V80A6,6 0 0 1 22,86H7"), {
      start: [0, 64],
      end: [7, 86],
    });
  });

  it("handles relative commands and implicit linetos", () => {
    assert.deepStrictEqual(pathEnds("m10,10 5,5h-3"), { start: [10, 10], end: [12, 15] });
  });

  it("gives up on what it can't read", () => {
    assert.strictEqual(pathEnds(""), undefined);
    assert.strictEqual(pathEnds("M1"), undefined);
    assert.strictEqual(pathEnds("X1,2"), undefined);
  });
});

describe("nearest", () => {
  const lifelines = [
    { id: "A", x: 0 },
    { id: "B", x: 114.95 },
    { id: "C", x: 218.95 },
  ];

  it("picks the lifeline a message ends near, past activation bars and boxes", () => {
    assert.strictEqual(nearest(7, lifelines), "A");
    assert.strictEqual(nearest(119.95, lifelines), "B");
    assert.strictEqual(nearest(178.95, lifelines), "C");
    assert.strictEqual(nearest(1, []), undefined);
  });
});
