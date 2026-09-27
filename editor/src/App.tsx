import { original } from "immer";
import { flushSync } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  lazy,
  useMemo,
  useRef,
  useReducer,
  useState,
  Suspense,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { editorApi } from "./api";
import { CommandError } from "../../shared/commandError";
import { NodeInspector } from "./components/NodeInspector";
import {
  findAssetReferences,
  findButtonTemplateReferences,
} from "./components/assetReferences";
import {
  animationDefinition,
  animationFilePath,
  type AnimationDraft,
} from "./imageAnimation";
import { projectAnimationMap } from "./imageAnimationMap";
import { expandSpriteActionNode } from "./timeline";
import {
  activeImportTokens as collectActiveImportTokens,
  activePendingAssetIds as collectActivePendingAssetIds,
  applyStagedAsset,
  registerPendingImports,
  type PendingAssetImport,
} from "./assetLibrary";
import { createProjectSectionState } from "./components/projectSections";
import { AssetLayoutProvider } from "./components/AssetChooser";
import {
  ProjectSidebar,
  type ImportDraft,
  type SidebarTab,
} from "./components/ProjectSidebar";
import { StoryGraph } from "./components/StoryGraph";
import { ScriptView } from "./components/ScriptView";
import {
  convertToTimeline as convertQuickNodeToTimeline,
  countCharacterReferences,
  countVariableReferences,
  defaultNode,
  ensureSceneLayout,
  findScene,
  insertNode,
  newSceneFile,
  nodeLabel,
  preparePastedNode,
  projectRequest,
  renameCharacter,
  renameNode,
  renameSpriteAction,
  renameScene,
  renameVariable,
  rewriteLongTextDocumentReferences,
  setPortTarget,
  splitDialogueAt,
  splitLongTextAt,
  uniqueNodeId,
} from "./story";
import type {
  ContentManifest,
  EditorProject,
  NodePosition,
  NodeType,
  SceneNode,
  SpriteSnapshot,
} from "./types";
import { validateLive } from "./validation";
import { ActivityBar } from "./shell/ActivityBar";
import { StatusBar } from "./shell/StatusBar";
import { TopBar } from "./shell/TopBar";
import { WelcomeScreen } from "./shell/WelcomeScreen";
import {
  loadRecentProjects,
  rememberRecentProject,
} from "./shell/recentProjects";
import { AppProviders } from "./shell/AppProviders";
import { useConfirm, useToast } from "./ui/feedbackContext";
import { ProjectSearch } from "./shell/ProjectSearch";
import { DeleteNodesDialog, IdEntryDialog } from "./app/dialogs";
import { idFormatError, idUnavailableReason } from "./app/ids";
import {
  addButtonTemplate,
  addSpriteAction,
  addUiMotion,
  duplicateButtonFile,
  duplicateSpriteActionFile,
  emptyChapterMapFile,
  formatReferenceList,
  newButtonFile,
  newSpriteActionFile,
  newUiMotionFile,
  removeAssetRegistration,
  removeButtonTemplate,
  removeScene,
  removeSpriteAction,
  removeUiMotion,
  spriteActionReferences,
  uiMotionReferenceCount,
} from "./app/libraryCommands";
import {
  deleteNodes as deleteNodesMutation,
  planChainDeletion,
  planNodeDeletion,
} from "./app/nodeCommands";
import {
  routeShowsNode,
  routeShowsScene,
  STORY_ROUTE,
  type EditorRoute,
} from "./app/routes";
import { isComposing, isTextEntryTarget } from "./ui/keyboard";
import { flushPendingCommits } from "./ui/pendingCommits";
import {
  editorReducer,
  INITIAL_EDITOR_STATE,
  type EditorMutation,
} from "./editorHistory";

type ResizeAxis = "left" | "right";

function currentPlainProject(draft: EditorProject): EditorProject {
  // Rename helpers intentionally return a complete project.  When they are
  // used from an Immer recipe, unwrap the proxy first so their defensive
  // structuredClone remains safe.  Immer's `original` is the state at the
  // start of this recipe; callers that need to include a just-made mutation
  // must apply that mutation to the unwrapped clone explicitly.
  return original(draft) ?? draft;
}

const ChapterMapWorkspace = lazy(() =>
  import("./components/ChapterMapWorkspace").then((module) => ({
    default: module.ChapterMapWorkspace,
  })),
);
const TimelineWorkspace = lazy(() =>
  import("./components/TimelineWorkspace").then((module) => ({
    default: module.TimelineWorkspace,
  })),
);
const LongTextWorkspace = lazy(() =>
  import("./components/LongTextWorkspace").then((module) => ({
    default: module.LongTextWorkspace,
  })),
);
const UiMotionWorkspace = lazy(() =>
  import("./components/UiMotionWorkspace").then((module) => ({
    default: module.UiMotionWorkspace,
  })),
);
const ButtonWorkspace = lazy(() =>
  import("./components/ButtonWorkspace").then((module) => ({
    default: module.ButtonWorkspace,
  })),
);
const ActionWorkspace = lazy(() =>
  import("./components/ActionWorkspace").then((module) => ({
    default: module.ActionWorkspace,
  })),
);

const GameplayPreview = lazy(() =>
  import("./components/GameplayPreview").then((module) => ({
    default: module.GameplayPreview,
  })),
);

function WorkspaceFallback(): ReactElement {
  return <main className="workspace-loading">正在载入工作区…</main>;
}

interface PanelSizes {
  left: number;
  right: number;
}

interface ResizeState {
  axis: ResizeAxis;
  startX: number;
  startY: number;
  initial: number;
}

interface NodeClipboard {
  node: SceneNode;
  sourceNodeId: string;
  sourceCharacterId: string | null;
}

const DEFAULT_PANEL_SIZES: PanelSizes = {
  left: 280,
  right: 340,
};

const PANEL_SIZES_KEY = "vectspace-editor:panel-sizes";

/** Panel widths are a per-machine preference, never part of the project. */
function loadPanelSizes(): PanelSizes {
  try {
    const stored = JSON.parse(
      localStorage.getItem(PANEL_SIZES_KEY) ?? "null",
    ) as Partial<PanelSizes> | null;
    return {
      left: clampPanelSize("left", stored?.left ?? DEFAULT_PANEL_SIZES.left),
      right: clampPanelSize(
        "right",
        stored?.right ?? DEFAULT_PANEL_SIZES.right,
      ),
    };
  } catch {
    return DEFAULT_PANEL_SIZES;
  }
}

function clampPanelSize(axis: ResizeAxis, value: number): number {
  const bounds: Record<ResizeAxis, [number, number]> = {
    left: [220, 480],
    right: [300, 560],
  };
  const [minimum, maximum] = bounds[axis];
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

function ResizeHandle({
  axis,
  onStart,
  onStep,
}: {
  axis: ResizeAxis;
  onStart(axis: ResizeAxis, startX: number, startY: number): void;
  onStep(axis: ResizeAxis, delta: number): void;
}): ReactElement {
  const label = axis === "left" ? "调整左侧栏宽度" : "调整右侧栏宽度";
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 32 : 12;
    let delta: number | null = null;
    if (axis === "left") {
      if (event.key === "ArrowRight") delta = step;
      if (event.key === "ArrowLeft") delta = -step;
    } else {
      if (event.key === "ArrowLeft") delta = step;
      if (event.key === "ArrowRight") delta = -step;
    }
    if (delta === null) return;
    event.preventDefault();
    onStep(axis, delta);
  };

  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      className={`resize-handle resize-handle-${axis}`}
      onKeyDown={handleKeyDown}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        onStart(axis, event.clientX, event.clientY);
      }}
      role="separator"
      tabIndex={0}
    />
  );
}

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
  const [leftPanelVisible, setLeftPanelVisible] = useState(true);
  const [rightPanelVisible, setRightPanelVisible] = useState(true);
  const [route, setRoute] = useState<EditorRoute>(STORY_ROUTE);
  // Legacy per-workspace names, derived from the single route.
  const timelineTarget = route.kind === "timeline" ? route : null;
  const longTextTarget = route.kind === "longText" ? route : null;
  const gameplayTarget = route.kind === "preview" ? route : null;
  const uiMotionTarget = route.kind === "uiMotion" ? route.id : null;
  const actionTarget = route.kind === "action" ? route.id : null;
  const buttonTarget = route.kind === "button" ? route.id : null;
  const mapWorkspace = route.kind === "map";
  const [uiMotionDialog, setUiMotionDialog] = useState<string | null>(null);
  const [buttonDialog, setButtonDialog] = useState<string | null>(null);
  const [mapSelectionId, setMapSelectionId] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<{
    nodeIds: string[];
    options: { id: string; label: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // Keep a synchronous lock alongside React state.  Pointer/text callbacks
  // can run before the next render while an async open is in flight;
  // the reducer entry points consult this ref to reject those late edits.
  const busyRef = useRef(false);
  const toast = useToast();
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
  const confirm = useConfirm();
  const setNotice = useCallback(
    (message: string | null): void => {
      if (message !== null) toast.show({ tone: "success", message });
    },
    [toast],
  );
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(loadPanelSizes);
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_SIZES_KEY, JSON.stringify(panelSizes));
    } catch {
      // Preferences are best-effort; a blocked storage keeps the defaults.
    }
  }, [panelSizes]);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const nodeClipboardRef = useRef<NodeClipboard | null>(null);
  const projectRef = useRef<EditorProject | null>(null);
  const editorStateRef = useRef(editorState);
  const pendingImportsRef = useRef<Record<string, PendingAssetImport>>({});
  const [pendingImports, setPendingImports] = useState<
    Record<string, PendingAssetImport>
  >({});
  // Editor-only bookkeeping for replacement destinations.  The host forbids
  // writing over the original binary or any previously staged replacement
  // path, so the UI must apply the same rules: the original path is remembered
  // here even after the row starts pointing at a staged file (and it survives
  // undo/redo and save).
  const [reservedReplacementPaths, setReservedReplacementPaths] = useState<
    Record<string, string[]>
  >({});
  const savedContentRef = useRef("");
  const savedContentVersionRef = useRef("");

  const setEditorBusy = useCallback((value: boolean): void => {
    busyRef.current = value;
    setBusy(value);
  }, []);

  useLayoutEffect(() => {
    projectRef.current = project;
    editorStateRef.current = editorState;
    pendingImportsRef.current = pendingImports;
  }, [editorState, pendingImports, project]);

  // Keep staged import capabilities in every validation/preview request. A
  // newly imported asset is intentionally absent from the formal assets tree
  // until save, so omitting these tokens would make an otherwise valid
  // unsaved map/timeline preview fail with “missing asset”.  A token is only
  // sent while the manifest still registers the same id, kind and path: an
  // undo that restores a replaced asset's old path drops the obsolete
  // capability instead of failing the whole save.
  const activeImportTokens = useMemo(
    () =>
      project === null
        ? []
        : collectActiveImportTokens(pendingImports, project.manifest),
    [pendingImports, project],
  );

  // Logical ids whose staged binary has not been published by a save yet.
  // The asset library shows a "待保存" badge for these rows.  Only tokens that
  // still match the current manifest id/kind/path are "active": an undo that
  // restores a replaced asset's old path hides the badge, and a redo brings it
  // back (the registry keeps every token, so redo capabilities are never
  // discarded).
  const pendingAssetIds = useMemo(
    () =>
      project === null
        ? []
        : collectActivePendingAssetIds(pendingImports, project.manifest),
    [pendingImports, project],
  );

  const flushEditorEdits = useCallback((): boolean => {
    let valid = true;
    flushSync(() => {
      // Commit-on-blur inspector fields keep their draft in the DOM; a
      // shortcut does not blur them, so flush their registered commits first.
      flushPendingCommits();
    });
    flushSync(() => {
      // All raw drafts and in-flight gestures live in the reducer now.  A
      // single active edit is therefore enough to flush both ScriptView and
      // ChapterMapWorkspace without querying component-local refs.
      const active = editorStateRef.current.activeEdit;
      if (active === null) return;
      valid = Object.keys(active.invalidDrafts).length === 0;
      if (valid) dispatchEditor({ type: "commit_edit", id: active.id });
    });
    return valid;
  }, []);

  const flushBeforeNavigation = useCallback((): boolean => {
    const valid = flushEditorEdits();
    if (!valid) {
      setError("存在未提交或无效的编辑内容，请修正后再离开当前视图。");
    }
    return valid;
  }, [flushEditorEdits, setError]);

  const resizeBy = (axis: ResizeAxis, delta: number): void => {
    setPanelSizes((current) => ({
      ...current,
      [axis]: clampPanelSize(axis, current[axis] + delta),
    }));
  };

  const startResize = (
    axis: ResizeAxis,
    startX: number,
    startY: number,
  ): void => {
    setResizeState({
      axis,
      startX,
      startY,
      initial: panelSizes[axis],
    });
  };

  useEffect(() => {
    if (resizeState === null) return;
    const handlePointerMove = (event: globalThis.PointerEvent): void => {
      const delta = event.clientX - resizeState.startX;
      const signedDelta = resizeState.axis === "right" ? -delta : delta;
      setPanelSizes((current) => ({
        ...current,
        [resizeState.axis]: clampPanelSize(
          resizeState.axis,
          resizeState.initial + signedDelta,
        ),
      }));
    };
    const stopResize = (): void => setResizeState(null);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    document.body.classList.add("panel-resizing");
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      document.body.classList.remove("panel-resizing");
    };
  }, [resizeState]);

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

  const commit = useCallback(
    (
      mutator: (draft: EditorProject) => unknown,
      history = true,
      label = "编辑项目",
      mergeActive = false,
    ): void => {
      // Opening another project replaces the document; saving only captures a
      // snapshot and does not prevent new edits.
      if (busyRef.current) return;
      dispatchEditor({
        type: "edit",
        mutation: mutator,
        history,
        label,
        mergeActive,
      });
    },
    [],
  );

  /**
   * Apply an undoable change right away and offer 撤销 in a toast instead of
   * asking first.  The toast only undoes this exact change: if anything was
   * edited since, it asks the author to use the history instead.
   */
  const commitUndoable = (
    mutation: (draft: EditorProject) => unknown,
    label: string,
    message: string,
  ): void => {
    flushSync(() => commit(mutation, true, label));
    const revision = editorStateRef.current.currentRevision;
    toast.show({
      tone: "success",
      message,
      action: {
        label: "撤销",
        onAction: () => {
          if (editorStateRef.current.currentRevision !== revision) {
            setError("之后已有新的编辑；请用顶栏的撤销按钮逐步撤销。");
            return;
          }
          dispatchEditor({ type: "undo" });
        },
      },
    });
  };

  const beginEdit = useCallback(
    (id: string, label: string): void => {
      if (busyRef.current) return;
      const current = editorStateRef.current;
      const active = current.activeEdit;
      if (active !== null && active.id !== id) {
        if (Object.keys(active.invalidDrafts).length > 0) {
          setError("请先修正当前输入，再编辑其他属性。");
          return;
        }
        // Focus/pointer transitions can arrive in one React batch.  Commit the
        // previous valid gesture synchronously before opening the next one;
        // otherwise both mutations would be attributed to whichever callback
        // happens to render first.
        flushSync(() => {
          dispatchEditor({ type: "commit_edit", id: active.id });
          dispatchEditor({ type: "begin_edit", id, label });
        });
        return;
      }
      // Focus/pointer handlers and the first input event may be delivered in
      // the same browser task.  Commit the ownership transition synchronously
      // so an immediately-following update_edit cannot be dropped because the
      // component still holds the previous reducer snapshot.
      flushSync(() => dispatchEditor({ type: "begin_edit", id, label }));
    },
    [setError],
  );

  const updateEdit = useCallback(
    (id: string, mutation: EditorMutation): void => {
      if (busyRef.current) return;
      dispatchEditor({ type: "update_edit", id, mutation });
    },
    [],
  );

  const commitEdit = useCallback((id: string, clearedKey?: string): boolean => {
    if (busyRef.current) return false;
    const current = editorStateRef.current;
    if (current.activeEdit?.id !== id) return true;
    const invalidKeys = Object.keys(current.activeEdit.invalidDrafts).filter(
      (key) => key !== clearedKey,
    );
    // A map inspector clears its raw field and commits in one browser blur
    // turn.  React dispatches both actions together, so inspect the key that
    // is about to be cleared rather than the stale ref from before the blur.
    if (clearedKey !== undefined)
      dispatchEditor({ type: "clear_edit_draft", id, key: clearedKey });
    const valid = invalidKeys.length === 0;
    dispatchEditor({ type: "commit_edit", id });
    // Returning the projected validity keeps callers from leaving the
    // workspace after an invalid blur, while allowing a corrected field to
    // clear-and-commit atomically.
    return valid;
  }, []);

  const cancelEdit = useCallback((id: string): void => {
    if (busyRef.current) return;
    dispatchEditor({ type: "cancel_edit", id });
  }, []);

  const setEditDraft = useCallback(
    (id: string, key: string, value: string, invalid = true): void => {
      if (busyRef.current) return;
      dispatchEditor({ type: "set_edit_draft", id, key, value, invalid });
    },
    [],
  );

  const setEditError = useCallback(
    (id: string, key: string, message: string | null): void => {
      if (busyRef.current) return;
      dispatchEditor({ type: "set_edit_error", id, key, message });
    },
    [],
  );

  const updateNodeEdit = useCallback(
    (editId: string, nodeId: string, node: SceneNode): void => {
      updateEdit(editId, (draft) => {
        const file = findScene(draft, activeSceneId);
        if (file !== undefined) file.definition.nodes[nodeId] = node;
      });
    },
    [activeSceneId, updateEdit],
  );

  const openProject = async (preferred?: string): Promise<void> => {
    if (savingRef.current) {
      setError("请等待当前项目保存完成后再打开其他项目。");
      return;
    }
    if (!flushEditorEdits()) return;
    if (
      (dirty ||
        (projectRef.current !== null &&
          contentDocumentFingerprint(projectRef.current) !==
            savedContentRef.current)) &&
      !(await confirm({
        title: "放弃未保存的更改？",
        description:
          "当前项目有尚未保存的修改。打开其他项目会丢弃这些修改，且无法撤销。",
        confirmLabel: "放弃更改并打开",
        danger: true,
      }))
    )
      return;
    let root = preferred;
    if (root === undefined) {
      try {
        const picked = await editorApi.pickProjectDirectory();
        if (picked === null) return;
        root = picked;
      } catch (reason) {
        reportCommandError(reason);
        return;
      }
    }
    setEditorBusy(true);
    setError(null);
    try {
      const loaded = await editorApi.openProject(root);
      dispatchEditor({ type: "load", project: loaded });
      setPendingImports({});
      setReservedReplacementPaths({});
      savedContentRef.current = contentDocumentFingerprint(loaded);
      savedContentVersionRef.current = loaded.manifest.content_version;
      const initialScene =
        loaded.manifest.entry_scene || loaded.scenes[0]?.definition.id || "";
      setActiveSceneId(initialScene);
      setAssetSelectionId(null);
      setSelectedNodeId(null);
      setRoute(STORY_ROUTE);
      setButtonDialog(null);
      setMapSelectionId(null);
      rememberRecentProject(loaded.root);
      setNotice(`已打开 ${loaded.root}`);
    } catch (reason) {
      reportCommandError(reason);
    } finally {
      setEditorBusy(false);
    }
  };

  const saveProject = useCallback(async (): Promise<void> => {
    if (savingRef.current || busyRef.current) return;
    if (!flushEditorEdits()) return;
    const currentProject = projectRef.current;
    if (currentProject === null) return;
    const currentDiagnostics = validateLive(currentProject);
    const errors = currentDiagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    if (errors.length > 0) {
      setSidebarTab("problems");
      setError(`存在 ${errors.length} 个错误，修复后才能保存。`);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const snapshot = currentProject;
    const revision = editorStateRef.current.currentRevision;
    try {
      const requestTokens = collectActiveImportTokens(
        pendingImportsRef.current,
        currentProject.manifest,
      );
      const request = projectRequest(currentProject, requestTokens);
      await editorApi.validateProject(request);
      const result = await editorApi.saveProject(request);
      const saved = result.project;
      dispatchEditor({
        type: "mark_saved",
        project: saved,
        snapshot,
        revision,
      });
      setPendingImports((current) => {
        const next = { ...current };
        for (const token of requestTokens) Reflect.deleteProperty(next, token);
        pendingImportsRef.current = next;
        return next;
      });
      savedContentRef.current = contentDocumentFingerprint(saved);
      savedContentVersionRef.current = saved.manifest.content_version;
      const changed = result.changed_paths.length;
      const warningText = result.warnings
        .map((warning) => warning.message)
        .filter((message) => message.length > 0)
        .join("；");
      const deleted = result.deleted_paths.length;
      const summary =
        changed === 0 && deleted === 0
          ? "项目没有需要写入的文件。"
          : `项目已安全保存（${changed} 个文件${deleted > 0 ? `，删除 ${deleted} 个` : ""}）。备份位于 .vectspace/backups。`;
      if (warningText.length > 0) {
        // Warnings stay until the author has read them.
        toast.show({
          tone: "warning",
          message: `${summary}\n警告：${warningText}`,
        });
      } else {
        setNotice(summary);
      }
    } catch (reason) {
      reportCommandError(reason);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [flushEditorEdits, reportCommandError, setError, setNotice, toast]);

  const undo = useCallback((): void => {
    const current = editorStateRef.current;
    if (
      current.activeEdit !== null &&
      Object.keys(current.activeEdit.invalidDrafts).length > 0
    ) {
      // An invalid numeric draft has no typed project value to undo.  Cancel
      // the owning editor session (and ask the workspace to restore its raw
      // input) instead of touching an older history entry.
      dispatchEditor({ type: "cancel_edit", id: current.activeEdit.id });
      return;
    }
    if (!flushEditorEdits()) return;
    dispatchEditor({ type: "undo" });
  }, [flushEditorEdits]);

  const redo = useCallback((): void => {
    if (!flushEditorEdits()) return;
    dispatchEditor({ type: "redo" });
  }, [flushEditorEdits]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || isComposing(event)) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProject();
        return;
      }
      // Undo/redo inside a text field is the field's own text history.
      if (isTextEntryTarget(event.target)) return;
      if (event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
      } else if (
        event.key.toLowerCase() === "y" ||
        (event.key.toLowerCase() === "z" && event.shiftKey)
      ) {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [redo, saveProject, undo]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  if (project === null) {
    return (
      <WelcomeScreen
        busy={busy}
        error={welcomeError}
        onOpen={(root) => void openProject(root)}
        recent={loadRecentProjects()}
      />
    );
  }

  const changeNode = (nodeId: string, node: SceneNode): void => {
    commit((draft) => {
      const scene = findScene(draft, activeSceneId);
      if (scene === undefined) return;
      const previous = scene.definition.nodes[nodeId];
      const previousDocument =
        previous?.type === "long_text" && (previous.mode ?? "start") === "start"
          ? (previous.document ?? nodeId)
          : null;
      const nextDocument =
        node.type === "long_text" && (node.mode ?? "start") === "start"
          ? (node.document ?? nodeId)
          : null;
      scene.definition.nodes[nodeId] = node;
      if (
        previousDocument !== null &&
        nextDocument !== null &&
        previousDocument !== nextDocument
      ) {
        rewriteLongTextDocumentReferences(
          scene.definition,
          previousDocument,
          nextDocument,
          nodeId,
        );
      }
    });
  };

  const convertNodeToTimeline = (nodeId: string): void => {
    const sceneId = activeSceneId;
    const currentProject = editorStateRef.current.project ?? project;
    const sourceNode = findScene(currentProject, sceneId)?.definition.nodes[
      nodeId
    ];
    if (sourceNode === undefined) return;
    setError(null);
    try {
      const converted = convertQuickNodeToTimeline(
        sourceNode,
        currentProject.manifest,
      );
      commit((draft) => {
        const scene = findScene(draft, sceneId);
        if (scene === undefined) return;
        scene.definition.nodes[nodeId] = converted;
      });
      setNotice(
        `已将 ${nodeLabel(sourceNode.type)}节点展开为关键帧时间线；起始通道继承真实入口值。`,
      );
      setRoute({ kind: "timeline", sceneId, nodeId });
    } catch (reason) {
      reportCommandError(reason);
    }
  };

  const convertActionNodeToTimeline = async (nodeId: string): Promise<void> => {
    const scene = findScene(
      editorStateRef.current.project ?? project,
      activeSceneId,
    )?.definition;
    const sourceNode = scene?.nodes[nodeId];
    if (scene === undefined || sourceNode?.type !== "action") return;
    const action = (editorStateRef.current.project ?? project).actions?.find(
      (file) => file.definition.id === sourceNode.action,
    )?.definition;
    if (action === undefined) {
      setError(`未找到立绘动作 ${sourceNode.action}。`);
      return;
    }
    const currentProject = editorStateRef.current.project ?? project;
    try {
      const previewSettings = currentProject.layout.timeline_previews?.[
        `${activeSceneId}/${nodeId}`
      ] ?? { variable_overrides: {}, choices: [] };
      const preview = await editorApi.buildNodePreview({
        project: projectRequest(currentProject, activeImportTokens),
        target: { scene_id: activeSceneId, node_id: nodeId },
        variable_overrides: previewSettings.variable_overrides,
        choices: previewSettings.choices,
      });
      if (preview.status === "needs_choice") {
        setError(
          `解除引用需要唯一的真实进入状态；请先补充 ${preview.location.scene_id}/${preview.location.node_id} 的预览路径选择。`,
        );
        return;
      }
      if (preview.status === "unreachable") {
        setError(`无法构造动作节点的真实进入状态：${preview.message}`);
        return;
      }
      const base: SpriteSnapshot | undefined =
        preview.start_snapshot.world.sprites[sourceNode.sprite_id];
      if (base === undefined) {
        setError(
          `动作节点进入时不存在立绘 ${sourceNode.sprite_id}，无法安全解除引用。`,
        );
        return;
      }
      const converted = expandSpriteActionNode({
        node: sourceNode,
        action,
        base,
      });
      commit((draft) => {
        const target = findScene(draft, activeSceneId);
        const latest = target?.definition.nodes[nodeId];
        if (
          target !== undefined &&
          latest?.type === "action" &&
          latest.action === sourceNode.action &&
          latest.sprite_id === sourceNode.sprite_id
        ) {
          target.definition.nodes[nodeId] = converted;
        }
      });
      setNotice(
        `已将动作 ${sourceNode.action} 解除引用为关键帧时间线；通道已按当前立绘姿态展开。`,
      );
      setRoute({ kind: "timeline", sceneId: activeSceneId, nodeId });
    } catch (reason) {
      reportCommandError(reason);
    }
  };

  const splitDialogue = (
    nodeId: string,
    offset: number,
    textOverride?: string,
  ): void => {
    const scene =
      findScene(editorStateRef.current.project ?? project, activeSceneId)
        ?.definition ?? activeScene;
    if (scene === undefined) return;
    const sourceScene =
      textOverride === undefined
        ? scene
        : {
            ...scene,
            nodes: {
              ...scene.nodes,
              [nodeId]:
                scene.nodes[nodeId]?.type === "say"
                  ? { ...scene.nodes[nodeId], text: textOverride }
                  : scene.nodes[nodeId],
            },
          };
    let result: ReturnType<typeof splitDialogueAt>;
    try {
      result = splitDialogueAt(sourceScene, nodeId, offset);
    } catch (reason) {
      reportCommandError(reason);
      return;
    }
    let committed = false;
    let continuationId = result.continuationId;
    flushSync(() =>
      commit((draft) => {
        const base = structuredClone(currentPlainProject(draft));
        const file = findScene(base, activeSceneId);
        if (file === undefined) return undefined;
        const latestScene = file.definition;
        const latestSource =
          textOverride === undefined
            ? latestScene
            : {
                ...latestScene,
                nodes: {
                  ...latestScene.nodes,
                  [nodeId]:
                    latestScene.nodes[nodeId]?.type === "say"
                      ? { ...latestScene.nodes[nodeId], text: textOverride }
                      : latestScene.nodes[nodeId],
                },
              };
        let latest: ReturnType<typeof splitDialogueAt>;
        try {
          latest = splitDialogueAt(latestSource, nodeId, offset);
        } catch {
          return undefined;
        }
        file.definition.nodes[nodeId] = latest.first;
        file.definition.nodes[latest.continuationId] = latest.continuation;
        const layout = ensureSceneLayout(base.layout, activeSceneId);
        const origin = layout.nodes[nodeId] ?? { x: 0, y: 0 };
        layout.nodes[latest.continuationId] = {
          x: origin.x + 320,
          y: origin.y,
        };
        committed = true;
        continuationId = latest.continuationId;
        return base;
      }),
    );
    if (!committed) {
      setError("拆分失败：节点已发生变化，请重新尝试。");
      return;
    }
    setSelectedNodeId(continuationId);
    setNotice("已拆成两个对话段；可在它们之间插入动画节点。");
  };

  const splitLongText = (nodeId: string, stepIndex: number): void => {
    const scene =
      findScene(editorStateRef.current.project ?? project, activeSceneId)
        ?.definition ?? activeScene;
    const source = scene?.nodes[nodeId];
    if (scene === undefined || source?.type !== "long_text") return;
    let result: ReturnType<typeof splitLongTextAt>;
    try {
      result = splitLongTextAt(scene, nodeId, stepIndex);
    } catch (reason) {
      reportCommandError(reason);
      return;
    }
    let committed = false;
    let continuationId = result.continuationId;
    flushSync(() =>
      commit((draft) => {
        const base = structuredClone(currentPlainProject(draft));
        const file = findScene(base, activeSceneId);
        if (file === undefined) return undefined;
        let latest: ReturnType<typeof splitLongTextAt>;
        try {
          latest = splitLongTextAt(file.definition, nodeId, stepIndex);
        } catch {
          return undefined;
        }
        file.definition.nodes[nodeId] = latest.first;
        file.definition.nodes[latest.continuationId] = latest.continuation;
        rewriteLongTextDocumentReferences(
          file.definition,
          latest.previousDocument,
          latest.document,
          nodeId,
        );
        const layout = ensureSceneLayout(base.layout, activeSceneId);
        const origin = layout.nodes[nodeId] ?? { x: 0, y: 0 };
        layout.nodes[latest.continuationId] = {
          x: origin.x + 320,
          y: origin.y,
        };
        committed = true;
        continuationId = latest.continuationId;
        return base;
      }),
    );
    if (!committed) {
      setError("拆分失败：节点已发生变化，请重新尝试。");
      return;
    }
    setSelectedNodeId(continuationId);
    setNotice("已拆成长文稿接续节点；可在两段之间插入对话或动画。");
  };

  const addNode = (type: NodeType, position: NodePosition): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    let insertedId = "";
    let committed = false;
    flushSync(() =>
      commit(
        (draft) => {
          const base = structuredClone(currentPlainProject(draft));
          const file = findScene(base, activeSceneId);
          if (file === undefined) return undefined;
          insertedId = uniqueNodeId(file.definition, type);
          const fallback =
            file.definition.entry ||
            Object.keys(file.definition.nodes)[0] ||
            insertedId;
          file.definition.nodes[insertedId] = defaultNode(type, fallback);
          ensureSceneLayout(base.layout, activeSceneId).nodes[insertedId] = {
            x: Math.round(position.x / 16) * 16,
            y: Math.round(position.y / 16) * 16,
          };
          committed = true;
          return base;
        },
        true,
        `添加${nodeLabel(type)}节点`,
      ),
    );
    if (!committed) {
      setError("添加节点失败：场景已发生变化，请重新尝试。");
      return;
    }
    setSelectedNodeId(insertedId);
  };

  const quickInsertNode = (
    sourceId: string,
    side: "left" | "right",
    type: NodeType,
  ): void => {
    const currentProject = editorStateRef.current.project ?? project;
    if (currentProject === null) return;
    const result = insertNode(
      currentProject,
      activeSceneId,
      sourceId,
      side,
      type,
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }
    let insertedId = result.nodeId;
    let committed = false;
    flushSync(() =>
      commit((draft) => {
        const latest = insertNode(
          currentPlainProject(draft),
          activeSceneId,
          sourceId,
          side,
          type,
        );
        if (!latest.ok) return undefined;
        insertedId = latest.nodeId;
        committed = true;
        return latest.project;
      }),
    );
    if (!committed) {
      setError("插入节点失败：源节点已发生变化，请重新尝试。\n");
      return;
    }
    setSelectedNodeId(insertedId);
    setNotice(
      `已在${side === "left" ? "左" : "右"}侧插入${nodeLabel(type)}节点。`,
    );
  };

  const insertSayAfter = (sourceId: string, portId?: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    if (currentProject === null) return;
    // Compute the id/eligibility for immediate feedback, but perform the
    // actual insertion from the reducer's current project.  Deriving the
    // second project from this render's stale `project` would otherwise
    // overwrite a newer edit when several authoring gestures are batched.
    const preview = insertNode(
      currentProject,
      activeSceneId,
      sourceId,
      "right",
      "say",
      portId,
    );
    if (!preview.ok) {
      setError(preview.error);
      return;
    }
    let insertedId = preview.nodeId;
    let committed = false;
    flushSync(() => {
      commit((draft) => {
        // The reducer supplies the latest draft to this recipe.  `original`
        // unwraps it before the pure story helper clones the project.
        const latest = insertNode(
          currentPlainProject(draft),
          activeSceneId,
          sourceId,
          "right",
          "say",
          portId,
        );
        if (!latest.ok) return undefined;
        const latestSource = latest.project.scenes.find(
          (file) => file.definition.id === activeSceneId,
        )?.definition.nodes[sourceId];
        if (latestSource?.type === "say") {
          const inserted = latest.project.scenes.find(
            (file) => file.definition.id === activeSceneId,
          )?.definition.nodes[latest.nodeId];
          if (inserted?.type === "say") inserted.speaker = latestSource.speaker;
        }
        committed = true;
        insertedId = latest.nodeId;
        return latest.project;
      });
    });
    if (!committed) {
      setError("插入对话失败：源节点已发生变化，请重新尝试。");
      return;
    }
    setSelectedNodeId(insertedId);
  };

  const insertSayAfterWithText = (sourceId: string, text: string): boolean => {
    const current = projectRef.current;
    if (current === null) return false;
    const preview = insertNode(
      current,
      activeSceneId,
      sourceId,
      "right",
      "say",
    );
    if (!preview.ok) {
      setError(preview.error);
      return false;
    }
    let insertedId = preview.nodeId;
    let committed = false;
    flushSync(() => {
      commit(
        (draft) => {
          // `insertNode` is deliberately a pure helper.  Build its input from
          // the reducer's current project and apply the pending text before
          // the clone, so committing the textarea and inserting the next
          // sentence produces exactly one history entry.
          const base = structuredClone(currentPlainProject(draft));
          const source = findScene(base, activeSceneId)?.definition.nodes[
            sourceId
          ];
          if (source?.type !== "say") return undefined;
          source.text = text;
          const result = insertNode(
            base,
            activeSceneId,
            sourceId,
            "right",
            "say",
          );
          if (!result.ok) return undefined;
          committed = true;
          insertedId = result.nodeId;
          return result.project;
        },
        true,
        "提交对话并插入下一句",
        true,
      );
    });
    if (!committed) {
      setError(
        "插入对话失败：源节点已发生变化，请重新尝试。正文草稿已保留。\n",
      );
      return false;
    }
    setSelectedNodeId(insertedId);
    return true;
  };

  const insertSayBatch = (
    sourceId: string,
    rows: { speaker: string | null; text: string }[],
  ): void => {
    if (project === null || rows.length === 0) return;
    let candidate = project;
    let anchor = sourceId;
    let failed = false;
    for (const row of rows) {
      const result = insertNode(
        candidate,
        activeSceneId,
        anchor,
        "right",
        "say",
      );
      if (!result.ok) {
        setError(result.error);
        failed = true;
        break;
      }
      const file = result.project.scenes.find(
        (item) => item.definition.id === activeSceneId,
      );
      const inserted = file?.definition.nodes[result.nodeId];
      if (inserted?.type === "say") {
        inserted.speaker = row.speaker;
        inserted.text = row.text;
      }
      candidate = result.project;
      anchor = result.nodeId;
    }
    // A paste is one authoring gesture.  Never commit a prefix when a later
    // row cannot be inserted: the user should be able to fix the input and
    // retry without leaving a surprising half-pasted chain in the story.
    if (!failed && candidate !== project) {
      let committed = false;
      flushSync(() =>
        commit(
          (draft) => {
            let latest = structuredClone(currentPlainProject(draft));
            let latestAnchor = sourceId;
            for (const row of rows) {
              const result = insertNode(
                latest,
                activeSceneId,
                latestAnchor,
                "right",
                "say",
              );
              if (!result.ok) return undefined;
              const file = findScene(result.project, activeSceneId);
              const inserted = file?.definition.nodes[result.nodeId];
              if (inserted?.type === "say") {
                inserted.speaker = row.speaker;
                inserted.text = row.text;
              }
              latest = result.project;
              latestAnchor = result.nodeId;
            }
            committed = true;
            return latest;
          },
          true,
          "批量插入对话",
        ),
      );
      if (!committed) {
        setError("批量插入失败：源节点已发生变化，请重新尝试。");
        return;
      }
      setSelectedNodeId(anchor);
      setNotice(`已插入 ${rows.length} 句对话。`);
    }
  };

  const executeDeleteNodes = (nodeIds: string[], fallback: string): void => {
    const removed = new Set(nodeIds);
    commitUndoable(
      (draft) => deleteNodesMutation(draft, activeSceneId, nodeIds, fallback),
      nodeIds.length === 1 ? "删除节点" : "删除节点片段",
      nodeIds.length === 1
        ? `已删除节点 ${nodeIds[0]}，原有连线改接到 ${fallback}。`
        : `已删除 ${nodeIds.length} 个节点，原有连线改接到 ${fallback}。`,
    );
    setDeleteRequest(null);
    setSelectedNodeId(null);
    if (routeShowsNode(route, activeSceneId, removed)) setRoute(STORY_ROUTE);
  };

  const deleteNode = (nodeId: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    const plan = planNodeDeletion(currentScene, nodeId);
    if (!plan.ok) {
      setError(plan.error);
      return;
    }
    if (plan.options.length === 1) {
      executeDeleteNodes(plan.nodeIds, plan.options[0].id);
      return;
    }
    setDeleteRequest({ nodeIds: plan.nodeIds, options: plan.options });
  };

  const duplicateNode = (nodeId: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    const source = currentScene.nodes[nodeId];
    if (source === undefined) return;
    const duplicate = structuredClone(source);
    const id = uniqueNodeId(currentScene, `${nodeId}_copy`);
    commit((draft) => {
      const file = findScene(draft, activeSceneId);
      if (file === undefined || file.definition.nodes[nodeId] === undefined)
        return;
      file.definition.nodes[id] = duplicate;
      const sceneLayout = ensureSceneLayout(draft.layout, activeSceneId);
      const origin = sceneLayout.nodes[nodeId] ?? { x: 0, y: 0 };
      sceneLayout.nodes[id] = { x: origin.x + 48, y: origin.y + 48 };
    });
    setSelectedNodeId(id);
  };

  const copyNode = (nodeId: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const node = findScene(currentProject, activeSceneId)?.definition.nodes[
      nodeId
    ];
    if (node === undefined) return;
    const sourceCharacterId =
      node.type === "say" &&
      node.speaker !== null &&
      currentProject.manifest.characters[node.speaker] !== undefined
        ? node.speaker
        : null;
    nodeClipboardRef.current = {
      node: structuredClone(node),
      sourceNodeId: nodeId,
      sourceCharacterId,
    };
    setNotice(`已复制节点 ${nodeId}，可切换场景后粘贴。`);
  };

  const pasteNode = (position: NodePosition): void => {
    const clipboard = nodeClipboardRef.current;
    const currentProject = editorStateRef.current.project ?? project;
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (clipboard === null || currentScene === undefined) {
      setNotice("还没有复制节点。");
      return;
    }
    const id = uniqueNodeId(currentScene, `${clipboard.sourceNodeId}_copy`);
    const snapped = {
      x: Math.round(position.x / 16) * 16,
      y: Math.round(position.y / 16) * 16,
    };
    commit((draft) => {
      const file = findScene(draft, activeSceneId);
      if (file === undefined) return;
      file.definition.nodes[id] = preparePastedNode(
        clipboard.node,
        draft.manifest,
        clipboard.sourceCharacterId,
        draft.buttons ?? [],
      );
      ensureSceneLayout(draft.layout, activeSceneId).nodes[id] = snapped;
    });
    setSelectedNodeId(id);
    setNotice(`已粘贴为 ${id}；流程连接已清空。`);
  };

  const addScene = (id: string): boolean => {
    const currentProject = editorStateRef.current.project ?? project;
    const reason = idUnavailableReason("scene", id, currentProject);
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => {
      const file = newSceneFile(id);
      draft.scenes.push(file);
      draft.manifest.scenes.push(file.path);
      ensureSceneLayout(draft.layout, id).nodes.start = { x: 120, y: 120 };
    });
    setActiveSceneId(id);
    setSelectedNodeId("start");
    return true;
  };

  const deleteScene = (sceneId: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    if (currentProject.manifest.entry_scene === sceneId) {
      setError("不能删除项目入口场景，请先在项目设置中更换入口。");
      return;
    }
    commitUndoable(
      (draft) => removeScene(draft, sceneId),
      "删除场景",
      `已从项目移除场景 ${sceneId}（场景文件仍保留在磁盘上）。`,
    );
    const next =
      currentProject.scenes.find((file) => file.definition.id !== sceneId)
        ?.definition.id ?? "";
    if (routeShowsScene(route, sceneId)) setRoute(STORY_ROUTE);
    setActiveSceneId(next);
    setSelectedNodeId(null);
  };

  const deleteNodes = (nodeIds: string[]): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    const plan = planChainDeletion(currentScene, nodeIds);
    if (!plan.ok) {
      setError(plan.error);
      return;
    }
    if (plan.nodeIds.length === 1) {
      deleteNode(plan.nodeIds[0]);
      return;
    }
    if (plan.options.length === 1) {
      executeDeleteNodes(plan.nodeIds, plan.options[0].id);
      return;
    }
    setDeleteRequest({ nodeIds: plan.nodeIds, options: plan.options });
  };

  const batchChangeSpeaker = (
    nodeIds: string[],
    speaker: string | null,
  ): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined || nodeIds.length === 0) return;
    const ids = new Set(nodeIds);
    commit(
      (draft) => {
        const scene = findScene(draft, activeSceneId);
        if (scene === undefined) return;
        for (const id of ids) {
          const node = scene.definition.nodes[id];
          if (node?.type === "say") node.speaker = speaker;
        }
      },
      true,
      "批量修改角色",
    );
  };

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

  const importAssets = async (items: ImportDraft[]): Promise<void> => {
    // Importing adds manifest registrations, so it must not leap over an
    // active script/map draft.  Commit the same explicit edit session used by
    // Ctrl+S before minting host-side import capabilities.
    if (!flushEditorEdits()) {
      throw new Error("请先修正当前未提交的编辑内容，再导入素材。");
    }
    const importProject = editorStateRef.current.project;
    if (importProject === null) {
      throw new Error("项目已经关闭，无法导入素材。");
    }
    try {
      const imported = await editorApi.stageAssetImports(
        items.map((item) => ({
          id: item.id,
          kind: item.kind,
          file_name: item.fileName,
          inspection_id: item.inspectionId,
          replace_id: item.replaceId ?? null,
        })),
      );
      const latestProject = editorStateRef.current.project;
      if (latestProject === null || latestProject.root !== importProject.root) {
        throw new Error("项目已切换；本次素材导入未附加到其他项目。");
      }
      // A replacement intentionally reuses an existing logical id; only a
      // brand-new registration may not collide with the current manifest.
      const replacementIds = new Set(
        imported
          .filter(
            (asset) =>
              asset.replaced_from !== undefined && asset.replaced_from !== null,
          )
          .map((asset) => asset.id),
      );
      const conflicts = imported
        .map((asset) => asset.id)
        .filter((id) => !replacementIds.has(id))
        .filter((id) => latestProject.manifest.assets[id] !== undefined);
      if (conflicts.length > 0) {
        throw new Error(
          `导入期间素材 ID 已被占用：${conflicts.join("、")}。请重新检查导入清单。`,
        );
      }
      // A user may have opened an invalid draft while the file inspection was
      // running.  Re-run the shared commit gate before applying the result so
      // a staged token never becomes a manifest registration beside a broken
      // editor session.
      if (!flushEditorEdits()) {
        throw new Error("导入完成前出现无效编辑，未将素材加入项目。");
      }
      commit((draft) => {
        for (const asset of imported) {
          const sourceMetadata = items.find((item) => item.id === asset.id)
            ?.inspection?.metadata;
          // One asset row per logical id: a replacement updates the existing
          // row in place and never appends a duplicate.
          applyStagedAsset(draft, asset, sourceMetadata ?? null);
        }
      });
      if (
        imported.some(
          (asset) => asset.token !== undefined && asset.token !== null,
        )
      ) {
        setPendingImports((current) => {
          const next = registerPendingImports(current, imported);
          // A Ctrl+S dispatched in the same browser turn must use the newly
          // minted capabilities rather than wait for React's layout effect.
          pendingImportsRef.current = next;
          return next;
        });
      }
      // Remember every replaced destination so a later replacement cannot
      // reuse the original on-disk path or a superseded staged path, matching
      // the host's reservation of both.
      if (replacementIds.size > 0) {
        setReservedReplacementPaths((current) => {
          const next: Record<string, string[]> = { ...current };
          for (const asset of imported) {
            const paths = new Set(next[asset.id] ?? []);
            if (
              asset.replaced_from !== undefined &&
              asset.replaced_from !== null
            )
              paths.add(asset.replaced_from);
            if (asset.path !== "") paths.add(asset.path);
            next[asset.id] = [...paths];
          }
          return next;
        });
      }
      const reused = imported.filter(
        (asset) =>
          asset.reused_from !== undefined && asset.reused_from !== null,
      ).length;
      const replaced = replacementIds.size;
      if (replaced > 0) {
        setNotice(
          `已暂存 ${imported.length} 个素材（${replaced} 个替换原文件，旧文件保留在 assets 目录）；保存项目后才会正式加入项目。`,
        );
      } else {
        setNotice(
          reused > 0
            ? `已暂存 ${imported.length} 个素材（${reused} 个复用已有文件）；保存项目后才会正式加入项目。`
            : `已暂存 ${imported.length} 个素材；保存项目后才会正式加入项目。`,
        );
      }
    } catch (reason) {
      reportCommandError(reason);
      throw reason;
    }
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

  const createUiMotion = (rawId: string): boolean => {
    const id = rawId.trim();
    const currentProject = editorStateRef.current.project ?? project;
    const reason = idUnavailableReason("uiMotion", id, currentProject);
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => addUiMotion(draft, newUiMotionFile(id)));
    setRoute({ kind: "uiMotion", id });
    return true;
  };

  const deleteUiMotion = (id: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const references = uiMotionReferenceCount(currentProject, id);
    if (references > 0) {
      setError(`UI 动效 ${id} 仍被 ${references} 处引用，不能删除。`);
      return;
    }
    commitUndoable(
      (draft) => removeUiMotion(draft, id),
      "移除 UI 动效",
      `已移除 UI 动效 ${id}（文件仍保留在磁盘上）。`,
    );
    if (uiMotionTarget === id) setRoute(STORY_ROUTE);
  };

  const openCreateButton = (): void => {
    if (!flushBeforeNavigation()) return;
    setButtonDialog("button.default");
  };

  const createButtonTemplate = (rawId: string): boolean => {
    const id = rawId.trim();
    const currentProject = editorStateRef.current.project ?? project;
    const reason = idUnavailableReason("button", id, currentProject);
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => addButtonTemplate(draft, newButtonFile(id)));
    setRoute({ kind: "button", id });
    return true;
  };

  const deleteButtonTemplate = (id: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const references = findButtonTemplateReferences(currentProject, id);
    if (references.length > 0) {
      setError(
        `按钮模板 ${id} 仍被 ${references.length} 处剧情引用${formatReferenceList(references)}，不能删除。`,
      );
      return;
    }
    if (
      !(currentProject.buttons ?? []).some(
        (candidate) => candidate.definition.id === id,
      )
    )
      return;
    commitUndoable(
      (draft) => removeButtonTemplate(draft, id),
      "移除按钮模板",
      `已移除按钮模板 ${id}（文件仍保留在磁盘上）。`,
    );
    if (buttonTarget === id) setRoute(STORY_ROUTE);
  };

  const createImageAnimation = (draft: AnimationDraft): boolean => {
    const currentProject = editorStateRef.current.project ?? project;
    const animations = currentProject.animations ?? [];
    const formatReason =
      idFormatError(draft.id) ?? idFormatError(draft.assetId);
    if (formatReason !== null) {
      setError(formatReason);
      return false;
    }
    if (
      currentProject.manifest.assets[draft.id] !== undefined ||
      currentProject.manifest.assets[draft.assetId] !== undefined ||
      animations.some((file) => file.definition.id === draft.id)
    ) {
      setError("图片动画 ID 或素材 ID 已经存在。");
      return false;
    }
    const path = animationFilePath(draft.id);
    if (animations.some((file) => file.path === path)) {
      setError(`图片动画文件路径 ${path} 已经存在。`);
      return false;
    }
    const definition = animationDefinition(draft);
    // Rust resolves an animated asset to its first frame, so the optimistic
    // asset carries the same path, size and metadata the save response will.
    const firstFrame = currentProject.assets.find(
      (asset) => asset.id === definition.frames[0]?.asset,
    );
    commit((draftProject) => {
      draftProject.manifest.animations ??= [];
      draftProject.manifest.animations.push(path);
      draftProject.manifest.assets[draft.assetId] = {
        kind: draft.kind,
        animation: draft.id,
      };
      draftProject.animations ??= [];
      draftProject.animations.push({ path, definition });
      draftProject.assets.push({
        id: draft.assetId,
        kind: draft.kind,
        animation: draft.id,
        absolute_path: firstFrame?.absolute_path ?? "",
        size_bytes: firstFrame?.size_bytes,
        metadata: firstFrame?.metadata ?? null,
      });
    });
    setNotice(
      `已创建帧动画 ${draft.id}（${definition.frames.length} 帧）；图片与动画描述会在同一次保存中写入。`,
    );
    return true;
  };

  const createSpriteAction = (rawId: string): boolean => {
    const id = rawId.trim();
    const currentProject = editorStateRef.current.project ?? project;
    const reason = idUnavailableReason("action", id, currentProject);
    if (reason !== null) {
      setError(reason);
      return false;
    }
    commit((draft) => addSpriteAction(draft, newSpriteActionFile(id)));
    setNotice(`已创建立绘动作 ${id}。`);
    return true;
  };

  const deleteSpriteAction = (id: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const references = spriteActionReferences(currentProject, id);
    if (references.length > 0) {
      setError(
        `立绘动作 ${id} 仍被 ${references.length} 个节点引用${formatReferenceList(references)}，不能删除。`,
      );
      return;
    }
    if (
      !(currentProject.actions ?? []).some(
        (candidate) => candidate.definition.id === id,
      )
    )
      return;
    commitUndoable(
      (draft) => removeSpriteAction(draft, id),
      "移除立绘动作",
      `已移除立绘动作 ${id}（文件仍保留在磁盘上）。`,
    );
  };

  const duplicateSpriteAction = (id: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const file = duplicateSpriteActionFile(currentProject, id);
    if (file === null) return;
    commit((draft) => addSpriteAction(draft, file));
    setNotice(`已复制立绘动作 ${id} → ${file.definition.id}。`);
  };

  const duplicateButtonTemplate = (id: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const file = duplicateButtonFile(currentProject, id);
    if (file === null) return;
    commit((draft) => addButtonTemplate(draft, file));
    setRoute({ kind: "button", id: file.definition.id });
  };

  const uiMotionFile = project.ui_motions.find(
    (file) => file.definition.id === uiMotionTarget,
  );
  const buttonFile = (project.buttons ?? []).find(
    (file) => file.definition.id === buttonTarget,
  );
  const actionFile = (project.actions ?? []).find(
    (file) => file.definition.id === actionTarget,
  );
  const longTextScene = findScene(project, longTextTarget?.sceneId ?? "");
  const longTextNode =
    longTextTarget === null
      ? undefined
      : longTextScene?.definition.nodes[longTextTarget.nodeId];
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
  const validateWholeProject = (): void => {
    if (!flushEditorEdits()) {
      setError("存在未提交或无效的输入，请修正后再校验。");
      return;
    }
    const current = projectRef.current;
    if (current === null) return;
    void editorApi
      .validateProject(projectRequest(current, activeImportTokens))
      .then(() => setNotice("项目已通过完整校验。"))
      .catch((reason: unknown) => reportCommandError(reason));
  };
  // Exactly one route renders; the whole App shares one asset-layout
  // provider, one toast layer and one dialog layer.
  let workspace: ReactElement | null = null;
  if (
    longTextTarget !== null &&
    longTextScene !== undefined &&
    longTextNode?.type === "long_text"
  ) {
    workspace = (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <LongTextWorkspace
            animationMap={animationMap}
            assets={project.assets}
            dirty={dirty}
            importTokens={activeImportTokens}
            key={`${longTextTarget.sceneId}/${longTextTarget.nodeId}`}
            node={longTextNode}
            nodeId={longTextTarget.nodeId}
            onBack={() => {
              if (flushBeforeNavigation()) setRoute(STORY_ROUTE);
            }}
            onChange={(next) => changeNode(longTextTarget.nodeId, next)}
            onPreviewSettingsChange={(settings) =>
              commit((draft) => {
                draft.layout.timeline_previews ??= {};
                draft.layout.timeline_previews[
                  `${longTextTarget.sceneId}/${longTextTarget.nodeId}`
                ] = settings;
              }, false)
            }
            onRedo={redo}
            onSave={() => void saveProject()}
            onSplitLongText={(stepIndex) =>
              splitLongText(longTextTarget.nodeId, stepIndex)
            }
            onUndo={undo}
            project={project}
            redoAvailable={future.length > 0}
            sceneId={longTextTarget.sceneId}
            undoAvailable={past.length > 0}
          />
        </Suspense>
      </>
    );
  }
  if (
    mapWorkspace &&
    project.chapter_map !== null &&
    project.chapter_map !== undefined
  ) {
    workspace = (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <ChapterMapWorkspace
            animationMap={animationMap}
            assets={project.assets}
            dirty={dirty}
            manifest={project.manifest}
            map={project.chapter_map.definition}
            onChange={(definition) => {
              const mutate = (draft: EditorProject): void => {
                if (
                  draft.chapter_map !== null &&
                  draft.chapter_map !== undefined
                ) {
                  draft.chapter_map.definition = definition;
                }
              };
              // Pointer gestures and inspector edits are opened explicitly by
              // the workspace. Keep every intermediate update inside that
              // active edit so pointer-down → pointer-up produces one undo
              // record instead of one record per pointermove.
              const active = editorStateRef.current.activeEdit;
              if (active?.id.startsWith("map:")) updateEdit(active.id, mutate);
              else commit(mutate, true, "编辑章节地图");
            }}
            onClose={() => {
              if (!flushEditorEdits()) {
                setError("地图检查器中存在未提交或无效输入，请修正后再离开。");
                return;
              }
              setRoute(STORY_ROUTE);
            }}
            onSelectionChange={setMapSelectionId}
            activeEdit={activeEdit}
            onBeginEdit={beginEdit}
            onSetEditDraft={setEditDraft}
            onSetEditError={setEditError}
            onCommitEdit={commitEdit}
            onCancelEdit={cancelEdit}
            onRedo={redo}
            onSave={() => void saveProject()}
            onUndo={undo}
            onValidate={() => {
              if (!flushEditorEdits()) {
                setError("地图检查器中存在未提交或无效输入，请修正后再校验。");
                return;
              }
              const current = projectRef.current;
              if (current === null) return;
              void editorApi
                .validateProject(projectRequest(current, activeImportTokens))
                .then(() => setNotice("章节地图已通过完整校验。"))
                .catch((reason: unknown) => reportCommandError(reason));
            }}
            redoAvailable={future.length > 0}
            sceneIds={project.scenes.map((file) => file.definition.id)}
            selectionId={mapSelectionId}
            undoAvailable={past.length > 0}
          />
        </Suspense>
      </>
    );
  }
  if (buttonTarget !== null && buttonFile !== undefined) {
    workspace = (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <ButtonWorkspace
            animationMap={animationMap}
            assets={project.assets}
            dirty={dirty}
            file={buttonFile}
            onBack={() => {
              if (flushBeforeNavigation()) setRoute(STORY_ROUTE);
            }}
            onChange={(file) =>
              commit((draft) => {
                const index = (draft.buttons ?? []).findIndex(
                  (candidate) => candidate.definition.id === buttonTarget,
                );
                if (index >= 0 && draft.buttons !== undefined)
                  draft.buttons[index] = file;
              })
            }
            onRedo={redo}
            onSave={() => void saveProject()}
            onUndo={undo}
            redoAvailable={future.length > 0}
            undoAvailable={past.length > 0}
          />
        </Suspense>
      </>
    );
  }
  if (actionTarget !== null && actionFile !== undefined) {
    workspace = (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <ActionWorkspace
            animationMap={animationMap}
            assets={project.assets}
            definition={actionFile.definition}
            dirty={dirty}
            onBack={() => {
              if (flushBeforeNavigation()) setRoute(STORY_ROUTE);
            }}
            onChange={(definition) =>
              commit((draft) => {
                const files = draft.actions;
                if (files === undefined) return;
                const index = files.findIndex(
                  (candidate) => candidate.definition.id === actionTarget,
                );
                if (index >= 0) files[index] = { ...actionFile, definition };
              })
            }
            onRedo={redo}
            onSave={() => void saveProject()}
            onUndo={undo}
            redoAvailable={future.length > 0}
            undoAvailable={past.length > 0}
            onValidate={() => {
              if (!flushEditorEdits()) {
                setError("动作工作区存在未提交或无效输入，请修正后再校验。");
                return;
              }
              const current = projectRef.current;
              if (current === null) return;
              void editorApi
                .validateProject(projectRequest(current, activeImportTokens))
                .then(() => setNotice("立绘动作已通过完整校验。"))
                .catch((reason: unknown) => reportCommandError(reason));
            }}
            path={actionFile.path}
          />
        </Suspense>
      </>
    );
  }

  if (uiMotionTarget !== null && uiMotionFile !== undefined) {
    workspace = (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <UiMotionWorkspace
            animationMap={animationMap}
            assets={project.assets}
            defaultFontId={project.manifest.default_font}
            dirty={dirty}
            file={uiMotionFile}
            onBack={() => {
              if (flushBeforeNavigation()) setRoute(STORY_ROUTE);
            }}
            onChange={(file) =>
              commit((draft) => {
                const index = draft.ui_motions.findIndex(
                  (candidate) => candidate.definition.id === uiMotionTarget,
                );
                if (index >= 0) draft.ui_motions[index] = file;
              })
            }
            onRedo={redo}
            onSave={() => void saveProject()}
            onUndo={undo}
            redoAvailable={future.length > 0}
            undoAvailable={past.length > 0}
          />
        </Suspense>
      </>
    );
  }

  if (gameplayTarget !== null) {
    workspace = (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <GameplayPreview
            autoStart={gameplayTarget.autoStart}
            importTokens={activeImportTokens}
            key={`${gameplayTarget.sceneId}/${gameplayTarget.nodeId ?? ""}`}
            nodeId={gameplayTarget.nodeId}
            onBack={() => setRoute(gameplayTarget.returnTo ?? STORY_ROUTE)}
            onError={setError}
            project={project}
            sceneId={gameplayTarget.sceneId}
          />
        </Suspense>
      </>
    );
  }

  const timelineScene = findScene(project, timelineTarget?.sceneId ?? "");
  const timelineNode =
    timelineTarget === null
      ? undefined
      : timelineScene?.definition.nodes[timelineTarget.nodeId];
  if (timelineTarget !== null && timelineNode?.type === "timeline") {
    const previewKey = `${timelineTarget.sceneId}/${timelineTarget.nodeId}`;
    workspace = (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <TimelineWorkspace
            assets={project.assets}
            dirty={dirty}
            importTokens={activeImportTokens}
            futureAvailable={future.length > 0}
            pastAvailable={past.length > 0}
            node={timelineNode}
            nodeId={timelineTarget.nodeId}
            onBack={() => {
              if (flushBeforeNavigation()) setRoute(STORY_ROUTE);
            }}
            onChange={(node) => changeNode(timelineTarget.nodeId, node)}
            onError={setError}
            onPreviewSettingsChange={(settings) =>
              commit((draft) => {
                draft.layout.timeline_previews ??= {};
                draft.layout.timeline_previews[previewKey] = settings;
              }, false)
            }
            onRedo={redo}
            onSave={() => void saveProject()}
            onUndo={undo}
            project={project}
            previewSettings={project.layout.timeline_previews?.[previewKey]}
            sceneId={timelineTarget.sceneId}
          />
        </Suspense>
      </>
    );
  }

  return (
    <AssetLayoutProvider layout={project.layout}>
      {workspace ?? (
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
            onOpenProject={() => void openProject()}
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
            onToggleRightPanel={() =>
              setRightPanelVisible((visible) => !visible)
            }
            onUndo={undo}
            onValidate={validateWholeProject}
            projectName={project.root.split(/[\\/]/).at(-1) ?? project.root}
            rightPanelVisible={rightPanelVisible}
            saving={saving}
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
              onAddScene={addScene}
              onDeleteScene={deleteScene}
              onImportAssets={importAssets}
              pendingAssetIds={pendingAssetIds}
              reservedAssetPaths={reservedReplacementPaths}
              onChangeAssetLayout={(mutate, label) =>
                commit(
                  (draft) => {
                    draft.layout = mutate(draft.layout);
                  },
                  true,
                  label,
                )
              }
              onManifestChange={(manifest: ContentManifest) =>
                commit((draft) => void (draft.manifest = manifest))
              }
              onRemoveAsset={(id) => {
                const currentProject =
                  editorStateRef.current.project ?? project;
                const references = findAssetReferences(currentProject, id);
                if (references.length > 0) {
                  setError(
                    `素材 ${id} 仍被 ${references.length} 处内容引用${formatReferenceList(references)}，不能从清单移除。`,
                  );
                  return false;
                }
                commitUndoable(
                  (draft) => removeAssetRegistration(draft, id),
                  "移除素材",
                  `已从项目移除素材 ${id}（文件仍保留在磁盘上）。`,
                );
                return true;
              }}
              onCreateImageAnimation={createImageAnimation}
              onSelectAsset={(id) => {
                setAssetSelectionId(id);
                if (id !== null) setSidebarTab("assets");
              }}
              onAddVariable={(id, definition) => {
                const reason = idUnavailableReason(
                  "variable",
                  id,
                  editorStateRef.current.project ?? project,
                );
                if (reason !== null) {
                  setError(reason);
                  return false;
                }
                commit((draft) => {
                  draft.manifest.variables[id] = definition;
                });
                return true;
              }}
              onChangeVariable={(id, definition) =>
                commit((draft) => {
                  draft.manifest.variables[id] = definition;
                })
              }
              onDeleteVariable={(id) => {
                const currentProject =
                  editorStateRef.current.project ?? project;
                const references = countVariableReferences(currentProject, id);
                if (references > 0) {
                  setError(
                    `变量 ${id} 仍被 ${references} 处剧情引用，不能删除。`,
                  );
                  return;
                }
                commit((draft) => {
                  Reflect.deleteProperty(draft.manifest.variables, id);
                });
              }}
              onRenameScene={(previousId, nextId) => {
                const currentProject =
                  editorStateRef.current.project ?? project;
                const reason = idUnavailableReason(
                  "scene",
                  nextId,
                  currentProject,
                  { previous: previousId },
                );
                if (reason !== null) {
                  setError(reason);
                  return false;
                }
                void confirm({
                  title: `把场景 ${previousId} 重命名为 ${nextId}？`,
                  description:
                    "场景文件路径与项目内的所有跳转都会一并更新；但玩家已有存档中记录的旧场景 ID 将无法恢复。",
                  confirmLabel: "重命名并更新引用",
                }).then((accepted) => {
                  if (!accepted) return;
                  commit((draft) =>
                    renameScene(currentPlainProject(draft), previousId, nextId),
                  );
                  setActiveSceneId(nextId);
                });
                return true;
              }}
              onRenameVariable={(previousId, nextId) => {
                const currentProject =
                  editorStateRef.current.project ?? project;
                const reason = idUnavailableReason(
                  "variable",
                  nextId,
                  currentProject,
                );
                if (reason !== null) {
                  setError(reason);
                  return false;
                }
                commit((draft) =>
                  renameVariable(
                    currentPlainProject(draft),
                    previousId,
                    nextId,
                  ),
                );
                return true;
              }}
              onAddCharacter={(id, definition) => {
                const currentProject =
                  editorStateRef.current.project ?? project;
                const reason = idUnavailableReason(
                  "character",
                  id,
                  currentProject,
                );
                if (reason !== null) {
                  setError(reason);
                  return false;
                }
                commit((draft) => {
                  draft.manifest.characters[id] = definition;
                });
                return true;
              }}
              onChangeCharacter={(id, definition) =>
                commit((draft) => {
                  draft.manifest.characters[id] = definition;
                })
              }
              onDeleteCharacter={(id) => {
                const currentProject =
                  editorStateRef.current.project ?? project;
                const references = countCharacterReferences(currentProject, id);
                if (references > 0) {
                  setError(
                    `角色 ${id} 仍被 ${references} 句对话引用，不能删除。`,
                  );
                  return;
                }
                commit((draft) => {
                  Reflect.deleteProperty(draft.manifest.characters, id);
                });
              }}
              onRenameCharacter={(previousId, nextId) => {
                const currentProject =
                  editorStateRef.current.project ?? project;
                const reason = idUnavailableReason(
                  "character",
                  nextId,
                  currentProject,
                );
                if (reason !== null) {
                  setError(reason);
                  return false;
                }
                commit((draft) =>
                  renameCharacter(
                    currentPlainProject(draft),
                    previousId,
                    nextId,
                  ),
                );
                return true;
              }}
              onCreateUiMotion={openCreateUiMotion}
              onEditUiMotion={(motionId) => {
                if (!flushBeforeNavigation()) return;
                setRoute({ kind: "uiMotion", id: motionId });
              }}
              onDeleteUiMotion={deleteUiMotion}
              onCreateButtonTemplate={openCreateButton}
              onEditButtonTemplate={(buttonId) => {
                if (!flushBeforeNavigation()) return;
                setRoute({ kind: "button", id: buttonId });
              }}
              onDuplicateButtonTemplate={duplicateButtonTemplate}
              onDeleteButtonTemplate={deleteButtonTemplate}
              onCreateAction={(id) => {
                if (!flushBeforeNavigation()) return false;
                return createSpriteAction(id);
              }}
              onRenameAction={(previousId, nextId) => {
                const currentProject =
                  editorStateRef.current.project ?? project;
                const normalized = nextId.trim();
                const reason = idUnavailableReason(
                  "action",
                  normalized,
                  currentProject,
                  { previous: previousId },
                );
                if (reason !== null) {
                  setError(reason);
                  return false;
                }
                commit((draft) => {
                  const renamed = renameSpriteAction(
                    currentPlainProject(draft),
                    previousId,
                    normalized,
                  );
                  draft.actions = renamed.actions;
                  draft.manifest.actions = renamed.manifest.actions;
                  draft.scenes = renamed.scenes;
                });
                setNotice(`已重命名立绘动作 ${previousId} → ${normalized}。`);
                return true;
              }}
              onDuplicateAction={duplicateSpriteAction}
              onDeleteAction={deleteSpriteAction}
              onEditActionKeyframes={(id) => {
                if (!flushBeforeNavigation()) return;
                setRoute({ kind: "action", id });
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
              onToggleSidebarItem={(key) =>
                setSidebarItemOpen((current) => ({
                  ...current,
                  [key]: !(current[key] ?? true),
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
          <ResizeHandle axis="left" onStart={startResize} onStep={resizeBy} />

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
                  ? "Ctrl/⌘ 或 Shift 点击多选 · 右键组合/解散布局组（Ctrl+L 或 Ctrl+Shift+L）· Ctrl+Enter 预览"
                  : "Enter 插入下一句 · Shift+Enter 换行 · Ctrl/⌘ 点击多选"}
              </span>
            </div>
            {activeScene !== undefined && sceneViewMode === "graph" ? (
              <StoryGraph
                deleteDisabled={
                  deleteRequest !== null ||
                  uiMotionDialog !== null ||
                  buttonDialog !== null
                }
                diagnostics={diagnostics}
                layout={project.layout.scenes[activeSceneId]}
                manifest={project.manifest}
                onAddNode={addNode}
                onDuplicate={duplicateNode}
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
                onSetEntry={(nodeId) =>
                  commit((draft) => {
                    const file = findScene(draft, activeSceneId);
                    if (file !== undefined) file.definition.entry = nodeId;
                  })
                }
                onCopy={copyNode}
                onDelete={deleteNode}
                onConnect={(sourceId, handle, targetId) =>
                  commit((draft) => {
                    const file = findScene(draft, activeSceneId);
                    if (
                      file === undefined ||
                      file.definition.nodes[sourceId] === undefined
                    )
                      return;
                    file.definition.nodes[sourceId] = setPortTarget(
                      file.definition.nodes[sourceId],
                      handle,
                      targetId,
                    );
                  })
                }
                onMoveMany={(positions) =>
                  commit((draft) => {
                    // `positions` is a partial batch (a group drag commits only
                    // its descendants), so merge it and keep every unrelated
                    // node position intact.
                    const sceneLayout = ensureSceneLayout(
                      draft.layout,
                      activeSceneId,
                    );
                    Object.assign(sceneLayout.nodes, positions);
                  })
                }
                onSetGroups={(groups) =>
                  commit((draft) => {
                    ensureSceneLayout(draft.layout, activeSceneId).groups =
                      groups;
                  })
                }
                onMoveNode={(nodeId, position: NodePosition) =>
                  commit((draft) => {
                    ensureSceneLayout(draft.layout, activeSceneId).nodes[
                      nodeId
                    ] = position;
                  })
                }
                onPaste={pasteNode}
                onQuickInsert={quickInsertNode}
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
                onViewport={(viewport) =>
                  commit((draft) => {
                    ensureSceneLayout(draft.layout, activeSceneId).viewport =
                      viewport;
                  }, false)
                }
                scene={activeScene}
                selectedNodeId={selectedNodeId}
              />
            ) : activeScene !== undefined ? (
              <ScriptView
                deleteDisabled={
                  deleteRequest !== null ||
                  uiMotionDialog !== null ||
                  buttonDialog !== null
                }
                manifest={project.manifest}
                onChange={changeNode}
                onDelete={deleteNode}
                onDeleteMany={deleteNodes}
                onBatchSpeaker={batchChangeSpeaker}
                onCommitAndInsertAfter={insertSayAfterWithText}
                onBeginEdit={beginEdit}
                onSetEditDraft={setEditDraft}
                onSetEditError={setEditError}
                onUpdateNode={updateNodeEdit}
                onEditText={(nodeId, text) => {
                  const editId = `say:${activeSceneId}:${nodeId}`;
                  updateEdit(editId, (draft) => {
                    const file = findScene(draft, activeSceneId);
                    const node = file?.definition.nodes[nodeId];
                    if (node?.type === "say") node.text = text;
                  });
                  setEditDraft(editId, "text", text, false);
                }}
                onCommitEdit={commitEdit}
                onCancelEdit={cancelEdit}
                activeEdit={activeEdit}
                onInsertAfter={insertSayAfter}
                onInsertBatch={insertSayBatch}
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
              onChange={changeNode}
              onDelete={deleteNode}
              onDuplicate={duplicateNode}
              onConvertToTimeline={convertNodeToTimeline}
              onConvertActionToTimeline={convertActionNodeToTimeline}
              onSplitDialogue={splitDialogue}
              onSplitLongText={splitLongText}
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
              previewVariableOverrides={
                choicePreviewSettings.variable_overrides
              }
              previewChoices={choicePreviewSettings.choices}
              onLocateNode={(nodeId) => {
                if (!flushBeforeNavigation()) return;
                setSelectedNodeId(nodeId);
              }}
              onRename={(previousId, nextId) => {
                const reason = idUnavailableReason("node", nextId, project, {
                  sceneId: activeSceneId,
                });
                if (reason !== null) {
                  setError(reason);
                  return;
                }
                commit((draft) =>
                  renameNode(
                    currentPlainProject(draft),
                    activeSceneId,
                    previousId,
                    nextId,
                  ),
                );
                setSelectedNodeId(nextId);
              }}
              onSetEntry={(nodeId) =>
                commit((draft) => {
                  const file = findScene(draft, activeSceneId);
                  if (file !== undefined) file.definition.entry = nodeId;
                })
              }
              scene={activeScene}
            />
          )}
          <ResizeHandle axis="right" onStart={startResize} onStep={resizeBy} />
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
      )}
      {uiMotionDialog !== null && (
        <IdEntryDialog
          dialogLabel="创建 UI 动效"
          fieldLabel="UI 动效 ID"
          initialValue={uiMotionDialog}
          onCancel={() => setUiMotionDialog(null)}
          onSubmit={(value) => {
            if (createUiMotion(value)) setUiMotionDialog(null);
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
            if (createButtonTemplate(value)) setButtonDialog(null);
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
            executeDeleteNodes(deleteRequest.nodeIds, fallback)
          }
          options={deleteRequest.options}
        />
      )}
    </AssetLayoutProvider>
  );
}

function contentDocumentFingerprint(project: EditorProject): string {
  // Editor scalar integers are bigint so that i64 values never pass through
  // a lossy JavaScript number.  Fingerprints are only used for change
  // detection, but must still be deterministic and must not throw when a
  // project contains a bigint default/value.
  return JSON.stringify(
    {
      manifest: project.manifest,
      scenes: project.scenes,
      ui_motions: project.ui_motions,
      buttons: project.buttons ?? [],
      animations: project.animations ?? [],
      actions: project.actions ?? [],
      chapter_map: project.chapter_map,
    },
    (_key, value: unknown) =>
      typeof value === "bigint"
        ? { __vectspace_integer__: value.toString() }
        : value,
  );
}
