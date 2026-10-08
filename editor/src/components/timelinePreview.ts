/**
 * Per-canvas editor timeline preview.
 *
 * Instantiates the shared `SceneSurface` together with the shared
 * `TimelineSession`, exactly like the game does, and only supplies the policy
 * differences of an authoring preview:
 *
 * - `world: "restore"` loads start from the Rust entry snapshot instead of the
 *   live scene,
 * - the audio graph starts muted and is activated on the first unmute,
 * - decorative frame loops follow the playhead while idle, so scrubbing is
 *   deterministic and pause freezes the frame,
 * - the terminal frame is kept on screen when playback ends.
 */

import { AudioManager } from "@vectspace/presentation-core/audio";
import {
  SceneSurface,
  type SceneFrameCancel,
  type SceneFrameRequest,
  type SceneKit,
} from "@vectspace/presentation-core/scene-surface";
import type { SceneTextureLike } from "@vectspace/presentation-core/scene-textures";
import {
  TimelineSession,
  type TimelineDomAdapter,
} from "@vectspace/presentation-core/timeline-session";
import type { Settings } from "@vectspace/presentation-core/types";

/** Silent preview settings: nothing in a preview may make a sound by accident. */
export const MUTED_PREVIEW_SETTINGS: Settings = {
  master_volume: 0,
  bgm_volume: 1,
  ambience_volume: 1,
  sfx_volume: 1,
  video_volume: 1,
  text_speed_cps: 30,
  text_reveal_animation: "typewriter",
  skip_mode: "disabled",
};

export interface EditorTimelinePreview {
  surface: SceneSurface;
  session: TimelineSession;
}

/**
 * Host ports for integration tests.
 *
 * The workspace always creates the preview through this factory, so a test
 * can drive the real `DeferredSession` ownership code plus the real
 * `SceneSurface`/`TimelineSession` against the in-memory render kit instead of
 * duplicating the preview policies.
 */
export interface EditorPreviewEnvironment {
  kit?: SceneKit;
  requestFrame?: SceneFrameRequest;
  cancelFrame?: SceneFrameCancel;
  textureLoader?: (url: string) => Promise<SceneTextureLike>;
  textureBudget?: number;
  dom?: TimelineDomAdapter;
}

export function createEditorTimelinePreview(
  canvas: HTMLCanvasElement,
  diagnostic: (message: string) => void,
  environment: EditorPreviewEnvironment = {},
): { preview: EditorTimelinePreview; initialized: Promise<void> } {
  const audio = new AudioManager(MUTED_PREVIEW_SETTINGS, {
    deferUntilUnmuted: true,
  });
  const surface = new SceneSurface({
    canvas,
    diagnostic,
    ...(environment.kit === undefined ? {} : { kit: environment.kit }),
    ...(environment.requestFrame === undefined
      ? {}
      : { requestFrame: environment.requestFrame }),
    ...(environment.cancelFrame === undefined
      ? {}
      : { cancelFrame: environment.cancelFrame }),
    ...(environment.textureLoader === undefined
      ? {}
      : { textureLoader: environment.textureLoader }),
    ...(environment.textureBudget === undefined
      ? {}
      : { textureBudget: environment.textureBudget }),
  });
  const session = new TimelineSession({
    surface,
    audio,
    diagnostic,
    audioPolicy: "preview",
    decorations: "while-playing",
    videoAtEnd: "hold",
    ...(environment.dom === undefined ? {} : { dom: environment.dom }),
  });
  return { preview: { surface, session }, initialized: surface.init() };
}

export function disposeEditorTimelinePreview(
  preview: EditorTimelinePreview,
): void {
  preview.session.dispose();
  preview.surface.dispose();
}
