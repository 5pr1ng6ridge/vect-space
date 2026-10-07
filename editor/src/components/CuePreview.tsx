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
 *   source instead of duplicating Pixi resources or listeners,
 * - a static world may also replay one transient particle burst on top of it
 *   (`decorationTransport.burst`).  A burst cue resolves as soon as its
 *   emitter exists, so the burst is not driven by the cue promise: the same
 *   `PreviewFrameClock` that ticks the surface's decoration loops advances it
 *   from `0` to the particles' maximum lifetime.  Replay and seek rebuild the
 *   world and recreate the released transient batch, so the same playhead
 *   always shows the same particles and nothing is ever saved or recorded.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
} from "@vectspace/presentation-core/scene-frame";
import {
  SceneSurface,
  type SceneKit,
  type SceneVisualCue,
} from "@vectspace/presentation-core/scene-surface";
import type { SceneTextureLike } from "@vectspace/presentation-core/scene-textures";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { DeferredSession } from "@vectspace/presentation-core/deferred-session";

import { isSpaceKey, shouldReplayBurst } from "./burstShortcut";
import { emitterDragPosition } from "./particleAreaGeometry";
import { PreviewFrameClock } from "./previewFrameClock";
import { beginStageGesture } from "./stageGesture";

import { assetUrl } from "../api";
import {
  sceneFrameFromWorld,
  type CuePreviewRequest,
} from "../presentationPreview";
import { movedEnough, stagePointFromClientPoint } from "../stageEdit";
import type { EditorAsset } from "../types";
import { EMPTY_EDITOR_VISUALS, type EditorVisualResources } from "../visualResources";

export interface CuePreviewEnvironment {
  kit?: SceneKit;
  textureLoader?: (url: string) => Promise<SceneTextureLike>;
  textureBudget?: number;
}

interface PreviewSession {
  surface: SceneSurface;
  clock: PreviewFrameClock;
}

/** One transient burst of an emitter; it is never part of the saved world. */
export type BurstCue = Extract<SceneVisualCue, { type: "particle_state" }>;

export interface DecorationTransport {
  /** Length of the playhead: the continuous loop, or the burst's lifetime. */
  durationMs: number;
  /**
   * Transient burst replayed above the static world.  With it the transport
   * becomes a burst transport (replay, pause, seek over `durationMs`, and the
   * Space shortcut); without it the transport scrubs the continuous emitters.
   */
  burst?: BurstCue;
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
  /**
   * Resolved animation map for animated assets.
   *
   * Cue previews only map logical ids to a static url, which shows the first
   * frame of an animated asset; passing the project's map lets the shared
   * surface play the loop instead.
   */
  animations?: AnimationMap;
  visuals?: EditorVisualResources;
  /**
   * Sprite instance the author may drag on a static world preview.
   *
   * The gesture only starts when the pointer actually hits this object, and it
   * writes nothing itself: the world position of the finished drag is handed
   * back through `onDragCommit` so the host can commit one authored change.
   */
  dragTargetId?: string;
  /** Called once per completed drag with the world-space target position. */
  onDragCommit?(position: { x: number; y: number }): void;
  /** Extra layer rendered inside the 16:9 stage, above the canvas. */
  overlay?: ReactNode;
  /**
   * Play/pause/stop/seek for a static world's decoration (particles).  Seeking
   * evaluates the analytic particle state at that time on the shared surface,
   * so the same playhead always shows the same frame.  With `burst` the
   * transport replays one transient burst instead (button and Space), and the
   * burst is rebuilt for every replay and seek.
   */
  decorationTransport?: DecorationTransport;
}

export function CuePreview({
  request,
  assets,
  label,
  onError,
  environment,
  animations,
  visuals = EMPTY_EDITOR_VISUALS,
  dragTargetId,
  onDragCommit,
  overlay,
  decorationTransport,
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
  const dragTargetRef = useRef(dragTargetId);
  const dragCommitRef = useRef(onDragCommit);
  const gestureCleanupRef = useRef<(() => void) | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const transportRef = useRef(decorationTransport);
  const replayShortcutRef = useRef<() => void>(() => undefined);
  // True from a handled Space keydown until its keyup: holds back the native
  // auto-repeat and keyup activation of a focused button.
  const swallowSpaceRef = useRef(false);
  const [status, setStatus] = useState<PreviewStatus>("loading");
  const [progressMs, setProgressMs] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [decorationPlaying, setDecorationPlaying] = useState(true);
  const [decorationMs, setDecorationMs] = useState(0);
  // The playhead the author asked for while a burst is being (re)created.  The
  // clock restarts at zero for every rebuild, so showing it would snap the
  // controlled slider back to 0 under the author's hand: the requested target
  // is shown instead until the newest launch has put the clock there.
  const [pendingMs, setPendingMsState] = useState<number | null>(null);
  // Mirror for callbacks: the pause/play toggle must not touch the clock while
  // a launch has not created the emitter yet.
  const launchingRef = useRef(false);

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

  const setPending = useCallback((ms: number | null): void => {
    launchingRef.current = ms !== null;
    setPendingMsState(ms);
  }, []);

  useEffect(() => {
    diagnosticRef.current = (message: string): void => {
      onError?.(message);
    };
  }, [onError]);

  useEffect(() => {
    requestRef.current = request;
  }, [request]);

  // Declared before the build effect: a rebuild decides from the current
  // transport whether the clock may run on its own.
  useEffect(() => {
    transportRef.current = decorationTransport;
  }, [decorationTransport]);

  useEffect(() => {
    urlsRef.current = urls;
  }, [urls]);

  // Gesture state is read from refs: a commit must use the current callback
  // even when the host re-rendered while the pointer was down.
  useEffect(() => {
    dragTargetRef.current = dragTargetId;
  }, [dragTargetId]);

  useEffect(() => {
    dragCommitRef.current = onDragCommit;
  }, [onDragCommit]);

  useEffect(
    () => () => {
      gestureCleanupRef.current?.();
    },
    [],
  );

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
    session.clock.onStep = () => {
      if (requestRef.current.cue === null) {
        // A static world preview has no cue readout, and its clock runs
        // continuously for the decoration loops: writing state on every frame
        // would re-render the inspector without anything to show.  Only a
        // burst has a playhead: the shared clock is its time, and the burst
        // is over once the clock reaches the particles' maximum lifetime.
        const transport = transportRef.current;
        if (transport?.burst === undefined) return;
        const now = session.clock.now;
        setDecorationMs(Math.min(now, transport.durationMs));
        if (session.clock.auto && now >= transport.durationMs) {
          session.clock.pause();
          setDecorationPlaying(false);
        }
        return;
      }
      setProgressMs(session.clock.now);
    };
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

  useEffect(() => {
    const session = sessionRef.current;
    if (session === null || animations === undefined) return;
    session.surface.setAnimations(animations);
  }, [animations]);

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
    session.surface.setVisualResources(visuals.textBlocks, visuals.particles);
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
    if (requestRef.current.cue === null) {
      // A static world preview has no timeline: the world's own pose is the
      // evaluated frame, which is what makes it hit-testable and draggable.
      session.surface.applyFrame(
        sceneFrameFromWorld(requestRef.current.world, session.surface.geometry),
      );
      // The clock stays paused for a cue (its transport resumes it explicitly),
      // but a static world has no transport at all: it has to keep running so
      // the shared render loop ticks the decorative frame loops.  A paused
      // clock would freeze an animated sprite on its first frame forever.
      // A burst transport draws only once the transient batch exists. Drawing
      // the reset world here would flash an empty canvas during async scrubs.
      if (transportRef.current?.burst === undefined) {
        session.clock.step(0);
        session.clock.resume();
      }
      return session;
    }
    session.clock.step(0);
    return session;
  }, [visuals]);

  /**
   * Creates the transient burst on a freshly rebuilt world and puts the shared
   * clock at `atMs`.
   *
   * The cue resolves as soon as the emitter exists, so its promise says
   * nothing about the burst's life.  The world was rebuilt with the clock
   * paused at zero: stepping to `atMs` hands the surface exactly that much
   * decoration time, the same time a continuous run would have given it.
   */
  const launchBurst = useCallback(
    async (
      session: PreviewSession,
      generation: number,
      atMs: number,
      autoplay: boolean,
    ): Promise<void> => {
      const transport = transportRef.current;
      const cue = transport?.burst;
      if (transport === undefined || cue === undefined) return;
      const controller = new AbortController();
      abortRef.current = controller;
      await session.surface.runCue(cue, {
        assets: urlsRef.current,
        signal: controller.signal,
        getRate: () => 1,
      });
      if (
        controller.signal.aborted ||
        generation !== generationRef.current ||
        sessionRef.current !== session
      )
        return;
      const duration = Math.max(1, transport.durationMs);
      const target = Math.max(0, Math.min(atMs, duration));
      // The emitter exists now with zero elapsed time: re-base the shared
      // clock to the same instant, whatever it did while the texture decoded,
      // so the playhead and the particles can never disagree.
      session.clock.pause();
      session.clock.reset();
      session.clock.step(0);
      if (target > 0) session.clock.step(target);
      const playing = autoplay && target < duration;
      if (playing) session.clock.resume();
      setDecorationPlaying(playing);
      setDecorationMs(session.clock.now);
      setPending(null);
    },
    [setPending],
  );

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
      if (session === null) return;
      if (transportRef.current?.burst === undefined) {
        setStatus("ready");
        return;
      }
      // A burst plays once as soon as its world is ready, like the continuous
      // emitters start on their own.  The transport stays busy (`loading`)
      // until the emitter exists: before that there is nothing to pause, and
      // a resumed clock would run ahead of the particles.
      setPending(0);
      await launchBurst(session, generation, 0, true);
      if (generationRef.current === generation && sessionRef.current === session)
        setStatus("ready");
    } catch (reason: unknown) {
      // A superseded build must not overwrite the newer build's status.
      if (generationRef.current !== generation) return;
      setPending(null);
      report(`预览构建失败：${errorMessage(reason)}`);
      setStatus("error");
    }
  }, [launchBurst, rebuild, report, setPending]);

  useEffect(() => {
    // An authored change is an intentional external-system synchronization:
    // the preview rebuilds from scratch, so its status and playhead are reset
    // explicitly here instead of being derived during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus("loading");
    setProgressMs(0);
    // A rebuilt static world restarts its decoration clock from zero.  A burst
    // transport starts idle: it plays once its emitter exists.
    setDecorationPlaying(transportRef.current?.burst === undefined);
    setDecorationMs(0);
    setPending(null);
    void runBuild();
  }, [runBuild, request, urls, setPending]);

  /** Freeze decoration and show the analytic particle state at `ms`. */
  const seekDecoration = useCallback((ms: number): void => {
    const session = sessionRef.current;
    if (session === null) return;
    session.clock.pause();
    session.surface.seekParticles(ms);
    session.clock.step(0);
    setDecorationPlaying(false);
    setDecorationMs(ms);
  }, []);

  const toggleDecoration = useCallback((): void => {
    const session = sessionRef.current;
    if (session === null) return;
    if (decorationPlaying) {
      session.clock.pause();
      setDecorationPlaying(false);
    } else {
      session.clock.resume();
      setDecorationPlaying(true);
    }
  }, [decorationPlaying]);

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

  /**
   * Rebuilds the world and shows the burst at `atMs`: playing from there, or
   * frozen there.  Replay, stop and seek all recreate the transient batch, so
   * a burst that already expired comes back exactly as it was.
   */
  const replayBurst = useCallback(
    async (atMs = 0, autoplay = true): Promise<void> => {
      const transport = transportRef.current;
      if (transport?.burst === undefined) return;
      // The newest call owns the target readout and the clock; an older
      // launch finds its generation superseded and leaves both alone.
      const building = rebuildSession();
      const generation = generationRef.current;
      setPending(Math.max(0, Math.min(atMs, transport.durationMs)));
      const session = await building;
      if (session === null) {
        if (generationRef.current === generation) setPending(null);
        return;
      }
      try {
        await launchBurst(session, generation, atMs, autoplay);
      } catch (reason: unknown) {
        if (generationRef.current !== generation) return;
        setPending(null);
        report(`预览爆发失败：${errorMessage(reason)}`);
        setStatus("error");
        return;
      }
      if (generationRef.current === generation && sessionRef.current === session)
        setStatus("ready");
    },
    [launchBurst, rebuildSession, report, setPending],
  );

  const toggleBurst = useCallback((): void => {
    const session = sessionRef.current;
    const transport = transportRef.current;
    if (session === null || transport?.burst === undefined) return;
    // Nothing to pause or resume until the launch created the emitter.
    if (launchingRef.current) return;
    if (session.clock.auto) {
      session.clock.pause();
      setDecorationPlaying(false);
    } else if (session.clock.now >= transport.durationMs) {
      // Finished: playing again starts a new burst.
      void replayBurst();
    } else {
      session.clock.resume();
      setDecorationPlaying(true);
    }
  }, [replayBurst]);

  // The shortcut handler lives as long as the burst transport and reads the
  // newest replay/status through this ref.
  useEffect(() => {
    replayShortcutRef.current = () => {
      if (status === "loading" || status === "error") return;
      void replayBurst();
    };
  }, [replayBurst, status]);

  const burstEnabled = decorationTransport?.burst !== undefined;
  useEffect(() => {
    if (!burstEnabled) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      const section = sectionRef.current;
      if (section === null) return;
      // Holding Space replays once; the repeats only keep their default
      // action (page scroll, a focused button's click) away.  A fresh press
      // (not a repeat) is always judged on its own, so a keyup that never
      // arrived (focus left the window) cannot disable the shortcut.
      if (swallowSpaceRef.current && event.repeat && isSpaceKey(event)) {
        event.preventDefault();
        return;
      }
      const scope = section.closest("aside, main") ?? section.parentElement;
      if (!shouldReplayBurst(event, scope, section)) return;
      event.preventDefault();
      swallowSpaceRef.current = true;
      replayShortcutRef.current();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!swallowSpaceRef.current || !isSpaceKey(event)) return;
      swallowSpaceRef.current = false;
      // Some engines activate a focused button on keyup, after the keydown
      // already replayed.
      event.preventDefault();
    };
    const onBlur = (): void => {
      swallowSpaceRef.current = false;
    };
    // Capture phase, like the timeline workspace's Space handler: a third-party
    // document-level handler (the story graph's key-press hook) consumes Space
    // in the bubble phase before a bubbling window listener could judge it, so
    // a press on a bare page would never replay.  The policy in
    // `shouldReplayBurst` still decides, and nothing is stopped from
    // propagating.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      swallowSpaceRef.current = false;
    };
  }, [burstEnabled]);

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
    const cue = requestRef.current.cue;
    // A static world preview has no cue and therefore no transport; the guard
    // keeps that invariant local instead of relying on the hidden controls.
    if (cue === null) return;
    const session = await rebuildSession();
    if (session === null) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    rateRef.current = 1;
    setStatus("playing");
    let settled = false;
    const run = session.surface.runCue(cue, {
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
      const cue = requestRef.current.cue;
      if (cue === null) return;
      const session = await rebuildSession();
      if (session === null) return;
      const generation = generationRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      const duration = Math.max(1, requestRef.current.duration_ms);
      const target = Math.max(0, Math.min(ms, duration));
      rateRef.current = 1;
      let settled = false;
      const run = session.surface.runCue(cue, {
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

  /**
   * Starts a drag on the static world preview.
   *
   * Nothing is authored while the pointer moves: the shared surface gets a
   * temporary object override, so the document, the preview request and the
   * history stay untouched until the gesture finishes.  A click without
   * movement, `Escape`, a pointer cancel or the window losing focus restores
   * the exact evaluated pose and writes nothing at all.
   */
  const beginStageDrag = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ): void => {
    if (event.button !== 0) return;
    const session = sessionRef.current;
    const request = requestRef.current;
    const targetId = dragTargetRef.current;
    if (session === null || targetId === undefined || request.cue !== null)
      return;
    const rect = event.currentTarget.getBoundingClientRect();
    const down = stagePointFromClientPoint(rect, event.clientX, event.clientY);
    const object = session.surface.hitTest(down.x, down.y);
    if (object === null || object.id !== targetId || (object.kind !== "sprite" && object.kind !== "emitter"))
      return;
    event.preventDefault();
    const camera = session.surface.camera;
    const origin = { x: object.x, y: object.y };
    const space = object.space === "screen" ? "screen" : "world";
    let position = origin;
    let moved = false;
    gestureCleanupRef.current?.();
    setDragging(true);
    const finish = (): void => {
      if (gestureCleanupRef.current === stop) gestureCleanupRef.current = null;
      setDragging(false);
    };
    const stop = beginStageGesture({
      move: (moveEvent) => {
        const pointer = stagePointFromClientPoint(
          rect,
          moveEvent.clientX,
          moveEvent.clientY,
        );
        position = emitterDragPosition({
          space,
          origin,
          pointerDown: down,
          pointerNow: pointer,
          camera,
        });
        moved = moved || movedEnough(down, pointer);
        session.surface.setObjectOverride(object.id, position);
      },
      release: () => {
        finish();
        const commit = dragCommitRef.current;
        if (!moved || commit === undefined) {
          // A click, or a stage without a commit owner, never leaves a
          // temporary pose behind.
          session.surface.clearOverrides();
          return;
        }
        // The temporary pose stays on the surface until the host commits the
        // authored value and the rebuilt world replaces it, so the sprite never
        // jumps back to its old position in between.
        commit(position);
      },
      abort: () => {
        finish();
        // Overrides never touched the world, so clearing them restores exactly
        // the evaluated pose without a rebuild or an authored change.
        session.surface.clearOverrides();
      },
    });
    gestureCleanupRef.current = stop;
  };

  const duration = request.duration_ms;
  const staticWorld = request.cue === null;
  const busy = status === "loading";
  const grabbable = staticWorld && dragTargetId !== undefined;

  return (
    <section
      className={`cue-preview${staticWorld ? " cue-preview-static" : ""}`}
      ref={sectionRef}
    >
      <div
        className={`cue-preview-stage${grabbable ? " is-draggable" : ""}${
          dragging ? " is-dragging" : ""
        }`}
      >
        <canvas
          aria-label={label}
          className="timeline-stage"
          height={DESIGN_HEIGHT}
          onPointerDown={grabbable ? beginStageDrag : undefined}
          ref={canvasRef}
          width={DESIGN_WIDTH}
        />
        {overlay}
      </div>
      {staticWorld ? (
        status === "error" ? (
          <div className="cue-preview-transport">
            <button onClick={retry} type="button">
              重试
            </button>
          </div>
        ) : decorationTransport?.burst !== undefined ? (
          <div
            aria-busy={busy || pendingMs !== null}
            className="cue-preview-transport cue-preview-burst-transport"
          >
            <button
              aria-keyshortcuts="Space"
              disabled={busy}
              onClick={() => void replayBurst()}
              title="重播单次爆发（空格）"
              type="button"
            >
              ↻ 重播爆发
            </button>
            <button
              disabled={busy || pendingMs !== null}
              onClick={toggleBurst}
              type="button"
            >
              {decorationPlaying ? "❚❚ 暂停" : "▶ 播放"}
            </button>
            <button
              disabled={busy}
              onClick={() => void replayBurst(0, false)}
              type="button"
            >
              ■ 停止
            </button>
            <input
              aria-label={`${label}播放头`}
              disabled={busy}
              max={decorationTransport.durationMs}
              min={0}
              onChange={(event) =>
                void replayBurst(Number(event.currentTarget.value), false)
              }
              step={10}
              type="range"
              value={pendingMs ?? decorationMs}
            />
            <code>
              {Math.round(pendingMs ?? decorationMs)} /{" "}
              {decorationTransport.durationMs} ms
              {pendingMs === null &&
              !decorationPlaying &&
              decorationMs >= decorationTransport.durationMs
                ? " · 已结束"
                : ""}
            </code>
          </div>
        ) : decorationTransport !== undefined ? (
          <div className="cue-preview-transport">
            <button disabled={busy} onClick={toggleDecoration} type="button">
              {decorationPlaying ? "❚❚ 暂停" : "▶ 播放"}
            </button>
            <button disabled={busy} onClick={() => seekDecoration(0)} type="button">
              ■ 停止
            </button>
            <input
              aria-label={`${label}播放头`}
              disabled={busy}
              max={decorationTransport.durationMs}
              min={0}
              onChange={(event) => seekDecoration(Number(event.currentTarget.value))}
              step={10}
              type="range"
              value={decorationMs}
            />
            <code>
              {decorationPlaying ? "播放中" : `${Math.round(decorationMs)} ms`}
            </code>
          </div>
        ) : null
      ) : (
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
            <button
              disabled={status !== "paused"}
              onClick={resume}
              type="button"
            >
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
      )}
    </section>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
