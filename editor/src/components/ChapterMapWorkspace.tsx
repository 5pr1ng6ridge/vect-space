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
  AssetKind,
  ChapterMapDefinition,
  EditorAsset,
  ContentManifest,
} from "../types";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import { editorImageSource } from "../imageAnimationMap";
import { AnimatedImage } from "./AnimatedImage";
import { AssetChooser, useAssetLayout } from "./AssetChooser";
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
import { ASSET_DRAG_TYPE, draggedAssetId } from "../assetDrag";
import { assetChoiceOptions, firstVisibleAssetId } from "../assetLibrary";
import {
  clampMapCenter,
  containMapRect,
  resolveChapterMapHoverText,
  snapMap,
  sortMapObjects,
  sortMapLayer,
} from "@vectspace/presentation-core/chapter-map";
import type { MapLayerObject } from "@vectspace/presentation-core/chapter-map";

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

type Selection = { kind: "hotspot" | "decoration"; id: string } | null;

const MAP_INTERACTIVE_SELECTOR =
  ".map-editor-object, .map-resize-handle, .map-editor-view-frame span";

function isMapInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(MAP_INTERACTIVE_SELECTOR) !== null
  );
}

function captureMapPointer(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture?.(pointerId);
  } catch {
    // A cancelled pointer cannot be captured. The gesture state is still
    // useful for the current event, and selection must not be lost with it.
  }
}

const GRID = 20;
const MIN_ROOM = 1920;
const MAX_ROOM = 16380;

const snap = (value: number): number => snapMap(value, GRID);

function validAsset(asset: EditorAsset, kinds: AssetKind[]): boolean {
  return kinds.includes(asset.kind);
}

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
  // Selection is a single derived value, not a mirrored pair of states.
  //
  // An earlier design kept a local `selection` state *and* mirrored it to the
  // parent `selectionId` in two opposing effects.  Creating a hotspot updated
  // the local value first, the mirror-to-parent effect pushed the new id up,
  // and the mirror-from-parent effect cleared the local value in the same
  // commit because its `map` prop had not rendered yet.  That ping-ponged
  // forever ("selection jumps between background settings and the node").
  // The component is now controlled: pointer interactions call
  // `select()`, which only notifies the parent, and the rendered selection is
  // derived from `selectionId` plus the current map.
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
    (next: Selection | null): void => {
      if (controlledSelection) onSelectionChange?.(next?.id ?? null);
      else setUncontrolledSelectionId(next?.id ?? null);
    },
    [controlledSelection, onSelectionChange],
  );
  const selection = useMemo<Selection>(() => {
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
  ]) as (
    | {
        kind: "decoration";
        item: ChapterMapDefinition["decorations"][number];
      }
    | { kind: "hotspot"; item: ChapterMapDefinition["hotspots"][number] }
  )[];

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
        <aside className="map-side-panel">
          <h3>未放置的场景</h3>
          {unplacedScenes.length === 0 && (
            <p className="muted">所有场景都已放置</p>
          )}
          {unplacedScenes.map((sceneId) => (
            <button
              className="map-list-button"
              key={sceneId}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  "application/x-vectspace-kind",
                  "scene",
                );
                event.dataTransfer.setData(
                  "application/x-vectspace-id",
                  sceneId,
                );
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
                    : resolveChapterMapHoverText(
                        hotspot.title,
                        hotspot.hover_text,
                      );
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
        <aside className="map-inspector">
          <h3>
            {selectedObject === null
              ? "地图设置"
              : selection?.kind === "hotspot"
                ? "章节热点"
                : "地图装饰"}
          </h3>
          {selectedObject === null ? (
            <>
              <label>
                房间背景
                <AssetChooser
                  allowEmpty
                  assets={assets}
                  emptyLabel="无"
                  kind="background"
                  label="房间背景"
                  onChange={(value) =>
                    updateMap((next) => {
                      next.background = value;
                    })
                  }
                  value={map.background ?? null}
                />
              </label>
              <label>
                房间宽度
                <input
                  onBlur={() =>
                    commitDraftValue("map.width", (raw) => {
                      const value = parseNumberDraft(raw, "房间宽度");
                      return value === null
                        ? false
                        : resizeRoom(value, mapRef.current.height);
                    })
                  }
                  min={MIN_ROOM}
                  max={MAX_ROOM}
                  step={GRID}
                  type="number"
                  value={draftValue("map.width", map.width)}
                  onChange={(event) =>
                    setDraftValue("map.width", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                房间高度
                <input
                  onBlur={() =>
                    commitDraftValue("map.height", (raw) => {
                      const value = parseNumberDraft(raw, "房间高度");
                      return value === null
                        ? false
                        : resizeRoom(mapRef.current.width, value);
                    })
                  }
                  min={1080}
                  max={MAX_ROOM}
                  step={GRID}
                  type="number"
                  value={draftValue("map.height", map.height)}
                  onChange={(event) =>
                    setDraftValue("map.height", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                初始视图 X
                <input
                  onBlur={() =>
                    commitDraftValue("map.view_x", (raw) => {
                      const value = parseNumberDraft(raw, "初始视图 X");
                      if (value === null) return false;
                      const snapped = snap(value);
                      const bounded = clampMapCenter(snapped, map.width, 1920);
                      if (snapped !== bounded) {
                        setMapError("初始视图 X 超出可见视口边界。");
                        return false;
                      }
                      updateMap((next) => {
                        next.view_x = snapped;
                      });
                      return true;
                    })
                  }
                  step={GRID}
                  type="number"
                  value={draftValue("map.view_x", map.view_x)}
                  onChange={(event) =>
                    setDraftValue("map.view_x", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                初始视图 Y
                <input
                  onBlur={() =>
                    commitDraftValue("map.view_y", (raw) => {
                      const value = parseNumberDraft(raw, "初始视图 Y");
                      if (value === null) return false;
                      const snapped = snap(value);
                      const bounded = clampMapCenter(snapped, map.height, 1080);
                      if (snapped !== bounded) {
                        setMapError("初始视图 Y 超出可见视口边界。");
                        return false;
                      }
                      updateMap((next) => {
                        next.view_y = snapped;
                      });
                      return true;
                    })
                  }
                  step={GRID}
                  type="number"
                  value={draftValue("map.view_y", map.view_y)}
                  onChange={(event) =>
                    setDraftValue("map.view_y", event.currentTarget.value)
                  }
                />
              </label>
              <p className="muted">网格：20px。坐标和尺寸保存为设计像素。</p>
              {mapError !== null && <p className="inline-error">{mapError}</p>}
            </>
          ) : (
            <>
              {selection?.kind === "hotspot" && (
                <>
                  <label>
                    标题
                    <input
                      onBlur={() =>
                        commitDraftValue("selected.title", (raw) => {
                          if (raw.trim().length === 0) {
                            setMapError("章节标题不能为空。");
                            return false;
                          }
                          updateSelected({ title: raw });
                          return true;
                        })
                      }
                      value={draftValue(
                        "selected.title",
                        (
                          selectedObject as ChapterMapDefinition["hotspots"][number]
                        ).title,
                      )}
                      onChange={(event) =>
                        setDraftValue(
                          "selected.title",
                          event.currentTarget.value,
                        )
                      }
                    />
                  </label>
                  <label>
                    Hover 文案
                    <textarea
                      onBlur={() =>
                        commitDraftValue("selected.hover_text", () => true)
                      }
                      placeholder="未配置时使用标题；输入空白可隐藏文字框"
                      rows={3}
                      value={draftValue(
                        "selected.hover_text",
                        (
                          selectedObject as ChapterMapDefinition["hotspots"][number]
                        ).hover_text ?? "",
                      )}
                      onChange={(event) =>
                        setDraftValue(
                          "selected.hover_text",
                          event.currentTarget.value,
                        )
                      }
                    />
                  </label>
                  <button
                    className="map-hover-reset"
                    onClick={() => updateSelected({ hover_text: null })}
                    type="button"
                  >
                    恢复使用标题
                  </button>
                  <label>
                    揭示策略
                    <select
                      value={
                        (
                          selectedObject as ChapterMapDefinition["hotspots"][number]
                        ).reveal?.mode ?? "completed"
                      }
                      onChange={(event) => {
                        const mode = event.currentTarget.value as
                          "completed" | "always" | "condition";
                        const profile = Object.entries(manifest.variables).find(
                          ([, definition]) => definition.scope === "profile",
                        );
                        const current =
                          selectedObject as ChapterMapDefinition["hotspots"][number];
                        const condition =
                          current.reveal?.mode === "condition"
                            ? current.reveal.condition
                            : profile === undefined
                              ? undefined
                              : {
                                  op: "eq" as const,
                                  left: { variable: profile[0] },
                                  right: { value: profile[1].default },
                                };
                        updateSelected({
                          reveal:
                            mode === "condition" && condition !== undefined
                              ? { mode, condition }
                              : {
                                  mode:
                                    mode === "condition" ? "completed" : mode,
                                },
                        });
                      }}
                    >
                      <option value="completed">完成后显示</option>
                      <option value="always">始终显示</option>
                      <option
                        disabled={Object.values(manifest.variables).every(
                          (definition) => definition.scope !== "profile",
                        )}
                        value="condition"
                      >
                        条件显示
                      </option>
                    </select>
                  </label>
                  <label>
                    重演策略
                    <select
                      onChange={(event) =>
                        updateSelected({
                          replay: {
                            mode: event.currentTarget.value as
                              "completed" | "always",
                          },
                        })
                      }
                      value={
                        (
                          selectedObject as ChapterMapDefinition["hotspots"][number]
                        ).replay?.mode ?? "completed"
                      }
                    >
                      <option value="completed">完成后可重演</option>
                      <option value="always">始终可重演</option>
                    </select>
                  </label>
                  {(selectedObject as ChapterMapDefinition["hotspots"][number])
                    .replay?.mode === "always" && (
                    <p className="field-note">
                      未到达的章节也可以直接进入；若同时“始终显示”，编辑器不会再把它报为不可到达。
                    </p>
                  )}
                  {Object.keys(manifest.variables).length > 0 && (
                    <details className="map-overrides">
                      <summary>重演变量覆盖</summary>
                      {Object.entries(manifest.variables).map(
                        ([id, definition]) => (
                          <label key={id}>
                            {id} · {definition.scope}
                            <input
                              value={draftValue(
                                `override.${id}`,
                                (
                                  selectedObject as ChapterMapDefinition["hotspots"][number]
                                ).variable_overrides[id] ?? "",
                              )}
                              placeholder={String(definition.default)}
                              onChange={(event) =>
                                setDraftValue(
                                  `override.${id}`,
                                  event.currentTarget.value,
                                )
                              }
                              onBlur={() =>
                                commitDraftValue(`override.${id}`, (raw) => {
                                  const overrides = {
                                    ...(
                                      selectedObject as ChapterMapDefinition["hotspots"][number]
                                    ).variable_overrides,
                                  };
                                  if (raw === "") {
                                    Reflect.deleteProperty(overrides, id);
                                  } else if (definition.type === "boolean") {
                                    if (raw !== "true" && raw !== "false") {
                                      setMapError(
                                        `${id} 必须是 true 或 false。`,
                                      );
                                      return false;
                                    }
                                    overrides[id] = raw === "true";
                                  } else if (definition.type === "integer") {
                                    if (!/^(?:0|-?[1-9][0-9]*)$/.test(raw)) {
                                      setMapError(`${id} 必须是规范整数。`);
                                      return false;
                                    }
                                    try {
                                      overrides[id] = BigInt(raw);
                                    } catch {
                                      setMapError(`${id} 超出整数范围。`);
                                      return false;
                                    }
                                  } else if (definition.type === "number") {
                                    const number = Number(raw);
                                    if (!Number.isFinite(number)) {
                                      setMapError(`${id} 必须是有限数字。`);
                                      return false;
                                    }
                                    overrides[id] = number;
                                  } else {
                                    overrides[id] = raw;
                                  }
                                  setMapError(null);
                                  updateSelected({
                                    variable_overrides: overrides,
                                  });
                                  return true;
                                })
                              }
                            />
                          </label>
                        ),
                      )}
                    </details>
                  )}
                </>
              )}
              <label>
                素材
                <AssetChooser
                  allowEmpty={selection?.kind === "hotspot"}
                  assets={assets.filter((asset) =>
                    validAsset(asset, ["gui", "sprite"]),
                  )}
                  emptyLabel="默认卡片"
                  kind={["gui", "sprite"]}
                  label="素材"
                  onChange={(value) =>
                    updateSelected({
                      asset:
                        selection?.kind === "hotspot"
                          ? (value ?? null)
                          : (value ?? ""),
                    })
                  }
                  value={selectedObject.asset ?? null}
                />
              </label>
              <label>
                X
                <input
                  onBlur={() =>
                    commitDraftValue("selected.x", (raw) => {
                      const value = parseNumberDraft(raw, "X");
                      if (value === null) return false;
                      const x = snap(value);
                      if (
                        x < 0 ||
                        x > map.width ||
                        x > map.width - selectedObject.width
                      ) {
                        setMapError("X 会使对象超出房间边界。");
                        return false;
                      }
                      updateSelected({
                        x,
                      });
                      return true;
                    })
                  }
                  step={GRID}
                  type="number"
                  value={draftValue("selected.x", selectedObject.x)}
                  onChange={(event) =>
                    setDraftValue("selected.x", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                Y
                <input
                  onBlur={() =>
                    commitDraftValue("selected.y", (raw) => {
                      const value = parseNumberDraft(raw, "Y");
                      if (value === null) return false;
                      const y = snap(value);
                      if (
                        y < 0 ||
                        y > map.height ||
                        y > map.height - selectedObject.height
                      ) {
                        setMapError("Y 会使对象超出房间边界。");
                        return false;
                      }
                      updateSelected({
                        y,
                      });
                      return true;
                    })
                  }
                  step={GRID}
                  type="number"
                  value={draftValue("selected.y", selectedObject.y)}
                  onChange={(event) =>
                    setDraftValue("selected.y", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                宽
                <input
                  onBlur={() =>
                    commitDraftValue("selected.width", (raw) => {
                      const value = parseNumberDraft(raw, "宽");
                      if (value === null) return false;
                      const width = snap(value);
                      if (
                        width < GRID ||
                        width > map.width - selectedObject.x
                      ) {
                        setMapError("宽必须是至少 20px 且不能超出房间边界。");
                        return false;
                      }
                      updateSelected({ width });
                      return true;
                    })
                  }
                  min={GRID}
                  step={GRID}
                  type="number"
                  value={draftValue("selected.width", selectedObject.width)}
                  onChange={(event) =>
                    setDraftValue("selected.width", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                高
                <input
                  onBlur={() =>
                    commitDraftValue("selected.height", (raw) => {
                      const value = parseNumberDraft(raw, "高");
                      if (value === null) return false;
                      const height = snap(value);
                      if (
                        height < GRID ||
                        height > map.height - selectedObject.y
                      ) {
                        setMapError("高必须是至少 20px 且不能超出房间边界。");
                        return false;
                      }
                      updateSelected({ height });
                      return true;
                    })
                  }
                  min={GRID}
                  step={GRID}
                  type="number"
                  value={draftValue("selected.height", selectedObject.height)}
                  onChange={(event) =>
                    setDraftValue("selected.height", event.currentTarget.value)
                  }
                />
              </label>
              <label>
                层级
                <input
                  onBlur={() =>
                    commitDraftValue("selected.z", (raw) => {
                      const value = parseNumberDraft(raw, "层级");
                      if (value === null) return false;
                      if (
                        !Number.isInteger(value) ||
                        value < -2147483648 ||
                        value > 2147483647
                      ) {
                        setMapError("层级必须是 32 位整数。");
                        return false;
                      }
                      setMapError(null);
                      updateSelected({ z: Math.trunc(value) });
                      return true;
                    })
                  }
                  type="number"
                  value={draftValue("selected.z", selectedObject.z)}
                  onChange={(event) =>
                    setDraftValue("selected.z", event.currentTarget.value)
                  }
                />
              </label>
              <button
                className="danger-button"
                onClick={removeSelected}
                type="button"
              >
                删除对象
              </button>
              {mapError !== null && <p className="inline-error">{mapError}</p>}
            </>
          )}
          {selectedObject !== null && selection?.kind === "hotspot" && (
            <p className="muted">
              Scene：
              {
                (selectedObject as ChapterMapDefinition["hotspots"][number])
                  .scene_id
              }
            </p>
          )}
          <p className="muted">内容版本：{manifest.content_version}</p>
        </aside>
      </section>
    </main>
  );
}
