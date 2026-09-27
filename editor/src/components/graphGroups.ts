import type { GroupChildRef, NodePosition, SceneGroup } from "../types";

export interface GraphItem {
  id: string;
  position: NodePosition;
  width: number;
  height: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface GroupBounds extends NodePosition {
  width: number;
  height: number;
}

const PADDING = 24;

/**
 * Either persisted shape, as handed to the model helpers: the canonical nested
 * forest or the legacy flat `string[][]` membership.  The graph UI normalizes
 * to the canonical form once and then works with `SceneGroup[]` only.
 */
export type SceneGroupsInput = readonly (SceneGroup | readonly string[])[];

function isLegacyGroup(
  group: SceneGroup | readonly string[],
): group is readonly string[] {
  return Array.isArray(group);
}

// ---------------------------------------------------------------------------
// Nested rigid layout: every root group collapses into one ELK unit
// ---------------------------------------------------------------------------

/** One layout vertex handed to ELK: a free node or a collapsed root group. */
export interface LayoutVertex {
  id: string;
  width: number;
  height: number;
}

/** A synthetic vertex id and the root group it stands for. */
export interface LayoutUnit {
  groupId: string;
  vertexId: string;
}

export interface NestedLayoutGraph {
  children: LayoutVertex[];
  edges: { id: string; sources: string[]; targets: string[] }[];
  /** Root groups that became rigid vertices, in group order. */
  units: LayoutUnit[];
  /**
   * Turn ELK's vertex positions back into absolute node positions.  Every
   * descendant offset inside a root group is restored exactly, recursively, so
   * the group stays rigid while the vertices around it move freely.
   */
  expand(positions: Record<string, NodePosition>): Record<string, NodePosition>;
}

function boundsOf(rects: readonly GroupBounds[]): GroupBounds {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: left - PADDING,
    y: top - PADDING,
    width: right - left + PADDING * 2,
    height: bottom - top + PADDING * 2,
  };
}

/**
 * Collapse only the **root** groups into rigid ELK units, map every edge to the
 * unit that owns its endpoint, then expand the layout back into exact absolute
 * node positions.  Nested child groups are folded into their root: their own
 * offsets are preserved through the root frame, and a root group is a single
 * movable vertex so ELK can never interleave the groups' members.
 */
export function nestedGroupedLayout(
  items: readonly GraphItem[],
  edges: readonly GraphEdge[],
  groups: readonly SceneGroup[],
): NestedLayoutGraph {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const parentOf = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group.children) {
      if ("group" in ref) parentOf.set(ref.group, group.id);
    }
  }
  const rootOf = (groupId: string): string => {
    let cursor = groupId;
    const seen = new Set<string>();
    while (parentOf.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? cursor;
    }
    return cursor;
  };

  const bounds = nestedGroupBounds(items, groups);

  // A node is only collapsed when the root group that ultimately owns it has a
  // frame; otherwise it stays a free vertex so it can never lose its position.
  const collapsed = new Map<string, string>();
  for (const group of groups) {
    const root = rootOf(group.id);
    if (!bounds.has(root)) continue;
    for (const ref of group.children) {
      if ("node" in ref && itemById.has(ref.node))
        collapsed.set(ref.node, root);
    }
  }

  const occupied = new Set(items.map((item) => item.id));
  const units: LayoutUnit[] = [];
  const vertexIdByRoot = new Map<string, string>();
  for (const group of groups) {
    if (parentOf.has(group.id) || !bounds.has(group.id)) continue;
    let vertexId = `__layout_group_${units.length}`;
    while (occupied.has(vertexId)) vertexId += "_";
    occupied.add(vertexId);
    vertexIdByRoot.set(group.id, vertexId);
    units.push({ groupId: group.id, vertexId });
  }

  const children: LayoutVertex[] = [
    ...items
      .filter((item) => !collapsed.has(item.id))
      .map((item) => ({ id: item.id, width: item.width, height: item.height })),
    ...units.map((unit) => {
      const rect = bounds.get(unit.groupId);
      return {
        id: unit.vertexId,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
      };
    }),
  ];

  const vertexOf = (nodeId: string): string => {
    const root = collapsed.get(nodeId);
    if (root === undefined) return nodeId;
    return vertexIdByRoot.get(root) ?? nodeId;
  };
  const collapsedEdges = edges
    .map((edge) => ({
      id: edge.id,
      sources: [vertexOf(edge.source)],
      targets: [vertexOf(edge.target)],
    }))
    .filter((edge) => edge.sources[0] !== edge.targets[0]);

  const expand = (
    positions: Record<string, NodePosition>,
  ): Record<string, NodePosition> => {
    const result: Record<string, NodePosition> = {};
    const place = (groupId: string, origin: NodePosition): void => {
      const rect = bounds.get(groupId);
      const group = groupById.get(groupId);
      if (rect === undefined || group === undefined) return;
      for (const ref of group.children) {
        if ("node" in ref) {
          const item = itemById.get(ref.node);
          if (item !== undefined) {
            result[item.id] = {
              x: origin.x + item.position.x - rect.x,
              y: origin.y + item.position.y - rect.y,
            };
          }
          continue;
        }
        const childRect = bounds.get(ref.group);
        if (childRect !== undefined) {
          place(ref.group, {
            x: origin.x + childRect.x - rect.x,
            y: origin.y + childRect.y - rect.y,
          });
        }
      }
    };
    for (const item of items) {
      if (collapsed.has(item.id)) continue;
      const position = positions[item.id];
      if (position !== undefined) result[item.id] = position;
    }
    for (const unit of units) {
      const origin = positions[unit.vertexId];
      if (origin !== undefined) place(unit.groupId, origin);
    }
    return result;
  };

  return { children, edges: collapsedEdges, units, expand };
}

// ---------------------------------------------------------------------------
// Canonical nested forest (stable ids + explicit node/group references)
// ---------------------------------------------------------------------------

const GROUP_ID_PREFIX = "group-";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function refKey(ref: GroupChildRef): string {
  return "node" in ref ? `node:${ref.node}` : `group:${ref.group}`;
}

function rawChildRef(value: unknown): GroupChildRef | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (isNonEmptyString(record.node)) return { node: record.node };
  if (isNonEmptyString(record.group)) return { group: record.group };
  return null;
}

/**
 * Read either persisted shape into a list of groups with stable, unique ids.
 * Legacy flat lists get deterministic `group-N` ids; nested groups keep their
 * stored id and only a missing or duplicated id is regenerated.  References are
 * parsed defensively because this runs on hand-editable JSON.
 */
function parseSceneGroups(
  groups: SceneGroupsInput | undefined | null,
): SceneGroup[] {
  if (groups === undefined || groups === null) return [];
  const claimed = new Set<string>();
  for (const group of groups) {
    if (
      !isLegacyGroup(group) &&
      isNonEmptyString(group.id) &&
      !claimed.has(group.id)
    )
      claimed.add(group.id);
  }
  let auto = 0;
  const autoId = (): string => {
    let id: string;
    do {
      id = `${GROUP_ID_PREFIX}${auto}`;
      auto += 1;
    } while (claimed.has(id));
    claimed.add(id);
    return id;
  };
  const seen = new Set<string>();
  const result: SceneGroup[] = [];
  for (const group of groups) {
    if (isLegacyGroup(group)) {
      result.push({
        id: autoId(),
        children: group
          .filter((id): id is string => typeof id === "string")
          .map((node) => ({ node })),
      });
      continue;
    }
    let id = group.id;
    if (!isNonEmptyString(id) || seen.has(id)) id = autoId();
    else seen.add(id);
    const children = Array.isArray(group.children)
      ? group.children
          .map((child) => rawChildRef(child))
          .filter((ref): ref is GroupChildRef => ref !== null)
      : [];
    result.push({ id, children });
  }
  return result;
}

/**
 * Drop references that cannot be owned: unknown node/group ids, self-parents,
 * duplicate members within a group, and any node or group that a previous group
 * already owns.  Returns whether anything changed.
 */
function pruneSceneGroups(
  groups: SceneGroup[],
  nodeIds: ReadonlySet<string>,
): boolean {
  const ids = new Set(groups.map((group) => group.id));
  const ownedNodes = new Set<string>();
  const ownedGroups = new Set<string>();
  let changed = false;
  for (const group of groups) {
    const kept: GroupChildRef[] = [];
    for (const ref of group.children) {
      if ("node" in ref) {
        if (nodeIds.has(ref.node) && !ownedNodes.has(ref.node)) {
          ownedNodes.add(ref.node);
          kept.push(ref);
          continue;
        }
      } else if (
        ref.group !== group.id &&
        ids.has(ref.group) &&
        !ownedGroups.has(ref.group)
      ) {
        ownedGroups.add(ref.group);
        kept.push(ref);
        continue;
      }
      changed = true;
    }
    group.children = kept;
  }
  return changed;
}

/**
 * Remove one reference that closes a group containment cycle.  Ownership
 * already limits every group to a single parent, so each cycle is a simple
 * loop; dropping the parent link of a group that sits on the loop makes it a
 * root and restores the forest.  Returns whether a reference was removed.
 */
function breakGroupCycles(groups: SceneGroup[]): boolean {
  const indexById = new Map(groups.map((group, index) => [group.id, index]));
  const parentOf = new Map<string, string>();
  for (const group of groups)
    for (const ref of group.children)
      if ("group" in ref) parentOf.set(ref.group, group.id);
  for (const group of groups) {
    const seen = new Set<string>();
    let cursor: string | undefined = group.id;
    let cycleMember: string | undefined;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        cycleMember = cursor;
        break;
      }
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
    if (cycleMember === undefined) continue;
    const parent = parentOf.get(cycleMember);
    const index = parent === undefined ? undefined : indexById.get(parent);
    if (index === undefined) continue;
    groups[index].children = groups[index].children.filter(
      (ref) => !("group" in ref && ref.group === cycleMember),
    );
    return true;
  }
  return false;
}

/**
 * Enforce the nested-forest invariants to a fixed point: unique ownership and
 * acyclic containment, then collapse any group left with fewer than two
 * children.  A `0`-child group is removed; a `1`-child group is dissolved in
 * place and its single child (node or group) promoted into its slot, so nested
 * groups are never silently discarded.
 */
function repairSceneGroups(
  groups: SceneGroup[],
  nodeIds: ReadonlySet<string>,
): SceneGroup[] {
  const result = groups;
  for (;;) {
    let changed = pruneSceneGroups(result, nodeIds);
    changed = breakGroupCycles(result) || changed;
    if (changed) continue;
    const index = result.findIndex((group) => group.children.length < 2);
    if (index < 0) break;
    const [removed] = result.splice(index, 1);
    if (removed.children.length === 1) {
      const [child] = removed.children;
      for (const other of result)
        other.children = other.children.map((ref) =>
          "group" in ref && ref.group === removed.id ? child : ref,
        );
    }
  }
  return result;
}

/**
 * Canonicalize persisted membership into a nested forest.
 *
 * Accepts the canonical nested form or the legacy flat `string[][]`.  Mutually
 * consistent repair: missing/duplicate members are dropped, every node/group is
 * owned at most once, containment stays acyclic, and a group with fewer than two
 * children is collapsed or removed while preserving its surviving children.
 */
export function normalizeSceneGroups(
  groups: SceneGroupsInput | undefined | null,
  nodeIds: ReadonlySet<string>,
): SceneGroup[] {
  return repairSceneGroups(parseSceneGroups(groups), nodeIds);
}

/** Next deterministic `group-N` id that is not yet used. */
export function nextGroupId(groups: readonly SceneGroup[]): string {
  let max = -1;
  for (const group of groups) {
    const match = /^group-(\d+)$/.exec(group.id);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  const used = new Set(groups.map((group) => group.id));
  let candidate = `${GROUP_ID_PREFIX}${max + 1}`;
  while (used.has(candidate)) {
    max += 1;
    candidate = `${GROUP_ID_PREFIX}${max + 1}`;
  }
  return candidate;
}

/**
 * Rectangular frame for every group, computed bottom-up so a parent encloses
 * each direct node and every child frame with one `PADDING` margin.  A group
 * with fewer than two resolvable children yields no frame.
 */
export function nestedGroupBounds(
  items: readonly GraphItem[],
  groups: readonly SceneGroup[],
): Map<string, GroupBounds> {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const itemById = new Map(items.map((item) => [item.id, item]));
  const memo = new Map<string, GroupBounds | null>();
  const visiting = new Set<string>();
  const resolve = (id: string): GroupBounds | null => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const group = byId.get(id);
    if (group === undefined || visiting.has(id)) return null;
    visiting.add(id);
    const rects: GroupBounds[] = [];
    for (const ref of group.children) {
      if ("node" in ref) {
        const item = itemById.get(ref.node);
        if (item !== undefined)
          rects.push({
            x: item.position.x,
            y: item.position.y,
            width: item.width,
            height: item.height,
          });
      } else {
        const rect = resolve(ref.group);
        if (rect !== null) rects.push(rect);
      }
    }
    visiting.delete(id);
    const bounds = rects.length < 2 ? null : boundsOf(rects);
    memo.set(id, bounds);
    return bounds;
  };
  const result = new Map<string, GroupBounds>();
  for (const group of groups) {
    const rect = resolve(group.id);
    if (rect !== null) result.set(group.id, rect);
  }
  return result;
}

/** Every node id under `groupId`, recursively, in membership order. */
export function groupNodeIds(
  groups: readonly SceneGroup[],
  groupId: string,
): string[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const seen = new Set<string>();
  const result: string[] = [];
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const group = byId.get(id);
    if (group === undefined) return;
    for (const ref of group.children) {
      if ("node" in ref) result.push(ref.node);
      else walk(ref.group);
    }
  };
  walk(groupId);
  return result;
}

/** Every group id contained in `groupId`, recursively, excluding itself. */
export function groupChildGroupIds(
  groups: readonly SceneGroup[],
  groupId: string,
): string[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const seen = new Set<string>();
  const result: string[] = [];
  const walk = (id: string): void => {
    const group = byId.get(id);
    if (group === undefined) return;
    for (const ref of group.children) {
      if (!("group" in ref) || seen.has(ref.group)) continue;
      seen.add(ref.group);
      result.push(ref.group);
      walk(ref.group);
    }
  };
  walk(groupId);
  return result;
}

/** True when `inner` is `outer` itself or one of its descendants. */
function entityContains(
  groups: readonly SceneGroup[],
  outer: GroupChildRef,
  inner: GroupChildRef,
): boolean {
  if (refKey(outer) === refKey(inner)) return true;
  if ("node" in outer) return false;
  if ("node" in inner)
    return groupNodeIds(groups, outer.group).includes(inner.node);
  return (
    inner.group === outer.group ||
    groupChildGroupIds(groups, outer.group).includes(inner.group)
  );
}

/**
 * Reduce a raw entity selection to its maximal members: duplicates and any
 * entity that is a descendant of another selected entity are removed, so a
 * parent never coexists with something it already owns (which would cause
 * double membership or a cycle when a new parent is created).
 */
export function canonicalizeGroupSelection(
  groups: readonly SceneGroup[],
  selection: readonly GroupChildRef[],
): GroupChildRef[] {
  const maximal: GroupChildRef[] = [];
  for (const ref of selection) {
    if (maximal.some((kept) => entityContains(groups, kept, ref))) continue;
    for (let index = maximal.length - 1; index >= 0; index -= 1)
      if (entityContains(groups, ref, maximal[index])) maximal.splice(index, 1);
    maximal.push(ref);
  }
  return maximal;
}

/**
 * Ctrl+L on two or more entities: wrap the canonical selection in one new
 * parent group.  Each selected entity is detached from its previous owner so
 * ownership stays unique and a parent with one node + one child group (or any
 * mix) is accepted.  Fewer than two selectable entities returns the input.
 */
export function createParentGroup(
  groups: readonly SceneGroup[],
  selection: readonly GroupChildRef[],
  nodeIds: ReadonlySet<string>,
): SceneGroup[] {
  const normalized = normalizeSceneGroups(groups, nodeIds);
  const canonical = canonicalizeGroupSelection(normalized, selection).filter(
    (ref) =>
      "node" in ref
        ? nodeIds.has(ref.node)
        : normalized.some((group) => group.id === ref.group),
  );
  if (canonical.length < 2) return normalized;
  const selected = new Set(canonical.map(refKey));
  const detached = normalized.map((group) => ({
    ...group,
    children: group.children.filter((ref) => !selected.has(refKey(ref))),
  }));
  const parent: SceneGroup = {
    id: nextGroupId(normalized),
    children: canonical,
  };
  return repairSceneGroups([...detached, parent], nodeIds);
}

/**
 * Lift a node or child group out of its direct owner into the grandparent (or
 * the root). Collapse a former owner with fewer than two children in place,
 * preserving any surviving child group and its descendants.
 */
export function moveGroupChildUpOneLevel(
  groups: readonly SceneGroup[],
  child: GroupChildRef,
  nodeIds: ReadonlySet<string>,
): SceneGroup[] {
  const normalized = normalizeSceneGroups(groups, nodeIds);
  const key = refKey(child);
  const owner = normalized.find((group) =>
    group.children.some((ref) => refKey(ref) === key),
  );
  if (owner === undefined) return normalized;
  const grandparent = normalized.find((group) =>
    group.children.some((ref) => "group" in ref && ref.group === owner.id),
  );
  const detached = normalized.map((group) => ({
    ...group,
    children:
      group.id === owner.id
        ? group.children.filter((ref) => refKey(ref) !== key)
        : [...group.children],
  }));
  if (grandparent !== undefined) {
    const parent = detached.find((group) => group.id === grandparent.id);
    const remainingOwner = detached.find((group) => group.id === owner.id);
    if (parent !== undefined && remainingOwner !== undefined) {
      if (remainingOwner.children.length < 2) {
        const promoted = [...remainingOwner.children, child];
        parent.children = parent.children.flatMap((ref) =>
          "group" in ref && ref.group === owner.id ? promoted : [ref],
        );
        detached.splice(detached.indexOf(remainingOwner), 1);
      } else {
        parent.children = parent.children.flatMap((ref) =>
          "group" in ref && ref.group === owner.id ? [ref, child] : [ref],
        );
      }
    }
  }
  return repairSceneGroups(detached, nodeIds);
}

/**
 * Ctrl+L on a single group: dissolve only that layer.  Its children are
 * promoted into its former slot (or roots), so nested child groups and nodes
 * survive untouched.
 */
export function dissolveGroup(
  groups: readonly SceneGroup[],
  groupId: string,
  nodeIds: ReadonlySet<string>,
): SceneGroup[] {
  const normalized = normalizeSceneGroups(groups, nodeIds);
  const target = normalized.find((group) => group.id === groupId);
  if (target === undefined) return normalized;
  const promoted = normalized
    .filter((group) => group.id !== groupId)
    .map((group) => ({
      ...group,
      children: group.children.flatMap((ref) =>
        "group" in ref && ref.group === groupId ? target.children : [ref],
      ),
    }));
  return repairSceneGroups(promoted, nodeIds);
}

/**
 * Drop deleted node references from every group while keeping surviving
 * structure: a group left with one child is collapsed so its child (group or
 * node) is promoted instead of silently discarding a nested group.
 */
export function removeNodesFromGroups(
  groups: SceneGroupsInput | undefined | null,
  removed: ReadonlySet<string>,
  nodeIds: ReadonlySet<string>,
): SceneGroup[] {
  const stripped = parseSceneGroups(groups).map((group) => ({
    ...group,
    children: group.children.filter(
      (ref) => !("node" in ref) || !removed.has(ref.node),
    ),
  }));
  return repairSceneGroups(stripped, nodeIds);
}

/**
 * Rewrite every reference to a renamed node.  Group ids never change, so a
 * rename keeps group identity and nesting intact.
 */
export function renameNodeInGroups(
  groups: SceneGroupsInput | undefined | null,
  previousId: string,
  nextId: string,
  nodeIds: ReadonlySet<string>,
): SceneGroup[] {
  const renamed = parseSceneGroups(groups).map((group) => ({
    ...group,
    children: group.children.map((ref) =>
      "node" in ref && ref.node === previousId ? { node: nextId } : ref,
    ),
  }));
  return repairSceneGroups(renamed, nodeIds);
}
