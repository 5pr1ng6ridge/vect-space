import { useState, type ReactElement } from "react";
import { canConvertToTimeline, defaultNode } from "../story";
import type {
  AnimationFile,
  ActionFile,
  ContentManifest,
  EditorAsset,
  ScalarValue,
  SceneDefinition,
  SceneNode,
  UiMotionFile,
  ButtonFile,
  EditorProject,
  PreviewChoiceDecision,
} from "../types";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type { ChoicePrompt } from "@vectspace/presentation-core/types";
import type { CuePreviewEnvironment } from "./CuePreview";
import { MousePointerClick } from "lucide-react";
import { EmptyState } from "../ui/Display";
import { InspectorSceneContext } from "./inspector/sceneContext";
import { InspectorHeader } from "./inspector/InspectorHeader";
import { renderFields } from "./inspector/renderFields";

interface NodeInspectorProps {
  scene: SceneDefinition;
  manifest: ContentManifest;
  nodeId: string | null;
  onChange(nodeId: string, node: SceneNode): void;
  onRename(previousId: string, nextId: string): void;
  onDelete(nodeId: string): void;
  onDuplicate(nodeId: string): void;
  onConvertToTimeline(nodeId: string): void;
  /** Inline a reusable sprite action into an ordinary Timeline node. */
  onConvertActionToTimeline?(nodeId: string): void | Promise<void>;
  onSplitDialogue(nodeId: string, offset: number, text?: string): void;
  onSplitLongText(nodeId: string, stepIndex: number): void;
  onSetEntry(nodeId: string): void;
  onOpenLongTextWorkspace(nodeId: string): void;
  uiMotions: UiMotionFile[];
  buttons: ButtonFile[];
  animations?: AnimationFile[];
  actions?: ActionFile[];
  assets?: EditorAsset[];
  /** Scene definitions used to author cross-scene button jumps. */
  scenes?: SceneDefinition[];
  /** Preview diagnostics (Pixi init, decode and cue failures). */
  onError?: (message: string) => void;
  /** Test seam: in-memory render kit for the inspector previews. */
  previewEnvironment?: CuePreviewEnvironment;
  /** Whole project for the Rust-backed Choice inspector preview. */
  previewProject?: EditorProject;
  previewAnimationMap?: AnimationMap;
  previewImportTokens?: string[];
  previewVariableOverrides?: Record<string, ScalarValue>;
  previewChoices?: PreviewChoiceDecision[];
  /** Select a node in the story graph (the target locator). */
  onLocateNode?(nodeId: string): void;
}

export function NodeInspector({
  scene,
  manifest,
  nodeId,
  onChange,
  onRename,
  onDelete,
  onDuplicate,
  onConvertToTimeline,
  onConvertActionToTimeline,
  onSplitDialogue,
  onSplitLongText,
  onSetEntry,
  onOpenLongTextWorkspace,
  uiMotions,
  buttons,
  animations = [],
  actions = [],
  assets = [],
  scenes = [],
  onError,
  previewEnvironment,
  previewProject,
  previewAnimationMap = {},
  previewImportTokens,
  previewVariableOverrides,
  previewChoices,
  onLocateNode,
}: NodeInspectorProps): ReactElement {
  const node = nodeId === null ? undefined : scene.nodes[nodeId];
  const [choicePreviewResolution, setChoicePreviewResolution] = useState<{
    project: EditorProject;
    sceneId: string;
    nodeId: string;
    prompt: ChoicePrompt | null;
  } | null>(null);
  const choicePreviewPrompt =
    choicePreviewResolution !== null &&
    choicePreviewResolution.project === previewProject &&
    choicePreviewResolution.sceneId === scene.id &&
    choicePreviewResolution.nodeId === nodeId
      ? choicePreviewResolution.prompt
      : null;

  if (nodeId === null || node === undefined) {
    return (
      <aside className="inspector empty-inspector">
        <EmptyState icon={MousePointerClick} title="未选择节点">
          在剧情图或脚本视图中选择一个节点，这里会显示它的全部属性。
        </EmptyState>
      </aside>
    );
  }

  const update = (next: SceneNode): void => onChange(nodeId, next);
  const fallback =
    Object.keys(scene.nodes).find((id) => id !== nodeId) ?? nodeId;

  return (
    <InspectorSceneContext.Provider
      value={{ scene, manifest, onLocate: onLocateNode }}
    >
      <aside className="inspector">
        <InspectorHeader
          isEntry={scene.entry === nodeId}
          node={node}
          nodeId={nodeId}
          onChangeType={(type) =>
            update(
              defaultNode(type, fallback, scenes.length > 0 ? scenes : [scene], previewProject?.proofs),
            )
          }
          onConvertActionToTimeline={
            node.type === "action" &&
            onConvertActionToTimeline !== undefined &&
            actions.some((file) => file.definition.id === node.action)
              ? () => void onConvertActionToTimeline(nodeId)
              : undefined
          }
          onConvertToTimeline={
            canConvertToTimeline(node)
              ? () => onConvertToTimeline(nodeId)
              : undefined
          }
          onDelete={() => onDelete(nodeId)}
          onDuplicate={() => onDuplicate(nodeId)}
          onRename={(next) => onRename(nodeId, next)}
          onSetEntry={() => onSetEntry(nodeId)}
        />

        <section className="inspector-section node-fields">
          {renderFields(node, {
            nodeId,
            update,
            scene,
            manifest,
            uiMotions,
            buttons,
            assets,
            animations,
            actions,
            scenes,
            onError,
            previewEnvironment,
            splitDialogue: (offset, text) =>
              onSplitDialogue(nodeId, offset, text),
            splitLongText: (stepIndex) => onSplitLongText(nodeId, stepIndex),
            openLongTextWorkspace: () => onOpenLongTextWorkspace(nodeId),
            preview:
              previewProject === undefined
                ? undefined
                : {
                    project: previewProject,
                    animationMap: previewAnimationMap,
                    importTokens: previewImportTokens ?? [],
                    variableOverrides: previewVariableOverrides ?? {},
                    choices: previewChoices ?? [],
                    onResolvedPrompt: (prompt) =>
                      setChoicePreviewResolution({
                        project: previewProject,
                        sceneId: scene.id,
                        nodeId,
                        prompt,
                      }),
                  },
            choicePreviewPrompt,
            targets: Object.keys(scene.nodes),
          })}
        </section>
      </aside>
    </InspectorSceneContext.Provider>
  );
}
