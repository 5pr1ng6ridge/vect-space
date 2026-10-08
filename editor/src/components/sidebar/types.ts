import type { VisualKind } from "../../app/visualLibrary";
import type { AssetKind, AssetInspection } from "../../types";

export interface VisualLibraryHandlers {
  /** `sceneId` files a new text block under that scene's group. */
  onCreate(kind: VisualKind, id: string, sceneId?: string): boolean;
  onRename(kind: VisualKind, previousId: string, nextId: string): boolean;
  onDuplicate(kind: VisualKind, id: string): void;
  onDelete(kind: VisualKind, id: string): void;
  /** `sceneId` is the scene whose group was clicked; 返回 lands on it. */
  onEdit(kind: VisualKind, id: string, sceneId?: string): void;
}

export type SidebarTab =
  | "scenes"
  | "assets"
  | "characters"
  | "variables"
  | "library"
  | "project"
  | "problems";

/** The project-settings slices the activity bar can show on their own. */
export type ProjectPanelView =
  "project" | "characters" | "variables" | "library";

/** A pending id-entry dialog of the project panel (add / rename flows). */
export interface ProjectDialogRequest {
  title: string;
  value: string;
  kind:
    | "character_add"
    | "character_rename"
    | "variable_add"
    | "variable_rename"
    | "action_add"
    | "action_rename"
    | "visual_add"
    | "visual_rename";
  previous?: string;
  visual?: VisualKind;
}

export interface AssetFolderChoice {
  id: string;
  path: string;
}

export interface ImportDraft {
  sourcePath: string;
  id: string;
  kind: AssetKind;
  fileName: string;
  inspectionId?: string;
  inspection?: AssetInspection;
  error?: string;
  /**
   * Set when this upload replaces the binary of an existing asset.  It always
   * equals `id`; the host keeps the logical id and references stable while
   * publishing the new file at a different path.
   */
  replaceId?: string;
}
