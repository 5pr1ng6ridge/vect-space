export type AssetKind =
  "background" | "sprite" | "gui" | "bgm" | "sfx" | "font" | "video";

export type ScalarValue = boolean | number | string;
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
  path: string;
}

export interface ContentManifest {
  schema_version: number;
  content_version: string;
  entry_scene: string;
  default_locale: string;
  variables: Record<string, VariableDefinition>;
  characters: Record<string, CharacterDefinition>;
  assets: Record<string, AssetDefinition>;
  scenes: string[];
  ui_motions: string[];
  ui_motion_defaults: UiMotionBindings;
  story_flow?: string | null;
}

export type StoryFlowReveal =
  | { mode: "completed" }
  | { mode: "always" }
  | { mode: "condition"; condition: ConditionExpression };

export interface StoryFlowNode {
  title: string;
  x: number;
  y: number;
  reveal?: StoryFlowReveal;
}

export interface StoryFlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string | null;
}

export interface StoryFlowDefinition {
  schema_version: number;
  nodes: Record<string, StoryFlowNode>;
  edges: StoryFlowEdge[];
}

export interface StoryFlowFile {
  path: string;
  definition: StoryFlowDefinition;
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
}

export interface LongTextStep {
  id: string;
  text: string;
  page_break_before: boolean;
}

export interface LongTextNode extends NextNode {
  type: "long_text";
  paper?: string | null;
  steps: LongTextStep[];
  speed_cps: number | null;
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

export interface EndNode {
  type: "end";
}

export type SceneNode =
  | BackgroundNode
  | SpriteNode
  | ClearNode
  | SayNode
  | LongTextNode
  | ChoiceNode
  | SetNode
  | ConditionNode
  | PlaybackNode
  | JumpNode
  | WaitNode
  | BgmNode
  | SfxNode
  | CameraNode
  | ScreenEffectNode
  | DialogueUiNode
  | UiMotionSetNode
  | UiMotionPlayNode
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
  path: string;
  absolute_path: string;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface EditorDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  scene_id: string | null;
  node_id: string | null;
  workspace?: "story" | "flow";
  flow_element_id?: string | null;
}

export interface EditorProject {
  root: string;
  manifest: ContentManifest;
  scenes: EditorSceneFile[];
  ui_motions: UiMotionFile[];
  story_flow: StoryFlowFile | null;
  layout: EditorLayout;
  assets: EditorAsset[];
  diagnostics: EditorDiagnostic[];
  fingerprint: string;
}

export interface SaveProjectRequest {
  manifest: ContentManifest;
  scenes: EditorSceneFile[];
  ui_motions: UiMotionFile[];
  story_flow: StoryFlowFile | null;
  layout: EditorLayout;
  expected_fingerprint: string;
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
  opacity: number;
  z: number;
}

export interface TimelinePreviewRequest {
  project: SaveProjectRequest;
  target: StoryLocation;
  variable_overrides: Record<string, ScalarValue>;
  choices: PreviewChoiceDecision[];
}

export type TimelinePreviewResult =
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
    }
  | { status: "unreachable"; message: string; trace: StoryLocation[] };

export interface ImportedAsset {
  id: string;
  kind: AssetKind;
  path: string;
  absolute_path: string;
}
import type {
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";
