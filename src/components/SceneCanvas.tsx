import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
} from "react";

import { PresentationController } from "../engine/presentation";
import type { AssetUrlMap, RuntimeUpdate, Settings } from "../engine/types";

export interface SceneCanvasHandle {
  captureThumbnail(): string | null;
  unlockAudio(): Promise<void>;
}

interface SceneCanvasProps {
  update: RuntimeUpdate | null;
  assets: AssetUrlMap;
  settings: Settings;
  typingSfxActive: boolean;
  playbackRate: number;
  suppressOneShots: boolean;
  onSettled(update: RuntimeUpdate): void;
  onDiagnostic(message: string): void;
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
      settings,
      typingSfxActive,
      playbackRate,
      suppressOneShots,
      onSettled,
      onDiagnostic,
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
    }, []);

    useEffect(() => {
      controller?.applySettings(settings);
    }, [controller, settings]);

    useEffect(() => {
      controller?.setPlaybackMode(playbackRate, suppressOneShots);
    }, [controller, playbackRate, suppressOneShots]);

    useEffect(() => {
      if (controller === null) {
        return;
      }
      void controller
        .setTypingSfx(typingSfxActive, assets)
        .catch((error: unknown) => {
          console.error("Typing SFX failed", error);
          onDiagnostic(`打字音效加载失败：${errorMessage(error)}`);
        });
    }, [assets, controller, onDiagnostic, typingSfxActive]);

    useEffect(() => {
      if (controller === null || update === null) {
        return;
      }
      let active = true;
      void controller
        .present(update, assets)
        .catch((error: unknown) => {
          if (active) {
            console.error("Presentation update failed", error);
            onDiagnostic(`表现同步失败：${errorMessage(error)}`);
          }
        })
        .finally(() => {
          if (active) {
            onSettled(update);
          }
        });
      return () => {
        active = false;
      };
    }, [assets, controller, onDiagnostic, onSettled, update]);

    useEffect(() => {
      if (initializationFailed && update !== null) {
        // A rendering failure must not leave a Runtime-gated story permanently locked.
        onSettled(update);
      }
    }, [initializationFailed, onSettled, update]);

    useImperativeHandle(
      ref,
      () => ({
        captureThumbnail: () => controller?.captureThumbnail() ?? null,
        unlockAudio: () => controller?.unlockAudio() ?? Promise.resolve(),
      }),
      [controller],
    );

    return (
      <canvas
        className="scene-canvas"
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
