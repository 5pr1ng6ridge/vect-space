import type { ReactElement, RefObject } from "react";
import { clampMapCenter } from "@vectspace/presentation-core/chapter-map";
import type {
  AssetKind,
  ChapterMapDefinition,
  ContentManifest,
  EditorAsset,
} from "../../types";
import { AssetChooser } from "../AssetChooser";
import { GRID, MAX_ROOM, MIN_ROOM, snap } from "./mapGrid";
import type { MapSelection } from "./mapTypes";

function validAsset(asset: EditorAsset, kinds: AssetKind[]): boolean {
  return kinds.includes(asset.kind);
}

/** Right column: room settings, or the selected hotspot / decoration. */
export function MapInspector({
  assets,
  commitDraftValue,
  draftValue,
  manifest,
  map,
  mapError,
  mapRef,
  parseNumberDraft,
  removeSelected,
  resizeRoom,
  selectedObject,
  selection,
  setDraftValue,
  setMapError,
  updateMap,
  updateSelected,
}: {
  assets: readonly EditorAsset[];
  commitDraftValue(key: string, commit: (raw: string) => boolean): void;
  draftValue(key: string, value: unknown): string;
  manifest: ContentManifest;
  map: ChapterMapDefinition;
  mapError: string | null;
  mapRef: RefObject<ChapterMapDefinition>;
  parseNumberDraft(raw: string, label: string): number | null;
  removeSelected(): void;
  resizeRoom(width: number, height: number): boolean;
  selectedObject:
    | ChapterMapDefinition["hotspots"][number]
    | ChapterMapDefinition["decorations"][number]
    | null;
  selection: MapSelection;
  setDraftValue(key: string, value: string): void;
  setMapError(message: string | null): void;
  updateMap(mutate: (next: ChapterMapDefinition) => void): void;
  updateSelected(patch: Record<string, unknown>): void;
}): ReactElement {
  return (
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
                    (selectedObject as ChapterMapDefinition["hotspots"][number])
                      .title,
                  )}
                  onChange={(event) =>
                    setDraftValue("selected.title", event.currentTarget.value)
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
                    (selectedObject as ChapterMapDefinition["hotspots"][number])
                      .hover_text ?? "",
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
                    (selectedObject as ChapterMapDefinition["hotspots"][number])
                      .reveal?.mode ?? "completed"
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
                              mode: mode === "condition" ? "completed" : mode,
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
                    (selectedObject as ChapterMapDefinition["hotspots"][number])
                      .replay?.mode ?? "completed"
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
                                  setMapError(`${id} 必须是 true 或 false。`);
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
                  if (width < GRID || width > map.width - selectedObject.x) {
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
                  if (height < GRID || height > map.height - selectedObject.y) {
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
  );
}
