import { useMemo, useState, type ReactElement } from "react";
import { isAssetDrag, resolveBackgroundDrop } from "../../assetDrag";
import { useAssetLayout } from "../AssetChooser";
import type { EditorAsset, SceneDefinition, SceneNode } from "../../types";
import { CuePreview } from "../CuePreview";
import type { CuePreviewEnvironment } from "../CuePreview";
import {
  buildBackgroundPreviewRequest,
  buildCurtainPreviewRequest,
  buildScreenEffectPreviewRequest,
  storyVisualStateAtNode,
} from "../../presentationPreview";

export function BackgroundPreview({
  assets,
  environment,
  node,
  nodeId,
  onChange,
  onError,
  scene,
}: {
  assets: readonly EditorAsset[];
  environment: CuePreviewEnvironment | undefined;
  node: Extract<SceneNode, { type: "background" }>;
  nodeId: string;
  onChange(node: SceneNode): void;
  onError: ((message: string) => void) | undefined;
  scene: SceneDefinition;
}): ReactElement {
  const request = useMemo(
    () =>
      buildBackgroundPreviewRequest(
        node,
        storyVisualStateAtNode(scene, nodeId),
      ),
    [node, nodeId, scene],
  );
  const layout = useAssetLayout();
  const [dragOver, setDragOver] = useState(false);
  return (
    <CuePreview
      assets={assets}
      environment={environment}
      label="背景转场预览"
      onError={onError}
      overlay={
        <div
          className={`stage-drop-target${dragOver ? " is-active" : ""}`}
          onDragLeave={() => setDragOver(false)}
          onDragOver={(event) => {
            // Every drag over the stage canvas is consumed, including one the
            // canvas refuses: an uncancelled drag leaves the WebView free to
            // open a dropped OS file (or the file's target) and throw away
            // unsaved authoring.  Only an internal single-asset drag offers
            // the drop affordance; a refused payload is consumed silently.
            event.preventDefault();
            const internal = isAssetDrag(event.dataTransfer);
            event.dataTransfer.dropEffect = internal ? "copy" : "none";
            setDragOver(internal);
          }}
          onDrop={(event) => {
            // Consumed unconditionally: dropping on the canvas is never a file
            // import (that is the asset library's own drop zone) and a refused
            // drop must not bubble into another target either.
            event.preventDefault();
            event.stopPropagation();
            setDragOver(false);
            if (!isAssetDrag(event.dataTransfer)) return;
            const id = resolveBackgroundDrop(
              event.dataTransfer,
              assets,
              layout,
            );
            // Re-dropping the background the node already shows is a no-op:
            // an unchanged value must never create an undo entry.
            if (id === null || id === node.background) return;
            onChange({ ...node, background: id });
          }}
        >
          {dragOver && <span>松开以更换背景</span>}
        </div>
      }
      request={request}
    />
  );
}

export function CurtainPreview({
  assets,
  environment,
  node,
  nodeId,
  onError,
  scene,
}: {
  assets: readonly EditorAsset[];
  environment: CuePreviewEnvironment | undefined;
  node: Extract<SceneNode, { type: "curtain" }>;
  nodeId: string;
  onError: ((message: string) => void) | undefined;
  scene: SceneDefinition;
}): ReactElement {
  const request = useMemo(
    () =>
      buildCurtainPreviewRequest(node, storyVisualStateAtNode(scene, nodeId)),
    [node, nodeId, scene],
  );
  return (
    <CuePreview
      assets={assets}
      environment={environment}
      label="幕布预览"
      onError={onError}
      request={request}
    />
  );
}

export function ScreenEffectPreview({
  assets,
  environment,
  node,
  nodeId,
  onError,
  scene,
}: {
  assets: readonly EditorAsset[];
  environment: CuePreviewEnvironment | undefined;
  node: Extract<SceneNode, { type: "screen_effect" }>;
  nodeId: string;
  onError: ((message: string) => void) | undefined;
  scene: SceneDefinition;
}): ReactElement {
  const request = useMemo(
    () =>
      buildScreenEffectPreviewRequest(
        node,
        storyVisualStateAtNode(scene, nodeId),
      ),
    [node, nodeId, scene],
  );
  return (
    <CuePreview
      assets={assets}
      environment={environment}
      label="屏幕效果预览"
      onError={onError}
      request={request}
    />
  );
}
