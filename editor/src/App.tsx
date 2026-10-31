import {
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from "react";
import { CommandError } from "../../shared/commandError";
import { editorApi } from "./api";
import { createLibraryActions } from "./app/libraryActions";
import {
  createNodeActions,
  type DeleteRequest,
  useNodeClipboard,
} from "./app/nodeActions";
import { DeleteNodesDialog, IdEntryDialog } from "./app/dialogs";
import { idUnavailableReason } from "./app/ids";
import { emptyChapterMapFile } from "./app/libraryCommands";
import { STORY_ROUTE, type EditorRoute } from "./app/routes";
import { useEditorHistory } from "./app/useEditorHistory";
import { useProjectSession } from "./app/useProjectSession";
import { WorkspaceRoute } from "./app/WorkspaceRoute";
import { AssetLayoutProvider } from "./components/AssetChooser";
import { NodeInspector } from "./components/NodeInspector";
import { createProjectSectionState } from "./components/projectSections";
import { ProjectSidebar, type SidebarTab } from "./components/ProjectSidebar";
import { ScriptView } from "./components/ScriptView";
import { StoryGraph } from "./components/StoryGraph";
import { editorReducer, INITIAL_EDITOR_STATE } from "./editorHistory";
import { projectAnimationMap } from "./imageAnimationMap";
import { ActivityBar } from "./shell/ActivityBar";
import { AppProviders } from "./shell/AppProviders";
import { PanelResizeHandle } from "./shell/PanelResizeHandle";
import { ProjectSearch } from "./shell/ProjectSearch";
import { loadRecentProjects } from "./shell/recentProjects";
import { StatusBar } from "./shell/StatusBar";
import { TopBar } from "./shell/TopBar";
import { usePanelLayout } from "./shell/usePanelLayout";
import { WelcomeScreen } from "./shell/WelcomeScreen";
import { findScene, nodeLabel, projectRequest } from "./story";
import type { EditorProject, SceneNode } from "./types";
import { useConfirm, useToast } from "./ui/feedbackContext";
import { validateLive } from "./validation";

/** The editor, with its app-wide feedback providers. */
export function App(): ReactElement {
  return (
    <AppProviders>
      <EditorApp />
    </AppProviders>
  );
}

function EditorApp(): ReactElement {
  const [editorState, dispatchEditor] = useReducer(
    editorReducer,
    INITIAL_EDITOR_STATE,
  );
  const { project, past, future, activeEdit } = editorState;
  const dirty = editorState.dirty || activeEdit !== null;
  const animationMap = useMemo(
    () => (project === null ? {} : projectAnimationMap(project)),
    [project],
  );
  const [activeSceneId, setActiveSceneId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [sceneViewMode, setSceneViewMode] = useState<"graph" | "script">(
    "graph",
  );
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("scenes");
  // Sidebar view state lives here because App survives the early-return
  // keyframe/full-screen workspaces that unmount ProjectSidebar, and because
  // collapse/scroll preferences are UI-only: they must never dirty content.
  const [sidebarSections, setSidebarSections] = useState(
    createProjectSectionState,
  );
  const [sidebarItemOpen, setSidebarItemOpen] = useState<
    Record<string, boolean>
  >({});
  const sidebarScrollRef = useRef<Partial<Record<SidebarTab, number>>>({});
  const handleSidebarScroll = useCallback(
    (tab: SidebarTab, offset: number): void => {
      sidebarScrollRef.current[tab] = offset;
    },
    [],
  );
  const [assetSelectionId, setAssetSelectionId] = useState<string | null>(null);
  const panels = usePanelLayout();
  const [route, setRoute] = useState<EditorRoute>(STORY_ROUTE);
  const [uiMotionDialog, setUiMotionDialog] = useState<string | null>(null);
  const [buttonDialog, setButtonDialog] = useState<string | null>(null);
  const [mapSelectionId, setMapSelectionId] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(
    null,
  );
  const nodeClipboard = useNodeClipboard();
  const toast = useToast();
  const confirm = useConfirm();
  // Before a project is open, errors belong on the welcome screen; after
  // that every message is a toast (errors stay until dismissed).
  const [welcomeError, setWelcomeError] = useState<string | null>(null);
  const setError = useCallback(
    (message: string | null): void => {
      if (message === null) {
        setWelcomeError(null);
        return;
      }
      const text = message.trim();
      if (project === null) setWelcomeError(text);
      else toast.show({ tone: "error", message: text });
    },
    [project, toast],
  );
  const setNotice = useCallback(
    (message: string | null): void => {
      if (message !== null) toast.show({ tone: "success", message });
    },
    [toast],
  );

  const history = useEditorHistory({ editorState, dispatchEditor, setError });
  const {
    busy,
    commit,
    getLatestProject,
    flushBeforeNavigation,
    flushEditorEdits,
    projectRef,
    redo,
    undo,
  } = history;

  const reportCommandError = useCallback(
    (reason: unknown): void => {
      if (reason instanceof CommandError) {
        if (reason.code === "validation") setSidebarTab("problems");
        if (reason.location !== undefined) {
          setActiveSceneId(reason.location.scene_id);
          setSelectedNodeId(reason.location.node_id);
        }
        if (reason.code === "stale_project") {
          setError(
            "项目文件已被外部修改，请重新打开后再保存。\n" + reason.message,
          );
        } else {
          setError(reason.message);
        }
        return;
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    },
    [setError],
  );

  const showProblems = useCallback((): void => setSidebarTab("problems"), []);
  const session = useProjectSession({
    project,
    history,
    dispatchEditor,
    dirty,
    setError,
    setNotice,
    reportCommandError,
    onProjectLoaded: (loaded) => {
      setActiveSceneId(
        loaded.manifest.entry_scene || loaded.scenes[0]?.definition.id || "",
      );
      setAssetSelectionId(null);
      setSelectedNodeId(null);
      setRoute(STORY_ROUTE);
      setButtonDialog(null);
      setMapSelectionId(null);
    },
    onSaveBlocked: showProblems,
  });
  const { activeImportTokens, saveProject } = session;

  const diagnostics = useMemo(
    () => (project === null ? [] : validateLive(project)),
    [project],
  );
  const activeSceneFile =
    project === null ? undefined : findScene(project, activeSceneId);
  const activeScene = activeSceneFile?.definition;
  // Saved preview-path decisions feed the Rust-backed Choice inspector
  // preview, exactly like the long-text and timeline workspaces.
  const choicePreviewSettings = useMemo(() => {
    const key = `${activeSceneId}/${selectedNodeId ?? ""}`;
    return (
      project?.layout.timeline_previews?.[key] ?? {
        variable_overrides: {},
        choices: [],
      }
    );
  }, [activeSceneId, project, selectedNodeId]);

  const updateNodeEdit = useCallback(
    (editId: string, nodeId: string, node: SceneNode): void => {
      history.updateEdit(editId, (draft) => {
        const file = findScene(draft, activeSceneId);
        if (file !== undefined) file.definition.nodes[nodeId] = node;
      });
    },
    [activeSceneId, history],
  );

  if (project === null) {
    return (
      <WelcomeScreen
        busy={busy}
        error={welcomeError}
        onOpen={(root) => void session.openProject(root)}
        recent={loadRecentProjects()}
      />
    );
  }

  const actionContext = {
    project,
    latestProject: (): EditorProject => getLatestProject() ?? project,
    activeSceneId,
    route,
    commit,
    commitUndoable: history.commitUndoable,
    setError,
    setNotice,
    reportCommandError,
    setActiveSceneId,
    setSelectedNodeId,
    setRoute,
  };
  const nodes = createNodeActions({
    ...actionContext,
    activeScene,
    activeImportTokens,
    clipboard: nodeClipboard,
    setDeleteRequest,
  });
  const library = createLibraryActions({ ...actionContext, confirm });

  const openChapterMapWorkspace = (selectionId: string | null = null): void => {
    if (!flushBeforeNavigation()) return;
    const currentProject = projectRef.current;
    if (currentProject === null) return;
    if (
      currentProject.chapter_map === null ||
      currentProject.chapter_map === undefined
    ) {
      createEmptyChapterMap();
    }
    setMapSelectionId(selectionId);
    setRoute({ kind: "map" });
  };

  const createEmptyChapterMap = (): void => {
    const currentProject = projectRef.current;
    if (currentProject === null) return;
    const file = emptyChapterMapFile(currentProject.manifest.entry_scene);
    commit(
      (draft) => {
        draft.manifest.chapter_map = file.path;
        draft.chapter_map = file;
      },
      true,
      "创建章节地图",
    );
  };

  const navigate = (
    sceneId: string | null,
    nodeId: string | null,
    workspace?: "story" | "map",
    flowElementId?: string | null,
  ): void => {
    if (!flushBeforeNavigation()) return;
    const currentProject = projectRef.current;
    if (currentProject === null) return;
    if (workspace === "map") {
      openChapterMapWorkspace(flowElementId ?? null);
      return;
    }
    if (sceneId !== null && findScene(currentProject, sceneId) !== undefined) {
      setActiveSceneId(sceneId);
      setSidebarTab("scenes");
    }
    setSelectedNodeId(nodeId);
  };

  const openCreateUiMotion = (): void => {
    if (!flushBeforeNavigation()) return;
    setUiMotionDialog("ui.dialogue.motion");
  };

  const openCreateButton = (): void => {
    if (!flushBeforeNavigation()) return;
    setButtonDialog("button.default");
  };

  const errorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
  const openPreviewFromSelection = (): void => {
    if (!flushBeforeNavigation()) return;
    setRoute({
      kind: "preview",
      sceneId: activeSceneId,
      nodeId: selectedNodeId,
    });
  };
  const validate = (blockedMessage: string, success: string): void => {
    if (!flushEditorEdits()) {
      setError(blockedMessage);
      return;
    }
    const current = projectRef.current;
    if (current === null) return;
    void editorApi
      .validateProject(projectRequest(current, activeImportTokens))
      .then(() => setNotice(success))
      .catch((reason: unknown) => reportCommandError(reason));
  };
  const validateWholeProject = (): void =>
    validate(
      "存在未提交或无效的输入，请修正后再校验。",
      "项目已通过完整校验。",
    );

  const {
    leftPanelVisible,
    rightPanelVisible,
    setLeftPanelVisible,
    setRightPanelVisible,
    panelSizes,
  } = panels;
  const deleteDisabled =
    deleteRequest !== null || uiMotionDialog !== null || buttonDialog !== null;

  const storyShell = (
    <main
      className={`app-shell${leftPanelVisible ? "" : " left-hidden"}${rightPanelVisible ? "" : " right-hidden"}`}
      style={
        {
          "--left-panel-width": `${panelSizes.left}px`,
          "--right-panel-width": `${panelSizes.right}px`,
        } as CSSProperties
      }
    >
      <TopBar
        busy={busy}
        canRedo={future.length > 0}
        canUndo={past.length > 0}
        dirty={dirty}
        entrySceneId={project.manifest.entry_scene}
        leftPanelVisible={leftPanelVisible}
        onOpenMap={() => openChapterMapWorkspace()}
        onOpenProject={() => void session.openProject()}
        onOpenSettings={() => {
          setLeftPanelVisible(true);
          setSidebarTab("project");
        }}
        onPreview={openPreviewFromSelection}
        onRedo={redo}
        onSave={() => void saveProject()}
        onSelectScene={(sceneId) => {
          if (!flushBeforeNavigation()) return;
          setActiveSceneId(sceneId);
          setSelectedNodeId(null);
        }}
        onToggleLeftPanel={() => setLeftPanelVisible((visible) => !visible)}
        onToggleRightPanel={() => setRightPanelVisible((visible) => !visible)}
        onUndo={undo}
        onValidate={validateWholeProject}
        projectName={project.root.split(/[\\/]/).at(-1) ?? project.root}
        rightPanelVisible={rightPanelVisible}
        saving={session.saving}
        search={
          <ProjectSearch
            onNavigate={navigate}
            onSelectAsset={(id) => {
              setAssetSelectionId(id);
              setSidebarTab("assets");
              setLeftPanelVisible(true);
            }}
            project={project}
          />
        }
        sceneId={activeSceneId}
        sceneIds={project.scenes.map((file) => file.definition.id)}
      />
      <ActivityBar
        activeTab={sidebarTab}
        errorCount={errorCount}
        onSelect={(tab) => {
          if (leftPanelVisible && tab === sidebarTab) {
            setLeftPanelVisible(false);
            return;
          }
          setSidebarTab(tab);
          setLeftPanelVisible(true);
        }}
        panelVisible={leftPanelVisible}
        problemCount={diagnostics.length}
      />

      <div className="left-panels">
        <ProjectSidebar
          hideTabs
          selectedAssetId={assetSelectionId}
          activeTab={sidebarTab}
          activeSceneId={activeSceneId}
          diagnostics={diagnostics}
          onAddScene={library.addScene}
          onDeleteScene={library.deleteScene}
          onSetSceneRole={library.setSceneRole}
          onImportAssets={session.importAssets}
          pendingAssetIds={session.pendingAssetIds}
          reservedAssetPaths={session.reservedReplacementPaths}
          onChangeAssetLayout={library.changeAssetLayout}
          onManifestChange={library.changeManifest}
          onRemoveAsset={library.removeAsset}
          onCreateImageAnimation={library.createImageAnimation}
          onSelectAsset={(id) => {
            setAssetSelectionId(id);
            if (id !== null) setSidebarTab("assets");
          }}
          onAddVariable={library.addVariable}
          onChangeVariable={library.changeVariable}
          onDeleteVariable={library.deleteVariable}
          onRenameScene={library.renameScene}
          onRenameVariable={library.renameVariable}
          onAddCharacter={library.addCharacter}
          onChangeCharacter={library.changeCharacter}
          onDeleteCharacter={library.deleteCharacter}
          onRenameCharacter={library.renameCharacter}
          onCreateUiMotion={openCreateUiMotion}
          onEditUiMotion={(motionId) => {
            if (!flushBeforeNavigation()) return;
            setRoute({ kind: "uiMotion", id: motionId });
          }}
          onDeleteUiMotion={library.deleteUiMotion}
          onCreateButtonTemplate={openCreateButton}
          onEditButtonTemplate={(buttonId) => {
            if (!flushBeforeNavigation()) return;
            setRoute({ kind: "button", id: buttonId });
          }}
          onDuplicateButtonTemplate={library.duplicateButtonTemplate}
          onDeleteButtonTemplate={library.deleteButtonTemplate}
          onCreateAction={(id) => {
            if (!flushBeforeNavigation()) return false;
            return library.createSpriteAction(id);
          }}
          onRenameAction={library.renameAction}
          onDuplicateAction={library.duplicateSpriteAction}
          onDeleteAction={library.deleteSpriteAction}
          onEditActionKeyframes={(id) => {
            if (!flushBeforeNavigation()) return;
            setRoute({ kind: "action", id });
          }}
          visualLibrary={{
            onCreate: (kind, id, sceneId) =>
              flushBeforeNavigation() &&
              library.createVisual(kind, id, sceneId),
            onRename: library.renameVisual,
            onDuplicate: library.duplicateVisual,
            onDelete: library.deleteVisual,
            onEdit: (kind, id, sceneId) => {
              if (!flushBeforeNavigation()) return;
              setRoute({
                kind: "visual",
                visual: kind,
                id,
                ...(sceneId === undefined ? {} : { sceneId }),
              });
            },
          }}
          onSelectScene={(sceneId) => {
            if (!flushBeforeNavigation()) return;
            setActiveSceneId(sceneId);
            setSelectedNodeId(null);
          }}
          onNavigate={navigate}
          onScrollOffset={handleSidebarScroll}
          onTabChange={setSidebarTab}
          onToggleSection={(sectionId) =>
            setSidebarSections((current) => ({
              ...current,
              [sectionId]: !current[sectionId],
            }))
          }
          sidebarItemOpen={sidebarItemOpen}
          onToggleSidebarItem={(key, defaultOpen = true) =>
            setSidebarItemOpen((current) => ({
              ...current,
              [key]: !(current[key] ?? defaultOpen),
            }))
          }
          project={project}
          scrollStore={sidebarScrollRef}
          sectionOpen={sidebarSections}
        />
        <aside
          aria-label="素材详情栏"
          className="asset-detail-column"
          id="asset-detail-column"
        />
      </div>
      <PanelResizeHandle
        axis="left"
        collapsed={!leftPanelVisible}
        onExpand={panels.expandPanel}
        onStart={panels.startResize}
        onStep={panels.resizeBy}
        size={panelSizes.left}
      />

      <section className="workspace">
        <div className="workspace-header">
          <div aria-label="场景视图" className="segmented" role="group">
            {(
              [
                ["graph", "剧情图"],
                ["script", "脚本"],
              ] as const
            ).map(([mode, label]) => (
              <button
                aria-pressed={sceneViewMode === mode}
                className={sceneViewMode === mode ? "is-active" : ""}
                key={mode}
                onClick={() => {
                  if (!flushBeforeNavigation()) return;
                  setSceneViewMode(mode);
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
          <span className="workspace-header-hint">
            {sceneViewMode === "graph"
              ? "Ctrl/⌘ 或 Shift 点击多选 · Ctrl+C/V 批量复制粘贴 · Ctrl+L 组合/解散（也可点工具栏或右键）· Ctrl+Enter 预览"
              : "Enter 插入下一句 · Shift+Enter 换行 · Ctrl/⌘ 点击多选"}
          </span>
        </div>
        {activeScene !== undefined && sceneViewMode === "graph" ? (
          <StoryGraph
            deleteDisabled={deleteDisabled}
            diagnostics={diagnostics}
            layout={project.layout.scenes[activeSceneId]}
            manifest={project.manifest}
            proofs={project.proofs}
            onAddNode={nodes.addNode}
            onDuplicate={nodes.duplicateNode}
            onDuplicateSelection={nodes.duplicateGraphSelection}
            onCopySelection={nodes.copyGraphSelection}
            onEditNode={(nodeId) => {
              setSelectedNodeId(nodeId);
              setRightPanelVisible(true);
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLElement>(
                    ".inspector .node-fields :is(input, textarea, select)",
                  )
                  ?.focus(),
              );
            }}
            onSetEntry={nodes.setEntry}
            onCopy={nodes.copyNode}
            onDelete={nodes.deleteNode}
            onConnect={nodes.connectPort}
            onMoveMany={nodes.moveNodes}
            onSetGroups={nodes.setGroups}
            onMoveNode={nodes.moveNode}
            onPaste={nodes.pasteNode}
            onQuickInsert={nodes.quickInsertNode}
            onPreview={(nodeId) => {
              // Ordinary nodes: double-click flushes pending edits and opens
              // the live preview starting from the clicked node.  timeline /
              // long_text still use `onOpen` for their workspace.
              if (!flushBeforeNavigation()) return;
              setRoute({
                kind: "preview",
                sceneId: activeSceneId,
                nodeId,
                autoStart: "node",
              });
            }}
            onOpen={(nodeId) => {
              if (!flushBeforeNavigation()) return;
              const currentProject = projectRef.current;
              const currentScene =
                currentProject === null
                  ? undefined
                  : findScene(currentProject, activeSceneId)?.definition;
              const node = currentScene?.nodes[nodeId];
              if (currentScene === undefined) return;
              if (node?.type === "timeline") {
                setRoute({
                  kind: "timeline",
                  sceneId: activeSceneId,
                  nodeId,
                });
              } else if (node?.type === "long_text") {
                setRoute({
                  kind: "longText",
                  sceneId: activeSceneId,
                  nodeId,
                });
              }
            }}
            onSelect={setSelectedNodeId}
            onViewport={nodes.setViewport}
            scene={activeScene}
            selectedNodeId={selectedNodeId}
          />
        ) : activeScene !== undefined ? (
          <ScriptView
            deleteDisabled={deleteDisabled}
            manifest={project.manifest}
            onChange={nodes.changeNode}
            onDelete={nodes.deleteNode}
            onDeleteMany={nodes.deleteNodes}
            onBatchSpeaker={nodes.batchChangeSpeaker}
            onCommitAndInsertAfter={nodes.insertSayAfterWithText}
            onBeginEdit={history.beginEdit}
            onSetEditDraft={history.setEditDraft}
            onSetEditError={history.setEditError}
            onUpdateNode={updateNodeEdit}
            onEditText={(nodeId, text) => {
              const editId = `say:${activeSceneId}:${nodeId}`;
              history.updateEdit(editId, (draft) => {
                const file = findScene(draft, activeSceneId);
                const node = file?.definition.nodes[nodeId];
                if (node?.type === "say") node.text = text;
              });
              history.setEditDraft(editId, "text", text, false);
            }}
            onCommitEdit={history.commitEdit}
            onCancelEdit={history.cancelEdit}
            activeEdit={activeEdit}
            onInsertAfter={nodes.insertSayAfter}
            onInsertBatch={nodes.insertSayBatch}
            onOpenGraph={(nodeId) => {
              if (!flushBeforeNavigation()) return;
              setSelectedNodeId(nodeId);
              setSceneViewMode("graph");
            }}
            onNavigateToNode={(targetScene, nodeId) => {
              if (!flushBeforeNavigation()) return;
              if (
                targetScene !== null &&
                targetScene.length > 0 &&
                targetScene !== activeSceneId &&
                findScene(projectRef.current ?? project, targetScene) !==
                  undefined
              ) {
                setActiveSceneId(targetScene);
                setSceneViewMode("script");
              }
              setSelectedNodeId(nodeId);
            }}
            onSelect={setSelectedNodeId}
            scene={activeScene}
            selectedNodeId={selectedNodeId}
          />
        ) : (
          <div className="empty-state">没有可编辑的场景</div>
        )}
      </section>

      {activeScene !== undefined && (
        <NodeInspector
          key={`${activeSceneId}:${selectedNodeId ?? ""}`}
          manifest={project.manifest}
          nodeId={selectedNodeId}
          onChange={nodes.changeNode}
          onDelete={nodes.deleteNode}
          onDuplicate={nodes.duplicateNode}
          onConvertToTimeline={nodes.convertNodeToTimeline}
          onConvertActionToTimeline={nodes.convertActionNodeToTimeline}
          onSplitDialogue={nodes.splitDialogue}
          onSplitLongText={nodes.splitLongText}
          onOpenLongTextWorkspace={(nodeId) => {
            if (!flushBeforeNavigation()) return;
            setRoute({ kind: "longText", sceneId: activeSceneId, nodeId });
          }}
          onError={setError}
          buttons={project.buttons ?? []}
          animations={project.animations ?? []}
          actions={project.actions ?? []}
          assets={project.assets}
          scenes={project.scenes.map((file) => file.definition)}
          uiMotions={project.ui_motions}
          previewProject={project}
          previewAnimationMap={animationMap}
          previewImportTokens={activeImportTokens}
          previewVariableOverrides={choicePreviewSettings.variable_overrides}
          previewChoices={choicePreviewSettings.choices}
          onLocateNode={(nodeId) => {
            if (!flushBeforeNavigation()) return;
            setSelectedNodeId(nodeId);
          }}
          onRename={nodes.renameSelectedNode}
          onSetEntry={nodes.setEntry}
          scene={activeScene}
        />
      )}
      <PanelResizeHandle
        axis="right"
        collapsed={!rightPanelVisible}
        onExpand={panels.expandPanel}
        onStart={panels.startResize}
        onStep={panels.resizeBy}
        size={panelSizes.right}
      />
      <StatusBar
        errorCount={errorCount}
        onShowProblems={() => {
          setLeftPanelVisible(true);
          setSidebarTab("problems");
        }}
        sceneNodeCount={Object.keys(activeScene?.nodes ?? {}).length}
        selection={
          selectedNodeId !== null && activeScene?.nodes[selectedNodeId]
            ? `${nodeLabel(activeScene.nodes[selectedNodeId].type)} · ${selectedNodeId}`
            : "未选择节点"
        }
        warningCount={diagnostics.length - errorCount}
      />
    </main>
  );

  // Exactly one route renders; the whole App shares one asset-layout
  // provider, one toast layer and one dialog layer.
  return (
    <AssetLayoutProvider layout={project.layout}>
      <WorkspaceRoute
        activeEdit={activeEdit}
        activeSceneId={activeSceneId}
        animationMap={animationMap}
        canRedo={future.length > 0}
        canUndo={past.length > 0}
        changeNode={nodes.changeNode}
        dirty={dirty}
        history={history}
        importTokens={activeImportTokens}
        mapSelectionId={mapSelectionId}
        project={project}
        route={route}
        save={() => void saveProject()}
        setActiveSceneId={setActiveSceneId}
        setError={setError}
        setMapSelectionId={setMapSelectionId}
        setRoute={setRoute}
        setSelectedNodeId={setSelectedNodeId}
        splitLongText={nodes.splitLongText}
        validate={validate}
      >
        {storyShell}
      </WorkspaceRoute>
      {uiMotionDialog !== null && (
        <IdEntryDialog
          dialogLabel="创建 UI 动效"
          fieldLabel="UI 动效 ID"
          initialValue={uiMotionDialog}
          onCancel={() => setUiMotionDialog(null)}
          onSubmit={(value) => {
            if (library.createUiMotion(value)) setUiMotionDialog(null);
          }}
          title="新 UI 动效"
          validate={(value) => idUnavailableReason("uiMotion", value, project)}
        />
      )}
      {buttonDialog !== null && (
        <IdEntryDialog
          dialogLabel="创建按钮模板"
          fieldLabel="按钮模板 ID"
          initialValue={buttonDialog}
          onCancel={() => setButtonDialog(null)}
          onSubmit={(value) => {
            if (library.createButtonTemplate(value)) setButtonDialog(null);
          }}
          title="新按钮模板"
          validate={(value) => idUnavailableReason("button", value, project)}
        />
      )}
      {deleteRequest !== null && (
        <DeleteNodesDialog
          nodeIds={deleteRequest.nodeIds}
          onCancel={() => setDeleteRequest(null)}
          onConfirm={(fallback) =>
            nodes.executeDeleteNodes(deleteRequest.nodeIds, fallback)
          }
          options={deleteRequest.options}
        />
      )}
    </AssetLayoutProvider>
  );
}
