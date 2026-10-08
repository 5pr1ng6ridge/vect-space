import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";

import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
} from "@vectspace/presentation-core/scene-frame";
import { DeferredSession } from "@vectspace/presentation-core/deferred-session";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type {
  RuntimeSnapshot,
  RuntimeUpdate,
} from "@vectspace/presentation-core/types";

import { assetUrl } from "../api";
import type { EditorAsset, SpriteSnapshot, TimelineNode } from "../types";
import {
  createEditorTimelinePreview,
  disposeEditorTimelinePreview,
  type EditorPreviewEnvironment,
  type EditorTimelinePreview,
} from "./timelinePreview";
import { errorMessage } from "./errorMessage";

const PREVIEW_SPRITE_ID = "action.preview";

export interface ActionPreviewHandle {
  seek(ms: number): void;
}

interface ActionPreviewProps {
  node: TimelineNode;
  base: SpriteSnapshot;
  asset: string | null;
  assets: EditorAsset[];
  animations: AnimationMap;
  playhead: number;
  onPlayheadChange(ms: number): void;
  onError(message: string): void;
  environment?: EditorPreviewEnvironment;
}

/**
 * Real Pixi preview for a reusable sprite action.
 *
 * An action has no story location of its own, so this component builds a tiny
 * in-memory snapshot/update pair around the author-selected base pose.  The
 * pixels and clock still go through the exact SceneSurface + TimelineSession
 * used by story timelines and by the game.
 */
export const ActionPreview = forwardRef<
  ActionPreviewHandle,
  ActionPreviewProps
>(function ActionPreview(
  {
    node,
    base,
    asset,
    assets,
    animations,
    playhead,
    onPlayheadChange,
    onError,
    environment,
  },
  ref,
): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lifecycleRef = useRef<DeferredSession<EditorTimelinePreview> | null>(
    null,
  );
  const sessionRef = useRef<EditorTimelinePreview["session"] | null>(null);
  const readyRef = useRef<Promise<void>>(Promise.resolve());
  const generationRef = useRef(0);
  const playheadRef = useRef(playhead);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const urls = useMemo(
    () =>
      Object.fromEntries(
        assets.map((candidate) => [
          candidate.id,
          assetUrl(candidate.absolute_path),
        ]),
      ),
    [assets],
  );

  const request = useMemo(
    () => buildActionPreviewRequest(node, base, asset),
    [asset, base, node],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    lifecycleRef.current ??= new DeferredSession<EditorTimelinePreview>({
      create: () => {
        const created = createEditorTimelinePreview(
          canvas,
          onError,
          environment,
        );
        return {
          session: created.preview,
          initialized: created.initialized,
        };
      },
      dispose: disposeEditorTimelinePreview,
    });
    const lifecycle = lifecycleRef.current;
    const handle = lifecycle.acquire();
    const preview = handle.session;
    preview.session.setMuted(true);
    preview.session.setFrameListener((frame) => {
      playheadRef.current = frame.elapsed_ms;
      onPlayheadChange(frame.elapsed_ms);
    });
    preview.session.setPlayingListener(setPlaying);
    sessionRef.current = preview.session;
    readyRef.current = handle.initialized.then(() => undefined);
    void readyRef.current.catch((reason: unknown) => {
      onError(`动作 Pixi 预览初始化失败：${errorMessage(reason)}`);
    });
    return () => {
      generationRef.current += 1;
      preview.session.setFrameListener(null);
      preview.session.setPlayingListener(null);
      if (sessionRef.current === preview.session) sessionRef.current = null;
      lifecycle.release();
    };
  }, [environment, onError, onPlayheadChange]);

  useEffect(() => {
    const session = sessionRef.current;
    if (session === null || request === null) {
      setLoaded(false);
      return;
    }
    const generation = ++generationRef.current;
    setLoaded(false);
    void readyRef.current
      .then(() =>
        session.load({
          update: request.update,
          assets: urls,
          snapshot: request.snapshot,
          world: "restore",
          animations,
        }),
      )
      .then(async (status) => {
        if (
          status !== "loaded" ||
          generation !== generationRef.current ||
          sessionRef.current !== session
        )
          return;
        await session.seek(playheadRef.current, "scrub");
        if (
          generation === generationRef.current &&
          sessionRef.current === session
        )
          setLoaded(true);
      })
      .catch((reason: unknown) => {
        if (generation !== generationRef.current) return;
        setLoaded(false);
        onError(`动作预览加载失败：${errorMessage(reason)}`);
      });
  }, [animations, onError, request, urls]);

  const seek = useCallback(
    (ms: number): void => {
      const session = sessionRef.current;
      const elapsed = Math.max(0, Math.min(node.duration_ms, ms));
      playheadRef.current = elapsed;
      onPlayheadChange(elapsed);
      if (session === null) return;
      session.pause();
      void session.seek(elapsed, "scrub").catch((reason: unknown) => {
        onError(`动作预览定位失败：${errorMessage(reason)}`);
      });
    },
    [node.duration_ms, onError, onPlayheadChange],
  );

  useImperativeHandle(ref, () => ({ seek }), [seek]);

  const togglePlayback = (): void => {
    const session = sessionRef.current;
    if (session === null || !loaded) return;
    if (playing) {
      session.pause();
      return;
    }
    void (async (): Promise<void> => {
      if (playheadRef.current >= node.duration_ms) {
        await session.seek(0, "scrub");
      }
      await session.play();
    })().catch((reason: unknown) => {
      onError(`动作预览播放失败：${errorMessage(reason)}`);
    });
  };

  return (
    <section className="action-scene-preview">
      <div className="action-scene-preview-stage">
        <canvas
          aria-label="立绘动作 Pixi 预览"
          className="timeline-stage"
          height={DESIGN_HEIGHT}
          ref={canvasRef}
          width={DESIGN_WIDTH}
        />
        {asset === null && (
          <p className="action-scene-preview-empty">项目中没有可用立绘素材</p>
        )}
      </div>
      <div className="action-scene-preview-transport">
        <button disabled={!loaded} onClick={togglePlayback} type="button">
          {playing ? "❚❚" : "▶"}
        </button>
        <button disabled={!loaded} onClick={() => seek(0)} type="button">
          ■
        </button>
        <code>
          {Math.round(playhead)} / {node.duration_ms} ms
        </code>
        <input
          aria-label="动作预览播放头"
          disabled={!loaded}
          max={node.duration_ms}
          min={0}
          onChange={(event) => seek(Number(event.currentTarget.value))}
          type="range"
          value={playhead}
        />
      </div>
    </section>
  );
});

function buildActionPreviewRequest(
  node: TimelineNode,
  base: SpriteSnapshot,
  asset: string | null,
): { snapshot: RuntimeSnapshot; update: RuntimeUpdate } | null {
  if (asset === null) return null;
  const location = { scene_id: "__action_preview__", node_id: "timeline" };
  const world = {
    background: null,
    sprites: {
      [PREVIEW_SPRITE_ID]: { ...base, asset },
    },
    buttons: {},
    camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
    dialogue_ui_visible: false,
    ui_motion_bindings: {},
    persistent_effects: [],
  };
  const snapshot: RuntimeSnapshot = {
    revision: "0",
    location,
    variables: {},
    world,
    audio: { bgm: null },
    playback: { auto: "normal", ctrl_fast_forward: "allow" },
    prompt: { kind: "none" },
  };
  const update: RuntimeUpdate = {
    update_id: "0",
    snapshot,
    cues: [
      {
        cue_id: "0",
        gate: "none",
        type: "timeline",
        presentation_id: "action-preview",
        duration_ms: node.duration_ms,
        skippable: true,
        is_seen: true,
        tracks: node.tracks,
        events: [],
      },
    ],
    requires_ack: false,
  };
  return { snapshot, update };
}
