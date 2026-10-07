import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { PresentationController } from "@vectspace/presentation-core/gameplay-host";
import { DeferredSession } from "@vectspace/presentation-core/deferred-session";
import { BoundedLedger } from "@vectspace/presentation-core/ledger";
import type { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type { TextBlockMap } from "@vectspace/presentation-core/text-block";
import type { ParticleMap } from "@vectspace/presentation-core/particles";
import type {
  AssetUrlMap,
  PresentationOutcome,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
} from "@vectspace/presentation-core/types";

export interface SceneCanvasHandle {
  captureThumbnail(): string | null;
  unlockAudio(): Promise<void>;
  skipCurrentPresentation(): boolean;
  cancelCurrentPresentation(): void;
  applySnapshotImmediately(snapshot: RuntimeSnapshot): Promise<void>;
  /** Covers the canvas with the host-only session curtain. */
  coverSession(): Promise<void>;
  /** Reveals the session curtain after the replacement is on screen. */
  revealSession(): Promise<void>;
  /** Covers, hard-aligns the snapshot and reveals again (session switch). */
  applySessionSnapshot(snapshot: RuntimeSnapshot): Promise<void>;
  isPresentationCurrent(updateId: string): boolean;
}

interface SceneCanvasProps {
  /**
   * The story update that owns the presentation.  Only its identity
   * (`session_id` + `update_id`) restarts the presentation: a live refresh of
   * the same story update (new snapshot object, same ids) must not cancel the
   * running cues or the pending settle callback.
   */
  update: RuntimeUpdate | null;
  /**
   * Timer effect updates delivered since the story update, in order.  Each one
   * runs once, beside the story, through the controller's effect path.
   */
  effects?: readonly RuntimeUpdate[];
  /**
   * Ids of the Scene timers that are still active in the live snapshot
   * (`snapshot.interaction.timers`), or `null`/absent when unknown.  A repeating
   * timer that disappears from it was stopped: its in-flight effects are
   * cancelled, nothing else is touched.
   */
  activeTimers?: readonly string[] | null;
  assets: AssetUrlMap;
  animations: AnimationMap;
  textBlocks?: TextBlockMap;
  particles?: ParticleMap;
  settings: Settings;
  typingSfxActive: boolean;
  typingSfxCps: number;
  playbackRate: number;
  suppressOneShots: boolean;
  paused: boolean;
  visible: boolean;
  onSettled(update: RuntimeUpdate, outcome: PresentationOutcome): void;
  onDiagnostic(message: string): void;
  uiMotionHost: UiMotionHost;
}

export const SceneCanvas = forwardRef<SceneCanvasHandle, SceneCanvasProps>(
  function SceneCanvas(
    {
      update,
      effects = NO_EFFECTS,
      activeTimers = null,
      assets,
      animations,
      textBlocks = NO_TEXT_BLOCKS,
      particles = NO_PARTICLES,
      settings,
      typingSfxActive,
      typingSfxCps,
      playbackRate,
      suppressOneShots,
      paused,
      visible,
      onSettled,
      onDiagnostic,
      uiMotionHost,
    },
    ref,
  ): ReactElement {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const initialSettingsRef = useRef(settings);
    const diagnosticRef = useRef(onDiagnostic);
    const uiMotionHostRef = useRef(uiMotionHost);
    const lifecycleRef = useRef<DeferredSession<PresentationController> | null>(
      null,
    );
    const [controller, setController] = useState<PresentationController | null>(
      null,
    );
    const [initializationFailed, setInitializationFailed] = useState(false);
    // The presentation effect is keyed by story identity, not by object
    // identity, so it reads everything else through this ref.  It is written in
    // an effect declared before the presentation effects, which React runs in
    // order within one commit.
    const latestRef = useRef({ update, assets, onSettled, onDiagnostic });
    const effectLedgerRef = useRef(new BoundedLedger<string>(256));
    // Timers whose effect re-armed itself (still present in the effect's own
    // snapshot): only those can be "stopped" by vanishing from the live state.
    // A one-shot timer is removed when it fires, and its effect must run on.
    const repeatingOwnersRef = useRef(new Set<string>());
    const activeTimerKey =
      activeTimers === null ? null : JSON.stringify([...activeTimers].sort());

    useEffect(() => {
      diagnosticRef.current = onDiagnostic;
      uiMotionHostRef.current = uiMotionHost;
    }, [onDiagnostic, uiMotionHost]);

    useEffect(() => {
      latestRef.current = { update, assets, onSettled, onDiagnostic };
    }, [assets, onDiagnostic, onSettled, update]);

    useEffect(() => {
      const canvas = canvasRef.current;
      if (canvas === null) {
        return;
      }
      const existing = lifecycleRef.current;
      if (existing === null) {
        lifecycleRef.current = new DeferredSession<PresentationController>({
          create: () => {
            const controller = new PresentationController(
              canvas,
              initialSettingsRef.current,
              (message: string) => diagnosticRef.current(message),
              uiMotionHostRef.current,
            );
            return { session: controller, initialized: controller.init() };
          },
          dispose: (controller) => controller.destroy(),
        });
      }
      const lifecycle = lifecycleRef.current;
      if (lifecycle === null) {
        return;
      }
      // Strict Mode immediately re-runs this effect: the shared lifecycle
      // defers destruction by one task so that second setup reclaims the same
      // initialized WebGL application instead of tearing it down.
      const handle = lifecycle.acquire();
      let active = true;
      void handle.initialized
        .then((initializedController) => {
          if (active) {
            setController(initializedController);
          }
        })
        .catch((error: unknown) => {
          console.error("Pixi WebGL initialization failed", error);
          if (active) {
            diagnosticRef.current(
              `Pixi WebGL 初始化失败：${errorMessage(error)}`,
            );
            setInitializationFailed(true);
          }
        });
      return () => {
        active = false;
        setController(null);
        lifecycle.release();
      };
    }, [uiMotionHost]);

    useEffect(() => {
      controller?.applySettings(settings);
    }, [controller, settings]);

    useEffect(() => {
      controller?.setPlaybackMode(playbackRate, suppressOneShots);
    }, [controller, playbackRate, suppressOneShots]);

    useEffect(() => {
      controller?.setPaused(paused);
    }, [controller, paused]);

    useEffect(() => {
      // Frame lists are replaced whenever the host re-resolves assets.  The
      // controller keeps each instance's loop position unless its asset
      // actually changed, so this never restarts a running animation.
      controller?.setAnimationAssets(animations);
    }, [animations, controller]);

    useEffect(() => {
      controller?.setVisualResources(textBlocks, particles);
    }, [controller, particles, textBlocks]);

    useEffect(() => {
      if (controller === null) {
        return;
      }
      void controller
        .setTypingSfx(typingSfxActive, assets, typingSfxCps)
        .catch((error: unknown) => {
          console.error("Typing SFX failed", error);
          onDiagnostic(`打字音效加载失败：${errorMessage(error)}`);
        });
    }, [assets, controller, onDiagnostic, typingSfxActive, typingSfxCps]);

    const storyUpdateId = update?.update_id ?? null;
    const storySessionId = update?.session_id ?? null;
    useEffect(() => {
      const target = latestRef.current.update;
      if (controller === null || target === null) {
        return;
      }
      let active = true;
      let outcome: PresentationOutcome = "failed";
      void controller
        .present(target, latestRef.current.assets)
        .then((result) => {
          outcome = result;
        })
        .catch((error: unknown) => {
          if (active) {
            console.error("Presentation update failed", error);
            latestRef.current.onDiagnostic(
              `表现同步失败：${errorMessage(error)}`,
            );
          }
        })
        .finally(() => {
          // Cancelling a controller aborts animations but intentionally lets
          // their promises settle.  Guard the callback with the controller's
          // generation as well as the React effect lifetime, otherwise a
          // title/replay transition could acknowledge an old RuntimeUpdate
          // after the host has already switched sessions.
          if (active && controller.isPresentationCurrent(target.update_id)) {
            const current = latestRef.current.update;
            latestRef.current.onSettled(
              current?.update_id === target.update_id ? current : target,
              outcome,
            );
          }
        });
      return () => {
        active = false;
      };
      // Deliberately keyed by story identity: a state refresh replaces the
      // update object but must not restart (or orphan the settle of) the
      // presentation that is still running.
    }, [controller, storyUpdateId, storySessionId]);

    useEffect(() => {
      effectLedgerRef.current.clear();
      repeatingOwnersRef.current.clear();
    }, [controller]);

    useEffect(() => {
      if (controller === null || activeTimerKey === null) return;
      const active = new Set(JSON.parse(activeTimerKey) as string[]);
      for (const owner of [...repeatingOwnersRef.current]) {
        if (active.has(owner)) continue;
        repeatingOwnersRef.current.delete(owner);
        controller.cancelEffectsOf(owner);
      }
    }, [activeTimerKey, controller]);

    useEffect(() => {
      if (controller === null || effects.length === 0) return;
      for (const effect of effects) {
        const key = `${effect.session_id ?? ""}:${effect.update_id}`;
        if (!effectLedgerRef.current.consume(key)) continue;
        const owner = effect.effect_timer ?? null;
        if (
          owner !== null &&
          effect.snapshot.interaction?.timers?.[owner] !== undefined
        ) {
          // A repeating timer that the live state already shows as stopped must
          // not start another cycle from an effect that was still queued.
          if (
            activeTimerKey !== null &&
            !(JSON.parse(activeTimerKey) as string[]).includes(owner)
          ) {
            continue;
          }
          repeatingOwnersRef.current.add(owner);
        }
        void controller
          .runEffect(effect, latestRef.current.assets)
          .then((result) => {
            // The host never expects an acknowledgement for a timer effect
            // today, but if it ever does the pending presentation must settle.
            if (effect.requires_ack) {
              latestRef.current.onSettled(effect, result);
            }
          })
          .catch((error: unknown) => {
            console.error("Timer effect failed", error);
            latestRef.current.onDiagnostic(
              `表现同步失败：${errorMessage(error)}`,
            );
          });
      }
    }, [activeTimerKey, controller, effects]);

    useEffect(() => {
      const target = latestRef.current.update;
      if (initializationFailed && target !== null) {
        // A rendering failure must not leave a Runtime-gated story permanently locked.
        // Renderer initialization failures release gates without marking them seen.
        latestRef.current.onSettled(target, "failed");
      }
    }, [initializationFailed, storyUpdateId, storySessionId]);

    useImperativeHandle(
      ref,
      () => ({
        captureThumbnail: () => controller?.captureThumbnail() ?? null,
        unlockAudio: () => controller?.unlockAudio() ?? Promise.resolve(),
        skipCurrentPresentation: () =>
          controller?.skipCurrentPresentation() ?? false,
        cancelCurrentPresentation: () =>
          controller?.cancelCurrentPresentation(),
        applySnapshotImmediately: (snapshot) =>
          controller?.applySnapshotImmediately(snapshot, assets) ??
          Promise.resolve(),
        coverSession: () => controller?.coverSession() ?? Promise.resolve(),
        revealSession: () => controller?.revealSession() ?? Promise.resolve(),
        applySessionSnapshot: (snapshot) =>
          controller?.applySessionSnapshot(snapshot, assets) ??
          Promise.resolve(),
        isPresentationCurrent: (updateId) =>
          controller?.isPresentationCurrent(updateId) ?? false,
      }),
      [assets, controller],
    );

    return (
      <canvas
        className={`scene-canvas${visible ? "" : " scene-canvas-hidden"}`}
        height={1080}
        ref={canvasRef}
        width={1920}
      />
    );
  },
);

const NO_EFFECTS: readonly RuntimeUpdate[] = [];
const NO_TEXT_BLOCKS: TextBlockMap = {};
const NO_PARTICLES: ParticleMap = {};

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
