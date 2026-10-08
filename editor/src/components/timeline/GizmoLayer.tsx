import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";
import type {
  SceneFrame,
  SceneObjectFrame,
} from "@vectspace/presentation-core/scene-frame";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type { ButtonSnapshot } from "@vectspace/presentation-core/types";
import { TemplateButton } from "@vectspace/presentation-react/button";
// The shared gameplay stylesheet carries the `scene-button*` rules the real
// button is styled with; a host-local copy is forbidden by the CSS contract.
import "@vectspace/presentation-react/gameplay.css";
import {
  buttonPreviewStyle,
  evaluatedButtonSnapshot,
  gizmoStyle,
  type CameraHandle,
  type Tool,
  type TransformHandle,
} from "./gizmo";

const SPRITE_CORNERS: readonly {
  handle: TransformHandle;
  suffix: string;
  label: string;
}[] = [
  { handle: "scale_tl", suffix: "tl", label: "左上角缩放素材" },
  { handle: "scale_tr", suffix: "tr", label: "右上角缩放素材" },
  { handle: "scale_bl", suffix: "bl", label: "左下角缩放素材" },
  { handle: "scale_br", suffix: "br", label: "右下角缩放素材" },
];

/**
 * Overlay above the preview canvas: the runtime button DOM, one gizmo per
 * scene object and the camera gizmo.  Pointer gestures are delegated upward.
 */
export function GizmoLayer({
  animationMap,
  buttonObjects,
  camera,
  gizmoObjects,
  onCameraDrag,
  onObjectDrag,
  previewButtons,
  selectedId,
  targetKey,
  tool,
  urls,
}: {
  animationMap: AnimationMap;
  buttonObjects: readonly SceneObjectFrame[];
  camera: SceneFrame["camera"] | undefined;
  gizmoObjects: readonly SceneObjectFrame[];
  onCameraDrag(
    event: ReactPointerEvent<HTMLElement>,
    handle: CameraHandle,
  ): void;
  onObjectDrag(
    event: ReactPointerEvent<HTMLElement>,
    object: SceneObjectFrame,
    handle: TransformHandle,
  ): void;
  previewButtons: Readonly<Record<string, ButtonSnapshot>> | undefined;
  selectedId: string | null;
  targetKey: string;
  tool: Tool;
  urls: Record<string, string>;
}): ReactElement {
  return (
    <div className="timeline-gizmo-layer">
      {previewButtons !== undefined && buttonObjects.length > 0 && (
        <div className="timeline-button-layer">
          {buttonObjects.map((object) => {
            const base = previewButtons[object.id];
            if (base === undefined) return null;
            return (
              <TemplateButton
                animations={animationMap}
                assets={urls}
                button={evaluatedButtonSnapshot(base, object)}
                className="scene-button"
                disabled
                key={object.id}
                onActivate={() => undefined}
                paused
                playbackRate={1}
                sessionKey={`${targetKey}:${object.id}`}
                style={buttonPreviewStyle(object)}
              />
            );
          })}
        </div>
      )}
      {gizmoObjects.map((object) => (
        <div
          className={`timeline-gizmo${selectedId === object.id ? " selected" : ""}`}
          key={object.id}
          onPointerDown={(event) => onObjectDrag(event, object, "move")}
          style={gizmoStyle(object, camera)}
        >
          <span>{object.id}</span>
          {selectedId === object.id && (
            <>
              {object.kind === "sprite" ? (
                SPRITE_CORNERS.map(({ handle, label, suffix }) => (
                  <button
                    aria-label={label}
                    className={`timeline-gizmo-scale timeline-gizmo-scale-${suffix}`}
                    key={handle}
                    onPointerDown={(event) =>
                      onObjectDrag(event, object, handle)
                    }
                    type="button"
                  />
                ))
              ) : (
                <button
                  aria-label="缩放素材"
                  className="timeline-gizmo-scale"
                  onPointerDown={(event) =>
                    onObjectDrag(event, object, "scale")
                  }
                  type="button"
                />
              )}
              {object.kind !== "emitter" && (
                <>
                  <button
                    aria-label="水平缩放素材"
                    className="timeline-gizmo-scale-x"
                    onPointerDown={(event) =>
                      onObjectDrag(event, object, "scale_x")
                    }
                    type="button"
                  />
                  <button
                    aria-label="垂直缩放素材"
                    className="timeline-gizmo-scale-y"
                    onPointerDown={(event) =>
                      onObjectDrag(event, object, "scale_y")
                    }
                    type="button"
                  />
                </>
              )}
              {(object.kind === "sprite" ||
                object.kind === "emitter" ||
                object.kind === "button") && (
                <button
                  aria-label="旋转素材"
                  className="timeline-gizmo-rotate"
                  onPointerDown={(event) =>
                    onObjectDrag(event, object, "rotate")
                  }
                  type="button"
                />
              )}
            </>
          )}
        </div>
      ))}
      {tool === "camera" && (
        <div
          className="timeline-camera-gizmo"
          onPointerDown={(event) => onCameraDrag(event, "move")}
        >
          <button
            aria-label="缩放镜头"
            className="timeline-camera-zoom"
            onPointerDown={(event) => onCameraDrag(event, "zoom")}
            type="button"
          />
          <button
            aria-label="旋转镜头"
            className="timeline-camera-rotate"
            onPointerDown={(event) => onCameraDrag(event, "rotate")}
            type="button"
          />
        </div>
      )}
    </div>
  );
}
