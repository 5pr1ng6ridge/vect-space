/**
 * Overlay above the stage canvas for the particle generation point and area.
 *
 * Two independent, pointer-only gizmos share one 16:9 layer (the same layer
 * geometry the timeline gizmos use, so percentages map design pixels):
 *
 * - the generation-point marker, optionally draggable.  The host decides what
 *   the drag means: the scene stage saves `node.x/y`, the particle workspace
 *   only moves its preview centre.  The marker follows the pointer as a draft;
 *   nothing is authored until the host's `onMarkerDrop` is called, once, on
 *   release,
 * - eight resize handles around a rectangle area.  The draft rectangle follows
 *   the pointer; release calls `onAreaResize` exactly once with the final
 *   size, while a click, `Escape`, a pointer cancel or a blur calls nothing.
 *
 * Gestures use the shared window lifecycle (`beginStageGesture`) and the shared
 * client-to-design mapping (`stagePointFromClientPoint`).
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";

import {
  movedEnough,
  stagePointFromClientPoint,
  type StagePoint,
} from "../stageEdit";
import {
  AREA_HANDLES,
  AREA_HANDLE_LABELS,
  areaHandlePoint,
  areaStageBox,
  resizeAreaFromHandle,
  sameAreaSize,
  stageBoxPercent,
  stagePercent,
  type AreaHandle,
  type AreaSize,
} from "./particleAreaGeometry";
import { beginStageGesture } from "./stageGesture";

export interface MarkerDrop {
  /** Design-space pointer position when the gesture started. */
  pointerDown: StagePoint;
  /** Design-space pointer position when the gesture ended. */
  pointerNow: StagePoint;
}

interface ParticleGizmoProps {
  /** Stage position of the generation point; `null` draws nothing. */
  point: StagePoint | null;
  /** Visible marker caption. */
  markerLabel: string;
  /** Accessible name of the marker. */
  markerAriaLabel: string;
  /**
   * Present: the marker can be dragged.  Called once on a real drag; returns
   * true when the host authored a change, which keeps the marker where it was
   * dropped until the host reports a newer `revision` or a different `point`
   * (a refetched world), instead of snapping back for a moment.
   *
   * `pointerDown` is the cumulative origin: when the marker is still showing
   * an unresolved earlier drop, it is shifted by that drop so the host's
   * displacement (against the point it still knows) includes both drags.
   */
  onMarkerDrop?(drop: MarkerDrop): boolean;
  /**
   * Identity of the host's current answer for `point` (for example a counter
   * that advances for every completed refetch).  A kept drop is released as
   * soon as it changes, even when the new answer reports the very same point:
   * a drop that was undone before its refetch arrived must not leave the
   * marker at a position the document no longer has.
   */
  revision?: unknown;
  /** Rectangle area centred on the point; `null`/omitted draws no area. */
  area?: AreaSize | null;
  /** Emitter scale on the stage; the area is shown multiplied by it. */
  areaScale?: number;
  /** Present: the area can be resized, called once with the final size. */
  onAreaResize?(size: AreaSize): void;
}

export function ParticleGizmo({
  point,
  markerLabel,
  markerAriaLabel,
  onMarkerDrop,
  revision,
  area = null,
  areaScale = 1,
  onAreaResize,
}: ParticleGizmoProps): ReactElement {
  const layerRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<(() => void) | null>(null);
  // Gesture callbacks are read from refs: a release must call the current
  // owner callback even when the host re-rendered while the pointer was down.
  const dropRef = useRef(onMarkerDrop);
  const resizeRef = useRef(onAreaResize);
  const [markerOffset, setMarkerOffset] = useState<StagePoint | null>(null);
  // A committed drop keeps its offset only while the host still reports the
  // point the drag started from; the first different point replaces it.
  const [settled, setSettled] = useState<{
    from: StagePoint;
    revision: unknown;
    offset: StagePoint;
  } | null>(null);
  // What the host reports right now; a release reads it, not the render the
  // gesture started in.
  const latestRef = useRef({ point, revision });
  const [draftArea, setDraftArea] = useState<AreaSize | null>(null);
  const [resizing, setResizing] = useState<AreaHandle | null>(null);

  useEffect(() => {
    dropRef.current = onMarkerDrop;
  }, [onMarkerDrop]);

  useEffect(() => {
    resizeRef.current = onAreaResize;
  }, [onAreaResize]);

  useEffect(() => {
    latestRef.current = { point, revision };
  }, [point, revision]);

  useEffect(
    () => () => {
      gestureRef.current?.();
    },
    [],
  );

  const stagePoint = useCallback(
    (event: { clientX: number; clientY: number }): StagePoint | null => {
      const layer = layerRef.current;
      if (layer === null) return null;
      return stagePointFromClientPoint(
        layer.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
    },
    [],
  );

  if (
    settled !== null &&
    (point === null ||
      point.x !== settled.from.x ||
      point.y !== settled.from.y ||
      !Object.is(revision, settled.revision))
  ) {
    setSettled(null);
  }

  const startMarkerDrag = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || gestureRef.current !== null) return;
    if (dropRef.current === undefined) return;
    const down = stagePoint(event);
    if (down === null) return;
    event.preventDefault();
    event.stopPropagation();
    // Grabbing a marker that still shows an unresolved drop continues from
    // where it is shown: the origin is the pointer minus that shown offset.
    const base = settled?.offset ?? { x: 0, y: 0 };
    const origin = { x: down.x - base.x, y: down.y - base.y };
    let now = down;
    const end = (): void => {
      gestureRef.current = null;
      setMarkerOffset(null);
    };
    gestureRef.current = beginStageGesture({
      move: (moveEvent) => {
        const next = stagePoint(moveEvent);
        if (next === null) return;
        now = next;
        setMarkerOffset({ x: now.x - origin.x, y: now.y - origin.y });
      },
      release: () => {
        end();
        // A click without movement is never a drop.
        if (!movedEnough(down, now)) return;
        const committed = dropRef.current?.({
          pointerDown: origin,
          pointerNow: now,
        });
        const latest = latestRef.current;
        if (committed === true && latest.point !== null) {
          setSettled({
            from: latest.point,
            revision: latest.revision,
            offset: { x: now.x - origin.x, y: now.y - origin.y },
          });
        }
      },
      abort: end,
    });
  };

  const startResize = (
    handle: AreaHandle,
    event: ReactPointerEvent<HTMLElement>,
  ): void => {
    if (event.button !== 0 || gestureRef.current !== null) return;
    if (area === null || resizeRef.current === undefined) return;
    const down = stagePoint(event);
    if (down === null) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = area;
    let draft = origin;
    let moved = false;
    setResizing(handle);
    const end = (): void => {
      gestureRef.current = null;
      setResizing(null);
      setDraftArea(null);
    };
    gestureRef.current = beginStageGesture({
      move: (moveEvent) => {
        const now = stagePoint(moveEvent);
        if (now === null) return;
        // Past the click threshold the gesture is a drag for good, so coming
        // back to the start shows (and commits) the original size, not a
        // stale intermediate one.
        moved = moved || movedEnough(down, now);
        if (!moved) return;
        draft = resizeAreaFromHandle({
          handle,
          area: origin,
          scale: areaScale,
          pointerDown: down,
          pointerNow: now,
        });
        setDraftArea(draft);
      },
      release: () => {
        end();
        // Dragging back to the starting size is no change: no history entry.
        if (!sameAreaSize(draft, origin)) resizeRef.current?.(draft);
      },
      abort: end,
    });
  };

  const shownArea = draftArea ?? area;
  const shownOffset = markerOffset ?? settled?.offset ?? null;
  const center: StagePoint | null =
    point === null
      ? null
      : shownOffset === null
        ? point
        : { x: point.x + shownOffset.x, y: point.y + shownOffset.y };
  const draggable = onMarkerDrop !== undefined;

  return (
    <div
      aria-label="粒子生成点"
      className="timeline-gizmo-layer particle-emission-layer"
      ref={layerRef}
      role="group"
    >
      {center !== null && shownArea !== null && (
        <div
          className={`particle-emission-region${resizing === null ? "" : " is-resizing"}`}
          data-testid="particle-emission-region"
          style={{
            position: "absolute",
            boxSizing: "border-box",
            ...stageBoxPercent(areaStageBox(center, shownArea, areaScale)),
          }}
        >
          <span className="particle-emission-label particle-emission-size">
            {shownArea.width} × {shownArea.height}
          </span>
        </div>
      )}
      {center !== null &&
        shownArea !== null &&
        onAreaResize !== undefined &&
        AREA_HANDLES.map((handle) => (
          <button
            aria-label={`调整生成区域${AREA_HANDLE_LABELS[handle]}`}
            className={`particle-emission-handle particle-emission-handle-${handle}`}
            key={handle}
            onPointerDown={(event) => startResize(handle, event)}
            style={{
              position: "absolute",
              pointerEvents: "auto",
              ...stagePercent(
                areaHandlePoint(center, shownArea, handle, areaScale),
              ),
            }}
            tabIndex={-1}
            type="button"
          />
        ))}
      {center !== null && (
        <button
          aria-label={markerAriaLabel}
          className={`particle-emission-center${draggable ? " is-draggable" : ""}${
            markerOffset === null ? "" : " is-dragging"
          }`}
          onPointerDown={draggable ? startMarkerDrag : undefined}
          style={{
            position: "absolute",
            pointerEvents: draggable ? "auto" : "none",
            ...stagePercent(center),
          }}
          tabIndex={-1}
          type="button"
        >
          <span className="particle-emission-label">{markerLabel}</span>
        </button>
      )}
    </div>
  );
}
