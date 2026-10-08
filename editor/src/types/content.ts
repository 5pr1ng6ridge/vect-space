import type {
  TextBlockDefinition,
  ParticleDefinition,
} from "@vectspace/presentation-core/types";
import type { WireAssetInspection } from "../../../shared/generated/WireAssetInspection";
import type { WireAssetMetadata } from "../../../shared/generated/WireAssetMetadata";

export type AssetKind =
  | "background"
  | "sprite"
  | "gui"
  | "bgm"
  | "ambience"
  | "sfx"
  | "font"
  | "video";

export interface TextBlockFile {
  path: string;
  definition: TextBlockDefinition;
}

export interface ParticleFile {
  path: string;
  definition: ParticleDefinition;
}

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
