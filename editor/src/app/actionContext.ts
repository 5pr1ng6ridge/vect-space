import { original } from "immer";

import type { EditorProject } from "../types";
import type { EditorRoute } from "./routes";

type CommitFn = (
  mutator: (draft: EditorProject) => unknown,
  history?: boolean,
  label?: string,
  mergeActive?: boolean,
) => void;

/**
 * What the editor's action factories (`createNodeActions`,
 * `createLibraryActions`) need from `App`: the project, the selection and
 * route, and the ways to change them.  Actions are plain closures over this
 * snapshot and are rebuilt on every render.
 */
export interface ActionContext {
  /** The project of the current render. */
  project: EditorProject;
  /**
   * The reducer's current project.  Newer than `project` when several
   * gestures are batched into one render, so mutations are planned from it.
   */
  latestProject(): EditorProject;
  activeSceneId: string;
  route: EditorRoute;
  commit: CommitFn;
  commitUndoable(
    mutation: (draft: EditorProject) => unknown,
    label: string,
    message: string,
  ): void;
  setError(message: string | null): void;
  setNotice(message: string | null): void;
  reportCommandError(reason: unknown): void;
  setActiveSceneId(sceneId: string): void;
  setSelectedNodeId(nodeId: string | null): void;
  setRoute(route: EditorRoute): void;
}

/**
 * Rename helpers intentionally return a complete project.  When they are used
 * from an Immer recipe, unwrap the proxy first so their defensive
 * structuredClone remains safe.  Immer's `original` is the state at the start
 * of this recipe; callers that need to include a just-made mutation must
 * apply that mutation to the unwrapped clone explicitly.
 */
export function currentPlainProject(draft: EditorProject): EditorProject {
  return original(draft) ?? draft;
}
