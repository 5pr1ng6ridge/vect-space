import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type UIEventHandler,
} from "react";
import { createPortal } from "react-dom";
import { ASSET_DRAG_TYPE } from "../assetDrag";
import { assetUrl, editorApi } from "../api";
import {
  animationSourceId,
  frameCandidates,
  type AnimationDraft,
} from "../imageAnimation";
import { isCanonicalIntegerText } from "../scalars";
import { useAssetFont } from "../useAssetFont";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import {
  type ProjectSectionId,
  type SidebarScrollStore,
} from "./projectSections";
import {
  findAssetReferences,
  findButtonTemplateReferences,
} from "./assetReferences";
import {
  assetChoiceOptions,
  assetDisplayName,
  assetFolderId,
  buildAssetFolderTree,
  createAssetFolder,
  firstVisibleAssetId,
  folderDisplayPath,
  isAssetHidden,
  isValidAssetFolderName,
  moveAssetFolder,
  moveAssetsToFolder,
  removeAssetFolder,
  renameAssetFolder,
  setAssetDisplayName,
  setAssetHidden,
  validateFolderMove,
  type AssetFolderNode,
  type AssetChoiceOption,
} from "../assetLibrary";
import { AssetChooser, useAssetLayout } from "./AssetChooser";
import {
  Clapperboard,
  FolderInput,
  CopyPlus,
  MousePointerClick,
  Pencil,
  PersonStanding,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { IconButton } from "../ui/Button";
import { LibraryRow } from "./LibraryRow";
import { ColorSwatch, DeferredInput } from "./Fields";
import { ID_RULE_HINT, idUnavailableReason } from "../app/ids";
import { isComposing } from "../ui/keyboard";
import { ASSET_KIND_ICONS } from "../ui/assetIcons";
import {
  ASSET_KIND_LABELS,
  VARIABLE_SCOPE_LABELS,
  VARIABLE_TYPE_LABELS,
} from "../labels";
import { FrameSequencePreview } from "./FrameSequencePreview";
import { ImageAnimationPanel } from "./ImageAnimationPanel";
import type {
  AnimationFile,
  AssetKind,
  CharacterDefinition,
  CharacterExpression,
  ContentManifest,
  EditorAsset,
  EditorDiagnostic,
  EditorLayout,
  EditorProject,
  AssetInspection,
  AssetMetadata,
  ScalarValue,
  VariableDefinition,
  VariableType,
} from "../types";

interface ProjectSidebarProps {
  project: EditorProject;
  activeTab?: SidebarTab;
  activeSceneId: string;
  diagnostics: EditorDiagnostic[];
  onSelectScene(sceneId: string): void;
  onAddScene(id: string): boolean;
  onRenameScene(previousId: string, nextId: string): boolean;
  onDeleteScene(sceneId: string): void;
  onManifestChange(manifest: ContentManifest): void;
  onImportAssets(items: ImportDraft[]): Promise<void>;
  onRemoveAsset(id: string): boolean;
  /**
   * Commit an editor-only layout change (virtual folders, display name,
   * hidden flag).  Nothing here ever touches a manifest path or a binary.
   */
  onChangeAssetLayout?(
    mutate: (layout: EditorLayout) => EditorLayout,
    label: string,
  ): void;
  /** Asset ids whose staged binary has not been written by a save yet. */
  pendingAssetIds?: readonly string[];
  /**
   * Editor-only reserved replacement destinations per asset id: the original
   * on-disk path plus every earlier staged replacement path.  The host forbids
   * all of them as destinations, so the picker mirrors that rule.
   */
  reservedAssetPaths?: Readonly<Record<string, readonly string[]>>;
  onCreateImageAnimation(draft: AnimationDraft): boolean;
  onSelectAsset?(id: string | null): void;
  selectedAssetId?: string | null;
  onAddVariable(id: string, definition: VariableDefinition): boolean;
  onChangeVariable(id: string, definition: VariableDefinition): void;
  onRenameVariable(previousId: string, nextId: string): boolean;
  onDeleteVariable(id: string): void;
  onAddCharacter(id: string, definition: CharacterDefinition): boolean;
  onChangeCharacter(id: string, definition: CharacterDefinition): void;
  onRenameCharacter(previousId: string, nextId: string): boolean;
  onDeleteCharacter(id: string): void;
  onCreateUiMotion(): void;
  onEditUiMotion(id: string): void;
  onDeleteUiMotion(id: string): void;
  onCreateButtonTemplate(): void;
  onEditButtonTemplate(id: string): void;
  onDuplicateButtonTemplate(id: string): void;
  onDeleteButtonTemplate(id: string): void;
  onCreateAction(id: string): boolean;
  onRenameAction(previousId: string, nextId: string): boolean;
  onDuplicateAction(id: string): void;
  onDeleteAction(id: string): void;
  /** Open the shared keyframe workspace for one reusable action. */
  onEditActionKeyframes(id: string): void;
  onNavigate(
    sceneId: string | null,
    nodeId: string | null,
    workspace?: "story" | "map",
    flowElementId?: string | null,
  ): void;
  onTabChange?(tab: SidebarTab): void;
  /** App-owned expand/collapse state for the five project sections. */
  sectionOpen?: Partial<Record<ProjectSectionId, boolean>>;
  onToggleSection?(id: ProjectSectionId): void;
  /** Save-independent expanded state for individual character/variable cards. */
  sidebarItemOpen?: Readonly<Record<string, boolean>>;
  onToggleSidebarItem?(key: string): void;
  /** App-owned, save-independent sidebar scroll offsets keyed by tab. */
  scrollStore?: SidebarScrollStore;
  /** The App shell renders its own activity bar; show only the panel. */
  hideTabs?: boolean;
  /** Records the live offset of whichever tab is scrolled. */
  onScrollOffset?(tab: SidebarTab, offset: number): void;
}

export type SidebarTab =
  | "scenes"
  | "assets"
  | "characters"
  | "variables"
  | "library"
  | "project"
  | "problems";

const PANEL_TITLES: Record<SidebarTab, string> = {
  scenes: "场景",
  assets: "素材库",
  characters: "角色",
  variables: "剧情变量",
  library: "资源库",
  project: "项目设置",
  problems: "问题",
};

/** The project-settings slices the activity bar can show on their own. */
export type ProjectPanelView =
  "project" | "characters" | "variables" | "library";

/**
 * Restore the host-owned scroll offset for `tab` exactly when the element that
 * owns the scrollbar mounts.  A callback ref is used instead of an effect
 * because the problems panel is rendered conditionally: an effect owned by the
 * sidebar runs once at first mount, when the ref is still null, and never
 * reruns on an ordinary tab switch.  The callback ref fires on every attach, so
 * it covers tab switches inside the sidebar, conditional panels appearing, and
 * keyframe/full-screen workspace remounts, and it runs during commit (before
 * paint), so there is no flash of the panel top.
 *
 * `store` is ref-shaped host state with a stable identity, so the callback ref
 * is not re-created on re-render and the offset is not re-applied mid-scroll.
 */
function useSidebarScroller(
  tab: SidebarTab,
  store: SidebarScrollStore | undefined,
  onScrollOffset?: (tab: SidebarTab, offset: number) => void,
): {
  onScroll: UIEventHandler<HTMLDivElement>;
  ref(node: HTMLDivElement | null): void;
} {
  const offsets = store?.current;
  const ref = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node === null) return;
      node.scrollTop = offsets?.[tab] ?? 0;
    },
    [offsets, tab],
  );
  const onScroll = useCallback<UIEventHandler<HTMLDivElement>>(
    (event) => {
      onScrollOffset?.(tab, event.currentTarget.scrollTop);
    },
    [onScrollOffset, tab],
  );
  return { onScroll, ref };
}

function CollapsibleSection({
  id,
  title,
  className,
  open,
  onToggle,
  actions,
  children,
}: {
  id: ProjectSectionId;
  title: string;
  className?: string;
  open: boolean;
  onToggle(): void;
  actions?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const contentId = `project-section-content-${id}`;
  return (
    <section
      className={`variable-settings project-section${
        open ? "" : " collapsed"
      }${className === undefined ? "" : ` ${className}`}`}
    >
      <header>
        <button
          aria-controls={contentId}
          aria-expanded={open}
          className="project-section-toggle"
          onClick={onToggle}
          type="button"
        >
          <span aria-hidden="true" className="project-section-caret">
            {open ? "▾" : "▸"}
          </span>
          <strong>{title}</strong>
        </button>
        {actions !== undefined && (
          <div className="project-section-actions">{actions}</div>
        )}
      </header>
      <div className="project-section-content" hidden={!open} id={contentId}>
        {children}
      </div>
    </section>
  );
}

export function ProjectSidebar({
  project,
  activeTab,
  activeSceneId,
  diagnostics,
  onSelectScene,
  onAddScene,
  onRenameScene,
  onDeleteScene,
  onManifestChange,
  onImportAssets,
  onRemoveAsset,
  onChangeAssetLayout,
  pendingAssetIds,
  reservedAssetPaths,
  onCreateImageAnimation,
  onSelectAsset,
  selectedAssetId,
  onAddVariable,
  onChangeVariable,
  onRenameVariable,
  onDeleteVariable,
  onAddCharacter,
  onChangeCharacter,
  onRenameCharacter,
  onDeleteCharacter,
  onCreateUiMotion,
  onEditUiMotion,
  onDeleteUiMotion,
  onCreateButtonTemplate,
  onEditButtonTemplate,
  onDuplicateButtonTemplate,
  onDeleteButtonTemplate,
  onCreateAction,
  onRenameAction,
  onDuplicateAction,
  onDeleteAction,
  onEditActionKeyframes,
  onNavigate,
  onTabChange,
  onScrollOffset,
  sectionOpen,
  onToggleSection,
  sidebarItemOpen,
  onToggleSidebarItem,
  scrollStore,
  hideTabs = false,
}: ProjectSidebarProps): ReactElement {
  const [internalTab, setInternalTab] = useState<SidebarTab>("scenes");
  const tab = activeTab ?? internalTab;
  const errorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
  const setTab = (next: SidebarTab): void => {
    setInternalTab(next);
    onTabChange?.(next);
  };
  const { onScroll: onProblemsScroll, ref: problemsRef } = useSidebarScroller(
    "problems",
    scrollStore,
    onScrollOffset,
  );
  return (
    <aside className="project-sidebar">
      {!hideTabs && (
        <div className="sidebar-tabs">
          <button
            className={tab === "scenes" ? "active" : ""}
            onClick={() => setTab("scenes")}
            type="button"
          >
            场景
          </button>
          <button
            className={tab === "assets" ? "active" : ""}
            onClick={() => setTab("assets")}
            type="button"
          >
            素材
          </button>
          <button
            className={tab === "project" ? "active" : ""}
            onClick={() => setTab("project")}
            type="button"
          >
            项目
          </button>
          <button
            className={tab === "problems" ? "active" : ""}
            onClick={() => setTab("problems")}
            type="button"
          >
            问题
            {diagnostics.length > 0 && (
              <span className="sidebar-tab-count">{diagnostics.length}</span>
            )}
            {errorCount > 0 && (
              <span className="sidebar-tab-count sidebar-tab-count-error">
                {errorCount}
              </span>
            )}
          </button>
        </div>
      )}
      {hideTabs && tab !== "characters" && tab !== "variables" && (
        <header className="panel-header">
          <h2>{PANEL_TITLES[tab]}</h2>
        </header>
      )}
      {!hideTabs && (
        <ProjectSearch
          onNavigate={onNavigate}
          onSelectAsset={onSelectAsset}
          project={project}
        />
      )}
      {tab === "scenes" && (
        <ScenesPanel
          activeSceneId={activeSceneId}
          diagnostics={diagnostics}
          onAddScene={onAddScene}
          onDeleteScene={onDeleteScene}
          onRenameScene={onRenameScene}
          onScrollOffset={onScrollOffset}
          onSelectScene={onSelectScene}
          project={project}
          scrollStore={scrollStore}
        />
      )}
      {tab === "assets" && (
        <AssetsPanel
          onChangeAssetLayout={onChangeAssetLayout}
          onCreateImageAnimation={onCreateImageAnimation}
          pendingAssetIds={pendingAssetIds}
          reservedAssetPaths={reservedAssetPaths}
          project={project}
          onImportAssets={onImportAssets}
          onRemoveAsset={onRemoveAsset}
          onScrollOffset={onScrollOffset}
          onSelectAsset={onSelectAsset}
          selectedAssetId={selectedAssetId}
          scrollStore={scrollStore}
        />
      )}
      {(tab === "project" ||
        tab === "characters" ||
        tab === "variables" ||
        tab === "library") && (
        <ProjectPanel
          manifest={project.manifest}
          onChange={onManifestChange}
          onAddVariable={onAddVariable}
          onChangeVariable={onChangeVariable}
          onDeleteVariable={onDeleteVariable}
          onRenameVariable={onRenameVariable}
          onAddCharacter={onAddCharacter}
          onChangeCharacter={onChangeCharacter}
          onDeleteCharacter={onDeleteCharacter}
          onRenameCharacter={onRenameCharacter}
          onCreateUiMotion={onCreateUiMotion}
          onEditUiMotion={onEditUiMotion}
          onDeleteUiMotion={onDeleteUiMotion}
          onCreateButtonTemplate={onCreateButtonTemplate}
          onEditButtonTemplate={onEditButtonTemplate}
          onDuplicateButtonTemplate={onDuplicateButtonTemplate}
          onDeleteButtonTemplate={onDeleteButtonTemplate}
          onCreateAction={onCreateAction}
          onRenameAction={onRenameAction}
          onDuplicateAction={onDuplicateAction}
          onDeleteAction={onDeleteAction}
          onEditActionKeyframes={onEditActionKeyframes}
          onScrollOffset={onScrollOffset}
          onToggleSection={onToggleSection}
          sidebarItemOpen={sidebarItemOpen}
          onToggleSidebarItem={onToggleSidebarItem}
          project={project}
          scrollStore={scrollStore}
          sectionOpen={sectionOpen}
          view={hideTabs ? tab : "all"}
        />
      )}
      {tab === "problems" && (
        <DiagnosticsPanel
          diagnostics={diagnostics}
          onNavigate={onNavigate}
          onScroll={onProblemsScroll}
          scrollRef={problemsRef}
        />
      )}
    </aside>
  );
}

function ProjectSearch({
  project,
  onNavigate,
  onSelectAsset,
}: {
  project: EditorProject;
  onNavigate(
    sceneId: string | null,
    nodeId: string | null,
    workspace?: "story" | "map",
    flowElementId?: string | null,
  ): void;
  onSelectAsset?(id: string): void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2)
      return [] as {
        label: string;
        detail: string;
        sceneId: string | null;
        nodeId: string | null;
        assetId?: string;
      }[];
    const output: {
      label: string;
      detail: string;
      sceneId: string | null;
      nodeId: string | null;
      assetId?: string;
    }[] = [];
    for (const file of project.scenes) {
      for (const [nodeId, node] of Object.entries(file.definition.nodes)) {
        const speaker = node.type === "say" ? (node.speaker ?? "旁白") : "";
        const searchable =
          `${file.definition.id} ${nodeId} ${speaker} ${JSON.stringify(node)}`.toLowerCase();
        if (searchable.includes(needle))
          output.push({
            label: `${file.definition.id} / ${nodeId}`,
            detail:
              node.type === "say"
                ? `${speaker}：${node.text.slice(0, 80)}`
                : node.type,
            sceneId: file.definition.id,
            nodeId,
          });
        if (output.length >= 40) break;
      }
      if (output.length >= 40) break;
    }
    if (output.length < 40) {
      for (const asset of project.assets) {
        const description =
          asset.animation === undefined
            ? (asset.path ?? "")
            : `动画 ${asset.animation}`;
        if (`${asset.id} ${description}`.toLowerCase().includes(needle))
          output.push({
            label: asset.id,
            detail: description,
            sceneId: null,
            nodeId: null,
            assetId: asset.id,
          });
      }
    }
    return output;
  }, [project.assets, project.scenes, query]);
  return (
    <div className="project-search">
      <input
        aria-label="搜索项目"
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="搜索节点、正文、素材…"
        value={query}
      />
      {query.trim().length >= 2 && (
        <div className="project-search-results">
          {results.length === 0 ? (
            <small className="muted">没有匹配结果</small>
          ) : (
            results.map((result) => (
              <button
                key={`${result.sceneId ?? "asset"}:${result.nodeId ?? result.label}`}
                onClick={() => {
                  if (result.sceneId !== null)
                    onNavigate(result.sceneId, result.nodeId);
                  else if (result.assetId !== undefined)
                    onSelectAsset?.(result.assetId);
                }}
                type="button"
              >
                <strong>{result.label}</strong>
                <small>{result.detail}</small>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ScenesPanel({
  activeSceneId,
  diagnostics,
  onAddScene,
  onDeleteScene,
  onRenameScene,
  onScrollOffset,
  onSelectScene,
  project,
  scrollStore,
}: {
  activeSceneId: string;
  diagnostics: EditorDiagnostic[];
  onAddScene(id: string): boolean;
  onDeleteScene(sceneId: string): void;
  onRenameScene(previousId: string, nextId: string): boolean;
  onScrollOffset?(tab: SidebarTab, offset: number): void;
  onSelectScene(sceneId: string): void;
  project: EditorProject;
  scrollStore?: SidebarScrollStore;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<{
    title: string;
    value: string;
    mode: "add" | "rename";
    previous?: string;
  } | null>(null);
  const scenes = project.scenes.filter((file) =>
    file.definition.id.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const { onScroll: onSceneListScroll, ref: sceneListRef } = useSidebarScroller(
    "scenes",
    scrollStore,
    onScrollOffset,
  );
  return (
    <div className="sidebar-body">
      <div className="sidebar-search-row">
        <input
          aria-label="搜索场景"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="筛选场景…"
          value={query}
        />
        <IconButton
          icon={Plus}
          label="添加场景"
          onClick={() => {
            setDialog({ title: "新场景 ID", value: "new_scene", mode: "add" });
          }}
          tooltip="新建场景"
          variant="secondary"
        />
      </div>
      <div
        className="scene-list"
        data-sidebar-scroller="scenes"
        onScroll={onSceneListScroll}
        ref={sceneListRef}
      >
        {scenes.map((file) => {
          const scene = file.definition;
          const issueCount = diagnostics.filter(
            (diagnostic) => diagnostic.scene_id === scene.id,
          ).length;
          const entry = project.manifest.entry_scene === scene.id;
          return (
            <article
              className={`scene-row${activeSceneId === scene.id ? " active" : ""}`}
              key={scene.id}
            >
              <button
                className="scene-main"
                onClick={() => onSelectScene(scene.id)}
                type="button"
              >
                <Clapperboard aria-hidden="true" className="scene-icon" />
                <span className="scene-text">
                  <strong>{scene.id}</strong>
                  <small>
                    {Object.keys(scene.nodes).length} 个节点
                    {entry ? " · 项目入口" : ""}
                  </small>
                </span>
                {issueCount > 0 && (
                  <span className="scene-issues" title={`${issueCount} 个问题`}>
                    {issueCount}
                  </span>
                )}
              </button>
              <div className="scene-row-actions">
                <IconButton
                  icon={Pencil}
                  label="重命名场景"
                  onClick={() => {
                    setDialog({
                      title: "新的场景 ID",
                      value: scene.id,
                      mode: "rename",
                      previous: scene.id,
                    });
                  }}
                  size="sm"
                />
                <IconButton
                  disabled={entry}
                  icon={Trash2}
                  label="删除场景"
                  onClick={() => onDeleteScene(scene.id)}
                  size="sm"
                  tooltip={entry ? "项目入口场景不能删除" : "从项目移除场景"}
                />
              </div>
            </article>
          );
        })}
        {scenes.length === 0 && (
          <p className="library-empty">没有匹配的场景。</p>
        )}
      </div>
      {dialog !== null && (
        <TextEntryDialog
          initialValue={dialog.value}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            const accepted =
              dialog.mode === "add"
                ? onAddScene(value)
                : dialog.previous !== undefined && value !== dialog.previous
                  ? onRenameScene(dialog.previous, value)
                  : true;
            if (accepted) setDialog(null);
            return accepted;
          }}
          hint={ID_RULE_HINT}
          title={dialog.title}
          validate={(value) =>
            idUnavailableReason("scene", value, project, {
              previous: dialog.previous,
            })
          }
        />
      )}
    </div>
  );
}

function AssetsPanel({
  project,
  onImportAssets,
  onRemoveAsset,
  onChangeAssetLayout,
  pendingAssetIds = [],
  reservedAssetPaths,
  onCreateImageAnimation,
  onScrollOffset,
  onSelectAsset,
  selectedAssetId,
  scrollStore,
}: {
  project: EditorProject;
  onImportAssets(items: ImportDraft[]): Promise<void>;
  onSelectAsset?(id: string | null): void;
  onRemoveAsset(id: string): boolean;
  onChangeAssetLayout?(
    mutate: (layout: EditorLayout) => EditorLayout,
    label: string,
  ): void;
  pendingAssetIds?: readonly string[];
  reservedAssetPaths?: Readonly<Record<string, readonly string[]>>;
  onCreateImageAnimation(draft: AnimationDraft): boolean;
  onScrollOffset?(tab: SidebarTab, offset: number): void;
  selectedAssetId?: string | null;
  scrollStore?: SidebarScrollStore;
}): ReactElement {
  const { assets, manifest } = project;
  const layout = project.layout;
  const animations = project.animations ?? [];
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    kind: "asset" | "folder" | "root";
    id: string | null;
    x: number;
    y: number;
  } | null>(null);
  const [selectionBox, setSelectionBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const explorerRef = useRef<HTMLDivElement>(null);
  const [showHidden, setShowHidden] = useState(true);
  const [folderFilter, setFolderFilter] = useState<string | null>("all");
  const [collapsedFolders, setCollapsedFolders] = useState<readonly string[]>(
    [],
  );
  const [folderDialog, setFolderDialog] = useState<
    | { mode: "create"; parentId: string | null }
    | { mode: "rename"; folderId: string }
    | null
  >(null);
  const [folderMoveTarget, setFolderMoveTarget] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importQueue, setImportQueue] = useState<ImportDraft[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [animationPanel, setAnimationPanel] = useState(false);
  const references = useMemo(
    () =>
      new Map(
        assets.map((asset) => [
          asset.id,
          findAssetReferences(project, asset.id),
        ]),
      ),
    [assets, project],
  );
  const shown = useMemo(
    () =>
      assetChoiceOptions({
        assets,
        layout,
        kind: kindFilter === "all" ? undefined : kindFilter,
        query,
        // Rows live under their own folder in the tree; selecting a folder
        // expands it rather than filtering all other folders away.
        // The asset manager is manager mode: hidden assets stay visible so
        // they can be unhidden, renamed or edited.  The toggle only narrows
        // that list for authors who want to see the runtime-effective set.
        includeHidden: showHidden,
        selectedIds,
      }),
    [assets, layout, kindFilter, query, showHidden, selectedIds],
  );
  const folderTree = useMemo(() => buildAssetFolderTree(layout), [layout]);
  const folderOptions = useMemo(() => flattenAssetFolders(layout), [layout]);
  const selectedAsset = assets.find((asset) => asset.id === selected);
  const selectedHidden =
    selectedAsset !== undefined && isAssetHidden(layout, selectedAsset.id);
  const selectedFolderId =
    selectedAsset === undefined
      ? null
      : assetFolderId(layout, selectedAsset.id);
  const selectedDisplayName =
    selectedAsset === undefined
      ? null
      : assetDisplayName(layout, selectedAsset.id);
  const selectedPending =
    selectedAsset !== undefined && pendingAssetIds.includes(selectedAsset.id);
  // Every destination the host already reserves: all currently registered
  // asset paths (including the row's current staged path) plus the editor-only
  // "original + earlier staged" list.  A replacement may not reuse any of them.
  const replacementReserved = useMemo(() => {
    const keys = new Set<string>();
    for (const asset of assets)
      if (asset.path) keys.add(collisionKey(asset.path));
    for (const definition of Object.values(manifest.assets))
      if (definition.path) keys.add(collisionKey(definition.path));
    for (const paths of Object.values(reservedAssetPaths ?? {}))
      for (const path of paths) keys.add(collisionKey(path));
    return keys;
  }, [assets, manifest, reservedAssetPaths]);
  const commitLayout = useCallback(
    (mutate: (current: EditorLayout) => EditorLayout, label: string): void => {
      if (onChangeAssetLayout === undefined) return;
      onChangeAssetLayout(mutate, label);
    },
    [onChangeAssetLayout],
  );
  const moveAsset = (assetId: string, folderId: string | null): void => {
    setFolderError(null);
    commitLayout(
      (current) =>
        moveAssetsToFolder(
          current,
          selectedIds.includes(assetId) ? selectedIds : [assetId],
          folderId,
        ),
      "移动素材到文件夹",
    );
  };
  const commitDisplayName = (value: string | null): void => {
    if (selectedAsset === undefined) return;
    commitLayout(
      (current) => setAssetDisplayName(current, selectedAsset.id, value),
      "重命名素材显示名称",
    );
    setNameDraft(null);
  };
  const moveFolder = (folderId: string, parentId: string | null): void => {
    const check = validateFolderMove(layout, folderId, parentId);
    if (!check.ok) {
      setFolderError(check.reason);
      return;
    }
    setFolderError(null);
    commitLayout(
      (current) => moveAssetFolder(current, folderId, parentId),
      "移动素材文件夹",
    );
  };
  const handleDrop = (
    event: { preventDefault(): void; dataTransfer: DataTransfer | null },
    folderId: string | null,
  ): void => {
    event.preventDefault();
    const payload = readAssetDragPayload(event);
    const draggedAssets = payload.assetIds;
    if (draggedAssets !== undefined) {
      setFolderError(null);
      commitLayout(
        (current) => moveAssetsToFolder(current, draggedAssets, folderId),
        "批量移动素材",
      );
    } else if (payload.assetId !== undefined)
      moveAsset(payload.assetId, folderId);
    else if (payload.folderId !== undefined && payload.folderId !== folderId)
      moveFolder(payload.folderId, folderId);
  };
  const assetById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset])),
    [assets],
  );
  const selectAsset = (id: string, additive = false, range = false): void => {
    const index = shown.findIndex((item) => item.id === id);
    const anchor = shown.findIndex((item) => item.id === selected);
    if (range && anchor >= 0) {
      const ids = shown
        .slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
        .map((item) => item.id);
      setSelectedIds((current) => [...new Set([...current, ...ids])]);
    } else if (additive) {
      setSelectedIds((current) =>
        current.includes(id)
          ? current.filter((item) => item !== id)
          : [...current, id],
      );
    } else setSelectedIds([id]);
    setSelected(id);
    onSelectAsset?.(id);
  };
  const revealAsset = (id: string): void => {
    void editorApi.revealAsset(id).catch((reason: unknown) => {
      setFolderError(reason instanceof Error ? reason.message : String(reason));
    });
  };
  useEffect(() => {
    if (contextMenu === null) return;
    const dismiss = (): void => setContextMenu(null);
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [contextMenu]);
  const renderAsset = (
    option: AssetChoiceOption,
    depth: number,
  ): ReactElement => {
    const asset = assetById.get(option.id);
    const pending = pendingAssetIds.includes(option.id);
    return (
      <button
        className={`asset-explorer-file${selectedIds.includes(option.id) ? " active" : ""}`}
        data-allow-context-menu="true"
        data-explorer-asset-id={option.id}
        draggable
        key={option.id}
        onClick={(event) =>
          selectAsset(option.id, event.ctrlKey || event.metaKey, event.shiftKey)
        }
        onContextMenu={(event) => {
          event.preventDefault();
          if (!selectedIds.includes(option.id)) selectAsset(option.id);
          setContextMenu({
            kind: "asset",
            id: option.id,
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onDragStart={(event) => {
          event.dataTransfer.setData(ASSET_DRAG_TYPE, option.id);
          if (selectedIds.includes(option.id) && selectedIds.length > 1) {
            event.dataTransfer.setData(
              "application/x-vect-assets",
              JSON.stringify(selectedIds),
            );
          }
          event.dataTransfer.effectAllowed = "copyMove";
        }}
        style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
        type="button"
      >
        <AssetKindIcon kind={option.kind} />
        <span>
          <strong>
            {option.label}
            {option.label !== option.id && (
              <small className="asset-id-chip">{option.id}</small>
            )}
            {asset?.animation !== undefined && (
              <span className="animation-badge">动画</span>
            )}
            {option.hidden && (
              <span className="asset-hidden-badge">已隐藏</span>
            )}
            {pending && <span className="asset-pending-badge">待保存</span>}
          </strong>
          <small>
            {option.folderPath !== "" ? `目录：${option.folderPath} · ` : ""}
            {asset === undefined
              ? option.path
              : assetDescription(asset, manifest)}{" "}
            · {formatAssetSize(asset?.size_bytes)} ·{" "}
            {formatAssetMetadata(asset?.metadata)} ·{" "}
            {references.get(option.id)?.length ?? 0} 处引用
          </small>
        </span>
      </button>
    );
  };
  // "全部" shows everything; "未分组" only root-level assets; a folder only
  // the assets inside its own subtree.  Folder rows always stay visible so
  // the tree remains the navigation for the filter.
  const filterFolderIds = useMemo(() => {
    if (folderFilter === "all" || folderFilter === null) return null;
    const ids = new Set<string>();
    const collect = (node: AssetFolderNode | undefined): void => {
      if (node === undefined) return;
      ids.add(node.id);
      node.children.forEach(collect);
    };
    collect(findFolderNode(folderTree, folderFilter));
    return ids;
  }, [folderFilter, folderTree]);
  const folderAssetsVisible = (folderId: string): boolean =>
    folderFilter === "all" ||
    (filterFolderIds !== null && filterFolderIds.has(folderId));
  const renderFolder = (node: AssetFolderNode): ReactElement => {
    const isCollapsed = collapsedFolders.includes(node.id);
    const count = assets.filter(
      (asset) => assetFolderId(layout, asset.id) === node.id,
    ).length;
    const hasChildren = node.children.length > 0;
    return (
      <div className="asset-folder-branch" key={node.id}>
        <div
          className={`asset-folder-row${folderFilter === node.id ? " active" : ""}`}
          data-allow-context-menu="true"
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({
              kind: "folder",
              id: node.id,
              x: event.clientX,
              y: event.clientY,
            });
          }}
          style={{ paddingLeft: `${node.depth * 14}px` }}
        >
          <button
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "展开" : "折叠"}文件夹 ${node.name}`}
            className="asset-folder-toggle"
            disabled={!hasChildren && count === 0}
            onClick={() =>
              setCollapsedFolders((current) =>
                isCollapsed
                  ? current.filter((id) => id !== node.id)
                  : [...current, node.id],
              )
            }
            type="button"
          >
            {hasChildren || count > 0 ? (isCollapsed ? "▸" : "▾") : "·"}
          </button>
          <button
            className="asset-folder-name"
            draggable
            onClick={() => {
              // Selecting a folder filters the list to its subtree and makes
              // sure that subtree is visible; the chevron toggles collapse.
              setFolderFilter(node.id);
              setCollapsedFolders((current) =>
                current.filter((id) => id !== node.id),
              );
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragStart={(event) => {
              event.dataTransfer.setData("application/x-vect-folder", node.id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDrop={(event) => handleDrop(event, node.id)}
            title={node.name}
            type="button"
          >
            {node.name}
          </button>
          <span className="asset-folder-count">{count}</span>
          <IconButton
            onClick={() => {
              setFolderError(null);
              setFolderDialog({ mode: "rename", folderId: node.id });
            }}
            icon={Pencil}
            label={`重命名文件夹 ${node.name}`}
            size="sm"
            variant="ghost"
          />
          <IconButton
            onClick={() => {
              setFolderError(null);
              setFolderDialog({ mode: "create", parentId: node.id });
            }}
            icon={Plus}
            label={`在 ${node.name} 下新建子文件夹`}
            size="sm"
            variant="ghost"
          />
          <IconButton
            onClick={() => {
              // Folders are editor-only grouping: removing one moves its
              // contents up a level and is undoable, so it needs no prompt.
              commitLayout(
                (current) => removeAssetFolder(current, node.id),
                "删除素材文件夹",
              );
              if (folderFilter === node.id)
                setFolderFilter(node.parentId ?? "all");
            }}
            icon={Trash2}
            label={`删除文件夹 ${node.name}`}
            size="sm"
          />
          <IconButton
            onClick={() => {
              setFolderError(null);
              setFolderMoveTarget(node.id);
            }}
            icon={FolderInput}
            label={`移动文件夹 ${node.name}`}
            size="sm"
            variant="ghost"
          />
        </div>
        {!isCollapsed && (
          <>
            {node.children.map(renderFolder)}
            {shown
              .filter(
                (option) =>
                  option.folderId === node.id && folderAssetsVisible(node.id),
              )
              .map((option) => renderAsset(option, node.depth))}
            {node.children.length === 0 && count === 0 && (
              <p
                className="asset-folder-empty muted"
                style={{ paddingLeft: `${(node.depth + 1) * 14 + 22}px` }}
              >
                （空文件夹）
              </p>
            )}
          </>
        )}
      </div>
    );
  };
  const { onScroll: onAssetListScroll, ref: assetListRef } = useSidebarScroller(
    "assets",
    scrollStore,
    onScrollOffset,
  );
  const setExplorerRef = useCallback(
    (element: HTMLDivElement | null) => {
      explorerRef.current = element;
      assetListRef(element);
    },
    [assetListRef],
  );
  useEffect(() => {
    if (
      selectedAssetId !== null &&
      selectedAssetId !== undefined &&
      assets.some((asset) => asset.id === selectedAssetId)
    ) {
      // Search results can target an asset while the panel is mounted but
      // hidden behind another sidebar tab.  Keep the detail view in sync when
      // the caller explicitly requests that asset.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelected(selectedAssetId);
    }
  }, [assets, selectedAssetId]);
  const queuePaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    setImportError(null);
    setInspecting(true);
    try {
      const inspections = await editorApi.inspectAssetImports(paths);
      const reserved = [...assets];
      const drafts = paths.map((sourcePath, index) => {
        const inspection = inspections[index];
        const fileName =
          inspection?.source_name ??
          sourcePath.split(/[\\/]/).at(-1) ??
          "asset";
        const stem = fileName.replace(/\.[^.]+$/, "");
        const suggested = inspection?.suggested_kind as
          AssetKind | null | undefined;
        const kind = suggested ?? inferAssetKind(fileName);
        const id = uniqueAssetId(stem, kind, reserved);
        reserved.push({
          id,
          kind,
          path: "",
          absolute_path: "",
        });
        const inspectionError = inspection?.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .map((diagnostic) => diagnostic.message)
          .join("；");
        return {
          sourcePath,
          fileName,
          id,
          kind,
          inspectionId: inspection?.inspection_id,
          inspection,
          error: inspectionError || undefined,
        };
      });
      setImportQueue(drafts);
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInspecting(false);
    }
  };
  const handleImport = async (): Promise<void> => {
    try {
      const paths = await editorApi.pickAssetFiles();
      void queuePaths(paths);
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  /**
   * Same-ID / new-path replacement.  The logical id and kind are locked, the
   * destination must differ from the registered path and the actual format
   * family must match the old binary; the host re-validates all of it, so this
   * is a friendly pre-check rather than the authority.
   */
  const queueReplacement = async (asset: EditorAsset): Promise<void> => {
    setImportError(null);
    setInspecting(true);
    try {
      const paths = await editorApi.pickAssetFiles();
      if (paths.length === 0) return;
      const sourcePath = paths[0];
      const instructions = await editorApi.inspectAssetImports([sourcePath]);
      const inspection = instructions[0];
      const fileName =
        inspection?.source_name ?? sourcePath.split(/[\\/]/).at(-1) ?? "asset";
      // Never prefill a destination the host would reject: the original
      // binary and every earlier staged replacement path are reserved, so a
      // colliding pick gets a free `_vN` suggestion up front.
      const suggested = suggestReplacementFileName(
        asset,
        fileName,
        replacementReserved,
      );
      const error = replacementError(
        asset,
        suggested,
        inspection,
        replacementReserved,
      );
      setImportQueue([
        {
          sourcePath,
          fileName: suggested,
          id: asset.id,
          kind: asset.kind,
          inspectionId: inspection?.inspection_id,
          inspection,
          replaceId: asset.id,
          error,
        },
      ]);
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setInspecting(false);
    }
  };
  const updateImport = (index: number, update: Partial<ImportDraft>): void => {
    setImportQueue((current) =>
      current === null
        ? null
        : current.map((item, candidate) => {
            if (candidate !== index) return item;
            const merged: ImportDraft = { ...item, ...update };
            if (merged.replaceId === undefined)
              return { ...merged, error: undefined };
            // A replacement error must follow the file-name edit live, so the
            // dialog explains a same-path or different-format pick immediately.
            const target = assets.find((asset) => asset.id === merged.id);
            return {
              ...merged,
              error:
                target === undefined
                  ? "清单中不存在要替换的素材"
                  : replacementError(
                      target,
                      merged.fileName,
                      merged.inspection,
                      replacementReserved,
                    ),
            };
          }),
    );
  };
  const submitImport = async (): Promise<void> => {
    if (importQueue === null) return;
    setImportError(null);
    const ids = new Map<string, number[]>();
    const paths = new Map<string, number[]>();
    for (const [index, item] of importQueue.entries()) {
      const idKey = item.id;
      ids.set(idKey, [...(ids.get(idKey) ?? []), index]);
      const pathKey =
        `${assetFolder(item.kind)}/${item.fileName}`.toLowerCase();
      paths.set(pathKey, [...(paths.get(pathKey) ?? []), index]);
    }
    const nextQueue = importQueue.map((item) => {
      const errors: string[] = [];
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(item.id))
        errors.push("ID 只能包含字母、数字、点、下划线或连字符");
      if (!/^[^\\/:*?"<>|]{1,200}$/.test(item.fileName))
        errors.push("文件名不是安全的单个文件名");
      // A replacement intentionally reuses an existing logical id; only a
      // brand-new registration may not collide with the current manifest.
      if (item.replaceId === undefined && item.id in manifest.assets)
        errors.push("ID 已存在");
      if (item.replaceId !== undefined && item.replaceId !== item.id)
        errors.push("替换目标与逻辑 ID 不一致");
      if ((ids.get(item.id)?.length ?? 0) > 1) errors.push("清单中 ID 重复");
      const destination = `${assetFolder(item.kind)}/${item.fileName}`;
      if ((paths.get(destination.toLowerCase())?.length ?? 0) > 1)
        errors.push("目标路径重复");
      if (!supportedImportExtension(item.kind, item.fileName))
        errors.push("文件扩展名与素材类型不匹配");
      if (item.replaceId !== undefined) {
        const existing = assets.find((asset) => asset.id === item.id);
        if (existing === undefined) errors.push("清单中不存在要替换的素材");
        else if (existing.animation !== undefined)
          errors.push("合成动画素材不能直接替换，请替换它的帧图片");
        else {
          const oldPath = existing.path ?? "";
          if (collisionKey(oldPath) === collisionKey(destination))
            errors.push("新文件路径必须与当前登记路径不同");
          else if (replacementReserved.has(collisionKey(destination)))
            errors.push("该目标路径已被原始文件或先前暂存的替换保留");
          if (extensionFamily(item.fileName) !== extensionFamily(oldPath))
            errors.push("新文件格式必须与旧文件一致");
        }
      }
      return {
        ...item,
        error: errors.length > 0 ? errors.join("；") : undefined,
      };
    });
    setImportQueue(nextQueue);
    if (
      nextQueue.some(
        (item) => item.error !== undefined || item.inspectionId === undefined,
      )
    ) {
      setImportError("请先修正清单中标出的错误。");
      return;
    }
    setImporting(true);
    try {
      // Use the validated snapshot we just built rather than the render's
      // stale queue.  React may batch a last inspector edit with this click;
      // the validated values are the ones that must cross the IPC boundary.
      await onImportAssets(nextQueue);
      setSelected(nextQueue.at(-1)?.id ?? null);
      setImportQueue(null);
    } catch (reason) {
      setImportError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  };
  const menuAssetId = contextMenu?.id ?? "";
  const mountDetail = (detail: ReactElement): ReactNode => {
    const target = document.getElementById("asset-detail-column");
    return target === null ? detail : createPortal(detail, target);
  };
  return (
    <div
      className="sidebar-body asset-sidebar"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        // An internal asset/folder drag has no OS files; a real file drop
        // carries a FileList.  Guard both so a synthetic drop never throws.
        const files = event.dataTransfer?.files;
        const paths = Array.from(files ?? [])
          .map((file) => (file as File & { path?: string }).path)
          .filter(
            (path): path is string =>
              typeof path === "string" && path.length > 0,
          );
        void queuePaths(paths);
      }}
    >
      <div className="sidebar-search-row">
        <input
          aria-label="搜索素材"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索素材…"
          value={query}
        />
        <select
          aria-label="素材类型筛选"
          onChange={(event) =>
            setKindFilter(event.currentTarget.value as AssetKind | "all")
          }
          value={kindFilter}
        >
          <option value="all">全部</option>
          {ASSET_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {ASSET_KIND_LABELS[kind]}
            </option>
          ))}
        </select>
        <button
          disabled={importing || inspecting}
          onClick={() => void handleImport()}
          title="导入素材"
          type="button"
        >
          {inspecting ? "检查中…" : "＋"}
        </button>
      </div>
      <button
        className="animation-create-entry"
        disabled={frameCandidates(assets).length === 0}
        onClick={() => setAnimationPanel(true)}
        title="把多张静态图片登记为一个循环帧动画素材"
        type="button"
      >
        创建帧动画
      </button>
      <div className="asset-folder-tree">
        <div className="asset-folder-toolbar">
          <button
            aria-label="新建根文件夹"
            onClick={() => {
              setFolderError(null);
              setFolderDialog({ mode: "create", parentId: null });
            }}
            type="button"
          >
            ＋ 新建文件夹
          </button>
          {selectedIds.length > 1 && (
            <label>
              已选 {selectedIds.length} 项 · 移动到
              <select
                aria-label="批量移动到文件夹"
                onChange={(event) => {
                  const destination = event.currentTarget.value;
                  setFolderError(null);
                  commitLayout(
                    (current) =>
                      moveAssetsToFolder(
                        current,
                        selectedIds,
                        destination === "" ? null : destination,
                      ),
                    "批量移动素材",
                  );
                }}
                value="__choose__"
              >
                <option disabled value="__choose__">
                  选择文件夹…
                </option>
                <option value="">未分组</option>
                {folderOptions.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.path}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="asset-hidden-toggle">
            <input
              checked={showHidden}
              onChange={(event) => setShowHidden(event.currentTarget.checked)}
              type="checkbox"
            />
            显示已隐藏
          </label>
        </div>
        <small className="muted">
          当前文件夹是虚拟分组；移动素材不会移动磁盘文件。
        </small>
        <div className="asset-folder-roots">
          <button
            className={folderFilter === "all" ? "active" : ""}
            onClick={() => {
              setFolderFilter("all");
              setCollapsedFolders([]);
            }}
            type="button"
          >
            全部素材
            <span className="asset-folder-count">{assets.length}</span>
          </button>
          <button
            aria-label="未分组（根目录）"
            className={folderFilter === null ? "active" : ""}
            data-allow-context-menu="true"
            onClick={() => setFolderFilter(null)}
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenu({
                kind: "root",
                id: null,
                x: event.clientX,
                y: event.clientY,
              });
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleDrop(event, null)}
            type="button"
          >
            未分组
          </button>
        </div>
      </div>
      {folderError !== null && (
        <p className="inline-error" role="alert">
          {folderError}
        </p>
      )}
      <div
        className="asset-list asset-explorer-tree"
        data-allow-context-menu="true"
        data-sidebar-scroller="assets"
        onScroll={onAssetListScroll}
        onContextMenu={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("button,.asset-folder-row")
          )
            return;
          event.preventDefault();
          setContextMenu({
            kind: "root",
            id: null,
            x: event.clientX,
            y: event.clientY,
          });
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            (event.target instanceof Element &&
              event.target.closest("button,input,select"))
          )
            return;
          const container = explorerRef.current;
          if (container === null) return;
          const startX = event.clientX;
          const startY = event.clientY;
          let moved = false;
          const move = (pointer: PointerEvent): void => {
            if (
              Math.abs(pointer.clientX - startX) +
                Math.abs(pointer.clientY - startY) <
              4
            )
              return;
            moved = true;
            const rect = container.getBoundingClientRect();
            const left = Math.max(rect.left, Math.min(startX, pointer.clientX));
            const right = Math.min(
              rect.right,
              Math.max(startX, pointer.clientX),
            );
            const top = Math.max(rect.top, Math.min(startY, pointer.clientY));
            const bottom = Math.min(
              rect.bottom,
              Math.max(startY, pointer.clientY),
            );
            setSelectionBox({
              left: left - rect.left,
              top: top - rect.top + container.scrollTop,
              width: Math.max(0, right - left),
              height: Math.max(0, bottom - top),
            });
            const ids = Array.from(
              container.querySelectorAll<HTMLElement>(
                "[data-explorer-asset-id]",
              ),
            )
              .filter((row) => {
                const bounds = row.getBoundingClientRect();
                return (
                  bounds.right >= left &&
                  bounds.left <= right &&
                  bounds.bottom >= top &&
                  bounds.top <= bottom
                );
              })
              .map((row) => row.dataset.explorerAssetId)
              .filter((id): id is string => id !== undefined);
            setSelectedIds(ids);
            setSelected(ids.at(-1) ?? null);
          };
          const finish = (): void => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", finish);
            window.removeEventListener("pointercancel", finish);
            setSelectionBox(null);
            onSelectAsset?.(null);
            if (!moved) {
              setSelectedIds([]);
              setSelected(null);
            }
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", finish, { once: true });
          window.addEventListener("pointercancel", finish, { once: true });
        }}
        ref={setExplorerRef}
      >
        {folderTree.map(renderFolder)}
        {assets.length === 0 && (
          <p className="muted">将文件拖到这里，或点击 ＋ 批量导入</p>
        )}
        {assets.length > 0 && shown.length === 0 && (
          <p className="muted">当前筛选没有素材。</p>
        )}
        {(folderFilter === "all" || folderFilter === null) &&
          shown
            .filter((option) => option.folderId === null)
            .map((option) => renderAsset(option, 0))}
        {selectionBox !== null && (
          <div
            aria-hidden="true"
            className="asset-selection-box"
            style={selectionBox}
          />
        )}
      </div>
      {contextMenu !== null && (
        <div
          aria-label="素材操作"
          className="asset-context-menu"
          onPointerDown={(event) => event.stopPropagation()}
          role="menu"
          style={{
            left: Math.min(contextMenu.x, window.innerWidth - 205),
            top: Math.min(contextMenu.y, window.innerHeight - 230),
          }}
        >
          {contextMenu.kind === "asset" && contextMenu.id !== null && (
            <>
              <button
                disabled={pendingAssetIds.includes(menuAssetId)}
                onClick={() => {
                  revealAsset(menuAssetId);
                  setContextMenu(null);
                }}
                role="menuitem"
                type="button"
              >
                打开文件所在位置
              </button>
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(menuAssetId);
                  setContextMenu(null);
                }}
                role="menuitem"
                type="button"
              >
                复制素材 ID
              </button>
              <button
                onClick={() => {
                  selectAsset(menuAssetId);
                  setContextMenu(null);
                }}
                role="menuitem"
                type="button"
              >
                查看／编辑详情
              </button>
              <button
                onClick={() => {
                  commitLayout(
                    (current) =>
                      setAssetHidden(
                        current,
                        menuAssetId,
                        !isAssetHidden(current, menuAssetId),
                      ),
                    "切换素材隐藏状态",
                  );
                  setContextMenu(null);
                }}
                role="menuitem"
                type="button"
              >
                {isAssetHidden(layout, contextMenu.id)
                  ? "取消隐藏"
                  : "隐藏素材"}
              </button>
              <button
                disabled={(references.get(menuAssetId)?.length ?? 0) > 0}
                onClick={() => {
                  if (onRemoveAsset(menuAssetId)) {
                    setSelected(null);
                    setSelectedIds([]);
                    onSelectAsset?.(null);
                  }
                  setContextMenu(null);
                }}
                role="menuitem"
                title={
                  (references.get(menuAssetId)?.length ?? 0) > 0
                    ? "该素材仍被引用，需先解除引用才能移除"
                    : undefined
                }
                type="button"
              >
                从清单移除
              </button>
            </>
          )}
          {contextMenu.kind !== "asset" && (
            <>
              <button
                onClick={() => {
                  setFolderDialog({ mode: "create", parentId: contextMenu.id });
                  setContextMenu(null);
                }}
                role="menuitem"
                type="button"
              >
                新建文件夹
              </button>
              {contextMenu.kind === "folder" && contextMenu.id !== null && (
                <>
                  <button
                    onClick={() => {
                      if (
                        contextMenu.id !== null &&
                        layout.asset_folders?.[contextMenu.id] !== undefined
                      ) {
                        setFolderDialog({
                          mode: "rename",
                          folderId: contextMenu.id,
                        });
                      }
                      setContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    重命名文件夹
                  </button>
                  <button
                    onClick={() => {
                      commitLayout(
                        (current) => removeAssetFolder(current, menuAssetId),
                        "删除素材文件夹",
                      );
                      setContextMenu(null);
                    }}
                    role="menuitem"
                    type="button"
                  >
                    删除文件夹
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
      {selectedAsset !== undefined &&
        mountDetail(
          <div className="asset-detail">
            <header className="asset-detail-header">
              <span>素材详情</span>
              <button
                aria-label="关闭素材详情"
                onClick={() => {
                  setSelected(null);
                  setSelectedIds([]);
                  onSelectAsset?.(null);
                }}
                type="button"
              >
                ✕
              </button>
            </header>
            <AssetPreview
              animations={animations}
              asset={selectedAsset}
              assets={assets}
            />
            <strong>
              {selectedDisplayName ?? selectedAsset.id}
              {selectedAsset.animation !== undefined && (
                <span className="animation-badge">动画</span>
              )}
              {selectedHidden && (
                <span className="asset-hidden-badge">已隐藏</span>
              )}
              {selectedPending && (
                <span className="asset-pending-badge">待保存</span>
              )}
            </strong>
            {selectedDisplayName !== null && (
              <small className="asset-id-chip">{selectedAsset.id}</small>
            )}
            <code>
              {selectedAsset.animation === undefined
                ? selectedAsset.path
                : `动画：${selectedAsset.animation}`}
            </code>
            {selectedAsset.animation !== undefined && (
              <small>
                {animationSummary(selectedAsset, assets, animations)}
              </small>
            )}
            {selectedDisplayName !== null && (
              <small className="muted">
                源文件路径（显示名称仅用于编辑器）：
                {selectedAsset.path ?? "（未登记）"}
              </small>
            )}
            <small>
              {formatAssetMetadata(selectedAsset.metadata)} · 大小：
              {formatAssetSize(selectedAsset.size_bytes)} · 引用：
              {references.get(selectedAsset.id)?.length ?? 0} 处
            </small>
            <small className="muted">
              文件夹：
              {folderDisplayPath(layout, selectedFolderId) || "（根目录）"}
            </small>
            <div className="asset-display-name">
              <input
                aria-label="显示名称"
                onChange={(event) => setNameDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitDisplayName(nameDraft);
                  }
                  if (event.key === "Escape") setNameDraft(null);
                }}
                placeholder={selectedAsset.id}
                value={nameDraft ?? selectedDisplayName ?? ""}
              />
              <button
                aria-label="保存显示名称"
                disabled={nameDraft === null}
                onClick={() => commitDisplayName(nameDraft)}
                type="button"
              >
                保存名称
              </button>
            </div>
            <label className="asset-folder-select">
              移动到文件夹
              <select
                aria-label="移动到文件夹"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  moveAsset(selectedAsset.id, value === "" ? null : value);
                }}
                value={selectedFolderId ?? ""}
              >
                <option value="">（根目录）</option>
                {folderOptions.map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.path}
                  </option>
                ))}
              </select>
            </label>
            <div className="asset-detail-actions">
              <button
                disabled={selectedPending}
                onClick={() => revealAsset(selectedAsset.id)}
                type="button"
              >
                打开文件所在位置
              </button>
              <button
                aria-pressed={selectedHidden}
                onClick={() =>
                  commitLayout(
                    (current) =>
                      setAssetHidden(
                        current,
                        selectedAsset.id,
                        !selectedHidden,
                      ),
                    selectedHidden ? "取消隐藏素材" : "隐藏素材",
                  )
                }
                type="button"
              >
                {selectedHidden ? "取消隐藏" : "隐藏素材"}
              </button>
              <button
                disabled={
                  selectedAsset.animation !== undefined ||
                  inspecting ||
                  importing
                }
                onClick={() => void queueReplacement(selectedAsset)}
                title="导入一个同格式文件，保留逻辑 ID，新文件写入新路径，旧文件不会被覆盖或删除"
                type="button"
              >
                替换文件…
              </button>
            </div>
            {selectedAsset.animation !== undefined && (
              <small className="muted">
                合成动画素材不能直接替换，请替换它的帧图片。
              </small>
            )}
            {(references.get(selectedAsset.id)?.length ?? 0) > 0 && (
              <details className="asset-references">
                <summary>使用位置</summary>
                <ul>
                  {references.get(selectedAsset.id)?.map((location) => (
                    <li key={location}>{location}</li>
                  ))}
                </ul>
              </details>
            )}
            {(references.get(selectedAsset.id)?.length ?? 0) > 0 && (
              <small className="inline-error">
                该素材仍被引用（可展开上方“使用位置”查看，帧动画也会列入），需先解除引用才能移除。
              </small>
            )}
            <button
              className="danger-button"
              disabled={(references.get(selectedAsset.id)?.length ?? 0) > 0}
              onClick={() => {
                if (onRemoveAsset(selectedAsset.id)) {
                  setSelected(null);
                  onSelectAsset?.(null);
                }
              }}
              type="button"
            >
              从清单移除
            </button>
          </div>,
        )}
      {importQueue !== null && (
        <div
          className="asset-import-dialog"
          role="dialog"
          aria-label={
            importQueue.some((item) => item.replaceId !== undefined)
              ? "替换素材文件"
              : "导入素材"
          }
        >
          <header>
            <strong>
              {importQueue.some((item) => item.replaceId !== undefined)
                ? `替换素材文件（${importQueue.length}）`
                : `导入素材 (${importQueue.length})`}
            </strong>
            <button onClick={() => setImportQueue(null)} type="button">
              取消
            </button>
          </header>
          <p>确认素材 ID、类型和文件名后导入；保存项目时才会正式写入。</p>
          {importQueue.some((item) => item.replaceId !== undefined) && (
            <p className="muted">
              替换保留逻辑 ID
              与引用关系，但必须写入一个不同路径的新文件；旧文件不会被
              覆盖或删除，仍留在 assets 目录作为恢复副本。
            </p>
          )}
          {importError !== null && (
            <p className="inline-error" role="alert">
              {importError}
            </p>
          )}
          <div className="asset-import-list">
            {importQueue.map((item, index) => (
              <div
                className="asset-import-row"
                key={`${item.sourcePath}-${index}`}
              >
                <small title={item.sourcePath}>
                  {item.sourcePath.split(/[\\/]/).at(-1)}
                </small>
                {item.error !== undefined && (
                  <small className="inline-error">{item.error}</small>
                )}
                {item.error === undefined && item.inspection !== undefined && (
                  <small className="asset-inspection-meta">
                    {item.inspection.detected_format} ·{" "}
                    {formatInspectionSize(item.inspection.size_bytes)}
                  </small>
                )}
                {item.replaceId !== undefined ? (
                  <>
                    <small className="asset-id-chip">
                      {item.id}（{item.kind}）
                    </small>
                    <input
                      aria-label={`${item.fileName} 文件名`}
                      onChange={(event) =>
                        updateImport(index, {
                          fileName: event.currentTarget.value,
                        })
                      }
                      value={item.fileName}
                    />
                  </>
                ) : (
                  <>
                    <input
                      aria-label={`${item.fileName} 逻辑 ID`}
                      onChange={(event) =>
                        updateImport(index, {
                          id: event.currentTarget.value.trim(),
                        })
                      }
                      value={item.id}
                    />
                    <select
                      aria-label={`${item.fileName} 类型`}
                      onChange={(event) =>
                        updateImport(index, {
                          kind: event.currentTarget.value as AssetKind,
                        })
                      }
                      value={item.kind}
                    >
                      {ASSET_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {ASSET_KIND_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                    <input
                      aria-label={`${item.fileName} 文件名`}
                      onChange={(event) =>
                        updateImport(index, {
                          fileName: event.currentTarget.value,
                        })
                      }
                      value={item.fileName}
                    />
                  </>
                )}
                <IconButton
                  onClick={() =>
                    setImportQueue(
                      (current) =>
                        current?.filter(
                          (_, candidate) => candidate !== index,
                        ) ?? null,
                    )
                  }
                  icon={Trash2}
                  label={`移除 ${item.fileName}`}
                  size="sm"
                />
              </div>
            ))}
          </div>
          <button
            className="primary-action"
            disabled={importing || importQueue.length === 0}
            onClick={() => void submitImport()}
            type="button"
          >
            {importing ? "导入中…" : "导入清单"}
          </button>
        </div>
      )}
      {folderDialog !== null && folderDialog.mode === "create" && (
        <TextEntryDialog
          initialValue="新文件夹"
          onCancel={() => setFolderDialog(null)}
          onSubmit={(value) => {
            const result = createAssetFolder(layout, {
              name: value,
              parentId: folderDialog.parentId,
            });
            if (!result.ok) {
              setFolderError(result.reason);
              return false;
            }
            setFolderError(null);
            commitLayout(() => result.layout, "新建素材文件夹");
            setFolderDialog(null);
            return true;
          }}
          title="新建文件夹"
        />
      )}
      {folderDialog !== null && folderDialog.mode === "rename" && (
        <TextEntryDialog
          initialValue={
            (layout.asset_folders ?? {})[folderDialog.folderId]?.name ?? ""
          }
          onCancel={() => setFolderDialog(null)}
          onSubmit={(value) => {
            if (!isValidAssetFolderName(value)) {
              setFolderError("文件夹名称必须为 1–120 个非控制字符。");
              return false;
            }
            setFolderError(null);
            commitLayout(
              (current) =>
                renameAssetFolder(current, folderDialog.folderId, value),
              "重命名素材文件夹",
            );
            setFolderDialog(null);
            return true;
          }}
          title="重命名文件夹"
        />
      )}
      {folderMoveTarget !== null && (
        <FolderMoveDialog
          folderId={folderMoveTarget}
          layout={layout}
          onCancel={() => setFolderMoveTarget(null)}
          onSubmit={(parentId) => {
            moveFolder(folderMoveTarget, parentId);
            setFolderMoveTarget(null);
          }}
        />
      )}
      {animationPanel && (
        <ImageAnimationPanel
          assets={assets}
          existingAnimationIds={
            new Set(animations.map((file) => file.definition.id))
          }
          existingAnimationPaths={new Set(animations.map((file) => file.path))}
          existingAssetIds={new Set(Object.keys(manifest.assets))}
          onClose={() => setAnimationPanel(false)}
          onCreate={onCreateImageAnimation}
        />
      )}
    </div>
  );
}

interface AssetFolderChoice {
  id: string;
  path: string;
}

/** Flat folder list (id + display path) for folder selects. */
function findFolderNode(
  nodes: readonly AssetFolderNode[],
  id: string,
): AssetFolderNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findFolderNode(node.children, id);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function AssetKindIcon({ kind }: { kind: AssetKind }): ReactElement {
  const Icon = ASSET_KIND_ICONS[kind];
  return (
    <span
      className={`asset-kind asset-kind-${kind}`}
      title={ASSET_KIND_LABELS[kind]}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}

function flattenAssetFolders(layout: EditorLayout): AssetFolderChoice[] {
  const folders = layout.asset_folders ?? {};
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
    .map((id) => ({ id, path: pathOf(id).join(" / ") }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function readAssetDragPayload(event: { dataTransfer: DataTransfer | null }): {
  assetId?: string;
  assetIds?: string[];
  folderId?: string;
} {
  const data = event.dataTransfer;
  if (data === null || data === undefined) return {};
  const assetId = data.getData("application/x-vect-asset");
  const folderId = data.getData("application/x-vect-folder");
  let assetIds: string[] | undefined;
  try {
    const parsed: unknown = JSON.parse(
      data.getData("application/x-vect-assets"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((id) => typeof id === "string")
    ) {
      assetIds = parsed.filter((id) => id === assetId);
      // Only accept a multi-drag that includes its actual drag origin.
      if (assetIds.length !== 1) assetIds = undefined;
      else assetIds = parsed;
    }
  } catch {
    /* Old single-item payload. */
  }
  return {
    assetId: assetId === "" ? undefined : assetId,
    assetIds,
    folderId: folderId === "" ? undefined : folderId,
  };
}

/**
 * Actual container format families.  The host re-decodes the upload and
 * rejects a mismatch; this map is the editor's friendly pre-check so the
 * dialog can explain the problem before staging anything.
 */
const EXTENSION_FAMILIES: Record<string, string> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
  ogg: "ogg",
  wav: "wav",
  mp3: "mp3",
  flac: "flac",
  mp4: "mp4",
  ttf: "font",
  otf: "font",
};

function extensionFamily(fileNameOrPath: string): string {
  const extension = fileNameOrPath.split(".").at(-1)?.toLowerCase() ?? "";
  return EXTENSION_FAMILIES[extension] ?? extension;
}

/** Case-insensitive comparison key for an asset-relative path. */
function collisionKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * A replacement must never target the current registration, the original
 * on-disk binary, or any earlier staged replacement path.  The host reserves
 * all of them, so the picker pre-checks the same set and suggests a free name.
 */
function replacementError(
  asset: EditorAsset,
  fileName: string,
  inspection: AssetInspection | undefined,
  forbidden: ReadonlySet<string>,
): string | undefined {
  const errors: string[] = [];
  const currentPath = asset.path ?? "";
  const destination = `${assetFolder(asset.kind)}/${fileName}`;
  const destinationKey = collisionKey(destination);
  if (collisionKey(currentPath) === destinationKey)
    errors.push("新文件路径必须与当前登记路径不同。");
  else if (forbidden.has(destinationKey))
    errors.push(
      "该目标路径已被原始文件或先前暂存的替换保留，请改用新的文件名（例如加 _v2）。",
    );
  if (!supportedImportExtension(asset.kind, fileName))
    errors.push("文件扩展名与素材类型不匹配。");
  else if (extensionFamily(fileName) !== extensionFamily(currentPath))
    errors.push(
      `新文件必须与旧文件格式一致（当前：${currentPath.split(".").at(-1) ?? "?"}）。`,
    );
  const inspectionError = inspection?.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message)
    .join("；");
  if (inspectionError !== undefined && inspectionError !== "")
    errors.push(inspectionError);
  return errors.length > 0 ? errors.join("；") : undefined;
}

/** First free `stem_vN.ext` name for a replacement destination. */
function suggestReplacementFileName(
  asset: EditorAsset,
  preferred: string,
  forbidden: ReadonlySet<string>,
): string {
  const folder = assetFolder(asset.kind);
  const dot = preferred.lastIndexOf(".");
  const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
  const extension = dot > 0 ? preferred.slice(dot) : "";
  let candidate = preferred;
  let index = 2;
  while (
    forbidden.has(collisionKey(`${folder}/${candidate}`)) &&
    index <= 999
  ) {
    candidate = `${stem}_v${index}${extension}`;
    index += 1;
  }
  return candidate;
}

/** Keyboard-accessible folder reparenting (the drag/drop alternative). */
function FolderMoveDialog({
  layout,
  folderId,
  onCancel,
  onSubmit,
}: {
  layout: EditorLayout;
  folderId: string;
  onCancel(): void;
  onSubmit(parentId: string | null): void;
}): ReactElement {
  const [parent, setParent] = useState<string>(
    () => (layout.asset_folders ?? {})[folderId]?.parent_id ?? "",
  );
  const options = flattenAssetFolders(layout).filter(
    (folder) =>
      folder.id !== folderId &&
      validateFolderMove(layout, folderId, folder.id).ok,
  );
  return (
    <div
      className="editor-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <form
        className="editor-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(parent === "" ? null : parent);
        }}
      >
        <h3>移动文件夹</h3>
        <label>
          目标父文件夹
          <select
            aria-label="目标父文件夹"
            onChange={(event) => setParent(event.currentTarget.value)}
            value={parent}
          >
            <option value="">（根目录）</option>
            {options.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.path}
              </option>
            ))}
          </select>
        </label>
        <div className="editor-dialog-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-button" type="submit">
            确定
          </button>
        </div>
      </form>
    </div>
  );
}

const ASSET_KINDS: AssetKind[] = [
  "background",
  "sprite",
  "gui",
  "bgm",
  "ambience",
  "sfx",
  "video",
  "font",
];
export interface ImportDraft {
  sourcePath: string;
  id: string;
  kind: AssetKind;
  fileName: string;
  inspectionId?: string;
  inspection?: AssetInspection;
  error?: string;
  /**
   * Set when this upload replaces the binary of an existing asset.  It always
   * equals `id`; the host keeps the logical id and references stable while
   * publishing the new file at a different path.
   */
  replaceId?: string;
}

function TextEntryDialog({
  title,
  initialValue,
  onSubmit,
  onCancel,
  validate,
  hint,
}: {
  title: string;
  initialValue: string;
  onSubmit(value: string): boolean;
  onCancel(): void;
  /** Live check; its message is shown inline and blocks submission. */
  validate?(value: string): string | null;
  hint?: string;
}): ReactElement {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const trimmed = value.trim();
  const problem =
    trimmed.length === 0 ? "输入不能为空。" : (validate?.(trimmed) ?? null);
  const submit = (): void => {
    if (problem !== null) {
      setError(problem);
      return;
    }
    const accepted = onSubmit(trimmed);
    if (!accepted) setError("输入未通过校验，请修正后重试。");
    else setError(null);
  };
  const message =
    validate !== undefined && trimmed.length > 0 ? problem : error;
  return (
    <div
      className="editor-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        className="editor-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !isComposing(event)) {
            event.preventDefault();
            onCancel();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h3>{title}</h3>
        <input
          aria-invalid={message !== null}
          aria-label={title}
          ref={inputRef}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
          spellCheck={false}
          value={value}
        />
        {message !== null ? (
          <p className="inline-error" role="alert">
            {message}
          </p>
        ) : (
          hint !== undefined && <small className="muted">{hint}</small>
        )}
        <div className="editor-dialog-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-button" type="submit">
            确定
          </button>
        </div>
      </form>
    </div>
  );
}

function inferAssetKind(fileName: string): AssetKind {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const stem = fileName
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.[^.]+$/, "")
    .toLowerCase();
  const tokens = stem?.split(/[^a-z0-9]+/).filter(Boolean) ?? [];
  // Audio containers do not encode their authored role.  Keep the historic
  // SFX fallback, but recognize the explicit ambience naming convention so a
  // file such as ambience.forest.ogg enters the import queue with the right
  // initial kind.
  if (tokens.some((token) => token === "ambience" || token === "ambient"))
    return "ambience";
  if (["ttf", "otf"].includes(extension)) return "font";
  // The runtime currently guarantees MP4/H.264 playback.  Do not classify
  // WebM/MOV as video only to make the later staged-import validation fail.
  if (extension === "mp4") return "video";
  if (["ogg", "wav", "mp3", "flac"].includes(extension)) return "sfx";
  return "background";
}

function assetFolder(kind: AssetKind): string {
  switch (kind) {
    case "background":
      return "backgrounds";
    case "sprite":
      return "sprites";
    case "gui":
      return "gui";
    case "bgm":
    case "ambience":
    case "sfx":
      return "audio";
    case "video":
      return "videos";
    case "font":
      return "fonts";
  }
}

function supportedImportExtension(kind: AssetKind, fileName: string): boolean {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const allowed: Record<AssetKind, string[]> = {
    background: ["png", "jpg", "jpeg", "webp"],
    sprite: ["png", "jpg", "jpeg", "webp"],
    gui: ["png", "jpg", "jpeg", "webp"],
    bgm: ["ogg", "wav", "mp3", "flac"],
    ambience: ["ogg", "wav", "mp3", "flac"],
    sfx: ["ogg", "wav", "mp3", "flac"],
    video: ["mp4"],
    font: ["ttf", "otf"],
  };
  return allowed[kind].includes(extension);
}

function formatAssetSize(size: string | number | bigint | undefined): string {
  if (size === undefined) return "大小未知";
  try {
    const bytes =
      typeof size === "string"
        ? BigInt(size)
        : typeof size === "bigint"
          ? size
          : Number.isFinite(size) && size >= 0
            ? BigInt(Math.trunc(size))
            : null;
    if (bytes === null || bytes < 0n) return "大小未知";
    if (bytes < 1024n) return `${bytes} B`;
    if (bytes < 1024n * 1024n)
      return `${(Number(bytes) / 1024).toFixed(1)} KiB`;
    return `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;
  } catch {
    return "大小未知";
  }
}

function formatInspectionSize(size: string): string {
  try {
    const bytes = BigInt(size);
    if (bytes < 1024n) return `${bytes} B`;
    if (bytes < 1024n * 1024n)
      return `${(Number(bytes) / 1024).toFixed(1)} KiB`;
    return `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;
  } catch {
    return "大小未知";
  }
}

function formatAssetMetadata(
  metadata: AssetMetadata | null | undefined,
): string {
  if (metadata === null || metadata === undefined) return "规格未知";
  const dimensions =
    metadata.width !== null &&
    metadata.width !== undefined &&
    metadata.height !== null &&
    metadata.height !== undefined
      ? `${metadata.width}×${metadata.height}px`
      : null;
  const duration =
    metadata.duration_ms !== null && metadata.duration_ms !== undefined
      ? `${formatDurationMs(metadata.duration_ms)}s`
      : null;
  const audio =
    metadata.sample_rate !== null && metadata.sample_rate !== undefined
      ? `${metadata.sample_rate}Hz${metadata.channels === null || metadata.channels === undefined ? "" : `/${metadata.channels}ch`}`
      : null;
  const font = metadata.font_family ?? null;
  return (
    [dimensions, duration, audio, font].filter(Boolean).join(" · ") ||
    "规格未知"
  );
}

function formatDurationMs(value: bigint | number | string): string {
  if (typeof value === "string") {
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return "?";
    try {
      return formatDurationMs(BigInt(value));
    } catch {
      return "?";
    }
  }
  if (typeof value === "bigint") {
    if (value < 0n) return "?";
    const seconds = value / 1000n;
    const hundredths = (value % 1000n) / 10n;
    return `${seconds.toString()}.${hundredths.toString().padStart(2, "0")}`;
  }
  return Number.isFinite(value) && value >= 0 ? (value / 1000).toFixed(2) : "?";
}

function uniqueAssetId(
  stem: string,
  kind: AssetKind,
  assets: EditorAsset[],
): string {
  const prefix =
    kind === "background"
      ? "bg"
      : kind === "sprite"
        ? "sprite"
        : kind === "gui"
          ? "gui"
          : kind;
  const base = `${prefix}.${
    stem
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^\.+|\.+$/g, "") || "new"
  }`;
  const used = new Set(assets.map((asset) => asset.id));
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Human label for the small list line: static path or animation reference. */
function assetDescription(
  asset: EditorAsset,
  manifest: ContentManifest,
): string {
  const declared = manifest.assets[asset.id];
  if (asset.animation !== undefined) return `动画 ${asset.animation}`;
  return declared?.path ?? asset.path ?? "（未登记路径）";
}

function assetSize(
  asset: EditorAsset,
): { width: number; height: number } | undefined {
  const metadata = asset.metadata;
  if (metadata === undefined || metadata === null) return undefined;
  if (metadata.width === null || metadata.height === null) return undefined;
  return { width: metadata.width, height: metadata.height };
}

/** Resolved frames of one animation document, in document order. */
function previewFramesFor(
  file: AnimationFile,
  assets: readonly EditorAsset[],
): { asset: string; url: string; duration_ms: number }[] {
  return file.definition.frames.map((frame) => ({
    asset: frame.asset,
    url: assetUrl(
      assets.find((candidate) => candidate.id === frame.asset)?.absolute_path ??
        "",
    ),
    duration_ms: frame.duration_ms,
  }));
}

function animationSummary(
  asset: EditorAsset,
  assets: readonly EditorAsset[],
  animations: readonly AnimationFile[],
): string {
  const file = animationSourceId(asset.animation ?? "", animations);
  if (file === undefined) return "动画描述文件缺失，保存前请修正。";
  const frames = file.definition.frames;
  const seen = new Set<string>();
  let decoded = 0;
  for (const frame of frames) {
    if (seen.has(frame.asset)) continue;
    seen.add(frame.asset);
    const size = assetSize(
      assets.find((candidate) => candidate.id === frame.asset) ?? asset,
    );
    if (size !== undefined) decoded += size.width * size.height * 4;
  }
  const size = assetSize(asset);
  return `${frames.length} 帧 · 总时长 ${frames.reduce((sum, frame) => sum + frame.duration_ms, 0)} ms · ${
    size === undefined ? "尺寸未知" : `${size.width} × ${size.height}`
  } · 解码约 ${Math.round(decoded / (1024 * 1024))} MiB`;
}

function AssetPreview({
  asset,
  assets,
  animations,
}: {
  asset: EditorAsset;
  assets: readonly EditorAsset[];
  animations: readonly AnimationFile[];
}): ReactElement {
  const url = assetUrl(asset.absolute_path);
  const font = useAssetFont(
    asset.kind === "font" ? url : undefined,
    `Asset ${asset.id}`,
  );
  const animation = animationSourceId(asset.animation ?? "", animations);
  if (animation !== undefined) {
    const size = assetSize(asset);
    return (
      <FrameSequencePreview
        frames={previewFramesFor(animation, assets)}
        height={size?.height}
        label={`素材 ${asset.id}`}
        width={size?.width}
      />
    );
  }
  if (["background", "sprite", "gui"].includes(asset.kind)) {
    return <img alt={asset.id} className="asset-preview" src={url} />;
  }
  if (
    asset.kind === "bgm" ||
    asset.kind === "ambience" ||
    asset.kind === "sfx"
  ) {
    return <audio className="asset-audio" controls src={url} />;
  }
  if (asset.kind === "video") {
    return (
      <video className="asset-preview" controls preload="metadata" src={url} />
    );
  }
  return (
    <div className="font-preview" style={{ fontFamily: font.fontFamily }}>
      {font.error === null ? "Aa 数学 123" : `字体加载失败：${font.error}`}
    </div>
  );
}

function ProjectPanel({
  manifest,
  onChange,
  onAddVariable,
  onChangeVariable,
  onDeleteVariable,
  onRenameVariable,
  onAddCharacter,
  onChangeCharacter,
  onDeleteCharacter,
  onRenameCharacter,
  onCreateUiMotion,
  onEditUiMotion,
  onDeleteUiMotion,
  onCreateButtonTemplate,
  onEditButtonTemplate,
  onDuplicateButtonTemplate,
  onDeleteButtonTemplate,
  onCreateAction,
  onRenameAction,
  onDuplicateAction,
  onDeleteAction,
  onEditActionKeyframes,
  onScrollOffset,
  project,
  scrollStore,
  sectionOpen,
  onToggleSection,
  sidebarItemOpen,
  onToggleSidebarItem,
  view = "all",
}: {
  manifest: ContentManifest;
  onChange(manifest: ContentManifest): void;
  onAddVariable(id: string, definition: VariableDefinition): boolean;
  onChangeVariable(id: string, definition: VariableDefinition): void;
  onDeleteVariable(id: string): void;
  onRenameVariable(previousId: string, nextId: string): boolean;
  onAddCharacter(id: string, definition: CharacterDefinition): boolean;
  onChangeCharacter(id: string, definition: CharacterDefinition): void;
  onDeleteCharacter(id: string): void;
  onRenameCharacter(previousId: string, nextId: string): boolean;
  onCreateUiMotion(): void;
  onEditUiMotion(id: string): void;
  onDeleteUiMotion(id: string): void;
  onCreateButtonTemplate(): void;
  onEditButtonTemplate(id: string): void;
  onDuplicateButtonTemplate(id: string): void;
  onDeleteButtonTemplate(id: string): void;
  onCreateAction(id: string): boolean;
  onRenameAction(previousId: string, nextId: string): boolean;
  onDuplicateAction(id: string): void;
  onDeleteAction(id: string): void;
  onEditActionKeyframes(id: string): void;
  onScrollOffset?(tab: SidebarTab, offset: number): void;
  project: EditorProject;
  scrollStore?: SidebarScrollStore;
  sectionOpen?: Partial<Record<ProjectSectionId, boolean>>;
  onToggleSection?(id: ProjectSectionId): void;
  sidebarItemOpen?: Readonly<Record<string, boolean>>;
  onToggleSidebarItem?(key: string): void;
  /** Which slice of the project settings to show; "all" stacks every section. */
  view?: "all" | ProjectPanelView;
}): ReactElement {
  const show = (group: ProjectPanelView): boolean =>
    view === "all" || view === group;
  const [dialog, setDialog] = useState<{
    title: string;
    value: string;
    kind:
      | "character_add"
      | "character_rename"
      | "variable_add"
      | "variable_rename"
      | "action_add"
      | "action_rename";
    previous?: string;
  } | null>(null);
  const { onScroll: onSettingsScroll, ref: settingsRef } = useSidebarScroller(
    "project",
    scrollStore,
    onScrollOffset,
  );
  const assetLayout = useAssetLayout();
  // A hidden asset must never be chosen silently: the first *visible* sprite
  // seeds a new expression, and with none available the ＋ action is disabled
  // with an explanation instead of falling back to a hidden asset.
  const defaultExpressionSprite = firstVisibleAssetId(
    project.assets,
    assetLayout,
    "sprite",
  );
  const isSectionOpen = (sectionId: ProjectSectionId): boolean =>
    sectionOpen?.[sectionId] ?? true;
  const toggleSection = (sectionId: ProjectSectionId): void => {
    onToggleSection?.(sectionId);
  };
  const isSidebarItemOpen = (itemKey: string): boolean =>
    sidebarItemOpen?.[itemKey] ?? true;
  const toggleSidebarItem = (itemKey: string): void => {
    onToggleSidebarItem?.(itemKey);
  };
  return (
    <div
      className={`sidebar-body project-settings project-view-${view}`}
      data-sidebar-scroller="project"
      onScroll={onSettingsScroll}
      ref={settingsRef}
    >
      {show("project") && (
        <>
          <label>
            <span>内容版本</span>
            <DeferredTextInput
              value={manifest.content_version}
              onCommit={(content_version) =>
                onChange({ ...manifest, content_version })
              }
            />
            <small>改变后旧存档将不再兼容</small>
          </label>
          <label>
            <span>默认语言</span>
            <DeferredTextInput
              value={manifest.default_locale}
              onCommit={(default_locale) =>
                onChange({ ...manifest, default_locale })
              }
            />
          </label>
          <label>
            <span>项目入口场景</span>
            <select
              value={manifest.entry_scene}
              onChange={(event) =>
                onChange({
                  ...manifest,
                  entry_scene: event.currentTarget.value,
                })
              }
            >
              {project.scenes.map((file) => (
                <option key={file.definition.id} value={file.definition.id}>
                  {file.definition.id}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {show("library") && (
        <CollapsibleSection
          actions={
            <IconButton
              icon={Plus}
              label="新建 UI 动效"
              onClick={onCreateUiMotion}
              size="sm"
            />
          }
          className="ui-motion-settings"
          id="ui-motion"
          onToggle={() => toggleSection("ui-motion")}
          open={isSectionOpen("ui-motion")}
          title="UI 动效"
        >
          <label>
            <span>对话框出现默认动效</span>
            <select
              value={manifest.ui_motion_defaults.dialogue_show ?? ""}
              onChange={(event) =>
                onChange({
                  ...manifest,
                  ui_motion_defaults: {
                    ...manifest.ui_motion_defaults,
                    dialogue_show: event.currentTarget.value || null,
                  },
                })
              }
            >
              <option value="">无（立即出现）</option>
              {project.ui_motions.map(({ definition }) => (
                <option key={definition.id} value={definition.id}>
                  {definition.id}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>对话框收起默认动效</span>
            <select
              value={manifest.ui_motion_defaults.dialogue_hide ?? ""}
              onChange={(event) =>
                onChange({
                  ...manifest,
                  ui_motion_defaults: {
                    ...manifest.ui_motion_defaults,
                    dialogue_hide: event.currentTarget.value || null,
                  },
                })
              }
            >
              <option value="">无（立即收起）</option>
              {project.ui_motions.map(({ definition }) => (
                <option key={definition.id} value={definition.id}>
                  {definition.id}
                </option>
              ))}
            </select>
          </label>
          <div className="library-list">
            {project.ui_motions.map(({ definition, path }) => (
              <LibraryRow
                actions={[
                  {
                    id: "delete",
                    label: "从项目移除",
                    icon: Trash2,
                    danger: true,
                    onSelect: () => onDeleteUiMotion(definition.id),
                  },
                ]}
                editLabel={`编辑 UI 动效 ${definition.id}`}
                icon={Sparkles}
                key={definition.id}
                meta={`${definition.duration_ms} ms · ${path}`}
                onOpen={() => onEditUiMotion(definition.id)}
                title={definition.id}
              />
            ))}
            {project.ui_motions.length === 0 && (
              <p className="library-empty">
                还没有 UI 动效。创建后可在对话框与 UI 动效节点中复用。
              </p>
            )}
          </div>
        </CollapsibleSection>
      )}
      {show("library") && (
        <CollapsibleSection
          actions={
            <IconButton
              icon={Plus}
              label="新建按钮模板"
              onClick={onCreateButtonTemplate}
              size="sm"
            />
          }
          className="button-template-settings"
          id="button-template"
          onToggle={() => toggleSection("button-template")}
          open={isSectionOpen("button-template")}
          title="按钮模板"
        >
          <div className="library-list">
            {(project.buttons ?? []).map(({ definition }) => {
              const references = findButtonTemplateReferences(
                project,
                definition.id,
              );
              return (
                <LibraryRow
                  actions={[
                    {
                      id: "duplicate",
                      label: "创建副本",
                      icon: CopyPlus,
                      onSelect: () => onDuplicateButtonTemplate(definition.id),
                    },
                    { kind: "separator", id: "sep" },
                    {
                      id: "delete",
                      label: "从项目移除",
                      icon: Trash2,
                      danger: true,
                      disabled: references.length > 0,
                      hint: `仍被 ${references.length} 处剧情引用`,
                      onSelect: () => onDeleteButtonTemplate(definition.id),
                    },
                  ]}
                  editLabel={`编辑按钮模板 ${definition.id}`}
                  icon={MousePointerClick}
                  key={definition.id}
                  meta={`${definition.width} × ${definition.height} · ${
                    references.length === 0
                      ? "未被引用"
                      : `${references.length} 处引用`
                  }`}
                  onOpen={() => onEditButtonTemplate(definition.id)}
                  title={definition.id}
                />
              );
            })}
            {(project.buttons ?? []).length === 0 && (
              <p className="library-empty">
                还没有按钮模板。创建后可在「创建按钮」节点中生成多个实例。
              </p>
            )}
          </div>
        </CollapsibleSection>
      )}
      {show("library") && (
        <CollapsibleSection
          actions={
            <IconButton
              onClick={() => {
                let index = (project.actions ?? []).length + 1;
                let id = `sprite.action_${index}`;
                while (
                  (project.actions ?? []).some(
                    (file) => file.definition.id === id,
                  )
                ) {
                  index += 1;
                  id = `sprite.action_${index}`;
                }
                setDialog({
                  title: "新立绘动作 ID",
                  value: id,
                  kind: "action_add",
                });
              }}
              icon={Plus}
              label="新建立绘动作"
              size="sm"
              variant="ghost"
            />
          }
          className="action-settings"
          id="sprite-action"
          onToggle={() => toggleSection("sprite-action")}
          open={isSectionOpen("sprite-action")}
          title="立绘动作库"
        >
          <div className="library-list">
            {(project.actions ?? []).map(({ definition }) => (
              <LibraryRow
                actions={[
                  {
                    id: "rename",
                    label: "重命名 ID…",
                    icon: Pencil,
                    onSelect: () =>
                      setDialog({
                        title: "新的动作 ID",
                        value: definition.id,
                        kind: "action_rename",
                        previous: definition.id,
                      }),
                  },
                  {
                    id: "duplicate",
                    label: "创建副本",
                    icon: CopyPlus,
                    onSelect: () => onDuplicateAction(definition.id),
                  },
                  { kind: "separator", id: "sep" },
                  {
                    id: "delete",
                    label: "从项目移除",
                    icon: Trash2,
                    danger: true,
                    onSelect: () => onDeleteAction(definition.id),
                  },
                ]}
                editLabel={`编辑立绘动作 ${definition.id}`}
                icon={PersonStanding}
                key={definition.id}
                meta={`${definition.id} · ${definition.duration_ms} ms`}
                onOpen={() => onEditActionKeyframes(definition.id)}
                title={definition.name || definition.id}
              />
            ))}
            {(project.actions ?? []).length === 0 && (
              <p className="library-empty">
                还没有立绘动作。动作以立绘当前姿态为基准，可在「立绘动作」节点中调用。
              </p>
            )}
          </div>
        </CollapsibleSection>
      )}
      {show("characters") && (
        <CollapsibleSection
          actions={
            <IconButton
              onClick={() => {
                setDialog({
                  title: "新角色 ID",
                  value: "new_character",
                  kind: "character_add",
                });
              }}
              icon={Plus}
              label="新建角色"
              size="sm"
              variant="ghost"
            />
          }
          className="character-settings"
          id="character"
          onToggle={() => toggleSection("character")}
          open={isSectionOpen("character")}
          title="角色"
        >
          {Object.entries(manifest.characters).map(([id, definition]) => {
            const itemKey = `character:${id}`;
            const open = isSidebarItemOpen(itemKey);
            const contentId = `sidebar-item-content-${encodeURIComponent(itemKey)}`;
            return (
              <article className="variable-card character-card" key={id}>
                <header>
                  <button
                    aria-controls={contentId}
                    aria-expanded={open}
                    aria-label={`${open ? "收起" : "展开"}角色 ${id}`}
                    className="sidebar-item-toggle"
                    onClick={() => toggleSidebarItem(itemKey)}
                    type="button"
                  >
                    <span aria-hidden="true" className="sidebar-item-caret">
                      {open ? "▾" : "▸"}
                    </span>
                    <code>{id}</code>
                  </button>
                  <div>
                    <IconButton
                      onClick={() => {
                        setDialog({
                          title: "新的角色 ID",
                          value: id,
                          kind: "character_rename",
                          previous: id,
                        });
                      }}
                      icon={Pencil}
                      label="重命名角色 ID"
                      size="sm"
                      variant="ghost"
                    />
                    <IconButton
                      onClick={() => onDeleteCharacter(id)}
                      icon={Trash2}
                      label="删除角色"
                      size="sm"
                    />
                  </div>
                </header>
                <div
                  className="sidebar-item-content"
                  hidden={!open}
                  id={contentId}
                >
                  <label>
                    <span>显示名</span>
                    <DeferredTextInput
                      maxLength={64}
                      value={definition.display_name}
                      onCommit={(display_name) =>
                        onChangeCharacter(id, { ...definition, display_name })
                      }
                    />
                  </label>
                  <CharacterColorInput
                    label="姓名色"
                    onChange={(name_color) =>
                      onChangeCharacter(id, { ...definition, name_color })
                    }
                    value={definition.name_color}
                  />
                  <CharacterColorInput
                    label="正文色"
                    onChange={(text_color) =>
                      onChangeCharacter(id, { ...definition, text_color })
                    }
                    value={definition.text_color}
                  />
                  <label>
                    <span>默认表情</span>
                    <select
                      value={definition.default_expression ?? ""}
                      onChange={(event) =>
                        onChangeCharacter(id, {
                          ...definition,
                          default_expression: event.currentTarget.value || null,
                        })
                      }
                    >
                      <option value="">无（由节点指定素材）</option>
                      {Object.keys(definition.expressions ?? {}).map(
                        (expressionId) => (
                          <option key={expressionId} value={expressionId}>
                            {expressionId}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    <span>默认缩放</span>
                    <DeferredInput
                      min={0.01}
                      onCommit={(raw) => {
                        const value = Number(raw);
                        if (!Number.isFinite(value) || value <= 0) return false;
                        onChangeCharacter(id, {
                          ...definition,
                          default_scale: value,
                        });
                      }}
                      step={0.05}
                      type="number"
                      value={String(definition.default_scale ?? 1)}
                    />
                  </label>
                  <div className="character-expression-list">
                    <header>
                      <span>表情图</span>
                      <IconButton
                        disabled={defaultExpressionSprite === null}
                        onClick={() => {
                          const expressions = {
                            ...(definition.expressions ?? {}),
                          };
                          let index = Object.keys(expressions).length + 1;
                          let expressionId = `expression_${index}`;
                          while (expressions[expressionId] !== undefined) {
                            index += 1;
                            expressionId = `expression_${index}`;
                          }
                          const firstSprite = firstVisibleAssetId(
                            project.assets,
                            assetLayout,
                            "sprite",
                          );
                          if (firstSprite === null) return;
                          expressions[expressionId] = {
                            asset: firstSprite,
                            anchor_x: 0.5,
                            anchor_y: 1,
                            offset_x: 0,
                            offset_y: 0,
                            scale: 1,
                          };
                          onChangeCharacter(id, { ...definition, expressions });
                        }}
                        icon={Plus}
                        label="添加表情"
                        tooltip={
                          defaultExpressionSprite === null
                            ? "没有可用的立绘素材（或全部已隐藏）"
                            : "添加表情"
                        }
                        size="sm"
                        variant="ghost"
                      />
                    </header>
                    {Object.entries(definition.expressions ?? {}).map(
                      ([expressionId, expression]) => (
                        <CharacterExpressionEditor
                          assets={project.assets}
                          expression={expression}
                          expressionId={expressionId}
                          key={expressionId}
                          onChange={(next) =>
                            onChangeCharacter(id, {
                              ...definition,
                              expressions: {
                                ...(definition.expressions ?? {}),
                                [expressionId]: next,
                              },
                            })
                          }
                          onDelete={() => {
                            const expressions = withoutKey(
                              definition.expressions ?? {},
                              expressionId,
                            );
                            onChangeCharacter(id, {
                              ...definition,
                              expressions,
                              default_expression:
                                definition.default_expression === expressionId
                                  ? null
                                  : definition.default_expression,
                            });
                          }}
                        />
                      ),
                    )}
                    {Object.keys(definition.expressions ?? {}).length === 0 && (
                      <small>添加 sprite 素材后，可为角色注册表情。</small>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </CollapsibleSection>
      )}
      {show("variables") && (
        <CollapsibleSection
          actions={
            <IconButton
              onClick={() => {
                setDialog({
                  title: "新变量 ID",
                  value: "new_variable",
                  kind: "variable_add",
                });
              }}
              icon={Plus}
              label="新建变量"
              size="sm"
              variant="ghost"
            />
          }
          id="variable"
          onToggle={() => toggleSection("variable")}
          open={isSectionOpen("variable")}
          title="剧情变量"
        >
          {Object.entries(manifest.variables).map(([id, definition]) => {
            const itemKey = `variable:${id}`;
            const open = isSidebarItemOpen(itemKey);
            const contentId = `sidebar-item-content-${encodeURIComponent(itemKey)}`;
            return (
              <article className="variable-card" key={id}>
                <header>
                  <button
                    aria-controls={contentId}
                    aria-expanded={open}
                    aria-label={`${open ? "收起" : "展开"}变量 ${id}`}
                    className="sidebar-item-toggle"
                    onClick={() => toggleSidebarItem(itemKey)}
                    type="button"
                  >
                    <span aria-hidden="true" className="sidebar-item-caret">
                      {open ? "▾" : "▸"}
                    </span>
                    <code>{id}</code>
                  </button>
                  <div>
                    <IconButton
                      onClick={() => {
                        setDialog({
                          title: "新的变量 ID",
                          value: id,
                          kind: "variable_rename",
                          previous: id,
                        });
                      }}
                      icon={Pencil}
                      label="重命名变量 ID"
                      size="sm"
                      variant="ghost"
                    />
                    <IconButton
                      onClick={() => onDeleteVariable(id)}
                      icon={Trash2}
                      label="删除变量"
                      size="sm"
                    />
                  </div>
                </header>
                <div
                  className="sidebar-item-content"
                  hidden={!open}
                  id={contentId}
                >
                  <label>
                    <span>作用域</span>
                    <select
                      value={definition.scope}
                      onChange={(event) =>
                        onChangeVariable(id, {
                          ...definition,
                          scope: event.currentTarget
                            .value as VariableDefinition["scope"],
                        })
                      }
                    >
                      <option value="save">{VARIABLE_SCOPE_LABELS.save}</option>
                      <option value="profile">
                        {VARIABLE_SCOPE_LABELS.profile}
                      </option>
                    </select>
                  </label>
                  <label>
                    <span>类型</span>
                    <select
                      value={definition.type}
                      onChange={(event) => {
                        const type = event.currentTarget.value as VariableType;
                        onChangeVariable(id, {
                          ...definition,
                          type,
                          default: defaultForVariableType(type),
                        });
                      }}
                    >
                      <option value="boolean">
                        {VARIABLE_TYPE_LABELS.boolean}
                      </option>
                      <option value="integer">
                        {VARIABLE_TYPE_LABELS.integer}
                      </option>
                      <option value="number">
                        {VARIABLE_TYPE_LABELS.number}
                      </option>
                      <option value="string">
                        {VARIABLE_TYPE_LABELS.string}
                      </option>
                    </select>
                  </label>
                  <label>
                    <span>默认值</span>
                    <VariableDefaultInput
                      definition={definition}
                      onChange={(defaultValue) =>
                        onChangeVariable(id, {
                          ...definition,
                          default: defaultValue,
                        })
                      }
                    />
                  </label>
                </div>
              </article>
            );
          })}
        </CollapsibleSection>
      )}
      {show("project") && (
        <>
          <dl className="project-facts">
            <div>
              <dt>Schema</dt>
              <dd>{manifest.schema_version}</dd>
            </div>
            <div>
              <dt>场景</dt>
              <dd>{project.scenes.length}</dd>
            </div>
            <div>
              <dt>素材</dt>
              <dd>{Object.keys(manifest.assets).length}</dd>
            </div>
          </dl>
          <code className="project-root">{project.root}</code>
        </>
      )}
      {dialog !== null && (
        <TextEntryDialog
          initialValue={dialog.value}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            let accepted = true;
            if (dialog.kind === "character_add") {
              if (manifest.characters[value] === undefined) {
                accepted = onAddCharacter(value, {
                  display_name: "新角色",
                  name_color: "#1D2948",
                  text_color: "#17213A",
                });
              } else {
                accepted = false;
              }
            } else if (dialog.kind === "character_rename") {
              if (dialog.previous !== undefined && value !== dialog.previous)
                accepted = onRenameCharacter(dialog.previous, value);
            } else if (dialog.kind === "variable_add") {
              if (manifest.variables[value] === undefined) {
                accepted = onAddVariable(value, {
                  scope: "save",
                  type: "boolean",
                  default: false,
                });
              } else {
                accepted = false;
              }
            } else if (dialog.kind === "action_add") {
              accepted = onCreateAction(value);
            } else if (
              dialog.kind === "action_rename" &&
              dialog.previous !== undefined
            ) {
              accepted = onRenameAction(dialog.previous, value);
            } else if (
              dialog.previous !== undefined &&
              value !== dialog.previous
            ) {
              accepted = onRenameVariable(dialog.previous, value);
            }
            if (accepted) setDialog(null);
            return accepted;
          }}
          hint={ID_RULE_HINT}
          title={dialog.title}
          validate={(value) =>
            idUnavailableReason(
              dialog.kind.startsWith("character")
                ? "character"
                : dialog.kind.startsWith("variable")
                  ? "variable"
                  : "action",
              value,
              project,
              { previous: dialog.previous },
            )
          }
        />
      )}
    </div>
  );
}

function CharacterColorInput({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange(value: string | null): void;
  value?: string | null;
}): ReactElement {
  const opaqueColor = value?.slice(0, 7) ?? "#FFFFFF";
  return (
    <label className="character-color-field">
      <span>{label}</span>
      <span>
        <ColorSwatch
          label={`${label}选择器`}
          onCommit={onChange}
          value={
            /^#[0-9A-Fa-f]{6}$/.test(opaqueColor) ? opaqueColor : "#FFFFFF"
          }
        />
        <DeferredTextInput
          placeholder="#RRGGBB / 留空"
          value={value ?? ""}
          onCommit={(next) => onChange(next || null)}
        />
      </span>
    </label>
  );
}

function CharacterExpressionEditor({
  assets,
  expression,
  expressionId,
  onChange,
  onDelete,
}: {
  assets: readonly EditorAsset[];
  expression: CharacterExpression;
  expressionId: string;
  onChange(value: CharacterExpression): void;
  onDelete(): void;
}): ReactElement {
  const spriteAssets = assets.filter((asset) => asset.kind === "sprite");
  return (
    <article className="character-expression-card">
      <header>
        <code>{expressionId}</code>
        <IconButton
          onClick={onDelete}
          icon={Trash2}
          label="删除表情"
          size="sm"
        />
      </header>
      <label>
        <span>素材</span>
        <AssetChooser
          assets={spriteAssets}
          kind="sprite"
          label="表情素材"
          onChange={(value) => onChange({ ...expression, asset: value ?? "" })}
          value={expression.asset || null}
        />
      </label>
      <div className="field-grid compact-grid">
        <NumberInput
          label="锚点 X"
          max={1}
          min={0}
          onChange={(anchor_x) => onChange({ ...expression, anchor_x })}
          step={0.01}
          value={expression.anchor_x ?? 0.5}
        />
        <NumberInput
          label="锚点 Y"
          max={1}
          min={0}
          onChange={(anchor_y) => onChange({ ...expression, anchor_y })}
          step={0.01}
          value={expression.anchor_y ?? 1}
        />
        <NumberInput
          label="偏移 X"
          onChange={(offset_x) => onChange({ ...expression, offset_x })}
          value={expression.offset_x ?? 0}
        />
        <NumberInput
          label="偏移 Y"
          onChange={(offset_y) => onChange({ ...expression, offset_y })}
          value={expression.offset_y ?? 0}
        />
        <NumberInput
          label="表情倍率"
          min={0.01}
          onChange={(scale) => onChange({ ...expression, scale })}
          step={0.05}
          value={expression.scale ?? 1}
        />
      </div>
    </article>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  step?: number;
}): ReactElement {
  return (
    <label>
      <span>{label}</span>
      <DeferredInput
        max={max}
        min={min}
        onCommit={(raw) => {
          const next = Number(raw);
          if (raw.trim() === "" || !Number.isFinite(next)) return false;
          onChange(next);
        }}
        step={step ?? "any"}
        type="number"
        value={String(value)}
      />
    </label>
  );
}

function VariableDefaultInput({
  definition,
  onChange,
}: {
  definition: VariableDefinition;
  onChange(value: ScalarValue): void;
}): ReactElement {
  if (definition.type === "boolean") {
    return (
      <select
        value={String(definition.default)}
        onChange={(event) => onChange(event.currentTarget.value === "true")}
      >
        <option value="true">是</option>
        <option value="false">否</option>
      </select>
    );
  }
  const defaultText = String(definition.default);
  if (definition.type === "integer") {
    return (
      <DeferredInput
        aria-label="整数默认值"
        inputMode="numeric"
        onCommit={(raw) => {
          if (!isCanonicalIntegerText(raw)) return false;
          onChange(BigInt(raw));
        }}
        type="text"
        value={defaultText}
      />
    );
  }
  return (
    <DeferredInput
      onCommit={(raw) => {
        if (definition.type !== "number") {
          onChange(raw);
          return;
        }
        const parsed = Number(raw);
        if (raw.trim() === "" || !Number.isFinite(parsed)) return false;
        if (parsed !== definition.default) onChange(parsed);
      }}
      step="any"
      type={definition.type === "number" ? "number" : "text"}
      value={defaultText}
    />
  );
}

function DeferredTextInput({
  maxLength,
  onCommit,
  placeholder,
  value,
}: {
  maxLength?: number;
  onCommit(value: string): void;
  placeholder?: string;
  value: string;
}): ReactElement {
  return (
    <DeferredInput
      maxLength={maxLength}
      onCommit={(raw) => onCommit(raw)}
      placeholder={placeholder}
      value={value}
    />
  );
}

function defaultForVariableType(type: VariableType): ScalarValue {
  switch (type) {
    case "boolean":
      return false;
    case "integer":
      return 0n;
    case "number":
      return 0;
    case "string":
      return "";
  }
}

function withoutKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([candidate]) => candidate !== key),
  );
}
