/**
 * In-memory media kit for `TimelineSession` host integration tests.
 *
 * jsdom has no usable `HTMLMediaElement` (play/seek never settle), so host
 * tests that must run the *real* session and surface ownership code need the
 * seam the production session already accepts: a `TimelineDomAdapter` that
 * hands out deterministic video elements.
 *
 * The fake element deliberately mirrors browser behaviour that the session
 * relies on: `readyState` is current (so metadata and presented-frame waits
 * resolve), a seek lands on the element's frame granularity and dispatches
 * `seeked`, and listener registration/removal is observable so tests can prove
 * that teardown released every callback.
 */

import type { TimelineDomAdapter } from "./timelineSession";

export interface FakeMediaElement {
  element: HTMLVideoElement;
  /** Live listener sets, keyed by event name. */
  readonly listeners: Map<string, Set<() => void>>;
  /** Every landed media time, in order. */
  readonly seeks: number[];
  readonly duration: number;
  readonly readyState: number;
  muted: boolean;
  paused: boolean;
  playbackRate: number;
  currentTime: number;
  src: string;
  /** Number of `play()` calls that resolved immediately. */
  playCalls: number;
  /** Number of `load()` calls, including the release path. */
  loadCalls: number;
  /** `removeAttribute("src")` was observed; the element was released. */
  released: boolean;
  dispatch(type: string): void;
  /**
   * Lands every `seeked` event that was deferred by
   * `FakeMediaDomOptions.deferSeekEvents`, modelling a real asynchronous seek.
   */
  settleSeeks(): void;
  /** Total listeners still registered across every event. */
  listenerCount(): number;
}

export interface FakeMediaDom extends TimelineDomAdapter {
  readonly videos: FakeMediaElement[];
}

export interface FakeMediaDomOptions {
  /** Media duration in seconds. */
  durationSeconds?: number;
  /**
   * Seek granularity in seconds; a real codec lands on a frame boundary, not
   * on the exact requested time.
   */
  seekGranularitySeconds?: number;
  /**
   * Keep every `seeked` event pending until `settleSeeks()` is called, so a
   * test can model a seek that completes *after* the caller returned (the real
   * browser behaviour that a synchronous fake hides).
   */
  deferSeekEvents?: boolean;
}

export function createFakeMediaDom(
  options: FakeMediaDomOptions = {},
): FakeMediaDom {
  const duration = options.durationSeconds ?? 10;
  const granularity = options.seekGranularitySeconds ?? 1 / 30;
  const deferSeeks = options.deferSeekEvents ?? false;
  const videos: FakeMediaElement[] = [];
  return {
    videos,
    createVideo: () => {
      const listeners = new Map<string, Set<() => void>>();
      const seeks: number[] = [];
      const pendingSeeks: Array<() => void> = [];
      const record: FakeMediaElement = {
        element: null as unknown as HTMLVideoElement,
        listeners,
        seeks,
        duration,
        readyState: 4,
        muted: true,
        paused: true,
        playbackRate: 1,
        currentTime: 0,
        src: "",
        playCalls: 0,
        loadCalls: 0,
        released: false,
        dispatch: (type: string) => {
          for (const listener of [...(listeners.get(type) ?? [])]) listener();
        },
        settleSeeks: () => {
          for (const settle of pendingSeeks.splice(0)) settle();
        },
        listenerCount: () => {
          let total = 0;
          for (const set of listeners.values()) total += set.size;
          return total;
        },
      };
      const element = {
        preload: "",
        crossOrigin: "",
        playsInline: false,
        autoplay: false,
        loop: false,
        controls: false,
        disablePictureInPicture: false,
        error: null,
        videoWidth: 640,
        videoHeight: 360,
        get muted() {
          return record.muted;
        },
        set muted(value: boolean) {
          record.muted = value;
        },
        get paused() {
          return record.paused;
        },
        get playbackRate() {
          return record.playbackRate;
        },
        set playbackRate(value: number) {
          record.playbackRate = value;
        },
        get readyState() {
          return record.readyState;
        },
        get duration() {
          return record.duration;
        },
        get src() {
          return record.src;
        },
        set src(value: string) {
          record.src = value;
        },
        get currentTime() {
          return record.currentTime;
        },
        set currentTime(value: number) {
          // A real codec lands on a frame boundary; the seek still completes
          // with a `seeked` event, which is what the session waits for.
          record.currentTime = Math.max(
            0,
            Math.round(value / granularity) * granularity,
          );
          seeks.push(record.currentTime);
          if (deferSeeks) pendingSeeks.push(() => record.dispatch("seeked"));
          else record.dispatch("seeked");
        },
        addEventListener: (type: string, listener: () => void) => {
          const set = listeners.get(type) ?? new Set<() => void>();
          set.add(listener);
          listeners.set(type, set);
        },
        removeEventListener: (type: string, listener: () => void) => {
          listeners.get(type)?.delete(listener);
        },
        play: () => {
          record.playCalls += 1;
          record.paused = false;
          record.dispatch("playing");
          return Promise.resolve();
        },
        pause: () => {
          record.paused = true;
        },
        load: () => {
          record.loadCalls += 1;
        },
        removeAttribute: (name: string) => {
          if (name === "src") {
            record.src = "";
            record.released = true;
          }
        },
        // No `requestVideoFrameCallback`: `readyState` is current, so the
        // presented-frame wait resolves without waiting for a browser frame.
      };
      record.element = element as unknown as HTMLVideoElement;
      videos.push(record);
      return record.element;
    },
    requestFrame: () => 0,
    cancelFrame: () => undefined,
  };
}
