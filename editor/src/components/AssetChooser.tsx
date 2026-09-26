import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { ASSET_DRAG_TYPE, draggedAssetId } from "../assetDrag";
import {
  assetChoiceOptions,
  isAssetHidden,
  type AssetChoiceOption,
  type AssetFileLike,
} from "../assetLibrary";
import type { AssetKind, EditorLayout } from "../types";

/**
 * One searchable asset chooser shared by every asset-picking seam.
 *
 * The candidate list always comes from `assetChoiceOptions`: hidden assets are
 * excluded from *new* choices, while a currently selected hidden id stays in
 * the list (marked) so editing a node can never silently clear its value.
 * Search covers the display name, stable id, path and virtual folder and is
 * case-insensitive; the whole popover is keyboard driveable (Arrow keys to
 * move, Enter to pick, Escape to close).
 *
 * The editor-only layout (`asset_folders` / `asset_metadata`) reaches the
 * chooser through `AssetLayoutProvider`, so a seam does not have to thread a
 * layout prop through several component layers.
 */
const AssetLayoutContext = createContext<EditorLayout | null>(null);

export function AssetLayoutProvider({
  layout,
  children,
}: {
  layout: EditorLayout | null;
  children: ReactNode;
}): ReactElement {
  return (
    <AssetLayoutContext.Provider value={layout}>
      {children}
    </AssetLayoutContext.Provider>
  );
}

// The provider and its hook live beside the chooser on purpose: every asset
// seam must read the same editor-only layout, and a separate module would only
// add indirection.  Fast refresh still remounts the chooser correctly.
// eslint-disable-next-line react-refresh/only-export-components
export function useAssetLayout(): EditorLayout | null {
  return useContext(AssetLayoutContext);
}

interface CommonAssetChooserProps {
  assets: readonly AssetFileLike[];
  /** Overrides the layout supplied by `AssetLayoutProvider`. */
  layout?: EditorLayout | null;
  /** One kind, or several (renders a kind filter inside the popover). */
  kind?: AssetKind | readonly AssetKind[];
  /** Accessible name for the trigger and the popover listbox. */
  label?: string;
  disabled?: boolean;
  /** Manager mode: keep hidden assets selectable (asset library only). */
  includeHidden?: boolean;
  className?: string;
  /** Optional id that is not a registered asset, e.g. a template reference. */
  extraOptions?: readonly { id: string; label: string }[];
}

interface SingleAssetChooserProps extends CommonAssetChooserProps {
  multiple?: false;
  value: string | null | undefined;
  onChange(value: string | null): void;
  /** Renders an explicit “none” option that clears the value. */
  allowEmpty?: boolean;
  emptyLabel?: string;
}

interface MultiAssetChooserProps extends CommonAssetChooserProps {
  multiple: true;
  value: readonly string[];
  onChange(value: string[]): void;
}

export type AssetChooserProps =
  SingleAssetChooserProps | MultiAssetChooserProps;

const KIND_LABELS: Record<AssetKind, string> = {
  background: "背景",
  sprite: "立绘",
  gui: "GUI",
  bgm: "BGM",
  ambience: "环境声",
  sfx: "音效",
  video: "视频",
  font: "字体",
};

function kindList(kind: AssetChooserProps["kind"]): readonly AssetKind[] {
  if (kind === undefined) return [];
  return typeof kind === "string" ? [kind] : kind;
}

function describeOption(option: AssetChoiceOption): string {
  const parts: string[] = [];
  if (option.id !== option.label) parts.push(option.id);
  if (option.path !== null && option.path !== "") parts.push(option.path);
  if (option.folderPath !== "") parts.push(`目录：${option.folderPath}`);
  if (option.hidden) parts.push("已隐藏");
  return parts.join(" · ");
}

function buildOptions(
  assets: readonly AssetFileLike[],
  layout: EditorLayout | null,
  kind: AssetChooserProps["kind"],
  selectedIds: readonly (string | null | undefined)[],
  query: string,
  includeHidden: boolean,
  folderFilter: string | null | undefined,
  extraOptions: readonly { id: string; label: string }[] | undefined,
): AssetChoiceOption[] {
  const kinds = kindList(kind);
  const typeFilter = kinds.length > 1 ? undefined : kinds[0];
  const options = assetChoiceOptions({
    assets,
    layout,
    kind: typeFilter,
    selectedIds,
    query,
    folderId: folderFilter,
    includeHidden,
  }).filter((option) =>
    kinds.length > 1 ? kinds.includes(option.kind) : true,
  );
  for (const extra of extraOptions ?? []) {
    if (options.some((option) => option.id === extra.id)) continue;
    if (
      query.trim() !== "" &&
      !`${extra.label} ${extra.id}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
    )
      continue;
    options.push({
      id: extra.id,
      kind: "gui",
      label: extra.label,
      displayName: null,
      path: null,
      folderId: null,
      folderPath: "",
      hidden: false,
      selectedHidden: false,
      selected: selectedIds.includes(extra.id),
    });
  }
  return options;
}

export function AssetChooser(props: AssetChooserProps): ReactElement {
  const { assets, disabled = false, includeHidden = false, className } = props;
  const contextLayout = useAssetLayout();
  const layout = props.layout ?? contextLayout;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<AssetKind | "all">("all");
  const [folderFilter, setFolderFilter] = useState<string | null | undefined>(
    undefined,
  );
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const multiple = props.multiple === true;
  const selectedIds = useMemo(() => {
    if (props.multiple === true) return [...props.value];
    const value = props.value;
    return value === null || value === undefined || value === "" ? [] : [value];
  }, [props]);
  const kinds = kindList(props.kind);
  const effectiveKind =
    kinds.length > 1 && typeFilter !== "all" ? typeFilter : props.kind;
  const options = useMemo(
    () =>
      buildOptions(
        assets,
        layout,
        effectiveKind,
        selectedIds,
        query,
        includeHidden,
        folderFilter,
        props.extraOptions,
      ),
    [
      assets,
      layout,
      effectiveKind,
      selectedIds,
      query,
      includeHidden,
      folderFilter,
      props.extraOptions,
    ],
  );
  const folders = useMemo(() => folderChoices(layout), [layout]);
  const animatedIds = useMemo(
    () =>
      new Set(
        assets
          .filter((asset) => asset.animation !== undefined)
          .map((asset) => asset.id),
      ),
    [assets],
  );
  const selectedOption = useMemo(() => {
    if (props.multiple === true) return undefined;
    const value = props.value;
    if (value === null || value === undefined || value === "") return undefined;
    return (
      options.find((option) => option.id === value) ?? {
        id: value,
        kind: "gui" as AssetKind,
        label: `${value}（缺失）`,
        displayName: null,
        path: null,
        folderId: null,
        folderPath: "",
        hidden: false,
        selectedHidden: false,
        selected: true,
      }
    );
  }, [options, props]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (
        containerRef.current !== null &&
        !containerRef.current.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const commitSingle = useCallback(
    (value: string | null): void => {
      if (props.multiple === true) return;
      props.onChange(value);
    },
    [props],
  );

  const toggleMulti = useCallback(
    (id: string): void => {
      if (props.multiple !== true) return;
      const current = [...props.value];
      const next = current.includes(id)
        ? current.filter((value) => value !== id)
        : [...current, id];
      props.onChange(next);
    },
    [props],
  );

  const choose = useCallback(
    (option: { id: string } | null): void => {
      if (option === null) {
        commitSingle(null);
        setOpen(false);
        return;
      }
      if (multiple) {
        toggleMulti(option.id);
        return;
      }
      commitSingle(option.id);
      setOpen(false);
    },
    [commitSingle, multiple, toggleMulti],
  );

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      setActive((current) => {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = (current + delta + options.length) % options.length;
        return next;
      });
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, options.length - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const option = options[Math.min(active, options.length - 1)];
      if (option !== undefined) choose(option);
    }
  };

  const label = props.label ?? "素材";
  const triggerText =
    props.multiple === true
      ? props.value.length === 0
        ? "— 请选择 —"
        : `已选 ${props.value.length} 项`
      : selectedOption !== undefined
        ? `${selectedOption.label}${
            animatedIds.has(selectedOption.id) ? "（动画）" : ""
          }`
        : props.allowEmpty
          ? (props.emptyLabel ?? "— 无 —")
          : "— 请选择 —";

  return (
    <div
      className={`asset-chooser${className === undefined ? "" : ` ${className}`}`}
      onDragOver={(event) => {
        if (
          disabled ||
          !Array.from(event.dataTransfer.types).includes(ASSET_DRAG_TYPE)
        )
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        // Consume internal drops even when the kind is incompatible: never
        // bubble to a parent drop target or disturb the current field value.
        if (!event.dataTransfer.getData(ASSET_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        if (disabled) return;
        const id = draggedAssetId(event.dataTransfer, assets, kinds);
        if (
          id === null ||
          (!includeHidden &&
            isAssetHidden(layout, id) &&
            !(props.multiple ? props.value.includes(id) : props.value === id))
        )
          return;
        choose({ id });
      }}
      ref={containerRef}
    >
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className="asset-chooser-trigger"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="asset-chooser-value">{triggerText}</span>
        {!multiple && selectedOption !== undefined && (
          <small className="asset-chooser-sub">
            {describeOption(selectedOption)}
          </small>
        )}
        <span aria-hidden className="asset-chooser-caret">
          ▾
        </span>
      </button>
      {open && (
        <div className="asset-chooser-popover" role="presentation">
          <input
            aria-label={`搜索${label}`}
            className="asset-chooser-search"
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="搜索名称、ID、路径或文件夹…"
            ref={searchRef}
            type="search"
            value={query}
          />
          {(kinds.length > 1 || folders.length > 0) && (
            <div className="asset-chooser-filters">
              {kinds.length > 1 && (
                <select
                  aria-label="素材类型筛选"
                  onChange={(event) => {
                    setTypeFilter(
                      event.currentTarget.value as AssetKind | "all",
                    );
                    setActive(0);
                  }}
                  value={typeFilter}
                >
                  <option value="all">全部类型</option>
                  {kinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              )}
              {folders.length > 0 && (
                <select
                  aria-label="文件夹筛选"
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setFolderFilter(
                      value === "all" ? undefined : value === "" ? null : value,
                    );
                    setActive(0);
                  }}
                  value={
                    folderFilter === undefined ? "all" : (folderFilter ?? "")
                  }
                >
                  <option value="all">全部文件夹</option>
                  <option value="">（根目录）</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.path}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <ul
            aria-label={label}
            className="asset-chooser-list"
            id={listId}
            role="listbox"
            aria-multiselectable={multiple || undefined}
          >
            {props.multiple !== true && props.allowEmpty && (
              <li
                aria-selected={
                  props.value === null || props.value === undefined
                }
                className="asset-chooser-option"
                data-asset-id=""
                onClick={() => choose(null)}
                onMouseEnter={() => undefined}
                role="option"
              >
                <span className="asset-chooser-option-label">
                  {props.emptyLabel ?? "— 无 —"}
                </span>
              </li>
            )}
            {options.length === 0 && (
              <li className="asset-chooser-empty muted">没有匹配的素材</li>
            )}
            {options.map((option, index) => {
              const selected =
                props.multiple === true
                  ? props.value.includes(option.id)
                  : props.value === option.id;
              return (
                <li
                  aria-selected={selected}
                  className={`asset-chooser-option${
                    index === active ? " active" : ""
                  }${selected ? " selected" : ""}`}
                  data-asset-id={option.id}
                  key={option.id}
                  onClick={() => choose(option)}
                  onMouseEnter={() => setActive(index)}
                  role="option"
                >
                  <span className="asset-chooser-option-label">
                    <strong>
                      {option.label}
                      {animatedIds.has(option.id) ? "（动画）" : ""}
                    </strong>
                    {option.selectedHidden && (
                      <span className="asset-hidden-badge">已隐藏</span>
                    )}
                    <span className="asset-kind-chip">
                      {KIND_LABELS[option.kind] ?? option.kind}
                    </span>
                  </span>
                  <small className="asset-chooser-option-detail">
                    {describeOption(option)}
                  </small>
                </li>
              );
            })}
          </ul>
          {multiple && (
            <div className="asset-chooser-actions">
              <button onClick={() => setOpen(false)} type="button">
                完成
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface FolderChoice {
  id: string;
  path: string;
}

/** Flat folder list (id + display path) for the popover's folder filter. */
function folderChoices(layout: EditorLayout | null): FolderChoice[] {
  const folders = layout?.asset_folders ?? {};
  const pathOf = (id: string): string[] => {
    const seen = new Set<string>();
    const names: string[] = [];
    let current: string | null = id;
    while (current !== null && !seen.has(current)) {
      const folder: { parent_id: string | null; name: string } | undefined =
        folders[current];
      if (folder === undefined) break;
      seen.add(current);
      names.unshift(folder.name);
      current = folder.parent_id ?? null;
    }
    return names;
  };
  return Object.keys(folders)
    .map((id) => ({ id, path: pathOf(id).join("/") }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
