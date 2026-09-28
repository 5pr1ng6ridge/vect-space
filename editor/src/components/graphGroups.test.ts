import { describe, expect, it } from "vitest";
import {
  canonicalizeGroupSelection,
  createParentGroup,
  dissolveGroup,
  groupNodeIds,
  moveGroupChildUpOneLevel,
  nestedGroupBounds,
  nestedGroupedLayout,
  normalizeSceneGroups,
  removeNodesFromGroups,
  renameNodeInGroups,
} from "./graphGroups";
import type { SceneGroup } from "../types";

const items = [
  { id: "a", position: { x: 100, y: 30 }, width: 100, height: 80 },
  { id: "b", position: { x: 230, y: 60 }, width: 100, height: 80 },
  { id: "c", position: { x: 400, y: 30 }, width: 100, height: 80 },
];

describe("move one group child up one level", () => {
  const ids = new Set(["a", "b", "c", "d"]);

  it("moves a node into its grandparent and collapses a unary former parent", () => {
    expect(
      moveGroupChildUpOneLevel(
        [
          { id: "outer", children: [{ group: "inner" }, { node: "d" }] },
          { id: "inner", children: [{ node: "a" }, { node: "b" }] },
        ],
        { node: "a" },
        ids,
      ),
    ).toEqual([
      { id: "outer", children: [{ node: "b" }, { node: "a" }, { node: "d" }] },
    ]);
  });

  it("moves a child group intact and preserves its descendants and ids", () => {
    expect(
      moveGroupChildUpOneLevel(
        [
          { id: "root", children: [{ group: "parent" }, { node: "d" }] },
          { id: "parent", children: [{ group: "child" }, { node: "c" }] },
          { id: "child", children: [{ node: "a" }, { node: "b" }] },
        ],
        { group: "child" },
        ids,
      ),
    ).toEqual([
      {
        id: "root",
        children: [{ node: "c" }, { group: "child" }, { node: "d" }],
      },
      { id: "child", children: [{ node: "a" }, { node: "b" }] },
    ]);
  });

  it("detaches from a root parent to become a root, collapsing the parent", () => {
    expect(
      moveGroupChildUpOneLevel(
        [{ id: "parent", children: [{ node: "a" }, { node: "b" }] }],
        { node: "a" },
        ids,
      ),
    ).toEqual([]);
  });

  it("does not move a root item or an unknown item", () => {
    const groups = [{ id: "parent", children: [{ node: "a" }, { node: "b" }] }];
    expect(moveGroupChildUpOneLevel(groups, { node: "c" }, ids)).toEqual(
      groups,
    );
    expect(moveGroupChildUpOneLevel(groups, { node: "missing" }, ids)).toEqual(
      groups,
    );
  });
});

describe("nested rigid graph layout", () => {
  it("collapses one root group into a padded unit and restores exact offsets", () => {
    const graph = nestedGroupedLayout(
      items,
      [
        { id: "ab", source: "a", target: "b" },
        { id: "bc", source: "b", target: "c" },
      ],
      [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    );
    expect(graph.children).toHaveLength(2);
    const unit = graph.units[0];
    const vertex = graph.children.find((child) => child.id === unit.vertexId);
    expect(vertex).toMatchObject({ width: 278, height: 158 });
    expect(graph.edges).toEqual([
      { id: "bc", sources: [unit.vertexId], targets: ["c"] },
    ]);
    expect(
      graph.expand({
        [unit.vertexId]: { x: 500, y: 200 },
        c: { x: 900, y: 200 },
      }),
    ).toEqual({
      a: { x: 524, y: 224 },
      b: { x: 654, y: 254 },
      c: { x: 900, y: 200 },
    });
  });

  it("folds nested groups into a single root unit and remaps their edges", () => {
    const groups: SceneGroup[] = [
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
      { id: "g0", children: [{ group: "g1" }, { node: "c" }] },
    ];
    const graph = nestedGroupedLayout(
      items,
      [
        { id: "ab", source: "a", target: "b" },
        { id: "bc", source: "b", target: "c" },
        { id: "ca", source: "c", target: "a" },
      ],
      groups,
    );
    // Only the root g0 becomes a vertex; g1 is folded into it and every edge
    // between its descendants is internal, so it disappears from ELK's input.
    expect(graph.units.map((unit) => unit.groupId)).toEqual(["g0"]);
    expect(graph.edges).toEqual([]);
  });

  it("expands nested groups recursively with exact descendant offsets", () => {
    const groups: SceneGroup[] = [
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
      { id: "g0", children: [{ group: "g1" }, { node: "c" }] },
    ];
    const graph = nestedGroupedLayout(items, [], groups);
    const unit = graph.units[0];
    const moved = graph.expand({ [unit.vertexId]: { x: 1000, y: 500 } });
    const outer = nestedGroupBounds(items, groups).get("g0");
    const inner = nestedGroupBounds(items, groups).get("g1");
    if (outer === undefined || inner === undefined)
      throw new Error("missing frame");
    expect(moved.a).toEqual({
      x: 1000 + (100 - outer.x),
      y: 500 + (30 - outer.y),
    });
    expect(moved.c).toEqual({
      x: 1000 + (400 - outer.x),
      y: 500 + (30 - outer.y),
    });
    // The child group is placed relative to the parent frame, so the inner
    // offset from a to b survives the recursive expansion untouched.
    expect(moved.b).toEqual({
      x: moved.a.x + (230 - 100),
      y: moved.a.y + (60 - 30),
    });
    expect(inner.x - outer.x).toBe(24);
  });

  it("keeps free nodes at their ELK vertex positions", () => {
    const graph = nestedGroupedLayout(
      items,
      [],
      [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    );
    const unit = graph.units[0];
    expect(
      graph.expand({
        [unit.vertexId]: { x: 0, y: 0 },
        c: { x: 42, y: 7 },
      }),
    ).toMatchObject({ c: { x: 42, y: 7 } });
  });

  it("uses collision-safe synthetic vertex ids", () => {
    const graph = nestedGroupedLayout(
      items,
      [],
      [{ id: "g1", children: [{ node: "a" }, { node: "b" }] }],
    );
    const ids = new Set(graph.children.map((child) => child.id));
    const nodeIds = new Set(items.map((item) => item.id));
    expect(ids.size).toBe(graph.children.length);
    // The synthetic unit id never shadows a real node id.
    expect(graph.units[0].vertexId).not.toBe("a");
    expect(nodeIds.has(graph.units[0].vertexId)).toBe(false);
    expect(ids.has(graph.units[0].vertexId)).toBe(true);
  });
});

describe("nested scene groups", () => {
  it("drops missing and duplicate members so every node has one owner", () => {
    const ids = new Set(["a", "b", "c", "d"]);
    expect(
      normalizeSceneGroups(
        [
          {
            id: "g1",
            children: [{ node: "a" }, { node: "missing" }, { node: "b" }],
          },
          {
            id: "g2",
            children: [{ node: "b" }, { node: "c" }, { node: "d" }],
          },
        ],
        ids,
      ),
    ).toEqual([
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
      { id: "g2", children: [{ node: "c" }, { node: "d" }] },
    ]);
  });

  it("breaks group containment cycles into a forest", () => {
    const ids = new Set(["a", "b", "c", "d"]);
    expect(
      normalizeSceneGroups(
        [
          {
            id: "g1",
            children: [{ node: "a" }, { node: "b" }, { group: "g2" }],
          },
          {
            id: "g2",
            children: [{ node: "c" }, { node: "d" }, { group: "g1" }],
          },
        ],
        ids,
      ),
    ).toEqual([
      { id: "g1", children: [{ node: "a" }, { node: "b" }, { group: "g2" }] },
      { id: "g2", children: [{ node: "c" }, { node: "d" }] },
    ]);
  });

  it("drops self-parents and references to unknown groups", () => {
    const ids = new Set(["a", "b", "c", "d"]);
    expect(
      normalizeSceneGroups(
        [
          {
            id: "g1",
            children: [{ node: "a" }, { node: "b" }, { group: "g1" }],
          },
          {
            id: "g2",
            children: [{ node: "c" }, { node: "d" }, { group: "ghost" }],
          },
        ],
        ids,
      ),
    ).toEqual([
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
      { id: "g2", children: [{ node: "c" }, { node: "d" }] },
    ]);
  });

  it("collapses a unary group by promoting its single child", () => {
    const ids = new Set(["a", "b", "c"]);
    expect(
      normalizeSceneGroups(
        [
          {
            id: "parent",
            children: [{ group: "child" }, { node: "c" }],
          },
          { id: "child", children: [{ node: "a" }] },
        ],
        ids,
      ),
    ).toEqual([{ id: "parent", children: [{ node: "a" }, { node: "c" }] }]);
  });

  it("reads an absent group list as an empty forest", () => {
    expect(normalizeSceneGroups(undefined, new Set())).toEqual([]);
    expect(normalizeSceneGroups([], new Set())).toEqual([]);
  });

  it("canonicalizes an ancestor together with its descendants", () => {
    const groups: SceneGroup[] = [
      { id: "g1", children: [{ node: "a" }, { group: "g2" }] },
      { id: "g2", children: [{ node: "b" }, { node: "c" }] },
    ];
    expect(
      canonicalizeGroupSelection(groups, [
        { group: "g1" },
        { node: "b" },
        { node: "c" },
        { group: "g2" },
      ]),
    ).toEqual([{ group: "g1" }]);
    expect(
      canonicalizeGroupSelection(groups, [{ node: "a" }, { node: "b" }]),
    ).toEqual([{ node: "a" }, { node: "b" }]);
    expect(groupNodeIds(groups, "g1")).toEqual(["a", "b", "c"]);
  });

  it("creates one parent around a mixed node + group selection", () => {
    const ids = new Set(["a", "b", "c", "d"]);
    const groups: SceneGroup[] = [
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
    ];
    expect(
      createParentGroup(
        groups,
        [{ group: "g1" }, { node: "c" }, { node: "d" }],
        ids,
      ),
    ).toEqual([
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
      {
        id: "group-0",
        children: [{ group: "g1" }, { node: "c" }, { node: "d" }],
      },
    ]);
  });

  it("uses the next free id when creating a parent", () => {
    const ids = new Set(["a", "b", "c", "d"]);
    const groups: SceneGroup[] = [
      { id: "group-0", children: [{ node: "a" }, { node: "b" }] },
    ];
    expect(
      createParentGroup(groups, [{ node: "c" }, { node: "d" }], ids),
    ).toEqual([
      { id: "group-0", children: [{ node: "a" }, { node: "b" }] },
      {
        id: "group-1",
        children: [{ node: "c" }, { node: "d" }],
      },
    ]);
  });

  it("ignores a selection with fewer than two selectable entities", () => {
    const ids = new Set(["a", "b"]);
    const groups: SceneGroup[] = [
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
    ];
    // Selecting a group and one of its own nodes collapses to the group alone.
    expect(
      createParentGroup(groups, [{ group: "g1" }, { node: "a" }], ids),
    ).toEqual(groups);
  });

  it("dissolves only one layer and retains nested child groups and nodes", () => {
    const ids = new Set(["a", "b", "c", "d"]);
    const groups: SceneGroup[] = [
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
      {
        id: "g0",
        children: [{ group: "g1" }, { node: "c" }, { node: "d" }],
      },
    ];
    expect(dissolveGroup(groups, "g0", ids)).toEqual([
      {
        id: "g1",
        children: [{ node: "a" }, { node: "b" }],
      },
    ]);
    expect(dissolveGroup(groups, "g1", ids)).toEqual([
      {
        id: "g0",
        children: [{ node: "a" }, { node: "b" }, { node: "c" }, { node: "d" }],
      },
    ]);
  });

  it("keeps a nested child group when a node deletion empties its parent", () => {
    const groups: SceneGroup[] = [
      { id: "g0", children: [{ node: "a" }, { group: "g1" }] },
      { id: "g1", children: [{ node: "b" }, { node: "c" }] },
    ];
    expect(
      removeNodesFromGroups(groups, new Set(["a"]), new Set(["b", "c"])),
    ).toEqual([{ id: "g1", children: [{ node: "b" }, { node: "c" }] }]);
  });

  it("renames node references without changing group ids", () => {
    const groups: SceneGroup[] = [
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
    ];
    expect(renameNodeInGroups(groups, "a", "z", new Set(["z", "b"]))).toEqual([
      { id: "g1", children: [{ node: "z" }, { node: "b" }] },
    ]);
  });

  it("nests frames around child frames with one padding margin", () => {
    const groups: SceneGroup[] = [
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
      { id: "g0", children: [{ group: "g1" }, { node: "c" }] },
    ];
    const bounds = nestedGroupBounds(items, groups);
    expect(bounds.get("g1")).toEqual({
      x: 76,
      y: 6,
      width: 278,
      height: 158,
    });
    expect(bounds.get("g0")).toEqual({
      x: 52,
      y: -18,
      width: 472,
      height: 206,
    });
    // The parent margin must exceed the child frame so frames never interlock.
    const parent = bounds.get("g0");
    const child = bounds.get("g1");
    if (parent === undefined || child === undefined)
      throw new Error("missing frame");
    expect(child.x - parent.x).toBe(24);
    expect(child.y - parent.y).toBe(24);
  });

  it("frames a parent that holds one node plus one child group", () => {
    const groups: SceneGroup[] = [
      { id: "g1", children: [{ node: "a" }, { node: "b" }] },
      { id: "g0", children: [{ group: "g1" }, { node: "c" }] },
    ];
    expect(nestedGroupBounds(items, groups).size).toBe(2);
  });
});
