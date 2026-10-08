import type { DragEvent, PointerEvent, ReactElement, RefObject } from "react";
import { AnimatedImage } from "@vectspace/presentation-react/animated-image";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { resolveChapterMapHoverText } from "@vectspace/presentation-core/chapter-map";
import { editorImageSource } from "../../imageAnimationMap";
import type { ChapterMapDefinition, EditorAsset } from "../../types";
import { isMapInteractiveTarget } from "./mapPointer";
import type {
  MapKind,
  MapObjectEntry,
  MapRect,
  MapSelection,
} from "./mapTypes";

type ResizeStart = (
  event: PointerEvent<HTMLSpanElement>,
  kind: MapKind,
  id: string,
  item: MapRect,
  edge: "nw" | "ne" | "sw" | "se",
) => void;

function ResizeHandles({
  kind,
  id,
  item,
  onResize,
}: {
  kind: "hotspot" | "decoration";
  id: string;
  item: { x: number; y: number; width: number; height: number };
  onResize(
    event: PointerEvent<HTMLSpanElement>,
    kind: "hotspot" | "decoration",
    id: string,
    item: { x: number; y: number; width: number; height: number },
    edge: "nw" | "ne" | "sw" | "se",
  ): void;
}): ReactElement {
  return (
    <>
      {(["nw", "ne", "sw", "se"] as const).map((edge) => (
        <span
          aria-label={`调整大小 ${edge}`}
          className={`map-resize-handle map-resize-${edge}`}
          key={edge}
          onPointerDown={(event) => onResize(event, kind, id, item, edge)}
          role="presentation"
        />
      ))}
    </>
  );
}

/** The pannable, zoomable room: grid, view frame, artwork, objects and resize handles. */
export function MapCanvas({
  animationMap,
  assets,
  cancelPointerOperation,
  canvasRef,
  displayedObject,
  dropOnStage,
  hiddenIds,
  hoveredObjectId,
  map,
  mapObjects,
  pan,
  pointerDown,
  pointerDownResize,
  pointerDownView,
  scale,
  select,
  selectedDisplay,
  selectedObject,
  selection,
  setHoveredObjectId,
  showGrid,
  showViewFrame,
  stagePointerDown,
  stagePointerMove,
  stagePointerUp,
  viewFrame,
  zoomBy,
}: {
  animationMap: AnimationMap;
  assets: readonly EditorAsset[];
  cancelPointerOperation(): void;
  canvasRef: RefObject<HTMLDivElement | null>;
  displayedObject(kind: MapKind, id: string, item: MapRect): MapRect;
  dropOnStage(event: DragEvent<HTMLDivElement>): void;
  hiddenIds: ReadonlySet<string>;
  hoveredObjectId: string | null;
  map: ChapterMapDefinition;
  mapObjects: readonly MapObjectEntry[];
  pan: { x: number; y: number };
  pointerDown(
    event: PointerEvent<HTMLDivElement>,
    kind: MapKind,
    id: string,
    x: number,
    y: number,
  ): void;
  pointerDownResize: ResizeStart;
  pointerDownView(event: PointerEvent<HTMLDivElement>): void;
  scale: number;
  select(next: MapSelection): void;
  selectedDisplay: MapRect | null;
  selectedObject: (MapRect & { id: string }) | null;
  selection: MapSelection;
  setHoveredObjectId(id: string | null): void;
  showGrid: boolean;
  showViewFrame: boolean;
  stagePointerDown(event: PointerEvent<HTMLDivElement>): void;
  stagePointerMove(event: PointerEvent<HTMLDivElement>): void;
  stagePointerUp(event: PointerEvent<HTMLDivElement>): void;
  viewFrame: MapRect;
  zoomBy(factor: number, anchor?: { x: number; y: number }): void;
}): ReactElement {
  return (
    <div
      className="map-canvas-wrap"
      onWheel={(event) => {
        // The wheel zooms around the pointer, like other map editors.
        if (event.deltaY === 0) return;
        zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, {
          x: event.clientX,
          y: event.clientY,
        });
      }}
      ref={canvasRef}
    >
      <div
        className="map-canvas-stage"
        onDragOver={(event) => event.preventDefault()}
        onDrop={dropOnStage}
        onPointerDown={stagePointerDown}
        onPointerMove={stagePointerMove}
        onPointerUp={stagePointerUp}
        onPointerCancel={cancelPointerOperation}
        onClick={(event) => {
          // A node click is handled by the node itself.  Keep this guard
          // even though the child currently stops propagation: it makes
          // selection robust when the target is a child/handle or when a
          // browser retargets a captured pointer event.
          if (isMapInteractiveTarget(event.target)) return;
          select(null);
        }}
        style={{
          height: `${map.height * scale}px`,
          transform: `translate(${pan.x}px, ${pan.y}px)`,
          width: `${map.width * scale}px`,
        }}
      >
        <div
          className="map-canvas-room"
          style={{
            height: `${map.height}px`,
            transform: `scale(${scale})`,
            width: `${map.width}px`,
          }}
        >
          {showGrid && <div className="map-grid" />}
          {showViewFrame && (
            <div
              aria-label="初始视图框"
              className="map-editor-view-frame"
              style={{
                height: viewFrame.height,
                left: viewFrame.x,
                top: viewFrame.y,
                width: viewFrame.width,
              }}
            >
              <span onPointerDown={pointerDownView}>初始视图</span>
            </div>
          )}
          {map.background !== null && map.background !== undefined && (
            <div
              className="map-editor-background"
              style={{
                backgroundImage: undefined,
              }}
            >
              <AnimatedImage
                alt=""
                source={editorImageSource(
                  assets.find((asset) => asset.id === map.background),
                  assets,
                  animationMap,
                )}
              />
            </div>
          )}
          {mapObjects.map(({ kind, item }) => {
            const active = selection?.id === item.id;
            const shown = displayedObject(kind, item.id, item);
            const source =
              kind === "decoration"
                ? assets.find((asset) => asset.id === item.asset)
                : item.asset === null || item.asset === undefined
                  ? undefined
                  : assets.find((asset) => asset.id === item.asset);
            const hotspot = kind === "hotspot" ? item : null;
            const hoverText =
              hotspot === null
                ? null
                : resolveChapterMapHoverText(hotspot.title, hotspot.hover_text);
            const isHovered = hoveredObjectId === item.id;
            return (
              <div
                className={`map-editor-object ${kind}${source === undefined ? "" : " has-artwork"}${active ? " selected" : ""}${isHovered ? " is-hovered" : ""}`}
                key={`${kind}:${item.id}:${item.asset ?? ""}:${source?.absolute_path ?? ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  select({ kind, id: item.id });
                }}
                onPointerEnter={() => setHoveredObjectId(item.id)}
                onPointerDown={(event) =>
                  pointerDown(event, kind, item.id, item.x, item.y)
                }
                onPointerLeave={() => setHoveredObjectId(null)}
                style={{
                  backgroundImage: undefined,
                  display: hiddenIds.has(item.id) ? "none" : undefined,
                  height: shown.height,
                  left: shown.x,
                  top: shown.y,
                  width: shown.width,
                  zIndex: item.z,
                }}
              >
                {source !== undefined && (
                  <AnimatedImage
                    alt=""
                    className="map-editor-object-artwork"
                    source={editorImageSource(source, assets, animationMap)}
                  />
                )}
                {source === undefined &&
                  (kind === "decoration" ? (
                    <span>{item.id}</span>
                  ) : (
                    <>
                      <strong>{item.title}</strong>
                      <small>{item.scene_id}</small>
                    </>
                  ))}
                {kind === "hotspot" && hoverText !== null && isHovered && (
                  <span
                    className="map-hover-card"
                    id={`map-hover-${item.id}`}
                    role="tooltip"
                  >
                    {hoverText}
                  </span>
                )}
              </div>
            );
          })}
          {selection !== null &&
            selectedObject !== null &&
            !hiddenIds.has(selection.id) && (
              <div
                className="map-resize-overlay"
                style={{
                  height: selectedDisplay?.height,
                  left: selectedDisplay?.x,
                  top: selectedDisplay?.y,
                  width: selectedDisplay?.width,
                }}
              >
                <ResizeHandles
                  id={selectedObject.id}
                  item={selectedDisplay ?? selectedObject}
                  kind={selection.kind}
                  onResize={pointerDownResize}
                />
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
