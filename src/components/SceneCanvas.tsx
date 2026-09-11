import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { PresentationController } from "../engine/presentation";
import type { UiMotionHost } from "@vectspace/presentation-core/ui-motion";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type {
  AssetUrlMap,
  PresentationOutcome,
  RuntimeSnapshot,
  RuntimeUpdate,
  Settings,
} from "../engine/types";

export interface SceneCanvasHandle {
  captureThumbnail(): string | null;
  unlockAudio(): Promise<void>;
  skipCurrentPresentation(): boolean;
  cancelCurrentPresentation(): void;
  applySnapshotImmediately(snapshot: RuntimeSnapshot): Promise<void>;
  isPresentationCurrent(updateId: string): boolean;
}

interface SceneCanvasProps {
  update: RuntimeUpdate | null;
  assets: AssetUrlMap;
  animations: AnimationMap;
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

interface PresentationSession {
  controller: PresentationController;
  initialized: Promise<PresentationController>;
}

export const SceneCanvas = forwardRef<SceneCanvasHandle, SceneCanvasProps>(
  function SceneCanvas(
    {
      update,
      assets,
      animations,
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
    const sessionRef = useRef<PresentationSession | null>(null);
    const destroyTimerRef = useRef<number | null>(null);
    const [controller, setController] = useState<PresentationController | null>(
      null,
    );
    const [initializationFailed, setInitializationFailed] = useState(false);

    useEffect(() => {
      if (destroyTimerRef.current !== null) {
        window.clearTimeout(destroyTimerRef.current);
        destroyTimerRef.current = null;
      }
      const canvas = canvasRef.current;
      if (canvas === null) {
        return;
      }
      let session = sessionRef.current;
      if (session === null) {
        const next = new PresentationController(
          canvas,
          initialSettingsRef.current,
          (message) => diagnosticRef.current(message),
          uiMotionHost,
        );
        session = {
          controller: next,
          initialized: next.init().then(() => next),
        };
        sessionRef.current = session;
      }
      const currentSession = session;
      let active = true;
      void currentSession.initialized
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
        // Strict Mode immediately re-runs this effect. Deferring destruction lets
        // that second setup reclaim the same initialized WebGL application.
        destroyTimerRef.current = window.setTimeout(() => {
          if (sessionRef.current !== currentSession) {
            return;
          }
          void currentSession.initialized
            .then(
              (initializedController) => initializedController.destroy(),
              () => undefined,
            )
            .finally(() => {
              if (sessionRef.current === currentSession) {
                sessionRef.current = null;
              }
            });
        }, 0);
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

    useEffect(() => {
      if (controller === null || update === null) {
        return;
      }
      let active = true;
      let outcome: PresentationOutcome = "failed";
      void controller
        .present(update, assets)
        .then((result) => {
          outcome = result;
        })
        .catch((error: unknown) => {
          if (active) {
            console.error("Presentation update failed", error);
            onDiagnostic(`表现同步失败：${errorMessage(error)}`);
          }
        })
        .finally(() => {
          // Cancelling a controller aborts animations but intentionally lets
          // their promises settle.  Guard the callback with the controller's
          // generation as well as the React effect lifetime, otherwise a
          // title/replay transition could acknowledge an old RuntimeUpdate
          // after the host has already switched sessions.
          if (active && controller.isPresentationCurrent(update.update_id)) {
            onSettled(update, outcome);
          }
        });
      return () => {
        active = false;
      };
    }, [assets, controller, onDiagnostic, onSettled, update]);

    useEffect(() => {
      if (initializationFailed && update !== null) {
        // A rendering failure must not leave a Runtime-gated story permanently locked.
        // Renderer initialization failures release gates without marking them seen.
        onSettled(update, "failed");
      }
    }, [initializationFailed, onSettled, update]);

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

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
