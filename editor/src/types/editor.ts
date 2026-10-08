import type {
  TextBlockDefinition,
  ParticleDefinition,
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";
import type {
  ActionFile,
  AnimationFile,
  AssetKind,
  AssetMetadata,
  ButtonFile,
  ChapterMapFile,
  ContentManifest,
  ParticleFile,
  ScalarValue,
  TextBlockFile,
  UiMotionFile,
} from "./content";
import type { EditorSceneFile } from "./nodes";

export interface NodePosition {
  x: number;
  y: number;
}

export interface EditorViewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * One persisted group member: a scene node or a nested child group.  Explicitly
 * tagged so a nested forest can be stored without relying on member order.
 */
export type GroupChildRef = { node: string } | { group: string };

/**
 * One editor-only rigid group.  `id` is a stable identity independent of node
 * names, so renaming a node never reassigns a group and nesting never has to
 * re-create a parent.  Ownership lives in `children` only.
 */
export interface SceneGroup {
  id: string;
  children: GroupChildRef[];
}

export interface SceneLayout {
  nodes: Record<string, NodePosition>;
  viewport: EditorViewport | null;
  /** Rigid node clusters used only by the editor's automatic graph layout. */
  groups?: SceneGroup[];
  /**
   * Fixed text block ids the author filed under this scene before any Sprite
   * uses them.  Editor-only: the runtime registry and text YAML never see it.
   * The sidebar shows the union of these pins and the scene's real Sprite /
   * timeline references (see `textBlockGroups`); the field is omitted rather
   * than saved empty.
   */
  text_block_ids?: string[];
}

export interface EditorLayout {
  version: number;
  scenes: Record<string, SceneLayout>;
  timeline_previews?: Record<string, TimelinePreviewSettings>;
  /**
   * Editor-only virtual asset folders keyed by a stable folder id.  Never
   * written to the manifest; no asset file is ever moved by a folder edit.
   */
  asset_folders?: Record<string, AssetFolderLayout>;
  /**
   * Editor-only metadata keyed by the stable manifest asset id.  A missing or
   * removed asset leaves its entry harmless instead of failing the layout.
   */
  asset_metadata?: Record<string, AssetLayoutMetadata>;
}

/** One editor-only virtual folder.  `parent_id: null` is a root folder. */
export interface AssetFolderLayout {
  parent_id: string | null;
  name: string;
  /** Deterministic sibling order; ties fall back to the folder id. */
  order: number;
}

/** Editor-only metadata for one existing asset id. */
export interface AssetLayoutMetadata {
  folder_id?: string | null;
  display_name?: string | null;
  hidden?: boolean;
}

export interface TimelinePreviewSettings {
  variable_overrides: Record<string, ScalarValue>;
  choices: PreviewChoiceDecision[];
}

export interface PreviewChoiceDecision {
  scene_id: string;
  node_id: string;
  visit: number;
  choice_id: string;
}

export interface EditorAsset {
  id: string;
  kind: AssetKind;
  /** Static image path.  Animated assets carry `animation` instead. */
  path?: string;
  /** Loop animation document id, present for animated assets. */
  animation?: string;
  /** For animated assets this is the first frame, so every host shows pixels. */
  absolute_path: string;
  /** WireU64 string; formatting may safely down-convert for display only. */
  size_bytes?: string;
  /** Host-inspected media metadata; old projects may omit it. */
  metadata?: AssetMetadata | null;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface EditorDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  scene_id: string | null;
  node_id: string | null;
  workspace?: "story" | "map";
  flow_element_id?: string | null;
}

export interface EditorProject {
  root: string;
  manifest: ContentManifest;
  scenes: EditorSceneFile[];
  ui_motions: UiMotionFile[];
  buttons?: ButtonFile[];
  animations?: AnimationFile[];
  actions?: ActionFile[];
  text_blocks?: TextBlockFile[];
  particles?: ParticleFile[];
  chapter_map?: ChapterMapFile | null;
  layout: EditorLayout;
  assets: EditorAsset[];
  diagnostics: EditorDiagnostic[];
  fingerprint: string;
}

export interface SaveProjectRequest {
  manifest: ContentManifest;
  scenes: EditorSceneFile[];
  ui_motions: UiMotionFile[];
  buttons?: ButtonFile[];
  animations?: AnimationFile[];
  actions?: ActionFile[];
  text_blocks?: TextBlockFile[];
  particles?: ParticleFile[];
  chapter_map: ChapterMapFile | null;
  layout: EditorLayout;
  expected_fingerprint: string;
  /** Opaque host-issued handles for binaries staged by the import dialog. */
  import_tokens?: string[];
}

export interface SaveProjectResult {
  project: EditorProject;
  changed_paths: string[];
  deleted_paths: string[];
  warnings: EditorDiagnostic[];
  transaction_id: string | null;
}

export interface StoryLocation {
  scene_id: string;
  node_id: string;
}

export type SpriteSnapshot =
  import("@vectspace/presentation-core/types").SpriteSnapshot;

export interface BuildNodePreviewRequest {
  project: SaveProjectRequest;
  target: StoryLocation;
  variable_overrides: Record<string, ScalarValue>;
  choices: PreviewChoiceDecision[];
}

export type BuildNodePreviewResult =
  | {
      status: "needs_choice";
      location: StoryLocation;
      visit: number;
      choices: { id: string; label: string; enabled: boolean }[];
      trace: StoryLocation[];
    }
  | {
      status: "ready";
      start_snapshot: RuntimeSnapshot;
      update: RuntimeUpdate;
      trace: StoryLocation[];
      resolved_texts?: Record<string, string>;
      assets?: PreviewResolvedAsset[];
      text_blocks?: Record<string, TextBlockDefinition>;
      particles?: Record<string, ParticleDefinition>;
      font_versions?: Record<string, string>;
    }
  | {
      status: "unreachable";
      message: string;
      trace: StoryLocation[];
    };

/** A resolved asset as returned by the live gameplay preview session. */
export interface PreviewResolvedAsset {
  id: string;
  kind: string;
  absolute_path: string;
  animation?: {
    id: string;
    width: number;
    height: number;
    total_duration_ms: number;
    frames: { asset: string; duration_ms: number; absolute_path: string }[];
  } | null;
}

export type PreviewStartMode = "scene" | "node" | "reset_node";

export interface PreviewSessionStartRequest {
  project: SaveProjectRequest;
  mode: PreviewStartMode;
  scene_id: string;
  node_id?: string;
  variable_overrides: Record<string, ScalarValue>;
  choices: PreviewChoiceDecision[];
}

export type PreviewSessionStartResult =
  | {
      status: "needs_choice";
      location: StoryLocation;
      visit: number;
      choices: { id: string; label: string; enabled: boolean }[];
      trace: StoryLocation[];
    }
  | {
      status: "started";
      session_id: string;
      update: RuntimeUpdate;
      assets: PreviewResolvedAsset[];
      text_blocks?: Record<string, TextBlockDefinition>;
      particles?: Record<string, ParticleDefinition>;
      font_versions?: Record<string, string>;
      /** What a single-window preview could not do; absent in old fixtures. */
      notes?: string[];
    }
  | {
      status: "unreachable";
      message: string;
      trace: StoryLocation[];
    };

/** Answer of one preview timer tick (see `preview_session_tick`). */
export interface PreviewSessionTickResult {
  /** `effect` updates, then story/refresh updates, in presentation order. */
  updates: RuntimeUpdate[];
  notes: string[];
  /** Timers the runtime stopped because their effect failed. */
  diagnostics: string[];
}

export interface ImportedAsset {
  id: string;
  kind: AssetKind;
  path: string;
  absolute_path: string;
  size_bytes: string;
  token?: string | null;
  /** Existing formal file reused by this new logical registration. */
  reused_from?: string | null;
  /**
   * Relative path of the previous binary when this record replaces an
   * existing asset.  The old file stays on disk as an unregistered recovery
   * copy and is never overwritten or deleted by the save transaction.
   */
  replaced_from?: string | null;
}

export interface ImportAssetRequest {
  id: string;
  kind: AssetKind;
  file_name?: string;
  inspection_id?: string;
  /**
   * Present when this upload replaces the binary of an existing asset.  Must
   * equal `id`; the host keeps the logical id and reference set stable while
   * publishing the new file at a different path.
   */
  replace_id?: string | null;
}
