export {
  SceneSurface,
  TimelinePreviewSurface,
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
} from "./timelinePreview";

import type { AssetUrlMap, RuntimeSnapshot, RuntimeUpdate } from "./types";

/** The shared scene surface also provides the timeline session lifecycle. */
export interface TimelineSession {
  load(
    start: RuntimeSnapshot,
    update: RuntimeUpdate,
    assets: AssetUrlMap,
  ): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(elapsedMs: number, fireEvents?: boolean): Promise<void>;
  setRate(rate: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}
