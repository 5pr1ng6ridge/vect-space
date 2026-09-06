export type AssetKind =
  "background" | "sprite" | "gui" | "bgm" | "sfx" | "font" | "video";
export type CueGate = "none" | "player_advance" | "runtime";
export type Easing = "linear" | "ease_in" | "ease_out" | "ease_in_out";
export type AdvanceSource = "manual" | "auto" | "fast_forward" | "forced_auto";
export type SkipMode = "disabled" | "read_only" | "all";
export type TextRevealAnimation = "line_sweep" | "typewriter" | "drop_fade";
export type PresentationOutcome = "completed" | "skipped" | "failed";

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

export interface CameraSnapshot {
  x: number;
  y: number;
  zoom: number;
  rotation_deg: number;
}

export interface WorldSnapshot {
  background: string | null;
  sprites: Record<string, SpriteSnapshot>;
  camera: CameraSnapshot;
  dialogue_ui_visible: boolean;
  ui_motion_bindings: UiMotionBindings;
  persistent_effects: string[];
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

export interface LoopingAudioSnapshot {
  asset: string;
  volume: number;
  start_ms: number;
  loop_start_ms?: number | null;
  loop_end_ms?: number | null;
}

export interface AudioSnapshot {
  bgm: LoopingAudioSnapshot | null;
}

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
}

export interface ChoicePrompt {
  kind: "choice";
  prompt_id: string;
  choices: ChoiceSnapshot[];
}

export interface EndPrompt {
  kind: "end";
  prompt_id: string;
}

export type PromptSnapshot =
  EmptyPrompt | DialoguePrompt | LongTextPrompt | ChoicePrompt | EndPrompt;

export interface RuntimeSnapshot {
  revision: WireU64;
  location: StoryLocation;
  variables: Record<string, WireScalarValue>;
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

export type PresentationCue = CueBase &
  (
    | {
        type: "background_transition";
        background: string | null;
        transition: "cut" | "cross_fade";
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
        effect: "shake" | "flash";
        duration_ms: number;
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
        type: "delay";
        duration_ms: number;
      }
    | {
        type: "timeline";
        presentation_id: string;
        duration_ms: number;
        skippable: boolean;
        is_seen: boolean;
        tracks: TimelineTrack[];
        events: TimelineEvent[];
      }
  );

export interface RuntimeUpdate {
  update_id: WireU64;
  snapshot: RuntimeSnapshot;
  cues: PresentationCue[];
  requires_ack: boolean;
}

export interface BootstrapPayload {
  update: RuntimeUpdate;
  asset_ids: string[];
  content_version: string;
  story_flow_available: boolean;
  default_font?: string | null;
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

export interface VisibleStoryFlowNode {
  scene_id: string;
  title: string;
  x: number;
  y: number;
  completed: boolean;
}

export interface VisibleStoryFlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string | null;
}

export interface StoryFlowSnapshot {
  nodes: VisibleStoryFlowNode[];
  edges: VisibleStoryFlowEdge[];
}

export interface ResolvedAsset {
  id: string;
  kind: AssetKind;
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
  text_speed_cps: number;
  text_reveal_animation: TextRevealAnimation;
  skip_mode: SkipMode;
}
import type { WireScalarValue } from "../../../shared/generated/WireScalarValue";
import type { WireU64 } from "../../../shared/generated/WireU64";
