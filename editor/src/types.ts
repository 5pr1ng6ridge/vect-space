export type AssetKind =
  "background" | "sprite" | "gui" | "bgm" | "sfx" | "font" | "video";

import type { WireAssetInspection } from "../../shared/generated/WireAssetInspection";
import type { WireAssetMetadata } from "../../shared/generated/WireAssetMetadata";

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
export type AdvanceSource = "manual" | "auto" | "fast_forward" | "forced_auto";
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
  ui_motion_defaults: UiMotionBindings;
  chapter_map?: string | null;
}

export type ChapterMapReveal =
  | { mode: "completed" }
  | { mode: "always" }
  | { mode: "condition"; condition: ConditionExpression };
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
  transition: "cut" | "cross_fade";
  easing: Easing;
}

export interface SpriteNode extends AwaitedNode {
  type: "sprite";
  sprite_id: string;
  action: "show" | "move" | "hide";
  asset: string | null;
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

export interface ChoiceDefinition {
  id: string;
  label: string;
  next: string;
  visible_if?: ConditionExpression;
  enabled_if?: ConditionExpression;
}

export interface ChoiceNode {
  type: "choice";
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

export type TimelineTrack =
  | {
      type: "sprite";
      sprite_id: string;
      asset: string | null;
      remove_at_end: boolean;
      channels: TimelineChannels;
    }
  | { type: "camera"; channels: TimelineChannels }
  | { type: "button"; instance_id: string; channels: TimelineChannels }
  | {
      type: "video";
      asset: string;
      clip_start_ms: number;
      clip_end_ms?: number | null;
      loop: boolean;
      fit: "contain" | "cover" | "stretch";
      audio_enabled: boolean;
      channels: TimelineChannels;
    }
  | { type: "bgm"; channels: TimelineChannels };

export type TimelineEvent =
  | { type: "sfx"; id: string; at_ms: number; asset: string; volume: number }
  | {
      type: "screen_effect";
      id: string;
      at_ms: number;
      effect: "shake" | "flash";
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
  effect: "shake" | "flash";
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
  | SpriteNode
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
  | WaitNode
  | BgmNode
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

export interface SceneLayout {
  nodes: Record<string, NodePosition>;
  viewport: EditorViewport | null;
}

export interface EditorLayout {
  version: number;
  scenes: Record<string, SceneLayout>;
  timeline_previews?: Record<string, TimelinePreviewSettings>;
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

export interface SpriteSnapshot {
  asset: string;
  x: number;
  y: number;
  scale: number;
  scale_x: number;
  scale_y: number;
  rotation_deg: number;
  flip_x?: boolean;
  anchor_x?: number;
  anchor_y?: number;
  opacity: number;
  z: number;
}

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
    }
  | {
      status: "unreachable";
      message: string;
      trace: StoryLocation[];
    };

export interface ImportedAsset {
  id: string;
  kind: AssetKind;
  path: string;
  absolute_path: string;
  size_bytes: string;
  token?: string | null;
  /** Existing formal file reused by this new logical registration. */
  reused_from?: string | null;
}

export interface ImportAssetRequest {
  id: string;
  kind: AssetKind;
  file_name?: string;
  inspection_id?: string;
}
import type {
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";
