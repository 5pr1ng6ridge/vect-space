export type AssetKind =
  "background" | "sprite" | "gui" | "bgm" | "sfx" | "font";
export type CueGate = "none" | "player_advance" | "runtime";
export type Easing = "linear" | "ease_in" | "ease_out" | "ease_in_out";

export interface StoryLocation {
  scene_id: string;
  node_id: string;
}

export interface SpriteSnapshot {
  asset: string;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  z: number;
}

export interface CameraSnapshot {
  x: number;
  y: number;
  zoom: number;
}

export interface WorldSnapshot {
  background: string | null;
  sprites: Record<string, SpriteSnapshot>;
  camera: CameraSnapshot;
  dialogue_ui_visible: boolean;
  persistent_effects: string[];
}

export interface LoopingAudioSnapshot {
  asset: string;
  volume: number;
}

export interface AudioSnapshot {
  bgm: LoopingAudioSnapshot | null;
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
  EmptyPrompt | DialoguePrompt | ChoicePrompt | EndPrompt;

export interface RuntimeSnapshot {
  revision: number;
  location: StoryLocation;
  variables: Record<string, boolean | number | string>;
  world: WorldSnapshot;
  audio: AudioSnapshot;
  prompt: PromptSnapshot;
}

interface CueBase {
  cue_id: number;
  gate: CueGate;
}

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
        speed_cps: number;
      }
    | {
        type: "dialogue_ui_transition";
        visible: boolean;
        duration_ms: number;
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
  );

export interface RuntimeUpdate {
  update_id: number;
  snapshot: RuntimeSnapshot;
  cues: PresentationCue[];
  requires_ack: boolean;
}

export interface BootstrapPayload {
  update: RuntimeUpdate;
  asset_ids: string[];
  content_version: string;
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
  text_speed_cps: number;
}
