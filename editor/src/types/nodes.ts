import type {
  CoordinateSpace,
  SpriteKind,
  SpriteLayout,
  SpriteSource,
  BackgroundTransitionSpec,
  CurtainAction,
  CurtainFill,
  CurtainTransitionSpec,
  ScreenEffectSpec,
} from "@vectspace/presentation-core/types";
import type {
  ButtonClickAction,
  ConditionExpression,
  Easing,
  MutationValue,
  SpriteActionEnd,
  VariableOperation,
} from "./content";

export type NodeType = SceneNode["type"];

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

export interface ProofNode extends NextNode {
  type: "proof";
  puzzle: string;
  abandon?: string | null;
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

export type TimelineTrack =
  import("@vectspace/presentation-core/types").TimelineTrack;

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
  | ProofNode
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
