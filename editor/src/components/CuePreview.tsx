/**
 * Real Pixi preview for a single one-shot presentation cue.
 *
 * The inspector previews background transitions, curtains and screen effects.
 * None of them is a timeline, so this component drives the shared
 * `SceneSurface` directly instead of going through `TimelineSession`:
 *
 * - pixels, texture cache and cue executors are the exact shared ones the game
 *   and the timeline preview use,
 * - the cue's own animation still runs through the shared `animate()` clock
 *   (and therefore through the shared virtual clock/evaluator code); this
 *   component only supplies the frame source,
 * - a deterministic seek drives that frame source to exactly the requested
 *   elapsed time and then freezes it with playback rate `0`, so the same
 *   authored parameters always produce the same frame,
 * - there is no audio graph at all, so a preview can never make a sound,
 * - the surface is owned by a `DeferredSession`, so React Strict Mode's
 *   setup/cleanup/setup probe reuses one initialized WebGL app and one frame
 *   source instead of duplicating Pixi resources or listeners.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
} from "@vectspace/presentation-core/scene-frame";
import {
  SceneSurface,
  type SceneKit,
} from "@vectspace/presentation-core/scene-surface";
import type { SceneTextureLike } from "@vectspace/presentation-core/scene-textures";
import { DeferredSession } from "@vectspace/presentation-core/deferred-session";

import { PreviewFrameClock } from "./previewFrameClock";

import { assetUrl } from "../api";
import type { EditorAsset } from "../types";
import type { CuePreviewRequest } from "../presentationPreview";

export interface CuePreviewEnvironment {
  kit?: SceneKit;
  textureLoader?: (url: string) => Promise<SceneTextureLike>;
  textureBudget?: number;
}

interface PreviewSession {
  surface: SceneSurface;
  clock: PreviewFrameClock;
}

type PreviewStatus =
  "loading" | "ready" | "playing" | "paused" | "done" | "error";

interface CuePreviewProps {
  request: CuePreviewRequest;
  assets: readonly EditorAsset[];
  /** Canvas aria label, e.g. `背景转场预览`. */
  label: string;
  onError?(message: string): void;
  environment?: CuePreviewEnvironment;
}

export function CuePreview({
  request,
  assets,
  label,
  onError,
  environment,
}: CuePreviewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lifecycleRef = useRef<DeferredSession<PreviewSession> | null>(null);
  const sessionRef = useRef<PreviewSession | null>(null);
  const readyRef = useRef<Promise<void>>(Promise.resolve());
  const diagnosticRef = useRef<(message: string) => void>(() => undefined);
  const requestRef = useRef(request);
  const urlsRef = useRef<Record<string, string>>({});
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const rateRef = useRef(1);
  const [status, setStatus] = useState<PreviewStatus>("loading");
  const [progressMs, setProgressMs] = useState(0);

  const assetsSignature = useMemo(
    () =>
      assets
        .map((asset) => `${asset.id}\u0000${asset.absolute_path}`)
        .join("\u0001"),
    [assets],
  );

  // The URL map is keyed on the id/path signature, not on the array identity:
  // an unrelated parent render may recreate the `assets` array without
  // changing the artwork, and that must not invalidate the rebuild effect
  // (which would reset the playhead and abort a running cue).
  const urls = useMemo(
    () =>
      Object.fromEntries(
        assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]),
      ),
    [assetsSignature], // eslint-disable-line react-hooks/exhaustive-deps -- the id/path signature is the deliberate key; an equivalent asset list must not rebuild the preview.
  );

  const report = useCallback((message: string): void => {
    diagnosticRef.current(message);
  }, []);

  useEffect(() => {
    diagnosticRef.current = (message: string): void => {
      onError?.(message);
    };
  }, [onError]);

  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  useEffect(() => {
    urlsRef.current = urls;
  }, [urls]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    lifecycleRef.current ??= new DeferredSession<PreviewSession>({
      create: () => {
        const clock = new PreviewFrameClock();
        const surface = new SceneSurface({
          canvas,
          diagnostic: (message) => diagnosticRef.current(message),
          requestFrame: clock.request,
          cancelFrame: clock.cancel,
          ...(environment?.kit === undefined ? {} : { kit: environment.kit }),
          ...(environment?.textureLoader === undefined
            ? {}
            : { textureLoader: environment.textureLoader }),
          ...(environment?.textureBudget === undefined
            ? {}
            : { textureBudget: environment.textureBudget }),
        });
        return {
          session: { surface, clock },
          initialized: surface.init(),
        };
      },
      dispose: (session) => {
        session.clock.dispose();
        session.surface.dispose();
      },
    });
    const lifecycle = lifecycleRef.current;
    const handle = lifecycle.acquire();
    const session = handle.session;
    session.clock.onStep = () => setProgressMs(session.clock.now);
    sessionRef.current = session;
    readyRef.current = handle.initialized.then(() => undefined);
    let active = true;
    void readyRef.current.catch((reason: unknown) => {
      if (active) report(`Pixi 预览初始化失败：${errorMessage(reason)}`);
    });
    return () => {
      active = false;
      generationRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      session.clock.onStep = null;
      session.clock.pause();
      if (sessionRef.current === session) sessionRef.current = null;
      lifecycle.release();
    };
  }, [environment, report]);

  /**
   * Rebuilds the before-state from scratch and returns the session.
   *
   * Every authored change and every seek goes through a reset/prepare/apply,
   * so the preview never inherits pixels from a superseded run and the same
   * request always rebuilds to the same frame.
   */
  const rebuild = useCallback(async (): Promise<PreviewSession | null> => {
    const session = sessionRef.current;
    if (session === null) return null;
    const generation = ++generationRef.current;
    abortRef.current?.abort();
    abortRef.current = null;
    rateRef.current = 1;
    session.clock.pause();
    session.clock.reset();
    await readyRef.current;
    if (generation !== generationRef.current || sessionRef.current !== session)
      return null;
    session.surface.reset();
    const prepared = await session.surface.prepare({
      world: requestRef.current.world,
      assets: urlsRef.current,
    });
    if (
      generation !== generationRef.current ||
      sessionRef.current !== session
    ) {
      if (prepared !== null) session.surface.discardPreparation(prepared);
      return null;
    }
    if (prepared === null || !session.surface.applyWorld(prepared)) {
      throw new Error("预览世界准备失败");
    }
    session.clock.step(0);
    return session;
  }, []);

  /**
   * Rebuilds the preview and leaves a terminal state on failure.
   *
   * An unresolved asset id or an asset whose frames all fail to decode must
   * never leave the transport disabled in `loading`: the failure is reported,
   * the status becomes `error`, and the retry control (or any transport
   * button) rebuilds once the artwork is resolvable again.
   */
  const runBuild = useCallback(async (): Promise<void> => {
    const pending = rebuild();
    const generation = generationRef.current;
    try {
      const session = await pending;
      if (session !== null) setStatus("ready");
    } catch (reason: unknown) {
      // A superseded build must not overwrite the newer build's status.
      if (generationRef.current !== generation) return;
      report(`预览构建失败：${errorMessage(reason)}`);
      setStatus("error");
    }
  }, [rebuild, report]);

  useEffect(() => {
    // An authored change is an intentional external-system synchronization:
    // the preview rebuilds from scratch, so its status and playhead are reset
    // explicitly here instead of being derived during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus("loading");
    setProgressMs(0);
    void runBuild();
  }, [runBuild, request, urls]);

  const retry = useCallback((): void => {
    setStatus("loading");
    setProgressMs(0);
    void runBuild();
  }, [runBuild]);

  /** Rebuilds for a transport action, keeping a failure retryable. */
  const rebuildSession =
    useCallback(async (): Promise<PreviewSession | null> => {
      const pending = rebuild();
      const generation = generationRef.current;
      try {
        return await pending;
      } catch (reason: unknown) {
        if (generationRef.current === generation) {
          report(`预览构建失败：${errorMessage(reason)}`);
          setStatus("error");
        }
        return null;
      }
    }, [rebuild, report]);

  /** Waits until the cue's own animation registered its first frame. */
  const waitForAnimation = useCallback(
    async (
      session: PreviewSession,
      isSettled: () => boolean,
    ): Promise<void> => {
      // A cut/zero-duration cue never registers an animation; the run settles
      // instead.  The budget only bounds a pathological decode; the memory
      // kit and local files register within a frame or two.
      for (let attempt = 0; attempt < 2500; attempt += 1) {
        if (session.clock.pendingCount() >= 2 || isSettled()) return;
        if (abortRef.current?.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    },
    [],
  );

  const play = useCallback(async (): Promise<void> => {
    const session = await rebuildSession();
    if (session === null) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    rateRef.current = 1;
    setStatus("playing");
    let settled = false;
    const run = session.surface.runCue(requestRef.current.cue, {
      assets: urlsRef.current,
      signal: controller.signal,
      getRate: () => rateRef.current,
    });
    run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    void run.catch((reason: unknown) => {
      report(`预览播放失败：${errorMessage(reason)}`);
    });
    await waitForAnimation(session, () => settled);
    if (generation !== generationRef.current || sessionRef.current !== session)
      return;
    if (!settled) session.clock.resume();
    await run;
    if (generation !== generationRef.current || sessionRef.current !== session)
      return;
    session.clock.pause();
    setProgressMs(requestRef.current.duration_ms);
    setStatus("done");
  }, [rebuildSession, report, waitForAnimation]);

  const pause = useCallback((): void => {
    const session = sessionRef.current;
    if (session === null) return;
    rateRef.current = 0;
    session.clock.pause();
    setStatus("paused");
  }, []);

  const resume = useCallback((): void => {
    const session = sessionRef.current;
    if (session === null || status !== "paused") return;
    rateRef.current = 1;
    session.clock.resume();
    setStatus("playing");
  }, [status]);

  /**
   * Deterministic seek: rebuild, start the cue, drive the frame source to the
   * requested elapsed time, then freeze it.  The cue's executed frame at that
   * virtual time is exactly the frame the game shows at the same time.
   */
  const seek = useCallback(
    async (ms: number): Promise<void> => {
      const session = await rebuildSession();
      if (session === null) return;
      const generation = generationRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      const duration = Math.max(1, requestRef.current.duration_ms);
      const target = Math.max(0, Math.min(ms, duration));
      rateRef.current = 1;
      let settled = false;
      const run = session.surface.runCue(requestRef.current.cue, {
        assets: urlsRef.current,
        signal: controller.signal,
        getRate: () => rateRef.current,
      });
      run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      void run.catch((reason: unknown) => {
        report(`预览定位失败：${errorMessage(reason)}`);
      });
      await waitForAnimation(session, () => settled);
      if (
        generation !== generationRef.current ||
        sessionRef.current !== session
      )
        return;
      session.clock.step(0);
      session.clock.step(target);
      rateRef.current = 0;
      session.clock.step(0);
      if (
        generation !== generationRef.current ||
        sessionRef.current !== session
      )
        return;
      setProgressMs(target);
      setStatus(target >= duration ? "done" : "paused");
    },
    [rebuildSession, report, waitForAnimation],
  );

  const duration = request.duration_ms;
  const busy = status === "loading";

  return (
    <section className="cue-preview">
      <div className="cue-preview-stage">
        <canvas
          aria-label={label}
          className="timeline-stage"
          height={DESIGN_HEIGHT}
          ref={canvasRef}
          width={DESIGN_WIDTH}
        />
      </div>
      <div className="cue-preview-transport">
        <button disabled={busy} onClick={() => void play()} type="button">
          ▶ 播放
        </button>
        {status === "error" && (
          <button onClick={retry} type="button">
            重试
          </button>
        )}
        {status === "playing" ? (
          <button onClick={pause} type="button">
            ❚❚ 暂停
          </button>
        ) : (
          <button disabled={status !== "paused"} onClick={resume} type="button">
            ▶ 继续
          </button>
        )}
        <button disabled={busy} onClick={() => void seek(0)} type="button">
          转场前
        </button>
        <button
          disabled={busy}
          onClick={() => void seek(duration)}
          type="button"
        >
          转场后
        </button>
        {duration > 0 && (
          <input
            aria-label={`${label}进度`}
            disabled={busy}
            max={duration}
            min={0}
            onChange={(event) => void seek(Number(event.currentTarget.value))}
            step={1}
            type="range"
            value={progressMs}
          />
        )}
        <code>
          {Math.round(progressMs)} / {duration} ms
        </code>
      </div>
    </section>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
