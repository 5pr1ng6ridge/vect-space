export type AssetKind =
  | "background"
  | "sprite"
  | "gui"
  | "bgm"
  | "ambience"
  | "sfx"
  | "font"
  | "video";

import type { CoordinateSpace, SpriteKind, SpriteLayout, SpriteSource, TextBlockDefinition, ParticleDefinition } from "@vectspace/presentation-core/types";
export type { CoordinateSpace, SpriteKind, SpriteLayout, SpriteSource, TextBlockDefinition, ParticleDefinition } from "@vectspace/presentation-core/types";

export interface TextBlockFile { path: string; definition: TextBlockDefinition }
export interface ParticleFile { path: string; definition: ParticleDefinition }

import type { WireAssetInspection } from "../../shared/generated/WireAssetInspection";
import type { WireAssetMetadata } from "../../shared/generated/WireAssetMetadata";

export type {
  BackgroundTransitionSpec,
  CurtainAction,
  CurtainFill,
  CurtainTransitionSpec,
  ScreenEffectSpec,
  TransitionDirection,
} from "@vectspace/presentation-core/types";
import type {
  BackgroundTransitionSpec,
  CurtainAction,
  CurtainFill,
  CurtainTransitionSpec,
  ScreenEffectSpec,
} from "@vectspace/presentation-core/types";

/** Host-verified metadata returned before an import is staged. */
export type AssetInspection = WireAssetInspection;
export type AssetMetadata = WireAssetMetadata;

/** Integer values use bigint when they do not fit in a safe JS number. */
export type ScalarValue = boolean | number | bigint | string;
export type VariableScope = "save" | "profile";
export type VariableType = "boolean" | "integer" | "number" | "string";
export type Easing = "linear" | "ease_in" | "ease_out" | "ease_in_out";
export type TimelineEasing =
  "step" | Easing | { cubic_bezier: [number, number, number, number] };
export interface TimelineKeyframe {
  at_ms: number;
  value: number | "inherit";
  easing: TimelineEasing;
}
export type TimelineChannels = Record<string, TimelineKeyframe[]>;
export type UiMotionTarget =
  | "dialogue_root"
  | "dialogue_frame"
  | "dialogue_nameplate"
  | "dialogue_text"
  | "dialogue_advance_indicator";
export interface UiMotionTrack {
  target: UiMotionTarget;
  channels: TimelineChannels;
}
export interface UiMotionPreset {
  schema_version: number;
  id: string;
  duration_ms: number;
  tracks: UiMotionTrack[];
}
export interface UiMotionFile {
  path: string;
  definition: UiMotionPreset;
}
export interface UiMotionBindings {
  dialogue_show?: string | null;
  dialogue_hide?: string | null;
}

export type ButtonAssetMode = "separate" | "overlay";
export type ButtonAssetFit = "contain" | "cover" | "stretch";
export type ButtonState = "normal" | "hover" | "pressed";
export interface ButtonAnimation {
  duration_ms: number;
  channels: TimelineChannels;
}
export interface ButtonAnimations {
  normal?: ButtonAnimation | null;
  hover?: ButtonAnimation | null;
  pressed?: ButtonAnimation | null;
}
export interface ButtonTemplate {
  schema_version: number;
  id: string;
  width: number;
  height: number;
  asset_mode: ButtonAssetMode;
  fit: ButtonAssetFit;
  normal?: string | null;
  hover?: string | null;
  pressed?: string | null;
  animations: ButtonAnimations;
}
export interface ButtonFile {
  path: string;
  definition: ButtonTemplate;
}
export interface ButtonSetAction {
  variable: string;
  op?: VariableOperation;
  value?: MutationValue;
}
export type ButtonPostAction =
  | { type: "advance" }
  | { type: "jump"; scene?: string | null; target: string }
  | { type: "open_panel"; panel: "saves" | "settings" | "history" };
export interface ButtonClickAction {
  sets: ButtonSetAction[];
  next?: ButtonPostAction | null;
}
export type AdvanceSource =
  "manual" | "auto" | "fast_forward" | "forced_auto" | "script";
export type NodeType = SceneNode["type"];

export interface VariableDefinition {
  scope: VariableScope;
  type: VariableType;
  default: ScalarValue;
}

export interface CharacterDefinition {
  display_name: string;
  name_color?: string | null;
  text_color?: string | null;
  expressions?: Record<string, CharacterExpression>;
  default_expression?: string | null;
  default_scale?: number;
}

export interface CharacterExpression {
  asset: string;
  anchor_x?: number;
  anchor_y?: number;
  offset_x?: number;
  offset_y?: number;
  scale?: number;
}

export type VariableOperation =
  "assign" | "add" | "sub" | "mul" | "mod" | "append" | "toggle";

export type MutationValue = ScalarValue | { variable: string };

export type ValueOperand = { variable: string } | { value: ScalarValue };

export type ConditionExpression =
  | {
      op: "eq" | "ne" | "lt" | "le" | "gt" | "ge";
      left: ValueOperand;
      right: ValueOperand;
    }
  | { op: "and" | "or"; conditions: ConditionExpression[] }
  | { op: "not"; condition: ConditionExpression };

export interface AssetDefinition {
  kind: AssetKind;
  /** Static image path; mutually exclusive with `animation`. */
  path?: string;
  /** Loop animation document id; mutually exclusive with `path`. */
  animation?: string;
}

/** One ordered frame of a standalone image animation document. */
export interface AnimationFrame {
  /** Logical id of a static image asset. */
  asset: string;
  duration_ms: number;
}

/** Standalone image animation document (schema v1). */
export interface ImageAnimationDefinition {
  schema_version: number;
  id: string;
  frames: AnimationFrame[];
}

/** An animation document keyed by the manifest path that lists it. */
export interface AnimationFile {
  path: string;
  definition: ImageAnimationDefinition;
}

export type SpriteActionEnd = "hold" | "restore";
export interface SpriteActionKeyframe {
  at_ms: number;
  value: number;
  easing?: TimelineEasing;
  parameter?: string | null;
}
export interface SpriteActionParameter {
  default: number;
  min?: number | null;
  max?: number | null;
}
export interface SpriteActionDefinition {
  schema_version: number;
  id: string;
  name: string;
  duration_ms: number;
  channels: Record<string, SpriteActionKeyframe[]>;
  parameters?: Record<string, SpriteActionParameter>;
  end?: SpriteActionEnd;
}
export interface ActionFile {
  path: string;
  definition: SpriteActionDefinition;
}

export interface ContentManifest {
  schema_version: number;
  content_version: string;
  entry_scene: string;
  default_locale: string;
  default_font?: string | null;
  variables: Record<string, VariableDefinition>;
  characters: Record<string, CharacterDefinition>;
  assets: Record<string, AssetDefinition>;
  scenes: string[];
  ui_motions: string[];
  buttons?: string[];
  animations?: string[];
  actions?: string[];
  text_blocks?: string[];
  particles?: string[];
  ui_motion_defaults: UiMotionBindings;
  chapter_map?: string | null;
}

export type ChapterMapReveal =
  | { mode: "completed" }
  | { mode: "always" }
  | { mode: "condition"; condition: ConditionExpression };
/** Replay policy: `always` lets a hotspot be entered before the story reaches it. */
export type ChapterMapReplay = { mode: "completed" } | { mode: "always" };
export interface ChapterMapDecoration {
  id: string;
  asset: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}
export interface ChapterMapHotspot {
  id: string;
  scene_id: string;
  title: string;
  hover_text?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  asset?: string | null;
  reveal?: ChapterMapReveal;
  replay?: ChapterMapReplay;
  variable_overrides: Record<string, ScalarValue>;
}
export interface ChapterMapDefinition {
  schema_version: number;
  width: number;
  height: number;
  view_x: number;
  view_y: number;
  background?: string | null;
  decorations: ChapterMapDecoration[];
  hotspots: ChapterMapHotspot[];
}
export interface ChapterMapFile {
  path: string;
  definition: ChapterMapDefinition;
}

interface NextNode {
  next: string;
}

interface AwaitedNode extends NextNode {
  duration_ms: number;
  await: boolean;
}

export interface BackgroundNode extends AwaitedNode {
  type: "background";
  background: string | null;
  /** Canonical transition normalised by the Rust loader. */
  transition: BackgroundTransitionSpec;
  easing: Easing;
}

/**
 * Persistent curtain layer above the world and below screen effects.
 *
 * `cover` draws the authored fill; `reveal` hides whatever the current
 * curtain shows.  Only the stable cover/fill are saved in the snapshot, so
 * `fill` is authored on `cover` nodes and must stay absent on `reveal`.
 */
export interface CurtainNode extends AwaitedNode {
  type: "curtain";
  action: CurtainAction;
  fill?: CurtainFill | null;
  transition: CurtainTransitionSpec;
  easing: Easing;
}

export interface SpriteNode extends AwaitedNode {
  type: "sprite";
  sprite_id: string;
  action: "show" | "move" | "hide";
  source?: SpriteSource;
  sprite_kind?: SpriteKind;
  space?: CoordinateSpace;
  layout?: SpriteLayout;
  scale_x?: number | null;
  scale_y?: number | null;
  rotation_deg?: number | null;
  anchor_x?: number | null;
  anchor_y?: number | null;
  /**
   * Optional in YAML when a character/expression supplies the artwork. Rust
   * omits null optionals while serializing, so the editor must accept both
   * null and an absent field after loading a scene.
   */
  asset?: string | null;
  character?: string | null;
  expression?: string | null;
  flip_x?: boolean;
  crossfade_ms?: number | null;
  x: number | null;
  y: number | null;
  scale: number | null;
  opacity: number | null;
  z: number | null;
  easing: Easing;
}

export interface ParticleNode extends NextNode {
  type: "particle";
  emitter_id: string;
  action: "start" | "stop" | "burst";
  particle?: string | null;
  seed?: number | null;
  space: CoordinateSpace;
  x: number;
  y: number;
  scale: number;
  rotation_deg: number;
  opacity: number;
  z: number;
}

/** Fade all scene-owned visual content to an empty world. */
export interface ClearNode extends AwaitedNode {
  type: "clear";
  easing: Easing;
}

export interface SayNode extends NextNode {
  type: "say";
  speaker: string | null;
  text: string;
  mode?: "start" | "append";
  page_id?: string | null;
  speed_cps: number | null;
  reveal_animation?: "line_sweep" | "typewriter" | "drop_fade" | null;
}

export interface LongTextStep {
  id: string;
  text: string;
  page_break_before: boolean;
}

export type LongTextMode = "start" | "continue";
export type LongTextExit = "close" | "hide" | "keep_visible";

export interface LongTextNode extends NextNode {
  type: "long_text";
  document?: string | null;
  mode?: LongTextMode;
  on_exit?: LongTextExit;
  paper?: string | null;
  pagination?: "continuous" | "auto" | "manual";
  font_size?: number;
  text_color?: string;
  layout?: LongTextLayout;
  steps: LongTextStep[];
  speed_cps: number | null;
  reveal_animation?: "line_sweep" | "typewriter" | "drop_fade" | null;
}

export interface LongTextControlNode extends NextNode {
  type: "long_text_control";
  document: string;
  action: "show" | "hide" | "close";
}

export interface LongTextLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  padding_x: number;
  padding_y: number;
  page_height: number;
  page_gap: number;
}

export type ChoiceFlowDirection = "vertical" | "horizontal";

/**
 * Optional template-driven presentation for a `choice` node.
 *
 * Field names and defaults mirror the Rust `ChoicePresentation`; a node that
 * never opts in keeps the shipped CSS panel placement and resolves to `null`.
 * Anchor coordinates are design pixels in the fixed 1920x1080 stage.
 */
export interface ChoicePresentation {
  template: string | null;
  anchor_x: number;
  anchor_y: number;
  direction: ChoiceFlowDirection;
  gap: number;
  button_width: number | null;
  button_height: number | null;
}

export interface ChoiceDefinition {
  id: string;
  label: string;
  next: string;
  visible_if?: ConditionExpression;
  enabled_if?: ConditionExpression;
  /** Optional reusable button template that beats the node default. */
  template?: string | null;
  /** Optional `gui` asset shown next to the label. */
  icon?: string | null;
}

export interface ChoiceNode {
  type: "choice";
  /** Absent/null keeps the legacy CSS placement. */
  presentation?: ChoicePresentation | null;
  choices: ChoiceDefinition[];
}

export interface SetNode extends NextNode {
  type: "set";
  variable: string;
  op?: VariableOperation;
  value?: MutationValue;
}

export interface ConditionNode {
  type: "condition";
  condition: ConditionExpression;
  then: string;
  otherwise: string;
}

export interface PlaybackNode extends NextNode {
  type: "playback";
  auto: "normal" | "forced";
  ctrl_fast_forward: "allow" | "block";
}

export interface ActionNode extends NextNode {
  type: "action";
  sprite_id: string;
  action: string;
  duration_ms?: number | null;
  await: boolean;
  parameters?: Record<string, number>;
  end?: SpriteActionEnd | null;
}

export interface JumpNode {
  type: "jump";
  scene: string | null;
  target: string;
}

/**
 * Ask the game host to show another Scene in the single secondary window.
 * Non-blocking: the story continues to `next` in the same Scene, and only the
 * main window's story runtime can act on the request.
 */
export interface OpenWindowNode extends NextNode {
  type: "open_window";
  scene: string;
}

/** Which native window a Scene is written for.  Missing means `main`. */
export type WindowRole = "main" | "secondary";

/**
 * Set the native title of an existing window.  The title is evaluated once and
 * stored; `[var=window.main.title]` / `[var=window.secondary.title]` read it.
 */
export interface WindowTitleNode extends NextNode {
  type: "window_title";
  target: WindowRole;
  title: string;
}

export type WindowControlAction = "block" | "unblock" | "advance";

/**
 * Block, unblock or script-advance the page turning of a window.  A block is
 * owned by the Scene that created it and is released by an `unblock` with the
 * same id, or automatically when that Scene exits.
 */
export interface WindowControlNode extends NextNode {
  type: "window_control";
  target: WindowRole;
  action: WindowControlAction;
  id?: string;
  message?: string;
}

/** What a window placement is measured against. */
export type WindowReference = "work_area" | "window" | "current";

/**
 * Puts the window's anchor point (fractions of its frame) on a point of the
 * reference rect (fractions of that rect), plus a logical-pixel offset.
 * Missing `relative_to` means `work_area`; missing offsets mean 0.
 */
export interface WindowPlacement {
  relative_to?: WindowReference;
  x: number;
  y: number;
  anchor_x: number;
  anchor_y: number;
  offset_x?: number;
  offset_y?: number;
}

export type WindowSizeUnit = "logical" | "work_area";

/** Missing `unit` means `logical` (client-area logical pixels). */
export interface WindowSize {
  unit?: WindowSizeUnit;
  width: number;
  height: number;
}

/**
 * Move and/or resize a game window, optionally animated.  At least one of
 * `position` and `size` is required.  The window never leaves the monitor and
 * keeps its minimum size; it is skipped while fullscreen or maximized.
 */
export interface WindowGeometryNode extends NextNode {
  type: "window_geometry";
  target: WindowRole;
  position?: WindowPlacement | null;
  size?: WindowSize | null;
  /** 0 snaps instantly. */
  duration_ms: number;
  easing: Easing;
  /** Wait for the animation (only meaningful when `duration_ms` > 0). */
  await: boolean;
}

export type WindowLayerAction = "raise" | "focus" | "top" | "bottom" | "normal";

/** Restack a window.  `raise` does not take keyboard focus, `focus` does. */
export interface WindowLayerNode extends NextNode {
  type: "window_layer";
  target: WindowRole;
  action: WindowLayerAction;
}

export type TimerAction = "start" | "stop";

/**
 * Scene timer.  `target` names an effect node of the same Scene that runs
 * (without following its own `next`) when the timer fires; the timer's own
 * `next` is the story continuation.
 */
export interface TimerNode extends NextNode {
  type: "timer";
  id: string;
  action: TimerAction;
  delay_ms?: number;
  interval_ms?: number | null;
  target?: string | null;
}

export interface WaitNode extends NextNode {
  type: "wait";
  duration_ms: number;
}

export interface BgmNode extends AwaitedNode {
  type: "bgm";
  action: "start" | "stop";
  asset: string | null;
  volume: number;
  start_ms?: number;
  loop_start_ms?: number | null;
  loop_end_ms?: number | null;
}

export type AmbienceSlot = "slot_1" | "slot_2" | "slot_3" | "slot_4";

export interface AmbienceNode extends AwaitedNode {
  type: "ambience";
  slot: AmbienceSlot;
  action: "start" | "stop";
  asset?: string | null;
  volume: number;
  start_ms?: number;
  loop_start_ms?: number | null;
  loop_end_ms?: number | null;
}

export type TimelineTrack = import("@vectspace/presentation-core/types").TimelineTrack;

export type TimelineEvent =
  | { type: "sfx"; id: string; at_ms: number; asset: string; volume: number }
  | {
      type: "screen_effect";
      id: string;
      at_ms: number;
      effect: ScreenEffectSpec;
      duration_ms: number;
    };

export interface TimelineNode extends NextNode {
  type: "timeline";
  duration_ms: number;
  await: boolean;
  skippable: boolean;
  tracks: TimelineTrack[];
  events: TimelineEvent[];
}

export interface SfxNode extends NextNode {
  type: "sfx";
  asset: string;
  volume: number;
}

export interface CameraNode extends AwaitedNode {
  type: "camera";
  x: number;
  y: number;
  zoom: number;
  easing: Easing;
}

export interface ScreenEffectNode extends AwaitedNode {
  type: "screen_effect";
  /** Canonical parameterised effect normalised by the Rust loader. */
  effect: ScreenEffectSpec;
}

export interface DialogueUiNode extends NextNode {
  type: "dialogue_ui";
  visible: boolean;
  motion: string | null;
  duration_ms: number | null;
  await: boolean;
}

export interface UiMotionSetNode extends NextNode {
  type: "ui_motion_set";
  slot: "dialogue_show" | "dialogue_hide";
  motion: string | null;
}

export interface UiMotionPlayNode extends NextNode {
  type: "ui_motion_play";
  motion: string;
  duration_ms: number | null;
  await: boolean;
}

export interface ButtonCreateNode extends NextNode {
  type: "button_create";
  instance_id: string;
  template: string;
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  rotation_deg?: number | null;
  scale_x?: number | null;
  scale_y?: number | null;
  opacity?: number | null;
  z?: number | null;
  visible: boolean;
  enabled: boolean;
  action: ButtonClickAction;
}
export interface ButtonUpdateNode extends NextNode {
  type: "button_update";
  instance_id: string;
  template?: string | null;
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
  rotation_deg?: number | null;
  scale_x?: number | null;
  scale_y?: number | null;
  opacity?: number | null;
  z?: number | null;
  visible?: boolean | null;
  enabled?: boolean | null;
  action?: ButtonClickAction | null;
}
export interface ButtonRemoveNode extends NextNode {
  type: "button_remove";
  instance_id: string;
}

export interface EndNode {
  type: "end";
}

export type SceneNode =
  | BackgroundNode
  | CurtainNode
  | SpriteNode
  | ParticleNode
  | ClearNode
  | SayNode
  | LongTextNode
  | LongTextControlNode
  | ChoiceNode
  | SetNode
  | ConditionNode
  | PlaybackNode
  | ActionNode
  | JumpNode
  | OpenWindowNode
  | WindowTitleNode
  | WindowControlNode
  | WindowGeometryNode
  | WindowLayerNode
  | TimerNode
  | WaitNode
  | BgmNode
  | AmbienceNode
  | SfxNode
  | CameraNode
  | ScreenEffectNode
  | DialogueUiNode
  | UiMotionSetNode
  | UiMotionPlayNode
  | ButtonCreateNode
  | ButtonUpdateNode
  | ButtonRemoveNode
  | TimelineNode
  | EndNode;

export interface SceneDefinition {
  /** Window this Scene is written for; absent means `main`. */
  window_role?: WindowRole;
  schema_version: number;
  id: string;
  entry: string;
  nodes: Record<string, SceneNode>;
}

export interface EditorSceneFile {
  path: string;
  definition: SceneDefinition;
}

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

export type SpriteSnapshot = import("@vectspace/presentation-core/types").SpriteSnapshot;

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
import type {
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";
