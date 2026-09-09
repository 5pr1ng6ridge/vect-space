import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactElement,
  type WheelEvent,
} from "react";

import type {
  AssetUrlMap,
  ChapterMapDecorationSnapshot,
  ChapterMapHotspotSnapshot,
  ChapterMapSnapshot,
} from "../engine/types";
import {
  clampMapCenter,
  mapDragExceededThreshold,
  sortMapObjects,
  sortMapLayer,
} from "@vectspace/presentation-core/chapter-map";
import type { MapLayerObject } from "@vectspace/presentation-core/chapter-map";

interface ChapterMapPageProps {
  map: ChapterMapSnapshot;
  assets: AssetUrlMap;
  sessionCenter?: Point | null;
  onViewChange?(center: Point): void;
  onClose(): void;
  onReplay(sceneId: string): void;
}

interface Point {
  x: number;
  y: number;
}

const VIEWPORT_WIDTH = 1920;
const VIEWPORT_HEIGHT = 1080;

/** A read-only room map.  The map is deliberately DOM based for now: its
 * design-pixel coordinate model is identical to the editor and leaves the
 * visual node layer easy to replace with image UI later. */
export function ChapterMapPage({
  map,
  assets,
  sessionCenter,
  onViewChange,
  onClose,
  onReplay,
}: ChapterMapPageProps): ReactElement {
  const [center, setCenter] = useState<Point>(() => ({
    x: clampMapCenter(
      sessionCenter?.x ?? map.view_x,
      map.width,
      VIEWPORT_WIDTH,
    ),
    y: clampMapCenter(
      sessionCenter?.y ?? map.view_y,
      map.height,
      VIEWPORT_HEIGHT,
    ),
  }));
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(
    null,
  );
  const drag = useRef<{
    pointerId: number;
    start: Point;
    center: Point;
    scale: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const contentRef = useRef<{ map: ChapterMapSnapshot; assets: AssetUrlMap }>({
    map,
    assets,
  });

  useLayoutEffect(() => {
    // A refreshed map/assets snapshot replaces the rendered hotspot DOM. Do
    // not carry a detail selection or an in-flight gesture across that
    // replacement; otherwise the old hotspot can keep its focus/selection
    // state while its artwork is being swapped out.
    if (
      contentRef.current.map !== map ||
      contentRef.current.assets !== assets
    ) {
      setSelectedHotspotId(null);
      drag.current = null;
      suppressClick.current = false;
      contentRef.current = { map, assets };
    }
  }, [assets, map]);

  useEffect(() => {
    if (sessionCenter !== null && sessionCenter !== undefined) return;
    const next = {
      x: clampMapCenter(map.view_x, map.width, VIEWPORT_WIDTH),
      y: clampMapCenter(map.view_y, map.height, VIEWPORT_HEIGHT),
    };
    const frame = requestAnimationFrame(() => setCenter(next));
    return () => cancelAnimationFrame(frame);
  }, [map.height, map.view_x, map.view_y, map.width, sessionCenter]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (selectedHotspotId !== null) setSelectedHotspotId(null);
      else onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, selectedHotspotId]);

  useEffect(() => {
    const cancel = (): void => {
      drag.current = null;
      suppressClick.current = false;
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, []);

  const updateCenter = (next: Point): void => {
    setCenter(next);
    onViewChange?.(next);
  };

  const offset = useMemo(
    () => ({
      x: VIEWPORT_WIDTH / 2 - center.x,
      y: VIEWPORT_HEIGHT / 2 - center.y,
    }),
    [center],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    // A hotspot owns its pointer gesture.  In particular, do not turn a
    // press-and-drag that starts on a node into a room pan: doing so also
    // captures the pointer on the viewport and prevents the hotspot click
    // from reaching the button.
    if (
      event.target instanceof Element &&
      event.target.closest(".chapter-map-hotspot") !== null
    ) {
      return;
    }
    // Hotspots and the room use one pointer state machine.  Remember which
    // pointer state only for room panning. The shared threshold suppresses a
    // background click after a real pan.
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = event.currentTarget.getBoundingClientRect();
    drag.current = {
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      center,
      scale: bounds.width > 0 ? bounds.width / VIEWPORT_WIDTH : 1,
      moved: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const active = drag.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    const moved = mapDragExceededThreshold(active.start, {
      x: event.clientX,
      y: event.clientY,
    });
    if (moved) suppressClick.current = true;
    const next = {
      x: clampMapCenter(
        active.center.x - (event.clientX - active.start.x) / active.scale,
        map.width,
        VIEWPORT_WIDTH,
      ),
      y: clampMapCenter(
        active.center.y - (event.clientY - active.start.y) / active.scale,
        map.height,
        VIEWPORT_HEIGHT,
      ),
    };
    active.moved = moved;
    updateCenter(next);
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const moved = drag.current.moved;
    drag.current = null;
    if (moved) {
      // A pointer capture may end over a hotspot without dispatching a
      // bubbling click to the viewport.  Clear the one-click suppression on
      // the next frame so the following genuine hotspot click is not lost.
      requestAnimationFrame(() => {
        suppressClick.current = false;
      });
    }
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const scale = bounds.width > 0 ? bounds.width / VIEWPORT_WIDTH : 1;
    const horizontal = (event.shiftKey ? event.deltaY : event.deltaX) / scale;
    const vertical = (event.shiftKey ? 0 : event.deltaY) / scale;
    setCenter((previous) => {
      const next = {
        x: clampMapCenter(previous.x + horizontal, map.width, VIEWPORT_WIDTH),
        y: clampMapCenter(previous.y + vertical, map.height, VIEWPORT_HEIGHT),
      };
      onViewChange?.(next);
      return next;
    });
  };

  const decorations = sortMapLayer(map.decorations);
  const hotspots = sortMapLayer(map.hotspots);
  const mapObjects = sortMapObjects<MapLayerObject>([
    ...decorations.map((item) => ({ kind: "decoration" as const, item })),
    ...hotspots.map((item) => ({ kind: "hotspot" as const, item })),
  ]) as (
    | { kind: "decoration"; item: ChapterMapDecorationSnapshot }
    | { kind: "hotspot"; item: ChapterMapHotspotSnapshot }
  )[];

  return (
    <div className="chapter-map-page" aria-label="章节地图">
      <header className="chapter-map-header">
        <div>
          <p className="eyebrow">CHAPTER MAP</p>
          <h2>章节地图</h2>
        </div>
        <button onClick={onClose} type="button">
          返回标题
        </button>
      </header>
      <div
        className="chapter-map-viewport"
        onPointerCancel={endDrag}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onWheel={onWheel}
        onClick={() => {
          suppressClick.current = false;
        }}
        role="application"
      >
        <div
          className="chapter-map-world"
          style={{
            height: `${map.height}px`,
            transform: `translate3d(${offset.x}px, ${offset.y}px, 0)`,
            width: `${map.width}px`,
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget)
              setSelectedHotspotId(null);
          }}
        >
          {map.background !== null &&
            map.background !== undefined &&
            assets[map.background] !== undefined && (
              <img
                alt=""
                className="chapter-map-background"
                draggable={false}
                src={assets[map.background]}
              />
            )}
          {mapObjects.map(({ kind, item }) => {
            if (kind === "decoration") {
              const source = assets[item.asset];
              // Decorations are intentionally non-interactive.  Keeping them
              // in the same sorted render sequence as hotspots makes ties
              // deterministic while the CSS pointer-events rule ensures a
              // decoration can never steal a hotspot click.
              return (
                <img
                  alt=""
                  className="chapter-map-decoration"
                  draggable={false}
                  key={item.id}
                  src={source}
                  style={{
                    height: `${item.height}px`,
                    left: `${item.x}px`,
                    top: `${item.y}px`,
                    width: `${item.width}px`,
                    zIndex: item.z,
                  }}
                />
              );
            }
            const hotspot = item;
            const image =
              hotspot.asset === null ? undefined : assets[hotspot.asset];
            return (
              <button
                aria-label={`${hotspot.title}${hotspot.completed ? "，可重演" : "，尚未完成"}`}
                className={`chapter-map-hotspot${image === undefined ? "" : " has-artwork"}${hotspot.completed ? " is-completed" : " is-locked"}${selectedHotspotId === hotspot.id ? " is-selected" : ""}`}
                disabled={!hotspot.completed}
                onPointerDown={(event) => event.stopPropagation()}
                key={`${hotspot.id}:${hotspot.asset ?? ""}:${image ?? ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  if (hotspot.completed)
                    setSelectedHotspotId((current) =>
                      current === hotspot.id ? null : hotspot.id,
                    );
                }}
                data-hotspot-id={hotspot.id}
                style={{
                  backgroundImage:
                    image === undefined ? undefined : `url("${image}")`,
                  height: `${hotspot.height}px`,
                  left: `${hotspot.x}px`,
                  top: `${hotspot.y}px`,
                  width: `${hotspot.width}px`,
                  zIndex: hotspot.z,
                }}
                type="button"
              >
                {image === undefined && (
                  <>
                    <span>{hotspot.title}</span>
                    <small>{hotspot.completed ? "重演" : "未完成"}</small>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {selectedHotspotId !== null &&
        (() => {
          const selected = map.hotspots.find(
            (hotspot) => hotspot.id === selectedHotspotId,
          );
          if (selected === undefined || !selected.completed) return null;
          return (
            <div
              aria-label={`${selected.title}章节操作`}
              className="chapter-map-hotspot-detail"
              role="dialog"
            >
              <strong>{selected.title}</strong>
              <button onClick={() => onReplay(selected.scene_id)} type="button">
                重演
              </button>
              <button
                aria-label="关闭章节详情"
                onClick={() => setSelectedHotspotId(null)}
                type="button"
              >
                关闭
              </button>
            </div>
          );
        })()}
      <p className="chapter-map-hint">
        拖动背景查看房间，滚轮平移；已完成章节可重演
      </p>
    </div>
  );
}
