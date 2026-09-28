import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type ReactElement,
  type WheelEvent,
} from "react";

import type {
  AssetUrlMap,
  ChapterMapDecorationSnapshot,
  ChapterMapHotspotSnapshot,
  ChapterMapSnapshot,
} from "@vectspace/presentation-core/types";
import {
  clampMapCenter,
  mapDragExceededThreshold,
  resolveChapterMapHoverText,
  sortMapObjects,
  sortMapLayer,
} from "@vectspace/presentation-core/chapter-map";
import type { MapLayerObject } from "@vectspace/presentation-core/chapter-map";
import {
  resolveImageAsset,
  type AnimationMap,
  type ImageAssetSource,
} from "@vectspace/presentation-core/image-animation";
import {
  AnimatedImage,
  useAnimatedImage,
} from "@vectspace/presentation-react/animated-image";

interface ChapterMapPageProps {
  map: ChapterMapSnapshot;
  assets: AssetUrlMap;
  /** Frame lists for animated map artwork.  Defaults to static-only. */
  animations?: AnimationMap;
  /** Hidden pages pause every map loop instead of ticking in the background. */
  paused?: boolean;
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
  animations = {},
  paused = false,
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
  const [hoveredHotspotId, setHoveredHotspotId] = useState<string | null>(null);
  const [focusedHotspotId, setFocusedHotspotId] = useState<string | null>(null);
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
    // not carry hover/focus or an in-flight gesture across that replacement;
    // otherwise the old hotspot can keep its interaction state while its
    // artwork is being swapped out.
    if (
      contentRef.current.map !== map ||
      contentRef.current.assets !== assets
    ) {
      setHoveredHotspotId(null);
      setFocusedHotspotId(null);
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
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

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
        >
          {map.background !== null &&
            map.background !== undefined &&
            assets[map.background] !== undefined && (
              <AnimatedImage
                alt=""
                className="chapter-map-background"
                paused={paused}
                source={resolveImageAsset(map.background, assets, animations)}
              />
            )}
          {mapObjects.map(({ kind, item }) => {
            if (kind === "decoration") {
              const source = resolveImageAsset(item.asset, assets, animations);
              if (source === undefined) return null;
              // Decorations are intentionally non-interactive.  Keeping them
              // in the same sorted render sequence as hotspots makes ties
              // deterministic while the CSS pointer-events rule ensures a
              // decoration can never steal a hotspot click.
              return (
                <AnimatedImage
                  alt=""
                  className="chapter-map-decoration"
                  key={item.id}
                  paused={paused}
                  source={source}
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
            const image = resolveImageAsset(
              hotspot.asset ?? "",
              assets,
              animations,
            );
            const hoverText = resolveChapterMapHoverText(
              hotspot.title,
              hotspot.hover_text,
            );
            const isHovering =
              hoveredHotspotId === hotspot.id ||
              focusedHotspotId === hotspot.id;
            return (
              <HotspotButton
                focused={focusedHotspotId === hotspot.id}
                hoverText={hoverText}
                hovering={isHovering}
                hotspot={hotspot}
                image={image}
                key={`${hotspot.id}:${hotspot.asset ?? ""}:${image?.url ?? ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  if (hotspot.replayable ?? hotspot.completed)
                    onReplay(hotspot.scene_id);
                }}
                onFocusChange={(focused) =>
                  setFocusedHotspotId(focused ? hotspot.id : null)
                }
                onHoverChange={(hovering) =>
                  setHoveredHotspotId(hovering ? hotspot.id : null)
                }
                paused={paused}
              />
            );
          })}
        </div>
      </div>
      <p className="chapter-map-hint">
        拖动背景查看房间，滚轮平移；悬停查看说明，单击已完成章节进入
      </p>
    </div>
  );
}

/**
 * One hotspot button.
 *
 * Extracted so each hotspot can own a frame loop (hooks cannot live in the
 * map callback) while keeping the interactive behaviour identical to the
 * static artwork case.
 */
function HotspotButton({
  hotspot,
  image,
  hoverText,
  hovering,
  focused,
  paused,
  onClick,
  onFocusChange,
  onHoverChange,
}: {
  hotspot: ChapterMapHotspotSnapshot;
  image: ImageAssetSource | undefined;
  hoverText: string | null;
  hovering: boolean;
  focused: boolean;
  paused: boolean;
  onClick(event: ReactMouseEvent<HTMLButtonElement>): void;
  onFocusChange(focused: boolean): void;
  onHoverChange(hovering: boolean): void;
}): ReactElement {
  const frame = useAnimatedImage(image, paused);
  const artwork = frame.url ?? image?.url;
  const isHovering = hovering || focused;
  // An author may open a chapter before the story reaches it.  Such a hotspot
  // is enterable, so it must never be presented as unreached: only a hotspot
  // that is both unreached and locked still says so.
  const replayable = hotspot.replayable ?? hotspot.completed;
  const statusText = hotspot.completed ? "重演" : "可直接进入";
  const ariaStatus = hotspot.completed
    ? "，可重演"
    : replayable
      ? "，尚未到达但可直接进入"
      : "，尚未完成";
  return (
    <button
      aria-label={`${hotspot.title}${ariaStatus}`}
      className={`chapter-map-hotspot${artwork === undefined ? "" : " has-artwork"}${hotspot.completed ? " is-completed" : replayable ? "" : " is-locked"}`}
      data-hotspot-id={hotspot.id}
      disabled={!replayable}
      onBlur={() => onFocusChange(false)}
      onClick={onClick}
      onFocus={() => onFocusChange(true)}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={() => onHoverChange(true)}
      onPointerLeave={() => onHoverChange(false)}
      style={{
        backgroundImage:
          artwork === undefined ? undefined : `url(${JSON.stringify(artwork)})`,
        height: `${hotspot.height}px`,
        left: `${hotspot.x}px`,
        top: `${hotspot.y}px`,
        width: `${hotspot.width}px`,
        zIndex: hotspot.z,
      }}
      type="button"
    >
      {artwork === undefined && (
        <>
          <span>{hotspot.title}</span>
          <small>{replayable ? statusText : "未完成"}</small>
        </>
      )}
      {hoverText !== null && isHovering && (
        <span
          className="chapter-map-hover-card"
          id={`chapter-map-hover-${hotspot.id}`}
          role="tooltip"
        >
          {hoverText}
        </span>
      )}
    </button>
  );
}
