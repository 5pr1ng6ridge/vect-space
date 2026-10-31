import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { projectRequest } from "../../story";
import { assetUrl, editorApi, previewAssetsToUrls } from "../../api";
import {
  buildEditorVisualResources,
  EMPTY_EDITOR_VISUALS,
  type EditorVisualResources,
} from "../../visualResources";
import { authoredSpritePosition, spriteDragTarget } from "../../stageEdit";
import type { ContentManifest, EditorAsset, SceneNode } from "../../types";
import type { SceneWorldSnapshot } from "@vectspace/presentation-core/scene-surface";
import type {
  PresentationCue,
  StoryLocation,
} from "@vectspace/presentation-core/types";
import type { EmitterSnapshot } from "@vectspace/presentation-core/particles";
import { CuePreview } from "../CuePreview";
import type { BurstCue, CuePreviewEnvironment } from "../CuePreview";
import {
  emitterDragPosition,
  emitterStagePoint,
  roundedPosition,
} from "../particleAreaGeometry";
import { ParticleGizmo } from "../ParticleGizmo";
import { buildWorldPreviewRequest } from "../../presentationPreview";
import type { NodePreviewContext } from "./fieldsContext";
import { errorMessage } from "../errorMessage";

/**
 * Where the sprite stage editor stands while its real entering state is being
 * resolved by the Rust runtime.
 *
 * `loading` keeps the previously resolved world (if any) on screen, so a
 * refetch never blanks the canvas or drops the just-committed pose.
 */
type SpriteStageState =
  | {
      status: "loading";
      world: SceneWorldSnapshot | null;
      burst: BurstCue | null;
      /** Request generation that produced `world`; advances per answer. */
      revision: number;
    }
  | {
      status: "ready";
      world: SceneWorldSnapshot;
      burst: BurstCue | null;
      revision: number;
    }
  | { status: "needs_choice"; location: StoryLocation }
  | { status: "unreachable"; message: string }
  | { status: "error"; message: string };

/** Debounce for the runtime preview request; typing must not fire per key. */
const STAGE_PREVIEW_SETTLE_MS = 200;

function stageWorld(state: SpriteStageState): SceneWorldSnapshot | null {
  return state.status === "loading" || state.status === "ready"
    ? state.world
    : null;
}

function stageRevision(state: SpriteStageState): number {
  return state.status === "loading" || state.status === "ready"
    ? state.revision
    : 0;
}

function stageBurst(state: SpriteStageState): BurstCue | null {
  return state.status === "loading" || state.status === "ready"
    ? state.burst
    : null;
}

/**
 * The runtime's transient burst for `emitterId`, if the node produced one.
 *
 * A burst never enters the snapshot world (it is not saved), so the only
 * place the resolved emitter exists is the node's own `particle_state` cue.
 */
function matchingBurstCue(
  cues: readonly PresentationCue[] | undefined,
  emitterId: string,
): BurstCue | null {
  for (const cue of cues ?? []) {
    if (
      cue.type === "particle_state" &&
      cue.burst &&
      cue.emitter !== null &&
      cue.emitter_id === emitterId
    )
      return cue;
  }
  return null;
}

/**
 * The editable stage of one ordinary `sprite` node.
 *
 * The world is always the real one the runtime produces: the node's own
 * `build_node_preview` result, resolved from the *current* draft and preview
 * decisions, never a graph-walk guess.  `show` and `move` therefore show the
 * exact pose the game will end up at, and dragging the visible sprite writes
 * the authored `x`/`y` once, on release:
 *
 * - the gesture temporarily overrides pixels on the shared surface only,
 * - `hide` removes the sprite, so it has no target and stays read-only,
 * - the authored value is derived from the world position by removing the
 *   resolved expression offset (see `stageEdit.ts`).
 */
export function SpriteStagePreview({
  assets,
  environment,
  manifest,
  node,
  nodeId,
  onChange,
  onError,
  preview,
  sceneId,
}: {
  assets: readonly EditorAsset[];
  environment: CuePreviewEnvironment | undefined;
  manifest: ContentManifest;
  node: Extract<SceneNode, { type: "sprite" | "particle" }>;
  nodeId: string;
  onChange(node: SceneNode): void;
  onError: ((message: string) => void) | undefined;
  preview: NodePreviewContext | undefined;
  sceneId: string;
}): ReactElement {
  const project = preview?.project;
  const choices = preview?.choices;
  const importTokens = preview?.importTokens;
  const variableOverrides = preview?.variableOverrides;
  const [visuals, setVisuals] =
    useState<EditorVisualResources>(EMPTY_EDITOR_VISUALS);
  const [resolvedAssets, setResolvedAssets] =
    useState<readonly EditorAsset[]>(assets);
  const [state, setState] = useState<SpriteStageState>({
    status: "loading",
    world: null,
    burst: null,
    revision: 0,
  });
  const burstEmitterId =
    node.type === "particle" && node.action === "burst"
      ? node.emitter_id
      : null;
  const [attempt, setAttempt] = useState(0);
  const generationRef = useRef(0);
  const sceneChoices = useMemo(
    () => (choices ?? []).filter((choice) => choice.scene_id === sceneId),
    [choices, sceneId],
  );
  // The parent rebuilds the preview inputs on every commit, so the effect keys
  // on signatures instead of object identities: an unrelated re-render may not
  // re-fire a host request (and therefore can never reorder two worlds).
  const importTokensKey = (importTokens ?? []).join("\u0000");
  const overridesKey = JSON.stringify(variableOverrides ?? {});
  const choicesKey = JSON.stringify(sceneChoices);

  useEffect(() => {
    if (project === undefined) return undefined;
    const generation = ++generationRef.current;
    let active = true;
    // Keeping the last world while the replacement is resolved is an
    // intentional external-system synchronization, exactly like the cue
    // preview's own loading state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((current) => ({
      status: "loading",
      world: stageWorld(current),
      burst: stageBurst(current),
      revision: stageRevision(current),
    }));
    // A short settle window keeps typing in the inspector from firing one
    // host round trip per keystroke; a superseded request never starts.
    const timer = window.setTimeout(() => {
      void editorApi
        .buildNodePreview({
          project: projectRequest(project, importTokens ?? []),
          target: { scene_id: sceneId, node_id: nodeId },
          variable_overrides: variableOverrides ?? {},
          choices: sceneChoices,
        })
        .then((result) => {
          if (!active || generation !== generationRef.current) return;
          if (result.status === "needs_choice") {
            setState({ status: "needs_choice", location: result.location });
            return;
          }
          if (result.status === "unreachable") {
            setState({ status: "unreachable", message: result.message });
            return;
          }
          const urls =
            result.assets === undefined
              ? Object.fromEntries(
                  assets.map((asset) => [
                    asset.id,
                    assetUrl(asset.absolute_path),
                  ]),
                )
              : previewAssetsToUrls(result.assets);
          setResolvedAssets(
            result.assets === undefined
              ? assets
              : assets.map((asset) => ({
                  ...asset,
                  absolute_path:
                    result.assets?.find((resolved) => resolved.id === asset.id)
                      ?.absolute_path ?? asset.absolute_path,
                })),
          );
          setVisuals(buildEditorVisualResources(project, urls, result));
          setState({
            status: "ready",
            world: result.update.snapshot.world,
            // Every completed answer is a new revision, even when it reports
            // the same coordinates: the marker uses it to drop a kept drop
            // that an undo made obsolete before this answer arrived.
            revision: generation,
            burst:
              burstEmitterId === null
                ? null
                : matchingBurstCue(result.update.cues, burstEmitterId),
          });
        })
        .catch((reason: unknown) => {
          if (!active || generation !== generationRef.current) return;
          setState({ status: "error", message: errorMessage(reason) });
        });
    }, STAGE_PREVIEW_SETTLE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
      generationRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signatures stand in for the derived decision objects; project identity changes on every commit.
  }, [
    project,
    sceneId,
    nodeId,
    importTokensKey,
    overridesKey,
    choicesKey,
    attempt,
    burstEmitterId,
  ]);

  const world = stageWorld(state);
  const burst = stageBurst(state);
  const request = useMemo(
    () => (world === null ? null : buildWorldPreviewRequest(world)),
    [world],
  );
  if (project === undefined) return <></>;
  if (request === null) {
    return (
      <p className="inspector-preview-note">
        {state.status === "needs_choice"
          ? `预览需要先补充路径选择：${state.location.scene_id}/${state.location.node_id}`
          : state.status === "unreachable"
            ? `无法从场景入口到达该节点：${state.message}`
            : state.status === "error"
              ? `预览失败：${state.message}`
              : "正在通过运行时解析预览…"}
        {state.status === "error" && (
          <button
            onClick={() => setAttempt((current) => current + 1)}
            type="button"
          >
            重试
          </button>
        )}
      </p>
    );
  }
  const spriteId =
    node.type === "sprite"
      ? spriteDragTarget(node)
      : node.action === "start"
        ? `emitter:${node.emitter_id}`
        : null;
  const commitPosition = (position: { x: number; y: number }): boolean => {
    const authored =
      node.type === "sprite"
        ? authoredSpritePosition(node, manifest, position)
        : roundedPosition(position);
    if (authored.x === (node.x ?? null) && authored.y === (node.y ?? null))
      return false;
    onChange({ ...node, x: authored.x, y: authored.y });
    return true;
  };
  // The generation point the runtime resolved: the persistent emitter of a
  // `start`, or the transient emitter of the node's own burst cue.
  const generation: EmitterSnapshot | null =
    node.type !== "particle"
      ? null
      : node.action === "start"
        ? (request.world.emitters?.[node.emitter_id] ?? null)
        : node.action === "burst"
          ? (burst?.emitter ?? null)
          : null;
  const burstDefinition =
    burst?.emitter == null
      ? undefined
      : visuals.particles[burst.emitter.particle];
  const gizmo =
    generation === null ? undefined : (
      <ParticleGizmo
        markerAriaLabel="拖动生成点"
        markerLabel={
          node.type === "particle" && node.action === "burst"
            ? "爆发生成点"
            : "发射器生成点"
        }
        onMarkerDrop={
          state.status === "ready"
            ? ({ pointerDown, pointerNow }) =>
                commitPosition(
                  emitterDragPosition({
                    space: generation.space,
                    origin: { x: generation.x, y: generation.y },
                    pointerDown,
                    pointerNow,
                    camera: request.world.camera,
                  }),
                )
            : undefined
        }
        point={emitterStagePoint(generation, request.world.camera)}
        revision={stageRevision(state)}
      />
    );
  return (
    <>
      <CuePreview
        animations={preview?.animationMap}
        assets={resolvedAssets}
        visuals={visuals}
        decorationTransport={
          burst === null
            ? undefined
            : {
                durationMs: Math.max(
                  1,
                  Math.ceil(burstDefinition?.lifetime_ms.max ?? 1000),
                ),
                burst,
              }
        }
        dragTargetId={
          state.status === "ready" && spriteId !== null ? spriteId : undefined
        }
        environment={environment}
        label={node.type === "sprite" ? "立绘预览" : "粒子预览"}
        onDragCommit={(position) => void commitPosition(position)}
        onError={onError}
        overlay={gizmo}
        request={request}
      />
      {node.type === "particle" ? (
        <p className="inspector-preview-note">
          {node.action === "stop"
            ? "停止节点没有可拖动的目标；画面是执行后的真实结果。"
            : node.action === "burst"
              ? "拖动生成点即可修改 X / Y；单次爆发只在预览中临时播放、不会保存发射器，按空格或“重播爆发”重播。"
              : "拖动生成点或画面中的发射器即可修改 X / Y。"}
        </p>
      ) : spriteId === null ? (
        <p className="inspector-preview-note">
          隐藏节点没有可拖动的目标；画面是执行后的真实结果。
        </p>
      ) : (
        <p className="inspector-preview-note">
          拖动画面中的立绘即可修改 X / Y。
        </p>
      )}
    </>
  );
}
