import type { Dispatch, ReactElement, SetStateAction } from "react";
import { sortMapLayer } from "@vectspace/presentation-core/chapter-map";
import { ASSET_DRAG_TYPE } from "../../assetDrag";
import type { AssetChoiceOption } from "../../assetLibrary";
import type { ChapterMapDefinition } from "../../types";
import type { MapSelection } from "./mapTypes";

/** Left column: unplaced scenes, droppable artwork and the layer list. */
export function MapSidePanel({
  addDecoration,
  addHotspot,
  decorationOptions,
  hiddenIds,
  map,
  select,
  selection,
  setHiddenIds,
  unplacedScenes,
}: {
  addDecoration(assetId?: string): void;
  addHotspot(sceneId: string): void;
  decorationOptions: readonly AssetChoiceOption[];
  hiddenIds: ReadonlySet<string>;
  map: ChapterMapDefinition;
  select(next: MapSelection): void;
  selection: MapSelection;
  setHiddenIds: Dispatch<SetStateAction<Set<string>>>;
  unplacedScenes: readonly string[];
}): ReactElement {
  return (
    <aside className="map-side-panel">
      <h3>未放置的场景</h3>
      {unplacedScenes.length === 0 && <p className="muted">所有场景都已放置</p>}
      {unplacedScenes.map((sceneId) => (
        <button
          className="map-list-button"
          key={sceneId}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData("application/x-vectspace-kind", "scene");
            event.dataTransfer.setData("application/x-vectspace-id", sceneId);
          }}
          onClick={() => addHotspot(sceneId)}
          type="button"
        >
          ＋ {sceneId}
        </button>
      ))}
      <button
        className="map-list-button"
        disabled={decorationOptions.length === 0}
        onClick={() => addDecoration()}
        type="button"
      >
        ＋ 添加装饰
      </button>
      <h3>可拖放素材</h3>
      {decorationOptions.map((option) => (
        <button
          className="map-list-button"
          draggable
          key={option.id}
          onDragStart={(event) => {
            event.dataTransfer.setData(ASSET_DRAG_TYPE, option.id);
          }}
          onClick={() => addDecoration(option.id)}
          type="button"
        >
          ＋ {option.label}
          {option.label !== option.id && (
            <small className="map-list-sub">{option.id}</small>
          )}
        </button>
      ))}
      <h3>图层</h3>
      {sortMapLayer([
        ...map.decorations.map((item) => ({
          kind: "decoration" as const,
          id: item.id,
          z: item.z,
          label: `装饰 · ${item.id}`,
        })),
        ...map.hotspots.map((item) => ({
          kind: "hotspot" as const,
          id: item.id,
          z: item.z,
          label: `章节 · ${item.title}`,
        })),
      ]).map((item) => (
        <div className="map-layer-row" key={item.id}>
          <button
            className={`map-list-button${selection?.id === item.id ? " active" : ""}`}
            onClick={() => select({ kind: item.kind, id: item.id })}
            type="button"
          >
            {item.label}
          </button>
          <button
            aria-label={`${hiddenIds.has(item.id) ? "显示" : "隐藏"} ${item.id}`}
            className="map-layer-toggle"
            onClick={() =>
              setHiddenIds((current) => {
                const next = new Set(current);
                if (next.has(item.id)) next.delete(item.id);
                else next.add(item.id);
                return next;
              })
            }
            type="button"
          >
            {hiddenIds.has(item.id) ? "○" : "●"}
          </button>
        </div>
      ))}
    </aside>
  );
}
