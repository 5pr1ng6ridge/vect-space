import type { VisualKind } from "./visualLibrary";

/** A text block / particle definition workspace. */
export interface VisualRoute {
  kind: "visual";
  visual: VisualKind;
  id: string;
  /**
   * The scene whose text group opened this workspace.  "返回" lands on it
   * even when another scene was active; absent for the shared / unassigned
   * groups and for particles, which return to whatever scene was active.
   */
  sceneId?: string;
}

/**
 * What the editor window is showing.  One value replaces the seven
 * independent "target" states that used to decide, by early-return order,
 * which full-screen workspace was active; routes are mutually exclusive by
 * construction.
 */
export type EditorRoute =
  | { kind: "story" }
  | { kind: "timeline"; sceneId: string; nodeId: string }
  | { kind: "longText"; sceneId: string; nodeId: string }
  | { kind: "map" }
  | { kind: "button"; id: string }
  | { kind: "uiMotion"; id: string }
  | { kind: "action"; id: string }
  | VisualRoute
  | {
      kind: "preview";
      sceneId: string;
      nodeId: string | null;
      /** Set by a node gesture to start immediately at that node. */
      autoStart?: "scene" | "node" | "reset_node";
      /** Where "返回" leads; the story shell when absent. */
      returnTo?: EditorRoute;
    };

export const STORY_ROUTE: EditorRoute = { kind: "story" };

/** True when `route` shows a node of `sceneId` whose id is in `nodeIds`. */
export function routeShowsNode(
  route: EditorRoute,
  sceneId: string,
  nodeIds: ReadonlySet<string>,
): boolean {
  return (
    (route.kind === "timeline" || route.kind === "longText") &&
    route.sceneId === sceneId &&
    nodeIds.has(route.nodeId)
  );
}

/** True when `route` shows anything that belongs to `sceneId`. */
export function routeShowsScene(route: EditorRoute, sceneId: string): boolean {
  return (
    (route.kind === "timeline" ||
      route.kind === "longText" ||
      route.kind === "preview") &&
    route.sceneId === sceneId
  );
}

/**
 * The scene "返回" should activate when leaving a visual workspace, or `null`
 * to keep the scene that was active.  A text opened from a scene's group
 * returns to that scene; if the scene disappeared (or none was recorded) the
 * current selection stays untouched.
 */
export function visualReturnScene(
  route: VisualRoute,
  sceneIds: readonly string[],
  activeSceneId: string,
): string | null {
  const origin = route.sceneId;
  if (origin === undefined || origin === activeSceneId) return null;
  return sceneIds.includes(origin) ? origin : null;
}
