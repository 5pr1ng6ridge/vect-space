import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type ReactElement,
} from "react";

import type {
  ChapterMapDefinition,
  EditorAsset,
  ContentManifest,
} from "../types";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { useAssetLayout } from "./AssetChooser";
import {
  Frame,
  Grid3x3,
  Map as MapIcon,
  Maximize,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { WorkspaceHeader } from "../shell/WorkspaceHeader";
import { IconButton } from "../ui/Button";
import {
  escapeTextEntry,
  isComposing,
  shouldIgnoreShortcut,
} from "../ui/keyboard";
import { isEditableTarget } from "./nodeDeleteShortcut";
import { draggedAssetId } from "../assetDrag";
import { assetChoiceOptions, firstVisibleAssetId } from "../assetLibrary";
import {
  clampMapCenter,
  containMapRect,
  sortMapObjects,
} from "@vectspace/presentation-core/chapter-map";
import type { MapLayerObject } from "@vectspace/presentation-core/chapter-map";
import { GRID, MAX_ROOM, MIN_ROOM, snap } from "./chapterMap/mapGrid";
import {
  captureMapPointer,
  isMapInteractiveTarget,
} from "./chapterMap/mapPointer";
import type { MapObjectEntry, MapSelection } from "./chapterMap/mapTypes";
import { MapCanvas } from "./chapterMap/MapCanvas";
import { MapInspector } from "./chapterMap/MapInspector";
import { MapSidePanel } from "./chapterMap/MapSidePanel";

interface ChapterMapWorkspaceProps {
  map: ChapterMapDefinition;
  manifest: ContentManifest;
  sceneIds: string[];
  assets: EditorAsset[];
  animationMap?: AnimationMap;
  dirty: boolean;
  selectionId: string | null;
  onSelectionChange?(selectionId: string | null): void;
  onClose(): void;
  onChange(map: ChapterMapDefinition): void;
  onSave(): void;
  onUndo(): void;
  onRedo(): void;
  onValidate(): void;
  onBeginEdit?(id: string, label: string): void;
  onSetEditDraft?(
    id: string,
    key: string,
    value: string,
    invalid?: boolean,
  ): void;
  onSetEditError?(id: string, key: string, message: string | null): void;
  onCommitEdit?(id: string, clearedKey?: string): boolean;
  onCancelEdit?(id: string): void;
  activeEdit?: {
    id: string;
    drafts: Record<string, string>;
    invalidDrafts: Record<string, string>;
    errors: Record<string, string>;
  } | null;
  undoAvailable: boolean;
  redoAvailable: boolean;
}

export function ChapterMapWorkspace({
  map,
  manifest,
  sceneIds,
  assets,
  animationMap = {},
  dirty,
  selectionId,
  onSelectionChange,
  onClose,
  onChange,
  onSave,
  onUndo,
  onRedo,
  onValidate,
  onBeginEdit,
  onSetEditDraft,
  onSetEditError,
  onCommitEdit,
  onCancelEdit,
  activeEdit,
  undoAvailable,
  redoAvailable,
}: ChapterMapWorkspaceProps): ReactElement {
  // Selection is a single value derived from the parent's `selectionId` plus
  // the current map; pointer interactions call `select()`, which only notifies
  // the parent.  Mirroring a local copy to the parent in effects ping-pongs
  // when a freshly created hotspot is selected before its `map` prop renders.
  const [uncontrolledSelectionId, setUncontrolledSelectionId] = useState<
    string | null
  >(null);
  const assetLayout = useAssetLayout();
  // Hidden assets are not offered as new map decorations; a decoration that
  // is already placed keeps its value (it is edited through the object
  // inspector, which retains the current id).
  const decorationOptions = useMemo(
    () =>
      assetChoiceOptions({
        assets,
        layout: assetLayout,
        kind: ["gui", "sprite"],
      }),
    [assets, assetLayout],
  );
  const controlledSelection = onSelectionChange !== undefined;
  const activeSelectionId = controlledSelection
    ? selectionId
    : uncontrolledSelectionId;
  const select = useCallback(
    (next: MapSelection): void => {
      if (controlledSelection) onSelectionChange?.(next?.id ?? null);
      else setUncontrolledSelectionId(next?.id ?? null);
    },
    [controlledSelection, onSelectionChange],
  );
  const selection = useMemo<MapSelection>(() => {
    if (activeSelectionId === null) return null;
    if (map.hotspots.some((item) => item.id === activeSelectionId))
      return { kind: "hotspot", id: activeSelectionId };
    if (map.decorations.some((item) => item.id === activeSelectionId))
      return { kind: "decoration", id: activeSelectionId };
    // A deleted object, a stale diagnostic target or a remapped id simply has
    // no selection instead of leaving an inspector for something gone.
    return null;
  }, [activeSelectionId, map.decorations, map.hotspots]);
  const [hoveredObjectId, setHoveredObjectId] = useState<string | null>(null);
  // `fitScale` fits the whole room into the canvas; `zoom` multiplies it.
  const [fitScale, setFitScale] = useState(1);
  const [zoom, setZoom] = useState(1);
  const scale = fitScale * zoom;
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showGrid, setShowGrid] = useState(true);
  const [showViewFrame, setShowViewFrame] = useState(true);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const activeInspectorKeyRef = useRef<string | null>(null);
  const objectAssetTokens = useMemo(() => {
    const tokens = new Map<string, string>();
    for (const item of map.decorations) {
      const source = assets.find((asset) => asset.id === item.asset);
      tokens.set(
        `decoration:${item.id}`,
        `${item.asset}:${source?.absolute_path ?? ""}`,
      );
    }
    for (const item of map.hotspots) {
      const source =
        item.asset === null || item.asset === undefined
          ? undefined
          : assets.find((asset) => asset.id === item.asset);
      tokens.set(
        `hotspot:${item.id}`,
        `${item.asset ?? ""}:${source?.absolute_path ?? ""}`,
      );
    }
    return tokens;
  }, [assets, map.decorations, map.hotspots]);
  const previousObjectAssetTokens = useRef(objectAssetTokens);
  const [drag, setDrag] = useState<{
    pointerId: number;
    kind: "hotspot" | "decoration";
    id: string;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    x: number;
    y: number;
  } | null>(null);
  const [resizeDrag, setResizeDrag] = useState<{
    pointerId: number;
    kind: "hotspot" | "decoration";
    id: string;
    edge: "nw" | "ne" | "sw" | "se";
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    originWidth: number;
    originHeight: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [viewDrag, setViewDrag] = useState<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    x: number;
    y: number;
  } | null>(null);
  const panDrag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  // React may batch several inspector/gesture events before the parent
  // renders a new `map` prop. Keep a mutable copy so two changes in one
  // browser task are based on the latest submitted definition rather than
  // both cloning the same stale render.
  const mapRef = useRef(map);

  useLayoutEffect(() => {
    mapRef.current = map;
  }, [map]);

  useEffect(() => {
    const element = canvasRef.current;
    if (element === null) return;
    const update = (): void => {
      const width = Math.max(320, element.clientWidth - 32);
      const height = Math.max(240, element.clientHeight - 32);
      setFitScale(Math.min(width / map.width, height / map.height, 1));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [map.height, map.width]);

  useEffect(() => {
    const cancel = (): void => {
      if (drag !== null) onCancelEdit?.(`map:${drag.kind}:${drag.id}`);
      if (resizeDrag !== null)
        onCancelEdit?.(`map:resize:${resizeDrag.kind}:${resizeDrag.id}`);
      if (viewDrag !== null) onCancelEdit?.("map:view");
      setDrag(null);
      setResizeDrag(null);
      setViewDrag(null);
      panDrag.current = null;
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", cancel);
    return () => {
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", cancel);
    };
  }, [drag, onCancelEdit, resizeDrag, viewDrag]);

  const selectedObject = useMemo(() => {
    if (selection === null) return null;
    return selection.kind === "hotspot"
      ? (map.hotspots.find((item) => item.id === selection.id) ?? null)
      : (map.decorations.find((item) => item.id === selection.id) ?? null);
  }, [map.decorations, map.hotspots, selection]);

  useEffect(() => {
    const previous = previousObjectAssetTokens.current;
    previousObjectAssetTokens.current = objectAssetTokens;
    const changedKeys = [...objectAssetTokens.keys()].filter(
      (key) =>
        previous.has(key) && previous.get(key) !== objectAssetTokens.get(key),
    );
    if (changedKeys.length === 0) return;

    setHoveredObjectId(null);
    if (selection === null) return;
    const key = `${selection.kind}:${selection.id}`;
    if (!changedKeys.includes(key)) return;

    // Replacing artwork replaces the visual object under the pointer. Drop
    // the old interaction state so its selection outline/hover state cannot
    // survive onto the refreshed artwork.
    if (drag?.kind === selection.kind && drag.id === selection.id)
      onCancelEdit?.(`map:${drag.kind}:${drag.id}`);
    setDrag(null);
    setResizeDrag(null);
    setViewDrag(null);
    panDrag.current = null;
    select(null);
  }, [drag, objectAssetTokens, onCancelEdit, select, selection]);

  const unplacedScenes = sceneIds.filter(
    (sceneId) => !map.hotspots.some((hotspot) => hotspot.scene_id === sceneId),
  );

  const mapError =
    activeEdit?.id.startsWith("map:") === true
      ? (Object.values(activeEdit.errors)[0] ?? null)
      : null;
  const setMapError = useCallback(
    (message: string | null): void => {
      const key = activeInspectorKeyRef.current ?? "validation";
      const id = activeEdit?.id ?? `map:field:${key}`;
      onSetEditError?.(id, key, message);
    },
    [activeEdit?.id, onSetEditError],
  );

  const updateMap = useCallback(
    (mutate: (next: ChapterMapDefinition) => void): void => {
      const next = structuredClone(mapRef.current);
      mutate(next);
      mapRef.current = next;
      setMapError(null);
      onChange(next);
    },
    [onChange, setMapError],
  );

  const resizeRoom = (width: number, height: number): boolean => {
    const currentMap = mapRef.current;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      setMapError("房间宽高必须是有限数字。");
      return false;
    }
    if (
      !Number.isInteger(width) ||
      width < MIN_ROOM ||
      width > MAX_ROOM ||
      width % GRID !== 0 ||
      !Number.isInteger(height) ||
      height < 1080 ||
      height > MAX_ROOM ||
      height % GRID !== 0
    ) {
      setMapError(
        `房间宽高必须是 ${GRID}px 网格上的整数（${MIN_ROOM}–${MAX_ROOM}）。`,
      );
      return false;
    }
    const nextWidth = width;
    const nextHeight = height;
    const offenders = [
      ...currentMap.decorations.map((item) => ({ ...item })),
      ...currentMap.hotspots.map((item) => ({ ...item })),
    ].filter((item) => !containMapRect(item, nextWidth, nextHeight));
    const nextViewX = clampMapCenter(currentMap.view_x, nextWidth, 1920);
    const nextViewY = clampMapCenter(currentMap.view_y, nextHeight, 1080);
    if (nextViewX !== currentMap.view_x || nextViewY !== currentMap.view_y) {
      setMapError("房间不能缩小到初始视图框之外，请先移动视图框。");
      return false;
    }
    if (offenders.length > 0) {
      setMapError(
        `房间不能缩小到对象之外：${offenders.map((item) => item.id).join("、")}`,
      );
      return false;
    }
    setMapError(null);
    updateMap((next) => {
      next.width = nextWidth;
      next.height = nextHeight;
    });
    return true;
  };

  const draftValue = (key: string, value: unknown): string => {
    if (activeEdit?.drafts[key] !== undefined) return activeEdit.drafts[key];
    if (value === null || value === undefined) return "";
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    return JSON.stringify(value);
  };
  const parseNumberDraft = (raw: string, label: string): number | null => {
    if (raw.trim() === "") {
      setMapError(`${label}不能为空。`);
      return null;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      setMapError(`${label}必须是有限数字。`);
      return null;
    }
    return value;
  };
  const parseDraftInput = (
    key: string,
    raw: string,
  ): { ok: true; value: unknown } | { ok: false; message: string } => {
    if (key === "selected.title") return { ok: true, value: raw };
    if (key === "selected.hover_text") {
      if (Array.from(raw).length > 256)
        return { ok: false, message: "Hover 文案不能超过 256 个字符。" };
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(raw)) {
        return { ok: false, message: "Hover 文案不能包含非法控制字符。" };
      }
      return { ok: true, value: raw };
    }
    if (key.startsWith("override.")) {
      const id = key.slice("override.".length);
      const definition = manifest.variables[id];
      if (definition === undefined)
        return { ok: false, message: `未知变量 ${id}。` };
      if (raw === "") return { ok: true, value: undefined };
      if (definition.type === "boolean") {
        if (raw !== "true" && raw !== "false")
          return { ok: false, message: `${id} 必须是 true 或 false。` };
        return { ok: true, value: raw === "true" };
      }
      if (definition.type === "integer") {
        if (!/^(?:0|-?[1-9][0-9]*)$/.test(raw))
          return { ok: false, message: `${id} 必须是规范整数。` };
        try {
          return { ok: true, value: BigInt(raw) };
        } catch {
          return { ok: false, message: `${id} 超出整数范围。` };
        }
      }
      if (definition.type === "number") {
        const number = Number(raw);
        return Number.isFinite(number)
          ? { ok: true, value: number }
          : { ok: false, message: `${id} 必须是有限数字。` };
      }
      return { ok: true, value: raw };
    }
    const numeric = new Set([
      "map.width",
      "map.height",
      "map.view_x",
      "map.view_y",
      "selected.x",
      "selected.y",
      "selected.width",
      "selected.height",
      "selected.z",
    ]);
    if (numeric.has(key)) {
      if (raw.trim() === "") return { ok: false, message: "数值不能为空。" };
      const value = Number(raw);
      return Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: "数值必须是有限数字。" };
    }
    return { ok: true, value: raw };
  };
  const applyDraftInput = (
    next: ChapterMapDefinition,
    key: string,
    value: unknown,
  ): void => {
    if (key === "map.width" && typeof value === "number") next.width = value;
    else if (key === "map.height" && typeof value === "number")
      next.height = value;
    else if (key === "map.view_x" && typeof value === "number")
      next.view_x = value;
    else if (key === "map.view_y" && typeof value === "number")
      next.view_y = value;
    else if (key === "selected.title" && typeof value === "string") {
      const item =
        selection === null
          ? undefined
          : (selection.kind === "hotspot"
              ? next.hotspots
              : next.decorations
            ).find((candidate) => candidate.id === selection.id);
      if (item !== undefined && "title" in item) item.title = value;
    } else if (key === "selected.hover_text" && typeof value === "string") {
      const item =
        selection?.kind === "hotspot"
          ? next.hotspots.find((candidate) => candidate.id === selection.id)
          : undefined;
      if (item !== undefined) item.hover_text = value;
    } else if (key.startsWith("selected.")) {
      const property = key.slice("selected.".length);
      const item =
        selection === null
          ? undefined
          : (selection.kind === "hotspot"
              ? next.hotspots
              : next.decorations
            ).find((candidate) => candidate.id === selection.id);
      if (item !== undefined && property in item && typeof value === "number")
        (item as unknown as Record<string, unknown>)[property] = value;
    } else if (key.startsWith("override.")) {
      const id = key.slice("override.".length);
      const item =
        selection?.kind === "hotspot"
          ? next.hotspots.find((candidate) => candidate.id === selection.id)
          : undefined;
      if (item !== undefined) {
        if (value === undefined)
          Reflect.deleteProperty(item.variable_overrides, id);
        else item.variable_overrides[id] = value as never;
      }
    }
  };
  const setDraftValue = (key: string, value: string): void => {
    activeInspectorKeyRef.current = key;
    const id = `map:field:${key}`;
    onBeginEdit?.(id, "编辑地图属性");
    const parsed = parseDraftInput(key, value);
    onSetEditDraft?.(id, key, value, !parsed.ok);
    if (!parsed.ok) {
      setMapError(parsed.message);
      return;
    }
    setMapError(null);
    updateMap((next) => applyDraftInput(next, key, parsed.value));
  };
  const commitDraftValue = (
    key: string,
    commitValue: (raw: string) => boolean,
  ): void => {
    const raw = activeEdit?.drafts[key];
    if (raw === undefined) return;
    if (!commitValue(raw)) {
      onSetEditDraft?.(`map:field:${key}`, key, raw, true);
      if (mapError === null) setMapError("输入值无效。");
      return;
    }
    onSetEditError?.(`map:field:${key}`, key, null);
    onCommitEdit?.(`map:field:${key}`, key);
    if (activeInspectorKeyRef.current === key)
      activeInspectorKeyRef.current = null;
  };

  const addHotspot = (sceneId: string, at?: { x: number; y: number }): void => {
    const currentMap = mapRef.current;
    const index = currentMap.hotspots.length;
    const idBase = sceneId.replace(/[^A-Za-z0-9._-]/g, "_");
    let id = idBase || `hotspot_${index + 1}`;
    let suffix = 2;
    while (
      currentMap.hotspots.some((item) => item.id === id) ||
      currentMap.decorations.some((item) => item.id === id)
    ) {
      id = `${idBase || "hotspot"}_${suffix++}`;
    }
    const hotspot = {
      id,
      scene_id: sceneId,
      title: sceneId,
      x: Math.max(
        0,
        Math.min(
          currentMap.width - 280,
          snap(at?.x ?? 240 + (index % 5) * 320),
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          currentMap.height - 160,
          snap(at?.y ?? 360 + Math.floor(index / 5) * 240),
        ),
      ),
      width: 280,
      height: 160,
      z: 10,
      asset: null,
      hover_text: null,
      reveal: { mode: "completed" as const },
      variable_overrides: {},
    };
    updateMap((next) => next.hotspots.push(hotspot));
    select({ kind: "hotspot", id });
  };

  const addDecoration = (
    assetId?: string,
    at?: { x: number; y: number },
  ): void => {
    const currentMap = mapRef.current;
    const fallback = firstVisibleAssetId(assets, assetLayout, [
      "gui",
      "sprite",
    ]);
    const resolvedId = assetId ?? fallback ?? undefined;
    const source =
      resolvedId === undefined
        ? undefined
        : assets.find((asset) => asset.id === resolvedId);
    if (source === undefined) return;
    let id = `decoration_${currentMap.decorations.length + 1}`;
    while (
      currentMap.decorations.some((item) => item.id === id) ||
      currentMap.hotspots.some((item) => item.id === id)
    )
      id = `${id}_x`;
    const decoration = {
      id,
      asset: source.id,
      x: Math.max(0, Math.min(currentMap.width - 240, snap(at?.x ?? 120))),
      y: Math.max(0, Math.min(currentMap.height - 180, snap(at?.y ?? 120))),
      width: 240,
      height: 180,
      z: 1,
    };
    updateMap((next) => next.decorations.push(decoration));
    select({ kind: "decoration", id });
  };

  const pointerDown = (
    event: PointerEvent<HTMLDivElement>,
    kind: "hotspot" | "decoration",
    id: string,
    x: number,
    y: number,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    // Select before requesting capture.  A synthetic/test pointer or a
    // pointer that was cancelled by the browser may not be capturable, but a
    // click on the object must still update the inspector.
    select({ kind, id });
    captureMapPointer(event.currentTarget, event.pointerId);
    onBeginEdit?.(
      `map:${kind}:${id}`,
      kind === "hotspot" ? "移动章节热点" : "移动地图装饰",
    );
    setDrag({
      pointerId: event.pointerId,
      kind,
      id,
      startX: event.clientX,
      startY: event.clientY,
      originX: x,
      originY: y,
      x,
      y,
    });
  };

  const pointerDownResize = (
    event: PointerEvent<HTMLSpanElement>,
    kind: "hotspot" | "decoration",
    id: string,
    item: { x: number; y: number; width: number; height: number },
    edge: "nw" | "ne" | "sw" | "se",
  ): void => {
    event.stopPropagation();
    event.preventDefault();
    captureMapPointer(event.currentTarget, event.pointerId);
    select({ kind, id });
    onBeginEdit?.(`map:resize:${kind}:${id}`, "调整地图对象大小");
    setResizeDrag({
      pointerId: event.pointerId,
      kind,
      id,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      originX: item.x,
      originY: item.y,
      originWidth: item.width,
      originHeight: item.height,
      x: item.x,
      y: item.y,
      width: item.width,
      height: item.height,
    });
  };

  const pointerDownView = (event: PointerEvent<HTMLDivElement>): void => {
    event.stopPropagation();
    event.preventDefault();
    captureMapPointer(event.currentTarget, event.pointerId);
    onBeginEdit?.("map:view", "移动初始视图框");
    const currentMap = mapRef.current;
    setViewDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: currentMap.view_x,
      originY: currentMap.view_y,
      x: currentMap.view_x,
      y: currentMap.view_y,
    });
  };

  const pointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag === null || drag.pointerId !== event.pointerId) return;
    // Keep the pointer-down position as the immutable base.  Adding the
    // total pointer delta to the already-updated x/y makes a long drag grow
    // quadratically (each move applies all previous deltas again).
    const nextX = snap(drag.originX + (event.clientX - drag.startX) / scale);
    const nextY = snap(drag.originY + (event.clientY - drag.startY) / scale);
    updateMap((next) => {
      const list = drag.kind === "hotspot" ? next.hotspots : next.decorations;
      const item = list.find((candidate) => candidate.id === drag.id);
      if (item !== undefined) {
        item.x = Math.max(0, Math.min(next.width - item.width, nextX));
        item.y = Math.max(0, Math.min(next.height - item.height, nextY));
      }
    });
    setDrag({ ...drag, x: nextX, y: nextY });
  };

  const stagePointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (
      event.button !== 0 ||
      drag !== null ||
      resizeDrag !== null ||
      viewDrag !== null ||
      isMapInteractiveTarget(event.target)
    )
      return;
    event.preventDefault();
    captureMapPointer(event.currentTarget, event.pointerId);
    panDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: pan.x,
      y: pan.y,
    };
  };

  const stagePointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (viewDrag !== null) {
      if (viewDrag.pointerId !== event.pointerId) return;
      const currentMap = mapRef.current;
      const x = clampMapCenter(
        snap(
          viewDrag.originX +
            (event.clientX - viewDrag.startX) / Math.max(scale, 0.001),
        ),
        currentMap.width,
        1920,
      );
      const y = clampMapCenter(
        snap(
          viewDrag.originY +
            (event.clientY - viewDrag.startY) / Math.max(scale, 0.001),
        ),
        currentMap.height,
        1080,
      );
      updateMap((next) => {
        next.view_x = x;
        next.view_y = y;
      });
      setViewDrag({ ...viewDrag, x, y });
      return;
    }
    if (resizeDrag !== null && resizeDrag.pointerId === event.pointerId) {
      const { x, y, width, height } = calculateResize(resizeDrag, event);
      updateMap((next) => {
        const list =
          resizeDrag.kind === "hotspot" ? next.hotspots : next.decorations;
        const item = list.find((candidate) => candidate.id === resizeDrag.id);
        if (item !== undefined) Object.assign(item, { x, y, width, height });
      });
      setResizeDrag({ ...resizeDrag, x, y, width, height });
      return;
    }
    if (drag !== null) {
      pointerMove(event);
      return;
    }
    const active = panDrag.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    setPan({
      x: active.x + event.clientX - active.startX,
      y: active.y + event.clientY - active.startY,
    });
  };

  const calculateResize = (
    active: NonNullable<typeof resizeDrag>,
    event: Pick<PointerEvent<HTMLDivElement>, "clientX" | "clientY">,
  ): Pick<NonNullable<typeof resizeDrag>, "x" | "y" | "width" | "height"> => {
    const currentMap = mapRef.current;
    const dx = (event.clientX - active.startX) / Math.max(scale, 0.001);
    const dy = (event.clientY - active.startY) / Math.max(scale, 0.001);
    let { x, y, width, height } = active;
    if (active.edge.includes("e")) width = snap(active.originWidth + dx);
    if (active.edge.includes("s")) height = snap(active.originHeight + dy);
    if (active.edge.includes("w")) {
      x = snap(active.originX + dx);
      width = snap(active.originWidth - dx);
    }
    if (active.edge.includes("n")) {
      y = snap(active.originY + dy);
      height = snap(active.originHeight - dy);
    }
    const minimum = GRID;
    if (width < minimum) {
      if (active.edge.includes("w"))
        x = active.originX + active.originWidth - minimum;
      width = minimum;
    }
    if (height < minimum) {
      if (active.edge.includes("n"))
        y = active.originY + active.originHeight - minimum;
      height = minimum;
    }
    // A handle dragged beyond the opposite room edge must not create a
    // rectangle wider/taller than the room; otherwise the subsequent
    // clamp would produce a negative `map.width - width` and an invalid
    // document. Preserve the anchored edge when reducing the dimension.
    if (width > currentMap.width) {
      width = currentMap.width;
      if (active.edge.includes("w")) x = 0;
    }
    if (height > currentMap.height) {
      height = currentMap.height;
      if (active.edge.includes("n")) y = 0;
    }
    x = Math.max(0, Math.min(currentMap.width - width, x));
    y = Math.max(0, Math.min(currentMap.height - height, y));
    return { x, y, width, height };
  };

  const stagePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (viewDrag !== null && viewDrag.pointerId === event.pointerId) {
      const currentMap = mapRef.current;
      const x = clampMapCenter(
        snap(
          viewDrag.originX +
            (event.clientX - viewDrag.startX) / Math.max(scale, 0.001),
        ),
        currentMap.width,
        1920,
      );
      const y = clampMapCenter(
        snap(
          viewDrag.originY +
            (event.clientY - viewDrag.startY) / Math.max(scale, 0.001),
        ),
        currentMap.height,
        1080,
      );
      updateMap((next) => {
        next.view_x = x;
        next.view_y = y;
      });
      onCommitEdit?.("map:view");
      setViewDrag(null);
    } else if (resizeDrag !== null && resizeDrag.pointerId === event.pointerId)
      resizePointerUp(event);
    else if (drag !== null && drag.pointerId === event.pointerId)
      pointerUp(event);
    if (panDrag.current?.pointerId === event.pointerId) panDrag.current = null;
  };

  const resizePointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (resizeDrag === null) return;
    if (resizeDrag.pointerId !== event.pointerId) return;
    const { kind, id } = resizeDrag;
    const { x, y, width, height } = calculateResize(resizeDrag, event);
    updateMap((next) => {
      const list = kind === "hotspot" ? next.hotspots : next.decorations;
      const item = list.find((candidate) => candidate.id === id);
      if (item !== undefined) Object.assign(item, { x, y, width, height });
    });
    onCommitEdit?.(`map:resize:${kind}:${id}`);
    setResizeDrag(null);
  };

  const dropOnStage = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    // Scenes come from this workspace's list; assets use the shared editor
    // asset drag type, so the asset library and this list are interchangeable.
    const libraryAsset = draggedAssetId(event.dataTransfer, assets, [
      "gui",
      "sprite",
    ]);
    const kind =
      libraryAsset !== null
        ? "asset"
        : event.dataTransfer.getData("application/x-vectspace-kind");
    const id =
      libraryAsset ?? event.dataTransfer.getData("application/x-vectspace-id");
    if (!id) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = snap((event.clientX - bounds.left) / Math.max(scale, 0.001));
    const y = snap((event.clientY - bounds.top) / Math.max(scale, 0.001));
    const clamped = { x: Math.max(0, x), y: Math.max(0, y) };
    if (kind === "scene") addHotspot(id, clamped);
    else if (kind === "asset") addDecoration(id, clamped);
  };

  const pointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag === null) return;
    if (drag.pointerId !== event.pointerId) return;
    const { kind, id } = drag;
    const x = snap(
      drag.originX + (event.clientX - drag.startX) / Math.max(scale, 0.001),
    );
    const y = snap(
      drag.originY + (event.clientY - drag.startY) / Math.max(scale, 0.001),
    );
    updateMap((next) => {
      const list = kind === "hotspot" ? next.hotspots : next.decorations;
      const item = list.find((candidate) => candidate.id === id);
      if (item !== undefined) {
        item.x = Math.max(0, Math.min(next.width - item.width, x));
        item.y = Math.max(0, Math.min(next.height - item.height, y));
      }
    });
    onCommitEdit?.(`map:${kind}:${id}`);
    setDrag(null);
  };

  const updateSelected = (patch: Record<string, unknown>): void => {
    if (selection === null) return;
    updateMap((next) => {
      const list =
        selection.kind === "hotspot" ? next.hotspots : next.decorations;
      const item = list.find((candidate) => candidate.id === selection.id);
      if (item !== undefined) Object.assign(item, patch);
    });
  };

  const MIN_ZOOM = 0.25;
  const MAX_ZOOM = 4;
  /** Zoom by `factor`, keeping the room point under `anchor` still. */
  const zoomBy = (factor: number, anchor?: { x: number; y: number }): void => {
    const wrap = canvasRef.current;
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    if (nextZoom === zoom) return;
    if (wrap === null || anchor === undefined) {
      setPan((current) => ({
        x: current.x * (nextZoom / zoom),
        y: current.y * (nextZoom / zoom),
      }));
      setZoom(nextZoom);
      return;
    }
    const rect = wrap.getBoundingClientRect();
    const centreX = rect.left + rect.width / 2;
    const centreY = rect.top + rect.height / 2;
    const current = fitScale * zoom;
    const next = fitScale * nextZoom;
    // World point under the cursor, with the stage centred in the canvas.
    const worldX =
      (anchor.x - (centreX - (map.width * current) / 2 + pan.x)) / current;
    const worldY =
      (anchor.y - (centreY - (map.height * current) / 2 + pan.y)) / current;
    setPan({
      x: anchor.x - centreX + (map.width * next) / 2 - worldX * next,
      y: anchor.y - centreY + (map.height * next) / 2 - worldY * next,
    });
    setZoom(nextZoom);
  };
  const resetView = (): void => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  /** Move the selected object by a grid-aligned offset (arrow keys). */
  const nudgeSelected = (dx: number, dy: number): void => {
    if (selection === null) return;
    updateMap((next) => {
      const items =
        selection.kind === "hotspot" ? next.hotspots : next.decorations;
      const item = items.find((candidate) => candidate.id === selection.id);
      if (item === undefined) return;
      item.x = Math.max(0, Math.min(next.width - item.width, item.x + dx));
      item.y = Math.max(0, Math.min(next.height - item.height, item.y + dy));
    });
  };

  const removeSelected = (): void => {
    if (selection === null) return;
    updateMap((next) => {
      if (selection.kind === "hotspot") {
        next.hotspots = next.hotspots.filter(
          (item) => item.id !== selection.id,
        );
      } else {
        next.decorations = next.decorations.filter(
          (item) => item.id !== selection.id,
        );
      }
    });
    select(null);
  };

  // Delete removes the selected object; arrow keys nudge it by one grid
  // cell (Shift: five cells).  Typing in the inspector is never affected.
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (shouldIgnoreShortcut(event) || isEditableTarget(event.target)) return;
      if (selection === null) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeSelected();
        return;
      }
      const step = GRID * (event.shiftKey ? 5 : 1);
      const offsets: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const offset = offsets[event.key];
      if (offset === undefined) return;
      event.preventDefault();
      nudgeSelected(offset[0], offset[1]);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const displayedObject = (
    kind: "hotspot" | "decoration",
    id: string,
    item: { x: number; y: number; width: number; height: number },
  ): { x: number; y: number; width: number; height: number } => {
    if (resizeDrag?.kind === kind && resizeDrag.id === id) {
      return resizeDrag;
    }
    if (drag?.kind === kind && drag.id === id) {
      return { ...item, x: drag.x, y: drag.y };
    }
    return item;
  };

  const selectedDisplay =
    selection !== null && selectedObject !== null
      ? displayedObject(selection.kind, selectedObject.id, selectedObject)
      : null;

  const viewCenterX = viewDrag?.x ?? map.view_x;
  const viewCenterY = viewDrag?.y ?? map.view_y;
  const viewFrame = {
    x: viewCenterX - 960,
    y: viewCenterY - 540,
    width: 1920,
    height: 1080,
  };
  const mapObjects = sortMapObjects<MapLayerObject>([
    ...map.decorations.map((item) => ({ kind: "decoration" as const, item })),
    ...map.hotspots.map((item) => ({ kind: "hotspot" as const, item })),
  ]) as MapObjectEntry[];

  const cancelPointerOperation = useCallback((): void => {
    if (drag !== null) onCancelEdit?.(`map:${drag.kind}:${drag.id}`);
    if (resizeDrag !== null)
      onCancelEdit?.(`map:resize:${resizeDrag.kind}:${resizeDrag.id}`);
    if (viewDrag !== null) onCancelEdit?.("map:view");
    setDrag(null);
    setResizeDrag(null);
    setViewDrag(null);
    panDrag.current = null;
  }, [drag, onCancelEdit, resizeDrag, viewDrag]);

  useEffect(() => {
    const handleEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented || isComposing(event)) return;
      event.preventDefault();

      const draftKey = activeInspectorKeyRef.current;
      if (
        draftKey !== null &&
        activeEdit?.id.startsWith("map:field:") === true
      ) {
        onCancelEdit?.(activeEdit.id);
        activeInspectorKeyRef.current = null;
        setMapError(null);
        if (event.target instanceof HTMLElement) event.target.blur();
        return;
      }

      // Escape first cancels the in-flight pointer gesture.  A second Escape
      // (or Escape with no gesture) leaves the workspace, so an unfinished
      // drag can never be committed accidentally while the user is trying to
      // go back.
      if (
        drag !== null ||
        resizeDrag !== null ||
        viewDrag !== null ||
        panDrag.current !== null
      ) {
        cancelPointerOperation();
        return;
      }
      if (escapeTextEntry(event)) return;
      onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [
    activeEdit,
    cancelPointerOperation,
    drag,
    onCancelEdit,
    onClose,
    setMapError,
    resizeDrag,
    viewDrag,
  ]);

  return (
    <main className="map-workspace" ref={workspaceRef}>
      <WorkspaceHeader
        backLabel="返回剧情图"
        dirty={dirty}
        icon={MapIcon}
        kind="章节地图"
        onBack={onClose}
        onRedo={onRedo}
        onSave={onSave}
        onUndo={onUndo}
        onValidate={onValidate}
        redoAvailable={redoAvailable}
        title="世界地图"
        undoAvailable={undoAvailable}
      >
        <IconButton
          active={showGrid}
          icon={Grid3x3}
          label="网格"
          onClick={() => setShowGrid((value) => !value)}
          size="sm"
          tooltip="显示 20px 吸附网格"
        />
        <IconButton
          active={showViewFrame}
          icon={Frame}
          label="初始视图框"
          onClick={() => setShowViewFrame((value) => !value)}
          size="sm"
          tooltip="显示玩家进入地图时的初始视图"
        />
        <span aria-hidden="true" className="shell-divider" />
        <IconButton
          icon={ZoomOut}
          label="缩小"
          onClick={() => zoomBy(1 / 1.25)}
          size="sm"
        />
        <span className="workspace-transport-readout" title="当前缩放">
          {Math.round(scale * 100)}%
        </span>
        <IconButton
          icon={ZoomIn}
          label="放大"
          onClick={() => zoomBy(1.25)}
          size="sm"
        />
        <IconButton
          icon={Maximize}
          label="适合画布"
          onClick={resetView}
          size="sm"
        />
      </WorkspaceHeader>
      <section className="map-workspace-body">
        <MapSidePanel
          addDecoration={addDecoration}
          addHotspot={addHotspot}
          decorationOptions={decorationOptions}
          hiddenIds={hiddenIds}
          map={map}
          select={select}
          selection={selection}
          setHiddenIds={setHiddenIds}
          unplacedScenes={unplacedScenes}
        />
        <MapCanvas
          animationMap={animationMap}
          assets={assets}
          cancelPointerOperation={cancelPointerOperation}
          canvasRef={canvasRef}
          displayedObject={displayedObject}
          dropOnStage={dropOnStage}
          hiddenIds={hiddenIds}
          hoveredObjectId={hoveredObjectId}
          map={map}
          mapObjects={mapObjects}
          pan={pan}
          pointerDown={pointerDown}
          pointerDownResize={pointerDownResize}
          pointerDownView={pointerDownView}
          scale={scale}
          select={select}
          selectedDisplay={selectedDisplay}
          selectedObject={selectedObject}
          selection={selection}
          setHoveredObjectId={setHoveredObjectId}
          showGrid={showGrid}
          showViewFrame={showViewFrame}
          stagePointerDown={stagePointerDown}
          stagePointerMove={stagePointerMove}
          stagePointerUp={stagePointerUp}
          viewFrame={viewFrame}
          zoomBy={zoomBy}
        />
        <MapInspector
          assets={assets}
          commitDraftValue={commitDraftValue}
          draftValue={draftValue}
          manifest={manifest}
          map={map}
          mapError={mapError}
          mapRef={mapRef}
          parseNumberDraft={parseNumberDraft}
          removeSelected={removeSelected}
          resizeRoom={resizeRoom}
          selectedObject={selectedObject}
          selection={selection}
          setDraftValue={setDraftValue}
          setMapError={setMapError}
          updateMap={updateMap}
          updateSelected={updateSelected}
        />
      </section>
    </main>
  );
}
