import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";

import { ChoiceLayer } from "@vectspace/presentation-react/choice";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type {
  ChoicePrompt,
  StoryLocation,
} from "@vectspace/presentation-core/types";

import { assetUrl, editorApi } from "../api";
import { projectRequest } from "../story";
import type {
  EditorAsset,
  EditorProject,
  PreviewChoiceDecision,
  ScalarValue,
} from "../types";

export interface ChoicePreviewProps {
  /** The current project; its identity changes on every committed edit. */
  project: EditorProject;
  sceneId: string;
  nodeId: string;
  assets?: readonly EditorAsset[];
  /** The project's resolved animation map; shared with the game host. */
  animations?: AnimationMap;
  /** Saved preview-path decisions for this scene (layout.timeline_previews). */
  choices?: PreviewChoiceDecision[];
  variableOverrides?: Record<string, ScalarValue>;
  importTokens?: string[];
  /** Reports the latest Rust-filtered prompt to authoring controls. */
  onResolvedPrompt?(prompt: ChoicePrompt | null): void;
}

type ChoicePreviewState =
  | { status: "loading" }
  | { status: "ready"; prompt: ChoicePrompt }
  | { status: "not_choice" }
  | { status: "needs_choice"; location: StoryLocation }
  | { status: "unreachable"; message: string }
  | { status: "error"; message: string };

const DESIGN_WIDTH = 1920;
const DESIGN_HEIGHT = 1080;
const FALLBACK_SCALE = 0.25;

/**
 * Inspector preview of a choice node's resolved prompt.
 *
 * It asks the Rust runtime preview path (`build_node_preview`) for the real
 * entering state, executes the node there and renders the returned
 * `PromptSnapshot` through the shared `ChoiceLayer`.  The preview therefore
 * shows exactly what the game would show: the filtered option set, the
 * interpolated labels, the resolved per-item templates, `gui` icons and the
 * design-pixel rects.
 *
 * Guarantees:
 *
 * - read-only: nothing is committed and `onChoose` is intentionally inert,
 * - silent: no audio graph is ever constructed,
 * - deterministic: the same request always yields the same prompt,
 * - cancellable: a superseded or unmounted request can never write state,
 * - Strict Mode safe: the effect's cleanup invalidates its own generation, so
 *   the dev double-invoke produces at most one committed result.
 */
export function ChoicePreview({
  project,
  sceneId,
  nodeId,
  assets = [],
  animations = {},
  choices = [],
  variableOverrides = {},
  importTokens = [],
  onResolvedPrompt,
}: ChoicePreviewProps): ReactElement {
  const [state, setState] = useState<ChoicePreviewState>({ status: "loading" });
  const stageRef = useRef<HTMLDivElement>(null);
  const scale = useStageScale(stageRef, DESIGN_WIDTH);
  const generationRef = useRef(0);
  const onResolvedPromptRef = useRef(onResolvedPrompt);
  useEffect(() => {
    onResolvedPromptRef.current = onResolvedPrompt;
  }, [onResolvedPrompt]);
  const sceneChoices = useMemo(
    () => choices.filter((choice) => choice.scene_id === sceneId),
    [choices, sceneId],
  );
  const urls = useMemo(
    () =>
      Object.fromEntries(
        assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]),
      ),
    [assets],
  );
  const overridesSignature = useMemo(
    () => JSON.stringify(variableOverrides),
    [variableOverrides],
  );
  const choicesSignature = useMemo(
    () => JSON.stringify(sceneChoices),
    [sceneChoices],
  );
  // The import-token list may be a fresh array on every parent render; the
  // joined key is the stable identity the effect actually depends on, so a
  // re-render can never re-fire the host preview request (and an infinite
  // request loop is impossible).
  const importTokensKey = importTokens.join("\u0000");

  useEffect(() => {
    const generation = ++generationRef.current;
    let active = true;
    // Do not let authoring controls reuse a prompt from a superseded project
    // revision while the Rust-filtered replacement is being built.
    onResolvedPromptRef.current?.(null);
    // Small settle window: typing in the inspector should not fire one host
    // round trip per keystroke, and a request that is already superseded never
    // even starts.
    const timer = window.setTimeout(() => {
      void editorApi
        .buildNodePreview({
          project: projectRequest(project, importTokens),
          target: { scene_id: sceneId, node_id: nodeId },
          variable_overrides: variableOverrides,
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
          const prompt = result.update.snapshot.prompt;
          if (prompt.kind === "choice") {
            setState({ status: "ready", prompt });
            onResolvedPromptRef.current?.(prompt);
          } else {
            setState({ status: "not_choice" });
            onResolvedPromptRef.current?.(null);
          }
        })
        .catch((reason: unknown) => {
          if (!active || generation !== generationRef.current) return;
          setState({ status: "error", message: errorMessage(reason) });
          onResolvedPromptRef.current?.(null);
        });
    }, 200);
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
    overridesSignature,
    choicesSignature,
  ]);

  return (
    <section className="choice-preview">
      <div
        className="choice-preview-stage"
        ref={stageRef}
        style={{ height: Math.round(DESIGN_HEIGHT * scale) }}
      >
        {state.status === "ready" && (
          <div
            className="choice-preview-design"
            style={{
              width: DESIGN_WIDTH,
              height: DESIGN_HEIGHT,
              transform: `scale(${scale})`,
            }}
          >
            <ChoiceLayer
              animations={animations}
              assets={urls}
              disabled={false}
              onChoose={() => undefined}
              prompt={state.prompt}
            />
          </div>
        )}
        {state.status === "loading" && (
          <p className="choice-preview-note">正在通过运行时解析预览…</p>
        )}
        {state.status === "not_choice" && (
          <p className="choice-preview-note">目标节点当前不是 choice 提示。</p>
        )}
        {state.status === "needs_choice" && (
          <p className="choice-preview-note">
            预览需要先补充路径选择：
            {state.location.scene_id}/{state.location.node_id}
          </p>
        )}
        {state.status === "unreachable" && (
          <p className="choice-preview-note">
            无法从场景入口到达该节点：{state.message}
          </p>
        )}
        {state.status === "error" && (
          <p className="choice-preview-note">预览失败：{state.message}</p>
        )}
      </div>
      {state.status === "ready" && (
        <>
          <div className="choice-preview-meta">
            <small>
              锚点 {state.prompt.layout.anchor_x},{" "}
              {state.prompt.layout.anchor_y} ·
              {state.prompt.layout.direction === "horizontal"
                ? " 横向"
                : " 纵向"}{" "}
              · 间距 {state.prompt.layout.gap}
            </small>
            {state.prompt.diagnostics.length > 0 && (
              <small className="choice-preview-diagnostics">
                {state.prompt.diagnostics
                  .map((diagnostic) => diagnostic.message)
                  .join("；")}
              </small>
            )}
          </div>
          <ul className="choice-preview-options">
            {state.prompt.choices.map((choice) => (
              <li key={choice.id}>
                <code>{choice.id}</code>
                <span>
                  {choice.x}, {choice.y} · {choice.width}×{choice.height}
                </span>
                <span>
                  {choice.template.kind === "button"
                    ? `模板 ${choice.template.button.template}`
                    : "内置 CSS 按钮"}
                </span>
                <span>
                  {choice.icon == null ? "无图标" : `图标 ${choice.icon}`}
                </span>
                <span>{choice.enabled ? "可选" : "禁用"}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function useStageScale(
  ref: RefObject<HTMLDivElement | null>,
  designWidth: number,
): number {
  const [scale, setScale] = useState(FALLBACK_SCALE);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;
    const update = (): void => {
      const width = element.clientWidth;
      if (width > 0) setScale(width / designWidth);
    };
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [designWidth, ref]);
  return scale;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
