import { useState, type ReactElement } from "react";
import type { AnimationDraft } from "../imageAnimation";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import type { ProjectSectionId, SidebarScrollStore } from "./projectSections";
import type {
  CharacterDefinition,
  ContentManifest,
  EditorDiagnostic,
  EditorLayout,
  EditorProject,
  VariableDefinition,
  WindowRole,
} from "../types";
import type {
  ImportDraft,
  SidebarTab,
  VisualLibraryHandlers,
} from "./sidebar/types";
import { useSidebarScroller } from "./sidebar/useSidebarScroller";
import { ProjectSearch } from "./sidebar/ProjectSearch";
import { ScenesPanel } from "./sidebar/ScenesPanel";
import { AssetsPanel } from "./sidebar/AssetsPanel";
import { ProjectPanel } from "./sidebar/ProjectPanel";

export type {
  ImportDraft,
  ProjectPanelView,
  SidebarTab,
  VisualLibraryHandlers,
} from "./sidebar/types";

interface ProjectSidebarProps {
  project: EditorProject;
  activeTab?: SidebarTab;
  activeSceneId: string;
  diagnostics: EditorDiagnostic[];
  onSelectScene(sceneId: string): void;
  onAddScene(id: string, role?: WindowRole): boolean;
  onRenameScene(previousId: string, nextId: string): boolean;
  onDeleteScene(sceneId: string): void;
  /** Change which window a Scene is written for (main / secondary). */
  onSetSceneRole?(sceneId: string, role: WindowRole): void;
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
  /** Fixed text block / image particle libraries; omitted sections stay hidden. */
  visualLibrary?: VisualLibraryHandlers;
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
  /** `defaultOpen` is the state shown while the key has no saved choice. */
  onToggleSidebarItem?(key: string, defaultOpen?: boolean): void;
  /** App-owned, save-independent sidebar scroll offsets keyed by tab. */
  scrollStore?: SidebarScrollStore;
  /** The App shell renders its own activity bar; show only the panel. */
  hideTabs?: boolean;
  /** Records the live offset of whichever tab is scrolled. */
  onScrollOffset?(tab: SidebarTab, offset: number): void;
}

const PANEL_TITLES: Record<SidebarTab, string> = {
  scenes: "场景",
  assets: "素材库",
  characters: "角色",
  variables: "剧情变量",
  library: "资源库",
  project: "项目设置",
  problems: "问题",
};

export function ProjectSidebar({
  project,
  activeTab,
  activeSceneId,
  diagnostics,
  onSelectScene,
  onAddScene,
  onRenameScene,
  onDeleteScene,
  onSetSceneRole,
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
  visualLibrary,
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
          onSetSceneRole={onSetSceneRole}
          onToggleSidebarItem={onToggleSidebarItem}
          project={project}
          scrollStore={scrollStore}
          sidebarItemOpen={sidebarItemOpen}
          visualLibrary={visualLibrary}
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
          visualLibrary={visualLibrary}
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
