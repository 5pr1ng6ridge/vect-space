export type AssetKind =
  | "background"
  | "sprite"
  | "gui"
  | "bgm"
  | "ambience"
  | "sfx"
  | "font"
  | "video";
export type CueGate = "none" | "player_advance" | "runtime";
export type Easing = "linear" | "ease_in" | "ease_out" | "ease_in_out";
export type AdvanceSource = "manual" | "auto" | "fast_forward" | "forced_auto";
export type SkipMode = "disabled" | "read_only" | "all";
export type TextRevealAnimation = "line_sweep" | "typewriter" | "drop_fade";
export type PresentationOutcome = "completed" | "skipped" | "failed";
export type SessionMode = WireSessionMode;

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

export type ButtonAssetMode = "separate" | "overlay";
export type ButtonAssetFit = "contain" | "cover" | "stretch";
export type ButtonState = "normal" | "hover" | "pressed";
export type ButtonPanel = "saves" | "settings" | "history";

export interface ButtonAnimation {
  duration_ms: number;
  channels: TimelineChannels;
}

export interface ButtonAnimations {
  normal?: ButtonAnimation | null;
  hover?: ButtonAnimation | null;
  pressed?: ButtonAnimation | null;
}

export interface ButtonSnapshot {
  id: string;
  template: string;
  asset_mode: ButtonAssetMode;
  fit: ButtonAssetFit;
  normal?: string | null;
  hover?: string | null;
  pressed?: string | null;
  animations: ButtonAnimations;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation_deg: number;
  scale_x: number;
  scale_y: number;
  opacity: number;
  z: number;
  visible: boolean;
  enabled: boolean;
  action: ButtonClickAction;
}

export interface ButtonTimelineBase {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation_deg: number;
  scale_x: number;
  scale_y: number;
  opacity: number;
  z: number;
}

export interface ButtonSetAction {
  variable: string;
  op: "assign" | "add" | "sub" | "mul" | "mod" | "append" | "toggle";
  value?: boolean | number | bigint | string | { variable: string } | null;
}

export type ButtonPostAction =
  | { type: "advance" }
  | { type: "jump"; scene?: string | null; target: string }
  | { type: "open_panel"; panel: ButtonPanel };

export interface ButtonClickAction {
  sets: ButtonSetAction[];
  next?: ButtonPostAction | null;
}

export interface CameraSnapshot {
  x: number;
  y: number;
  zoom: number;
  rotation_deg: number;
}

export interface WorldSnapshot {
  background: string | null;
  sprites: Record<string, SpriteSnapshot>;
  buttons?: Record<string, ButtonSnapshot>;
  camera: CameraSnapshot;
  dialogue_ui_visible: boolean;
  ui_motion_bindings: UiMotionBindings;
  persistent_effects: string[];
  /** Stable curtain state; absent only in pre-curtain fixtures. */
  curtain?: CurtainSnapshot | null;
}

export type TransitionDirection =
  "left_to_right" | "right_to_left" | "top_to_bottom" | "bottom_to_top";

export type BackgroundTransitionSpec =
  | { type: "cut" }
  | { type: "cross_fade" }
  | { type: "fade_through_color"; color: string }
  | { type: "wipe"; direction: TransitionDirection; softness: number }
  | { type: "push"; direction: TransitionDirection; softness: number };

/** Canonical, parameterised screen effect shared by nodes and timeline events. */
export type ScreenEffectSpec =
  | { type: "flash"; color: string; peak_alpha: number }
  | {
      type: "shake";
      amplitude_x: number;
      amplitude_y: number;
      frequency_hz: number;
      decay: number;
      /** JavaScript-safe integer (mirrors the Rust `u32` seed). */
      seed: number;
    };

export type CurtainAction = "cover" | "reveal";

/** Curtain fill: a solid colour or a `gui` asset reference. */
export type CurtainFill = { color: string } | { asset: string };

/** Open/close animation of a curtain; parameters live only in the cue. */
export type CurtainTransitionSpec =
  | { type: "fade" }
  | { type: "wipe"; direction: TransitionDirection }
  | { type: "split_horizontal" }
  | { type: "split_vertical" };

/** Persisted curtain: the stable cover/fill, never the transition params. */
export interface CurtainSnapshot {
  covered: boolean;
  fill?: CurtainFill | null;
}

export interface UiMotionBindings {
  dialogue_show?: string | null;
  dialogue_hide?: string | null;
}

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

import type {
  WireAmbienceSnapshot,
  WireAudioSnapshot,
  WireLoopingAudioSnapshot,
} from "../../../shared/generated";

export type {
  WireAmbienceSnapshot,
  WireAudioSnapshot,
  WireLoopingAudioSnapshot,
} from "../../../shared/generated";

/** Audio snapshots are the generated Rust-owned IPC contract, not a parallel TS shape. */
export type LoopingAudioSnapshot = WireLoopingAudioSnapshot;
export type AmbienceSnapshot = WireAmbienceSnapshot;
export type AudioSnapshot = WireAudioSnapshot;

export type AmbienceSlot = "slot_1" | "slot_2" | "slot_3" | "slot_4";

export interface PlaybackSnapshot {
  auto: "normal" | "forced";
  ctrl_fast_forward: "allow" | "block";
}

export interface EmptyPrompt {
  kind: "none";
}

export interface DialoguePrompt {
  kind: "dialogue";
  prompt_id: string;
  speaker: string | null;
  speaker_id?: string | null;
  name_color?: string | null;
  text_color?: string | null;
  text: string;
  is_read: boolean;
}

export interface DialoguePageSnapshot {
  page_id: string;
  speaker: string | null;
  speaker_id?: string | null;
  name_color?: string | null;
  text_color?: string | null;
  segments: string[];
}

export interface LongTextStepSnapshot {
  step_id: string;
  text: string;
  page_break_before: boolean;
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

export interface LongTextPageSnapshot {
  document_id: string;
  visible?: boolean;
  paper?: string | null;
  pagination: "continuous" | "auto" | "manual";
  font_size: number;
  text_color: string;
  layout: LongTextLayout;
  steps: LongTextStepSnapshot[];
  active_step_index: number;
}

export interface LongTextPrompt {
  kind: "long_text";
  prompt_id: string;
  document_id: string;
  step_id: string;
  step_index: number;
  text: string;
  is_read: boolean;
}

export interface ChoiceSnapshot {
  id: string;
  label: string;
  enabled: boolean;
  /** Resolved gui asset id; absent when none was authored or resolved. */
  icon?: string | null;
  /** Resolved skin; `fallback` renders the built-in CSS choice button. */
  template: ChoiceTemplateSnapshot;
  /** Effective item rect in design pixels of the fixed 1920x1080 space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Direction of the resolved choice button flow around the anchor. */
export type ChoiceFlowDirection = "vertical" | "horizontal";

/**
 * Resolved choice flow in the fixed 1920x1080 design space.
 *
 * `x`/`y`/`width`/`height` bound the whole visible group; each item carries
 * its own rect on {@link ChoiceSnapshot}.  `anchor_x`/`anchor_y` are the
 * effective group centre in design pixels (never normalized fractions): an
 * explicitly presented node uses its authored anchor (`0..=1920` and
 * `0..=1080`), while a node without `presentation` reports the centre
 * equivalent to the shipped `left: 470px; top: 360px` CSS panel placement.
 */
export interface ChoiceLayoutSnapshot {
  stage_width: number;
  stage_height: number;
  anchor_x: number;
  anchor_y: number;
  direction: ChoiceFlowDirection;
  gap: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Resolved template identity for one choice item.  `fallback` renders the
 * built-in CSS button; `button` reuses the canonical button skin model, so
 * choice skins stay in sync with story buttons.
 */
export type ChoiceTemplateSnapshot =
  { kind: "fallback" } | { kind: "button"; button: ButtonSnapshot };

export type ChoiceDiagnosticCode =
  | "missing_template"
  | "missing_icon"
  | "invalid_icon_kind"
  | "invalid_dimension"
  | "invalid_gap"
  | "invalid_anchor";

/**
 * A non-fatal presentation problem.  The runtime always falls back to a
 * documented default, so a diagnostic never blocks the prompt.
 */
export interface ChoiceDiagnostic {
  code: ChoiceDiagnosticCode;
  message: string;
  scene_id: string;
  node_id: string;
  choice_id?: string | null;
}

export interface ChoicePrompt {
  kind: "choice";
  prompt_id: string;
  layout: ChoiceLayoutSnapshot;
  diagnostics: ChoiceDiagnostic[];
  choices: ChoiceSnapshot[];
}

export interface EndPrompt {
  kind: "end";
  prompt_id: string;
}

export type PromptSnapshot =
  EmptyPrompt | DialoguePrompt | LongTextPrompt | ChoicePrompt | EndPrompt;

export interface RuntimeSnapshot {
  /** Host session generation; absent only in old editor fixtures. */
  session_id?: WireU64;
  mode?: SessionMode;
  revision: WireU64;
  location: StoryLocation;
  /** Runtime variables are decoded to the editor/game domain at the IPC
   * boundary.  Keeping them as tagged wire objects here would make a
   * consumer accidentally compare `{ kind: "integer", ... }` with a scalar
   * and would force every presentation component to know about transport
   * details. */
  variables: Record<string, ScalarValue>;
  world: WorldSnapshot;
  audio: AudioSnapshot;
  playback: PlaybackSnapshot;
  dialogue_page?: DialoguePageSnapshot | null;
  long_text_page?: LongTextPageSnapshot | null;
  prompt: PromptSnapshot;
}

interface CueBase {
  cue_id: WireU64;
  gate: CueGate;
}

export type TimelineEasing =
  | "step"
  | "linear"
  | "ease_in"
  | "ease_out"
  | "ease_in_out"
  | { cubic_bezier: [number, number, number, number] };

export interface TimelineKeyframe {
  at_ms: number;
  value: number | "inherit";
  easing: TimelineEasing;
}

export type TimelineChannels = Record<string, TimelineKeyframe[]>;

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
  | { type: "bgm"; channels: TimelineChannels }
  | { type: "ambience"; slot: AmbienceSlot; channels: TimelineChannels };

export type TimelineEvent =
  | { type: "sfx"; id: string; at_ms: number; asset: string; volume: number }
  | {
      type: "screen_effect";
      id: string;
      at_ms: number;
      effect: ScreenEffectSpec;
      duration_ms: number;
    };

/**
 * Presentation cues that actually cross the host IPC boundary.
 *
 * The core model also has an `open_window` cue, which is a *host control*
 * instruction rather than a presentation one: the desktop host consumes it while
 * committing the main story update and strips it before the update reaches any
 * WebView, so it is intentionally absent from this mirror. Keeping it out means
 * the cue dispatcher below stays exhaustive over everything it can receive.
 */
export type PresentationCue = CueBase &
  (
    | {
        type: "background_transition";
        background: string | null;
        transition: BackgroundTransitionSpec;
        duration_ms: number;
        easing: Easing;
      }
    | {
        type: "sprite_tween";
        sprite_id: string;
        from: SpriteSnapshot | null;
        to: SpriteSnapshot | null;
        duration_ms: number;
        easing: Easing;
        crossfade_ms?: number | null;
      }
    | {
        type: "clear_scene";
        duration_ms: number;
        easing: Easing;
      }
    | {
        type: "camera_tween";
        from: CameraSnapshot;
        to: CameraSnapshot;
        duration_ms: number;
        easing: Easing;
      }
    | {
        type: "screen_effect";
        effect: ScreenEffectSpec;
        duration_ms: number;
      }
    | {
        type: "curtain_transition";
        action: CurtainAction;
        fill: CurtainFill | null;
        transition: CurtainTransitionSpec;
        duration_ms: number;
        easing: Easing;
      }
    | {
        type: "dialogue_reveal";
        prompt_id: string;
        speed_cps: number | null;
        reveal_animation?: TextRevealAnimation | null;
      }
    | {
        type: "long_text_reveal";
        prompt_id: string;
        speed_cps: number | null;
        reveal_animation?: TextRevealAnimation | null;
      }
    | {
        type: "dialogue_ui_transition";
        visible: boolean;
        duration_ms: number;
        motion: UiMotionPreset | null;
      }
    | {
        cue_id: WireU64;
        gate: CueGate;
        type: "ui_motion";
        duration_ms: number;
        motion: UiMotionPreset;
      }
    | {
        type: "button_system_action";
        panel: ButtonPanel;
      }
    | {
        type: "play_sfx";
        asset: string;
        volume: number;
      }
    | {
        type: "bgm_transition";
        from: LoopingAudioSnapshot | null;
        to: LoopingAudioSnapshot | null;
        duration_ms: number;
      }
    | {
        type: "ambience_transition";
        slot: AmbienceSlot;
        from: LoopingAudioSnapshot | null;
        to: LoopingAudioSnapshot | null;
        duration_ms: number;
      }
    | {
        type: "delay";
        duration_ms: number;
      }
    | {
        type: "timeline";
        presentation_id: string;
        duration_ms: number;
        skippable: boolean;
        is_seen: boolean;
        button_bases?: Record<string, ButtonTimelineBase>;
        tracks: TimelineTrack[];
        events: TimelineEvent[];
      }
  );

export interface RuntimeUpdate {
  /** Host session generation; absent only in old editor fixtures. */
  session_id?: WireU64;
  mode?: SessionMode;
  update_id: WireU64;
  snapshot: RuntimeSnapshot;
  cues: PresentationCue[];
  requires_ack: boolean;
}

export type ScalarValue = boolean | bigint | number | string;

export interface BootstrapPayload {
  update: RuntimeUpdate;
  asset_ids: string[];
  content_version: string;
  chapter_map_available?: boolean;
  default_font?: string | null;
}

export interface ChapterMapDecorationSnapshot {
  id: string;
  asset: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

export interface ChapterMapHotspotSnapshot {
  id: string;
  scene_id: string;
  title: string;
  hover_text: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  asset: string | null;
  completed: boolean;
  /**
   * Resolved enterability.  A hotspot the author marked as always replayable
   * stays enterable before the chapter is reached, so the room page must not
   * present it as unreached.
   */
  replayable?: boolean;
}

export interface ChapterMapSnapshot {
  width: number;
  height: number;
  view_x: number;
  view_y: number;
  background: string | null;
  decorations: ChapterMapDecorationSnapshot[];
  hotspots: ChapterMapHotspotSnapshot[];
}

export interface DialogueHistoryEntry {
  entry_id: WireU64;
  prompt_id: string;
  speaker_id?: string | null;
  speaker: string | null;
  name_color?: string | null;
  text_color?: string | null;
  text: string;
}

export interface ResolvedAsset {
  id: string;
  kind: AssetKind;
  absolute_path: string;
  /** Present only when the asset resolves to a loop animation document. */
  animation?: ResolvedAnimation | null;
}

export interface ResolvedAnimation {
  id: string;
  width: number;
  height: number;
  total_duration_ms: number;
  frames: ResolvedAnimationFrame[];
}

export interface ResolvedAnimationFrame {
  asset: string;
  duration_ms: number;
  absolute_path: string;
}

export type AssetUrlMap = Readonly<Record<string, string>>;

export interface SaveSlotSummary {
  slot: string;
  exists: boolean;
  saved_at_unix_ms: number | null;
  scene_id: string | null;
  prompt_preview: string | null;
  thumbnail_data_url: string | null;
}

export interface Settings {
  master_volume: number;
  bgm_volume: number;
  sfx_volume: number;
  video_volume: number;
  /** Optional for settings files written before C1. */
  ambience_volume?: number;
  text_speed_cps: number;
  text_reveal_animation: TextRevealAnimation;
  skip_mode: SkipMode;
}
import type { WireSessionMode } from "../../../shared/generated/WireSessionMode";
import type { WireU64 } from "../../../shared/generated/WireU64";
