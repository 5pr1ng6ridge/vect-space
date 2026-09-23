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
  moveAssetToFolder,
  renameAssetFolder,
  setAssetDisplayName,
  setAssetHidden,
  validateFolderMove,
  type AssetFolderNode,
} from "../assetLibrary";
import { AssetChooser, useAssetLayout } from "./AssetChooser";
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
  SpriteActionDefinition,
  SpriteActionKeyframe,
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
  onSelectAsset?(id: string): void;
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
  onChangeAction(id: string, definition: SpriteActionDefinition): void;
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
  /** App-owned, save-independent sidebar scroll offsets keyed by tab. */
  scrollStore?: SidebarScrollStore;
  /** Records the live offset of whichever tab is scrolled. */
  onScrollOffset?(tab: SidebarTab, offset: number): void;
}

export type SidebarTab = "scenes" | "assets" | "project" | "problems";

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

/**
 * Accessible collapsible section for the project tab.  The title toggle is a
 * real button that owns `aria-expanded`/`aria-controls`; per-section action
 * buttons stay siblings of it so they keep working while collapsed, and the
 * body stays mounted (hidden) so its ids keep resolving.
 */
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
  onChangeAction,
  onRenameAction,
  onDuplicateAction,
  onDeleteAction,
  onEditActionKeyframes,
  onNavigate,
  onTabChange,
  onScrollOffset,
  sectionOpen,
  onToggleSection,
  scrollStore,
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
      <ProjectSearch
        onNavigate={onNavigate}
        onSelectAsset={onSelectAsset}
        project={project}
      />
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
          selectedAssetId={selectedAssetId}
          scrollStore={scrollStore}
        />
      )}
      {tab === "project" && (
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
          onChangeAction={onChangeAction}
          onRenameAction={onRenameAction}
          onDuplicateAction={onDuplicateAction}
          onDeleteAction={onDeleteAction}
          onEditActionKeyframes={onEditActionKeyframes}
          onScrollOffset={onScrollOffset}
          onToggleSection={onToggleSection}
          project={project}
          scrollStore={scrollStore}
          sectionOpen={sectionOpen}
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
          placeholder="搜索场景…"
          value={query}
        />
        <button
          aria-label="添加场景"
          onClick={() => {
            setDialog({ title: "新场景 ID", value: "new_scene", mode: "add" });
          }}
          type="button"
        >
          ＋
        </button>
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
                <span className="scene-icon">◇</span>
                <span>
                  <strong>{scene.id}</strong>
                  <small>{Object.keys(scene.nodes).length} 个节点</small>
                </span>
                {project.manifest.entry_scene === scene.id && <em>入口</em>}
                {issueCount > 0 && <b>{issueCount}</b>}
              </button>
              <div className="scene-row-actions">
                <button
                  aria-label="重命名场景"
                  onClick={() => {
                    setDialog({
                      title: "新的场景 ID",
                      value: scene.id,
                      mode: "rename",
                      previous: scene.id,
                    });
                  }}
                  type="button"
                >
                  ✎
                </button>
                <button
                  aria-label="删除场景"
                  onClick={() => onDeleteScene(scene.id)}
                  type="button"
                >
                  ×
                </button>
              </div>
            </article>
          );
        })}
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
          title={dialog.title}
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
  selectedAssetId,
  scrollStore,
}: {
  project: EditorProject;
  onImportAssets(items: ImportDraft[]): Promise<void>;
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
        folderId: folderFilter === "all" ? undefined : folderFilter,
        // The asset manager is manager mode: hidden assets stay visible so
        // they can be unhidden, renamed or edited.  The toggle only narrows
        // that list for authors who want to see the runtime-effective set.
        includeHidden: showHidden,
        selectedIds: selected === null ? [] : [selected],
      }),
    [assets, layout, kindFilter, query, folderFilter, showHidden, selected],
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
      (current) => moveAssetToFolder(current, assetId, folderId),
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
    if (payload.assetId !== undefined) moveAsset(payload.assetId, folderId);
    else if (payload.folderId !== undefined && payload.folderId !== folderId)
      moveFolder(payload.folderId, folderId);
  };
  const assetById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset])),
    [assets],
  );
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
          style={{ paddingLeft: `${node.depth * 14}px` }}
        >
          <button
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "展开" : "折叠"}文件夹 ${node.name}`}
            className="asset-folder-toggle"
            disabled={!hasChildren}
            onClick={() =>
              setCollapsedFolders((current) =>
                isCollapsed
                  ? current.filter((id) => id !== node.id)
                  : [...current, node.id],
              )
            }
            type="button"
          >
            {hasChildren ? (isCollapsed ? "▸" : "▾") : "·"}
          </button>
          <button
            className="asset-folder-name"
            draggable
            onClick={() => setFolderFilter(node.id)}
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
          <button
            aria-label={`重命名文件夹 ${node.name}`}
            className="asset-folder-action"
            onClick={() => {
              setFolderError(null);
              setFolderDialog({ mode: "rename", folderId: node.id });
            }}
            type="button"
          >
            ✎
          </button>
          <button
            aria-label={`在 ${node.name} 下新建子文件夹`}
            className="asset-folder-action"
            onClick={() => {
              setFolderError(null);
              setFolderDialog({ mode: "create", parentId: node.id });
            }}
            type="button"
          >
            ＋
          </button>
          <button
            aria-label={`移动文件夹 ${node.name}`}
            className="asset-folder-action"
            onClick={() => {
              setFolderError(null);
              setFolderMoveTarget(node.id);
            }}
            type="button"
          >
            ⇄
          </button>
        </div>
        {!isCollapsed && (
          <>
            {node.children.map(renderFolder)}
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
              {kind}
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
          <label className="asset-hidden-toggle">
            <input
              checked={showHidden}
              onChange={(event) => setShowHidden(event.currentTarget.checked)}
              type="checkbox"
            />
            显示已隐藏
          </label>
        </div>
        <div className="asset-folder-roots">
          <button
            className={folderFilter === "all" ? "active" : ""}
            onClick={() => setFolderFilter("all")}
            type="button"
          >
            全部素材
            <span className="asset-folder-count">{assets.length}</span>
          </button>
          <button
            aria-label="未分组（根目录）"
            className={folderFilter === null ? "active" : ""}
            onClick={() => setFolderFilter(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleDrop(event, null)}
            type="button"
          >
            未分组
          </button>
        </div>
        {folderTree.map(renderFolder)}
        {folderError !== null && (
          <p className="inline-error" role="alert">
            {folderError}
          </p>
        )}
      </div>
      <div
        className="asset-list"
        data-sidebar-scroller="assets"
        onScroll={onAssetListScroll}
        ref={assetListRef}
      >
        {assets.length === 0 && (
          <p className="muted">将文件拖到这里，或点击 ＋ 批量导入</p>
        )}
        {assets.length > 0 && shown.length === 0 && (
          <p className="muted">当前筛选没有素材。</p>
        )}
        {shown.map((option) => {
          const asset = assetById.get(option.id);
          const pending = pendingAssetIds.includes(option.id);
          return (
            <button
              className={selected === option.id ? "active" : ""}
              draggable
              key={option.id}
              onClick={() => setSelected(option.id)}
              onDragStart={(event) => {
                event.dataTransfer.setData(
                  "application/x-vect-asset",
                  option.id,
                );
                event.dataTransfer.effectAllowed = "move";
              }}
              type="button"
            >
              <span className={`asset-kind asset-kind-${option.kind}`}>
                {option.kind.slice(0, 2).toUpperCase()}
              </span>
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
                  {pending && (
                    <span className="asset-pending-badge">待保存</span>
                  )}
                </strong>
                <small>
                  {option.folderPath !== ""
                    ? `目录：${option.folderPath} · `
                    : ""}
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
        })}
      </div>
      {selectedAsset !== undefined && (
        <div className="asset-detail">
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
            <small>{animationSummary(selectedAsset, assets, animations)}</small>
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
              aria-pressed={selectedHidden}
              onClick={() =>
                commitLayout(
                  (current) =>
                    setAssetHidden(current, selectedAsset.id, !selectedHidden),
                  selectedHidden ? "取消隐藏素材" : "隐藏素材",
                )
              }
              type="button"
            >
              {selectedHidden ? "取消隐藏" : "隐藏素材"}
            </button>
            <button
              disabled={
                selectedAsset.animation !== undefined || inspecting || importing
              }
              onClick={() => void queueReplacement(selectedAsset)}
              title="导入一个同格式文件，保留逻辑 ID，新文件写入新路径，旧文件不会被覆盖或删除"
              type="button"
            >
              替换二进制文件…
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
            onClick={() => {
              if (window.confirm("从 manifest 移除此素材？磁盘文件会保留。")) {
                if (onRemoveAsset(selectedAsset.id)) setSelected(null);
              }
            }}
            type="button"
          >
            从清单移除
          </button>
        </div>
      )}
      {importQueue !== null && (
        <div
          className="asset-import-dialog"
          role="dialog"
          aria-label={
            importQueue.some((item) => item.replaceId !== undefined)
              ? "替换素材二进制"
              : "导入素材"
          }
        >
          <header>
            <strong>
              {importQueue.some((item) => item.replaceId !== undefined)
                ? `替换素材二进制 (${importQueue.length})`
                : `导入素材 (${importQueue.length})`}
            </strong>
            <button onClick={() => setImportQueue(null)} type="button">
              取消
            </button>
          </header>
          <p>
            确认逻辑 ID、类型和文件名后一次导入。保存项目才会写入 manifest。
          </p>
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
                          {kind}
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
                <button
                  aria-label={`移除 ${item.fileName}`}
                  onClick={() =>
                    setImportQueue(
                      (current) =>
                        current?.filter(
                          (_, candidate) => candidate !== index,
                        ) ?? null,
                    )
                  }
                  type="button"
                >
                  ×
                </button>
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
  folderId?: string;
} {
  const data = event.dataTransfer;
  if (data === null || data === undefined) return {};
  const assetId = data.getData("application/x-vect-asset");
  const folderId = data.getData("application/x-vect-folder");
  return {
    assetId: assetId === "" ? undefined : assetId,
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
}: {
  title: string;
  initialValue: string;
  onSubmit(value: string): boolean;
  onCancel(): void;
}): ReactElement {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setError("输入不能为空。");
      return;
    }
    const accepted = onSubmit(trimmed);
    if (!accepted) setError("输入未通过校验，请修正后重试。");
    else setError(null);
  };
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
          if (event.key === "Escape") {
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
          aria-label={title}
          ref={inputRef}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setError(null);
          }}
          value={value}
        />
        {error !== null && <p className="inline-error">{error}</p>}
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
  onChangeAction,
  onRenameAction,
  onDuplicateAction,
  onDeleteAction,
  onEditActionKeyframes,
  onScrollOffset,
  project,
  scrollStore,
  sectionOpen,
  onToggleSection,
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
  onChangeAction(id: string, definition: SpriteActionDefinition): void;
  onRenameAction(previousId: string, nextId: string): boolean;
  onDuplicateAction(id: string): void;
  onDeleteAction(id: string): void;
  onEditActionKeyframes(id: string): void;
  onScrollOffset?(tab: SidebarTab, offset: number): void;
  project: EditorProject;
  scrollStore?: SidebarScrollStore;
  sectionOpen?: Partial<Record<ProjectSectionId, boolean>>;
  onToggleSection?(id: ProjectSectionId): void;
}): ReactElement {
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
  return (
    <div
      className="sidebar-body project-settings"
      data-sidebar-scroller="project"
      onScroll={onSettingsScroll}
      ref={settingsRef}
    >
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
            onChange({ ...manifest, entry_scene: event.currentTarget.value })
          }
        >
          {project.scenes.map((file) => (
            <option key={file.definition.id} value={file.definition.id}>
              {file.definition.id}
            </option>
          ))}
        </select>
      </label>
      <CollapsibleSection
        actions={
          <button onClick={onCreateUiMotion} type="button">
            ＋
          </button>
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
        <div className="ui-motion-list">
          {project.ui_motions.map(({ definition, path }) => (
            <article className="variable-card" key={definition.id}>
              <header>
                <span>
                  <code>{definition.id}</code>
                  <small>{definition.duration_ms} ms</small>
                </span>
                <div>
                  <button
                    onClick={() => onEditUiMotion(definition.id)}
                    title="打开全屏关键帧编辑器"
                    type="button"
                  >
                    编辑
                  </button>
                  <button
                    className="danger-text"
                    onClick={() => onDeleteUiMotion(definition.id)}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              </header>
              <small>{path}</small>
            </article>
          ))}
          {project.ui_motions.length === 0 && (
            <small>还没有预设。创建后可在 UI 节点中复用。</small>
          )}
        </div>
      </CollapsibleSection>
      <CollapsibleSection
        actions={
          <button onClick={onCreateButtonTemplate} type="button">
            ＋
          </button>
        }
        className="button-template-settings"
        id="button-template"
        onToggle={() => toggleSection("button-template")}
        open={isSectionOpen("button-template")}
        title="按钮模板"
      >
        <p className="field-note">
          剧情节点可创建多个实例；模板被引用或贴图仍被使用时不能删除。
        </p>
        <div className="ui-motion-list">
          {(project.buttons ?? []).map(({ definition, path }) => {
            const references = findButtonTemplateReferences(
              project,
              definition.id,
            );
            return (
              <article className="variable-card" key={definition.id}>
                <header>
                  <span>
                    <code>{definition.id}</code>
                    <small>
                      {definition.width} × {definition.height} ·{" "}
                      {definition.asset_mode}
                    </small>
                  </span>
                  <div>
                    <button
                      onClick={() => onEditButtonTemplate(definition.id)}
                      title="打开按钮模板工作区"
                      type="button"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => onDuplicateButtonTemplate(definition.id)}
                      title="复制按钮模板"
                      type="button"
                    >
                      复制
                    </button>
                    <button
                      className="danger-text"
                      onClick={() => onDeleteButtonTemplate(definition.id)}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                </header>
                <small>{path}</small>
                <small>
                  {references.length === 0
                    ? "尚未被剧情引用"
                    : `引用 ${references.length} 处：${references
                        .slice(0, 3)
                        .join("、")}${references.length > 3 ? "…" : ""}`}
                </small>
                <div className="button-template-slots">
                  <span>正常：{definition.normal ?? "无"}</span>
                  <span>悬停：{definition.hover ?? "沿用/无"}</span>
                  <span>按下：{definition.pressed ?? "沿用/无"}</span>
                </div>
              </article>
            );
          })}
          {(project.buttons ?? []).length === 0 && (
            <small>还没有按钮模板。创建后可在按钮节点中复用。</small>
          )}
        </div>
      </CollapsibleSection>
      <CollapsibleSection
        actions={
          <button
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
            type="button"
          >
            ＋
          </button>
        }
        className="action-settings"
        id="sprite-action"
        onToggle={() => toggleSection("sprite-action")}
        open={isSectionOpen("sprite-action")}
        title="立绘动作库"
      >
        <p className="field-note">
          动作以当前立绘姿态为基准，位置/旋转为偏移，缩放/透明度为倍率。
        </p>
        <div className="ui-motion-list">
          {(project.actions ?? []).map(({ definition, path }) => (
            <ActionDefinitionEditor
              definition={definition}
              key={definition.id}
              onChange={(next) => onChangeAction(definition.id, next)}
              onEditKeyframes={() => onEditActionKeyframes(definition.id)}
              onRename={() =>
                setDialog({
                  title: "新的动作 ID",
                  value: definition.id,
                  kind: "action_rename",
                  previous: definition.id,
                })
              }
              onDuplicate={() => onDuplicateAction(definition.id)}
              onDelete={() => onDeleteAction(definition.id)}
              path={path}
            />
          ))}
          {(project.actions ?? []).length === 0 && (
            <small>还没有动作。创建后可在“立绘动作”节点中调用。</small>
          )}
        </div>
      </CollapsibleSection>
      <CollapsibleSection
        actions={
          <button
            onClick={() => {
              setDialog({
                title: "新角色 ID",
                value: "new_character",
                kind: "character_add",
              });
            }}
            type="button"
          >
            ＋
          </button>
        }
        className="character-settings"
        id="character"
        onToggle={() => toggleSection("character")}
        open={isSectionOpen("character")}
        title="角色"
      >
        {Object.entries(manifest.characters).map(([id, definition]) => (
          <article className="variable-card character-card" key={id}>
            <header>
              <code>{id}</code>
              <div>
                <button
                  onClick={() => {
                    setDialog({
                      title: "新的角色 ID",
                      value: id,
                      kind: "character_rename",
                      previous: id,
                    });
                  }}
                  type="button"
                >
                  ✎
                </button>
                <button
                  className="danger-text"
                  onClick={() => onDeleteCharacter(id)}
                  type="button"
                >
                  ×
                </button>
              </div>
            </header>
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
              <input
                min={0.01}
                onChange={(event) => {
                  const value = Number(event.currentTarget.value);
                  if (Number.isFinite(value) && value > 0)
                    onChangeCharacter(id, {
                      ...definition,
                      default_scale: value,
                    });
                }}
                step={0.05}
                type="number"
                value={definition.default_scale ?? 1}
              />
            </label>
            <div className="character-expression-list">
              <header>
                <span>表情图</span>
                <button
                  disabled={defaultExpressionSprite === null}
                  onClick={() => {
                    const expressions = { ...(definition.expressions ?? {}) };
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
                  title={
                    defaultExpressionSprite === null
                      ? "没有可用的立绘素材（或全部已隐藏）"
                      : undefined
                  }
                  type="button"
                >
                  ＋
                </button>
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
          </article>
        ))}
      </CollapsibleSection>
      <CollapsibleSection
        actions={
          <button
            onClick={() => {
              setDialog({
                title: "新变量 ID",
                value: "new_variable",
                kind: "variable_add",
              });
            }}
            type="button"
          >
            ＋
          </button>
        }
        id="variable"
        onToggle={() => toggleSection("variable")}
        open={isSectionOpen("variable")}
        title="剧情变量"
      >
        {Object.entries(manifest.variables).map(([id, definition]) => (
          <article className="variable-card" key={id}>
            <header>
              <code>{id}</code>
              <div>
                <button
                  onClick={() => {
                    setDialog({
                      title: "新的变量 ID",
                      value: id,
                      kind: "variable_rename",
                      previous: id,
                    });
                  }}
                  type="button"
                >
                  ✎
                </button>
                <button
                  className="danger-text"
                  onClick={() => onDeleteVariable(id)}
                  type="button"
                >
                  ×
                </button>
              </div>
            </header>
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
                <option value="save">save · 随存档</option>
                <option value="profile">profile · 跨存档</option>
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
                <option value="boolean">boolean</option>
                <option value="integer">integer</option>
                <option value="number">number</option>
                <option value="string">string</option>
              </select>
            </label>
            <label>
              <span>默认值</span>
              <VariableDefaultInput
                definition={definition}
                onChange={(defaultValue) =>
                  onChangeVariable(id, { ...definition, default: defaultValue })
                }
              />
            </label>
          </article>
        ))}
      </CollapsibleSection>
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
          title={dialog.title}
        />
      )}
    </div>
  );
}

const ACTION_CHANNELS: { id: string; label: string; defaultValue: number }[] = [
  { id: "x", label: "X 偏移", defaultValue: 0 },
  { id: "y", label: "Y 偏移", defaultValue: 0 },
  { id: "rotation_deg", label: "旋转偏移", defaultValue: 0 },
  { id: "scale", label: "整体缩放倍率", defaultValue: 1 },
  { id: "scale_x", label: "横向缩放倍率", defaultValue: 1 },
  { id: "scale_y", label: "纵向缩放倍率", defaultValue: 1 },
  { id: "opacity", label: "透明度倍率", defaultValue: 1 },
];

function ActionDefinitionEditor({
  definition,
  onRename,
  onDuplicate,
  onChange,
  onDelete,
  onEditKeyframes,
  path,
}: {
  definition: SpriteActionDefinition;
  onRename(): void;
  onDuplicate(): void;
  onChange(definition: SpriteActionDefinition): void;
  onDelete(): void;
  onEditKeyframes(): void;
  path: string;
}): ReactElement {
  const channels = definition.channels ?? {};
  const parameters = definition.parameters ?? {};
  const updateChannel = (
    channel: string,
    keyframes: SpriteActionKeyframe[],
  ): void => {
    const nextChannels = { ...channels };
    if (keyframes.length === 0) {
      onChange({
        ...definition,
        channels: withoutKey(channels, channel),
      });
      return;
    } else {
      nextChannels[channel] = [...keyframes].sort((a, b) => a.at_ms - b.at_ms);
    }
    onChange({ ...definition, channels: nextChannels });
  };
  return (
    <article
      className="variable-card action-card"
      onDoubleClick={onEditKeyframes}
      title="双击打开关键帧工作区"
    >
      <header>
        <span>
          <code>{definition.id}</code>
          <small>{definition.duration_ms} ms</small>
        </span>
        <div>
          <button
            onClick={onEditKeyframes}
            title="打开关键帧工作区"
            type="button"
          >
            关键帧
          </button>
          <button onClick={onRename} title="重命名动作" type="button">
            ✎
          </button>
          <button onClick={onDuplicate} title="复制动作" type="button">
            复制
          </button>
          <button className="danger-text" onClick={onDelete} type="button">
            ×
          </button>
        </div>
      </header>
      <small>{path}</small>
      <label>
        <span>动作名称</span>
        <DeferredTextInput
          maxLength={128}
          onCommit={(name) => onChange({ ...definition, name })}
          value={definition.name}
        />
      </label>
      <div className="field-grid">
        <label>
          <span>默认时长 ms</span>
          <ActionNumberInput
            min={1}
            onCommit={(duration_ms) => onChange({ ...definition, duration_ms })}
            value={definition.duration_ms}
          />
        </label>
        <label>
          <span>结束姿态</span>
          <select
            onChange={(event) =>
              onChange({
                ...definition,
                end: event.currentTarget.value as "hold" | "restore",
              })
            }
            value={definition.end ?? "hold"}
          >
            <option value="hold">保持最后一帧</option>
            <option value="restore">恢复动作前姿态</option>
          </select>
        </label>
      </div>
      <div className="action-channel-list">
        <div className="action-channel-toolbar">
          <strong>参数</strong>
          <button
            onClick={() => {
              let index = Object.keys(parameters).length + 1;
              let id = `amount_${index}`;
              while (parameters[id] !== undefined) {
                index += 1;
                id = `amount_${index}`;
              }
              onChange({
                ...definition,
                parameters: {
                  ...parameters,
                  [id]: { default: 1, min: -10, max: 10 },
                },
              });
            }}
            type="button"
          >
            ＋ 添加参数
          </button>
        </div>
        {Object.entries(parameters).map(([parameterId, parameter]) => (
          <div className="action-keyframe action-parameter" key={parameterId}>
            <code>{parameterId}</code>
            <ActionNumberInput
              ariaLabel={`${parameterId} 默认值`}
              onCommit={(value) =>
                onChange({
                  ...definition,
                  parameters: {
                    ...parameters,
                    [parameterId]: { ...parameter, default: value },
                  },
                })
              }
              value={parameter.default}
            />
            <ActionNumberInput
              ariaLabel={`${parameterId} 最小值`}
              onCommit={(value) =>
                onChange({
                  ...definition,
                  parameters: {
                    ...parameters,
                    [parameterId]: { ...parameter, min: value },
                  },
                })
              }
              value={parameter.min ?? -10}
            />
            <ActionNumberInput
              ariaLabel={`${parameterId} 最大值`}
              onCommit={(value) =>
                onChange({
                  ...definition,
                  parameters: {
                    ...parameters,
                    [parameterId]: { ...parameter, max: value },
                  },
                })
              }
              value={parameter.max ?? 10}
            />
            <button
              className="danger-text"
              onClick={() => {
                const next = withoutKey(parameters, parameterId);
                onChange({ ...definition, parameters: next });
              }}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
        <div className="action-channel-toolbar">
          <strong>变换通道</strong>
          <select
            aria-label="添加动作通道"
            defaultValue=""
            onChange={(event) => {
              const channel = event.currentTarget.value;
              event.currentTarget.value = "";
              if (!channel || channels[channel] !== undefined) return;
              const defaultValue =
                ACTION_CHANNELS.find((candidate) => candidate.id === channel)
                  ?.defaultValue ?? 0;
              updateChannel(channel, [
                { at_ms: 0, value: defaultValue, easing: "linear" },
                {
                  at_ms: definition.duration_ms,
                  value: defaultValue,
                  easing: "linear",
                },
              ]);
            }}
          >
            <option value="">＋ 添加通道</option>
            {ACTION_CHANNELS.filter(({ id }) => channels[id] === undefined).map(
              ({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ),
            )}
          </select>
        </div>
        {Object.entries(channels).map(([channel, keyframes]) => (
          <section className="action-channel" key={channel}>
            <header>
              <strong>
                {ACTION_CHANNELS.find((candidate) => candidate.id === channel)
                  ?.label ?? channel}
              </strong>
              <button
                className="danger-text"
                onClick={() => updateChannel(channel, [])}
                type="button"
              >
                删除通道
              </button>
            </header>
            {keyframes.map((keyframe, index) => (
              <div className="action-keyframe" key={`${channel}-${index}`}>
                <ActionNumberInput
                  ariaLabel="关键帧时间"
                  min={0}
                  max={definition.duration_ms}
                  onCommit={(at_ms) => {
                    const next = [...keyframes];
                    next[index] = { ...keyframe, at_ms };
                    updateChannel(channel, next);
                  }}
                  value={keyframe.at_ms}
                />
                <ActionNumberInput
                  ariaLabel="关键帧数值"
                  onCommit={(value) => {
                    const next = [...keyframes];
                    next[index] = { ...keyframe, value };
                    updateChannel(channel, next);
                  }}
                  value={keyframe.value}
                />
                <select
                  aria-label="关键帧缓动"
                  onChange={(event) => {
                    const next = [...keyframes];
                    next[index] = {
                      ...keyframe,
                      easing: event.currentTarget.value as
                        | "linear"
                        | "ease_in"
                        | "ease_out"
                        | "ease_in_out"
                        | "step",
                    };
                    updateChannel(channel, next);
                  }}
                  value={
                    typeof keyframe.easing === "string"
                      ? keyframe.easing
                      : "linear"
                  }
                >
                  <option value="linear">linear</option>
                  <option value="ease_in">ease in</option>
                  <option value="ease_out">ease out</option>
                  <option value="ease_in_out">ease in/out</option>
                  <option value="step">step</option>
                </select>
                <select
                  aria-label="关键帧参数"
                  onChange={(event) => {
                    const next = [...keyframes];
                    next[index] = {
                      ...keyframe,
                      parameter: event.currentTarget.value || undefined,
                    };
                    updateChannel(channel, next);
                  }}
                  value={keyframe.parameter ?? ""}
                >
                  <option value="">固定值</option>
                  {Object.keys(parameters).map((parameterId) => (
                    <option key={parameterId} value={parameterId}>
                      参数：{parameterId}
                    </option>
                  ))}
                </select>
                <button
                  className="danger-text"
                  disabled={keyframes.length <= 1}
                  onClick={() =>
                    updateChannel(
                      channel,
                      keyframes.filter((_, current) => current !== index),
                    )
                  }
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() =>
                updateChannel(channel, [
                  ...keyframes,
                  {
                    at_ms: definition.duration_ms,
                    value: keyframes.at(-1)?.value ?? 0,
                    easing: "linear",
                  },
                ])
              }
              type="button"
            >
              ＋ 关键帧
            </button>
          </section>
        ))}
      </div>
    </article>
  );
}

function ActionNumberInput({
  ariaLabel,
  max,
  min,
  onCommit,
  value,
}: {
  ariaLabel?: string;
  max?: number;
  min?: number;
  onCommit(value: number): void;
  value: number;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (): void => {
    const parsed = Number(inputRef.current?.value ?? value);
    if (!Number.isFinite(parsed)) {
      if (inputRef.current) inputRef.current.value = String(value);
      return;
    }
    const bounded = Math.min(max ?? parsed, Math.max(min ?? parsed, parsed));
    if (bounded !== value) onCommit(bounded);
  };
  return (
    <input
      aria-label={ariaLabel}
      defaultValue={String(value)}
      key={String(value)}
      max={max}
      min={min}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
      ref={inputRef}
      step="any"
      type="number"
    />
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
        <input
          aria-label={`${label}选择器`}
          onChange={(event) =>
            onChange(event.currentTarget.value.toUpperCase())
          }
          type="color"
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
        <button className="danger-text" onClick={onDelete} type="button">
          ×
        </button>
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
      <input
        max={max}
        min={min}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next)) onChange(next);
        }}
        step={step ?? "any"}
        type="number"
        value={value}
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
  const inputRef = useRef<HTMLInputElement>(null);
  if (definition.type === "boolean") {
    return (
      <select
        value={String(definition.default)}
        onChange={(event) => onChange(event.currentTarget.value === "true")}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  const numeric = definition.type === "integer" || definition.type === "number";
  const defaultText = String(definition.default);
  const commitInteger = (): void => {
    const text = inputRef.current?.value ?? defaultText;
    if (isCanonicalIntegerText(text)) onChange(BigInt(text));
    else if (inputRef.current !== null) inputRef.current.value = defaultText;
  };
  if (definition.type === "integer") {
    return (
      <input
        aria-label="整数默认值"
        inputMode="numeric"
        defaultValue={defaultText}
        key={defaultText}
        ref={inputRef}
        type="text"
        onBlur={commitInteger}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitInteger();
        }}
      />
    );
  }
  return (
    <input
      step="any"
      type={numeric ? "number" : "text"}
      defaultValue={defaultText}
      key={defaultText}
      ref={inputRef}
      onBlur={() => {
        const raw = inputRef.current?.value ?? defaultText;
        if (definition.type === "number") {
          const parsed = Number(raw);
          if (Number.isFinite(parsed) && parsed !== definition.default)
            onChange(parsed);
          else if (!Number.isFinite(parsed) && inputRef.current !== null)
            inputRef.current.value = defaultText;
        } else if (raw !== defaultText) {
          onChange(raw);
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const raw = inputRef.current?.value ?? defaultText;
        if (definition.type === "number") {
          const parsed = Number(raw);
          if (Number.isFinite(parsed) && parsed !== definition.default)
            onChange(parsed);
        } else if (raw !== defaultText) {
          onChange(raw);
        }
      }}
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
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (): void => {
    const draft = inputRef.current?.value ?? value;
    if (draft !== value) onCommit(draft);
  };
  return (
    <input
      defaultValue={value}
      key={value}
      maxLength={maxLength}
      ref={inputRef}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
      }}
      placeholder={placeholder}
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
