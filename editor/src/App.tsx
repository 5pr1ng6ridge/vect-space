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
import { createProjectSectionState } from "./components/projectSections";
import {
  ProjectSidebar,
  type ImportDraft,
  type SidebarTab,
} from "./components/ProjectSidebar";
import { StoryGraph } from "./components/StoryGraph";
import { ScriptView } from "./components/ScriptView";
import {
  NODE_TYPES,
  convertToTimeline as convertQuickNodeToTimeline,
  countCharacterReferences,
  countVariableReferences,
  defaultNode,
  ensureSceneLayout,
  findScene,
  insertNode,
  newSceneFile,
  nodeLabel,
  outputPorts,
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
  SpriteActionDefinition,
  SpriteSnapshot,
} from "./types";
import { validateLive } from "./validation";
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
  left: 252,
  right: 330,
};

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

export function App(): ReactElement {
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
  const [addType, setAddType] = useState<NodeType>("say");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("scenes");
  // Sidebar view state lives here because App survives the early-return
  // keyframe/full-screen workspaces that unmount ProjectSidebar, and because
  // collapse/scroll preferences are UI-only: they must never dirty content.
  const [sidebarSections, setSidebarSections] = useState(
    createProjectSectionState,
  );
  const sidebarScrollRef = useRef<Partial<Record<SidebarTab, number>>>({});
  const handleSidebarScroll = useCallback(
    (tab: SidebarTab, offset: number): void => {
      sidebarScrollRef.current[tab] = offset;
    },
    [],
  );
  const [assetSelectionId, setAssetSelectionId] = useState<string | null>(null);
  const [panelsVisible, setPanelsVisible] = useState(true);
  const [timelineTarget, setTimelineTarget] = useState<{
    sceneId: string;
    nodeId: string;
  } | null>(null);
  const [longTextTarget, setLongTextTarget] = useState<{
    sceneId: string;
    nodeId: string;
  } | null>(null);
  const [uiMotionTarget, setUiMotionTarget] = useState<string | null>(null);
  const [actionTarget, setActionTarget] = useState<string | null>(null);
  const [uiMotionDialog, setUiMotionDialog] = useState<string | null>(null);
  const [buttonTarget, setButtonTarget] = useState<string | null>(null);
  const [buttonDialog, setButtonDialog] = useState<string | null>(null);
  const [mapWorkspace, setMapWorkspace] = useState(false);
  const [mapSelectionId, setMapSelectionId] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<{
    nodeIds: string[];
    options: { id: string; label: string }[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // Keep a synchronous lock alongside React state.  Pointer/text callbacks
  // can run before the next render while an async open/save is in flight;
  // the reducer entry points consult this ref to reject those late edits.
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(DEFAULT_PANEL_SIZES);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const nodeClipboardRef = useRef<NodeClipboard | null>(null);
  const projectRef = useRef<EditorProject | null>(null);
  const editorStateRef = useRef(editorState);
  const pendingImportsRef = useRef<Record<string, string>>({});
  const [pendingImports, setPendingImports] = useState<Record<string, string>>(
    {},
  );
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
  // unsaved map/timeline preview fail with “missing asset”.
  const activeImportTokens = useMemo(
    () =>
      project === null
        ? []
        : Object.entries(pendingImports)
            .filter(([, id]) => project.manifest.assets[id] !== undefined)
            .map(([token]) => token),
    [pendingImports, project],
  );

  const flushEditorEdits = useCallback((): boolean => {
    let valid = true;
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
  }, [flushEditorEdits]);

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

  const reportCommandError = useCallback((reason: unknown): void => {
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
  }, []);

  const commit = useCallback(
    (
      mutator: (draft: EditorProject) => unknown,
      history = true,
      label = "编辑项目",
      mergeActive = false,
    ): void => {
      // The host save transaction is the document lock.  UI controls remain
      // mounted while it runs, so reject late pointer/text events instead of
      // allowing an edit to race `mark_saved` and get overwritten by the
      // response's project payload.
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

  const beginEdit = useCallback((id: string, label: string): void => {
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
  }, []);

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
    if (!flushEditorEdits()) return;
    if (
      (dirty ||
        (projectRef.current !== null &&
          contentDocumentFingerprint(projectRef.current) !==
            savedContentRef.current)) &&
      !window.confirm("当前项目有未保存的更改，仍要打开其他项目吗？")
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
      savedContentRef.current = contentDocumentFingerprint(loaded);
      savedContentVersionRef.current = loaded.manifest.content_version;
      const initialScene =
        loaded.manifest.entry_scene || loaded.scenes[0]?.definition.id || "";
      setActiveSceneId(initialScene);
      setAssetSelectionId(null);
      setSelectedNodeId(null);
      setTimelineTarget(null);
      setLongTextTarget(null);
      setUiMotionTarget(null);
      setActionTarget(null);
      setButtonTarget(null);
      setButtonDialog(null);
      setMapWorkspace(false);
      setMapSelectionId(null);
      localStorage.setItem("vectspace-editor:last-project", loaded.root);
      setNotice(`已打开 ${loaded.root}`);
    } catch (reason) {
      reportCommandError(reason);
    } finally {
      setEditorBusy(false);
    }
  };

  const saveProject = useCallback(async (): Promise<void> => {
    if (!flushEditorEdits()) return;
    const currentProject = projectRef.current;
    if (currentProject === null) return;
    /*if (
      contentDocumentFingerprint(currentProject) !== savedContentRef.current &&
      currentProject.manifest.content_version ===
        savedContentVersionRef.current &&
      !window.confirm(
        "剧情、动效或流程内容已经改变，但 content_version 没有更新。继续保存会保留旧的已读、历史和完成状态。仍要保存吗？",
      )
    ) {
      return;
    }*/
    const currentDiagnostics = validateLive(currentProject);
    const errors = currentDiagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    if (errors.length > 0) {
      setSidebarTab("problems");
      setError(`存在 ${errors.length} 个错误，修复后才能保存。`);
      return;
    }
    setEditorBusy(true);
    setError(null);
    try {
      const requestTokens = Object.entries(pendingImportsRef.current)
        .filter(([, id]) => currentProject.manifest.assets[id] !== undefined)
        .map(([token]) => token);
      const request = projectRequest(currentProject, requestTokens);
      await editorApi.validateProject(request);
      const result = await editorApi.saveProject(request);
      const saved = result.project;
      dispatchEditor({ type: "mark_saved", project: saved });
      setPendingImports({});
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
      setNotice(
        warningText.length > 0 ? `${summary} 警告：${warningText}` : summary,
      );
    } catch (reason) {
      reportCommandError(reason);
    } finally {
      setEditorBusy(false);
    }
  }, [flushEditorEdits, reportCommandError, setEditorBusy]);

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
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProject();
      } else if (event.key.toLowerCase() === "z" && !event.shiftKey) {
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

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (project === null) {
    const recent = localStorage.getItem("vectspace-editor:last-project");
    return (
      <main className="welcome-shell">
        <div className="welcome-grid" />
        <section className="welcome-card">
          <div className="brand-mark">V</div>
          <span className="eyebrow">VECTSPACE AUTHORING TOOL</span>
          <h1>Story Graph Editor</h1>
          <p>
            用有向节点图编辑 YAML 剧情，并由游戏运行时在保存前完成权威校验。
          </p>
          <button
            className="welcome-primary"
            disabled={busy}
            onClick={() => void openProject()}
            type="button"
          >
            打开项目目录
          </button>
          {recent !== null && (
            <button
              className="recent-project"
              disabled={busy}
              onClick={() => void openProject(recent)}
              type="button"
            >
              <span>最近项目</span>
              <code>{recent}</code>
            </button>
          )}
          {error !== null && <div className="welcome-error">{error}</div>}
          <small>
            可选择仓库根目录，或直接选择包含 manifest.yaml 的 game 目录。
          </small>
        </section>
      </main>
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
      setTimelineTarget({ sceneId, nodeId });
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
      setTimelineTarget({ sceneId: activeSceneId, nodeId });
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

  const addNode = (): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    let insertedId = "";
    let committed = false;
    flushSync(() =>
      commit((draft) => {
        const base = structuredClone(currentPlainProject(draft));
        const file = findScene(base, activeSceneId);
        if (file === undefined) return undefined;
        insertedId = uniqueNodeId(file.definition, addType);
        const fallback =
          file.definition.entry ||
          Object.keys(file.definition.nodes)[0] ||
          insertedId;
        file.definition.nodes[insertedId] = defaultNode(addType, fallback);
        const sceneLayout = ensureSceneLayout(base.layout, activeSceneId);
        const count = Object.keys(file.definition.nodes).length;
        sceneLayout.nodes[insertedId] = {
          x: (count % 4) * 300,
          y: Math.floor(count / 4) * 210,
        };
        committed = true;
        return base;
      }),
    );
    if (!committed) {
      setError("添加节点失败：场景已发生变化，请重新尝试。\n");
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
    commit(
      (draft) => {
        const target = findScene(draft, activeSceneId);
        if (
          target === undefined ||
          target.definition.nodes[fallback] === undefined
        )
          return;
        for (const id of nodeIds)
          Reflect.deleteProperty(target.definition.nodes, id);
        if (removed.has(target.definition.entry))
          target.definition.entry = fallback;
        for (const file of draft.scenes) {
          for (const [candidateId, candidate] of Object.entries(
            file.definition.nodes,
          )) {
            let changed = candidate;
            if (file.definition.id === activeSceneId) {
              for (const port of outputPorts(changed)) {
                if (port.targetScene === null && removed.has(port.target))
                  changed = setPortTarget(changed, port.id, fallback);
              }
            }
            if (
              changed.type === "jump" &&
              (changed.scene ?? file.definition.id) === activeSceneId &&
              removed.has(changed.target)
            ) {
              changed = { ...changed, target: fallback };
            }
            file.definition.nodes[candidateId] = changed;
          }
        }
        const sceneLayout = ensureSceneLayout(draft.layout, activeSceneId);
        for (const id of nodeIds) Reflect.deleteProperty(sceneLayout.nodes, id);
        if (draft.layout.timeline_previews !== undefined) {
          for (const id of nodeIds)
            Reflect.deleteProperty(
              draft.layout.timeline_previews,
              `${activeSceneId}/${id}`,
            );
          for (const settings of Object.values(
            draft.layout.timeline_previews,
          )) {
            settings.choices = settings.choices.filter(
              (choice) =>
                choice.scene_id !== activeSceneId ||
                !removed.has(choice.node_id),
            );
          }
        }
      },
      true,
      nodeIds.length === 1 ? "删除脚本节点" : "删除脚本片段",
    );
    setDeleteRequest(null);
    setSelectedNodeId(null);
    if (
      longTextTarget?.sceneId === activeSceneId &&
      longTextTarget.nodeId !== null &&
      removed.has(longTextTarget.nodeId)
    ) {
      setLongTextTarget(null);
    }
  };

  const deleteNode = (nodeId: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (
      currentScene === undefined ||
      Object.keys(currentScene.nodes).length <= 1
    ) {
      setError("场景至少需要保留一个节点。");
      return;
    }
    const node = currentScene.nodes[nodeId];
    if (node === undefined) return;
    if (node.type === "long_text" && (node.mode ?? "start") === "start") {
      const documentId = node.document ?? nodeId;
      const references = Object.entries(currentScene.nodes).filter(
        ([candidateId, candidate]) =>
          candidateId !== nodeId &&
          ((candidate.type === "long_text" &&
            candidate.document === documentId &&
            candidate.mode === "continue") ||
            (candidate.type === "long_text_control" &&
              candidate.document === documentId)),
      ).length;
      if (references > 0) {
        setError(
          `文稿 ${documentId} 仍被 ${references} 个接续或控制节点引用，不能删除开始节点。`,
        );
        return;
      }
    }
    const outgoing = outputPorts(node).filter(
      (port) => port.target !== nodeId && port.targetScene === null,
    );
    const successorIds = [...new Set(outgoing.map((port) => port.target))];
    const options = successorIds.map((id) => ({
      id,
      label:
        outgoing.find((port) => port.target === id)?.label ?? `后继 · ${id}`,
    }));
    if (options.length === 0) {
      for (const id of Object.keys(currentScene.nodes).sort()) {
        if (id !== nodeId) options.push({ id, label: `保留节点 · ${id}` });
      }
    }
    if (options.length === 0) {
      setError("删除后没有可保留的节点。");
      return;
    }
    if (options.length === 1) {
      if (!window.confirm(`删除节点 ${nodeId}？入口和指向它的连线将重定向。`))
        return;
      executeDeleteNodes([nodeId], options[0].id);
      return;
    }
    setDeleteRequest({ nodeIds: [nodeId], options });
  };

  const duplicateNode = (nodeId: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    const id = uniqueNodeId(currentScene, `${nodeId}_copy`);
    commit((draft) => {
      const file = findScene(draft, activeSceneId);
      const source = file?.definition.nodes[nodeId];
      if (file === undefined || source === undefined) return;
      file.definition.nodes[id] = structuredClone(source);
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
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
      findScene(currentProject, id) !== undefined
    ) {
      setError("场景 ID 非法或已经存在。");
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
    if (
      !window.confirm(
        `从 manifest 移除场景 ${sceneId}？原 YAML 文件会作为可恢复副本保留。`,
      )
    )
      return;
    commit((draft) => {
      const file = findScene(draft, sceneId);
      draft.scenes = draft.scenes.filter(
        (candidate) => candidate.definition.id !== sceneId,
      );
      if (file !== undefined) {
        draft.manifest.scenes = draft.manifest.scenes.filter(
          (path) => path !== file.path,
        );
      }
      Reflect.deleteProperty(draft.layout.scenes, sceneId);
      if (draft.layout.timeline_previews !== undefined) {
        for (const key of Object.keys(draft.layout.timeline_previews)) {
          if (key.startsWith(`${sceneId}/`))
            Reflect.deleteProperty(draft.layout.timeline_previews, key);
        }
        for (const settings of Object.values(draft.layout.timeline_previews)) {
          settings.choices = settings.choices.filter(
            (choice) => choice.scene_id !== sceneId,
          );
        }
      }
      if (draft.chapter_map !== null && draft.chapter_map !== undefined) {
        draft.chapter_map.definition.hotspots =
          draft.chapter_map.definition.hotspots.filter(
            (hotspot) => hotspot.scene_id !== sceneId,
          );
      }
    });
    const next =
      currentProject.scenes.find((file) => file.definition.id !== sceneId)
        ?.definition.id ?? "";
    if (longTextTarget?.sceneId === sceneId) setLongTextTarget(null);
    setActiveSceneId(next);
    setSelectedNodeId(null);
  };

  const deleteNodes = (nodeIds: string[]): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const currentScene = findScene(currentProject, activeSceneId)?.definition;
    if (currentScene === undefined) return;
    const ids = [...new Set(nodeIds)].filter(
      (id) => currentScene.nodes[id] !== undefined,
    );
    if (ids.length <= 1) {
      if (ids.length === 1) deleteNode(ids[0]);
      return;
    }
    if (Object.keys(currentScene.nodes).length <= ids.length) {
      setError("场景至少需要保留一个节点。");
      return;
    }
    const removed = new Set(ids);
    // Script multi-select is intentionally limited to one contiguous linear
    // segment.  Refuse a set that crosses a branch, a merge, or two unrelated
    // rows instead of silently reconnecting both regions to one successor.
    const internalSuccessors = new Map<string, string>();
    const internalPredecessorCount = new Map<string, number>();
    for (const id of ids) {
      const targets = outputPorts(currentScene.nodes[id])
        .filter((port) => port.targetScene === null && removed.has(port.target))
        .map((port) => port.target);
      if (targets.length > 1) {
        setError("只能删除同一条连续链，所选节点跨越了分支出口。");
        return;
      }
      if (targets.length === 1) {
        internalSuccessors.set(id, targets[0]);
        internalPredecessorCount.set(
          targets[0],
          (internalPredecessorCount.get(targets[0]) ?? 0) + 1,
        );
      }
    }
    if ([...internalPredecessorCount.values()].some((count) => count > 1)) {
      setError("只能删除同一条连续链，所选节点包含了合流。");
      return;
    }
    const starts = ids.filter((id) => !internalPredecessorCount.has(id));
    const visited = new Set<string>();
    let cursor: string | undefined = starts[0];
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      cursor = internalSuccessors.get(cursor);
    }
    if (starts.length !== 1 || visited.size !== ids.length) {
      setError("请选择同一条连续链中的节点后再删除。");
      return;
    }
    const successors = new Set<string>();
    for (const id of ids) {
      for (const port of outputPorts(currentScene.nodes[id])) {
        if (port.targetScene === null && !removed.has(port.target))
          successors.add(port.target);
      }
    }
    const successorsList = [...successors].sort();
    const options = successorsList.map((id) => ({
      id,
      label: `后继 · ${id}`,
    }));
    if (options.length === 0) {
      for (const id of Object.keys(currentScene.nodes).sort()) {
        if (!removed.has(id)) options.push({ id, label: `保留节点 · ${id}` });
      }
    }
    if (options.length === 0) {
      setError("删除后没有可保留的节点。");
      return;
    }
    if (options.length === 1) {
      if (
        !window.confirm(
          `删除 ${ids.length} 个连续节点？受影响的入口将连接到 ${options[0].id}。`,
        )
      )
        return;
      executeDeleteNodes(ids, options[0].id);
      return;
    }
    setDeleteRequest({ nodeIds: ids, options });
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
    setMapWorkspace(true);
  };

  const createEmptyChapterMap = (): void => {
    const currentProject = projectRef.current;
    if (currentProject === null) return;
    const entry = currentProject.manifest.entry_scene;
    commit(
      (draft) => {
        draft.manifest.chapter_map = "chapter-map.yaml";
        draft.chapter_map = {
          path: "chapter-map.yaml",
          definition: {
            schema_version: 1,
            width: 1920,
            height: 1080,
            view_x: 960,
            view_y: 540,
            background: null,
            decorations: [],
            hotspots: [
              {
                id: entry,
                scene_id: entry,
                title: entry,
                x: 240,
                y: 460,
                width: 280,
                height: 160,
                z: 10,
                asset: null,
                reveal: { mode: "completed" as const },
                variable_overrides: {},
              },
            ],
          },
        };
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
        })),
      );
      const latestProject = editorStateRef.current.project;
      if (latestProject === null || latestProject.root !== importProject.root) {
        throw new Error("项目已切换；本次素材导入未附加到其他项目。");
      }
      const conflicts = imported
        .map((asset) => asset.id)
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
          draft.manifest.assets[asset.id] = {
            kind: asset.kind,
            path: asset.path,
          };
          draft.assets.push({
            ...asset,
            size_bytes: asset.size_bytes,
            metadata: sourceMetadata,
          });
        }
      });
      const stagedTokens = Object.fromEntries(
        imported
          .filter(
            (asset): asset is typeof asset & { token: string } =>
              asset.token !== undefined && asset.token !== null,
          )
          .map((asset) => [asset.token, asset.id]),
      );
      if (Object.keys(stagedTokens).length > 0) {
        setPendingImports((current) => {
          const next = { ...current, ...stagedTokens };
          // A Ctrl+S dispatched in the same browser turn must use the newly
          // minted capabilities rather than wait for React's layout effect.
          pendingImportsRef.current = next;
          return next;
        });
      }
      const reused = imported.filter(
        (asset) =>
          asset.reused_from !== undefined && asset.reused_from !== null,
      ).length;
      setNotice(
        reused > 0
          ? `已暂存 ${imported.length} 个素材（${reused} 个复用已有文件）；保存项目后写入 manifest。`
          : `已暂存 ${imported.length} 个素材；保存项目后写入 manifest。`,
      );
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
    if (!id) return false;
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
      project.ui_motions.some((file) => file.definition.id === id)
    ) {
      setError("UI 动效 ID 非法或已经存在。");
      return false;
    }
    const path = `ui/motions/${id.replaceAll(".", "_")}.yaml`;
    if (project.ui_motions.some((file) => file.path === path)) {
      setError(`动效文件路径 ${path} 已经存在。`);
      return false;
    }
    commit((draft) => {
      draft.manifest.ui_motions.push(path);
      draft.ui_motions.push({
        path,
        definition: {
          schema_version: 1,
          id,
          duration_ms: 280,
          tracks: [
            {
              target: "dialogue_root",
              channels: {
                offset_y: [
                  { at_ms: 0, value: 48, easing: "ease_out" },
                  { at_ms: 280, value: 0, easing: "linear" },
                ],
                opacity: [
                  { at_ms: 0, value: 0, easing: "ease_out" },
                  { at_ms: 280, value: 1, easing: "linear" },
                ],
              },
            },
          ],
        },
      });
    });
    setUiMotionTarget(id);
    return true;
  };

  const deleteUiMotion = (id: string): void => {
    let references = 0;
    if (project.manifest.ui_motion_defaults.dialogue_show === id)
      references += 1;
    if (project.manifest.ui_motion_defaults.dialogue_hide === id)
      references += 1;
    for (const file of project.scenes) {
      for (const node of Object.values(file.definition.nodes)) {
        if (node.type === "dialogue_ui" && node.motion === id) references += 1;
        if (node.type === "ui_motion_set" && node.motion === id)
          references += 1;
        if (node.type === "ui_motion_play" && node.motion === id)
          references += 1;
      }
    }
    if (references > 0) {
      setError(`UI 动效 ${id} 仍被 ${references} 处引用，不能删除。`);
      return;
    }
    if (
      !window.confirm(
        `从项目清单移除 UI 动效 ${id}？磁盘上的 YAML 文件会保留。`,
      )
    )
      return;
    commit((draft) => {
      const file = draft.ui_motions.find(
        (candidate) => candidate.definition.id === id,
      );
      if (file === undefined) return;
      draft.ui_motions = draft.ui_motions.filter(
        (candidate) => candidate.definition.id !== id,
      );
      draft.manifest.ui_motions = draft.manifest.ui_motions.filter(
        (path) => path !== file.path,
      );
    });
    if (uiMotionTarget === id) setUiMotionTarget(null);
    if (actionTarget === id) setActionTarget(null);
  };

  const openCreateButton = (): void => {
    if (!flushBeforeNavigation()) return;
    setButtonDialog("button.default");
  };

  const createButtonTemplate = (rawId: string): boolean => {
    const id = rawId.trim();
    const buttons = project.buttons ?? [];
    if (
      !id ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
      buttons.some((file) => file.definition.id === id)
    ) {
      setError("按钮模板 ID 非法或已经存在。");
      return false;
    }
    const path = `ui/buttons/${id.replaceAll(".", "_")}.yaml`;
    if (buttons.some((file) => file.path === path)) {
      setError(`按钮模板文件路径 ${path} 已经存在。`);
      return false;
    }
    commit((draft) => {
      draft.manifest.buttons ??= [];
      draft.manifest.buttons.push(path);
      draft.buttons ??= [];
      draft.buttons.push({
        path,
        definition: {
          schema_version: 1,
          id,
          width: 200,
          height: 80,
          asset_mode: "separate",
          fit: "stretch",
          normal: null,
          hover: null,
          pressed: null,
          animations: {},
        },
      });
    });
    setButtonTarget(id);
    return true;
  };

  const deleteButtonTemplate = (id: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const references = findButtonTemplateReferences(currentProject, id);
    if (references.length > 0) {
      setError(
        `按钮模板 ${id} 仍被 ${references.length} 处剧情引用（${references
          .slice(0, 8)
          .join("、")}${references.length > 8 ? "…" : ""}），不能删除。`,
      );
      return;
    }
    const file = (currentProject.buttons ?? []).find(
      (candidate) => candidate.definition.id === id,
    );
    if (file === undefined) return;
    if (
      !window.confirm(
        `从项目清单移除按钮模板 ${id}？磁盘上的 YAML 文件会保留。`,
      )
    )
      return;
    commit((draft) => {
      draft.buttons = (draft.buttons ?? []).filter(
        (candidate) => candidate.definition.id !== id,
      );
      draft.manifest.buttons = (draft.manifest.buttons ?? []).filter(
        (path) => path !== file.path,
      );
    });
    if (buttonTarget === id) setButtonTarget(null);
  };

  const createImageAnimation = (draft: AnimationDraft): boolean => {
    const currentProject = editorStateRef.current.project ?? project;
    const animations = currentProject.animations ?? [];
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(draft.id) ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(draft.assetId)
    ) {
      setError("图片动画 ID 或素材 ID 非法。");
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
    const actions = currentProject.actions ?? [];
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
      actions.some((file) => file.definition.id === id) ||
      currentProject.manifest.assets[id] !== undefined ||
      (currentProject.animations ?? []).some(
        (file) => file.definition.id === id,
      )
    ) {
      setError("立绘动作 ID 非法、已存在或与素材/图片动画冲突。");
      return false;
    }
    const path = `actions/${id.replaceAll(".", "_")}.yaml`;
    if (actions.some((file) => file.path === path)) {
      setError(`立绘动作文件路径 ${path} 已经存在。`);
      return false;
    }
    const definition: SpriteActionDefinition = {
      schema_version: 1,
      id,
      name: "新立绘动作",
      duration_ms: 400,
      channels: {
        y: [
          { at_ms: 0, value: 0, easing: "linear" },
          { at_ms: 200, value: -18, easing: "ease_out" },
          { at_ms: 400, value: 0, easing: "ease_in" },
        ],
      },
      parameters: {},
      end: "hold",
    };
    commit((draft) => {
      draft.manifest.actions ??= [];
      draft.manifest.actions.push(path);
      draft.actions ??= [];
      draft.actions.push({ path, definition });
    });
    setNotice(`已创建立绘动作 ${id}。`);
    return true;
  };

  const deleteSpriteAction = (id: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const references: string[] = [];
    for (const scene of currentProject.scenes) {
      for (const [nodeId, node] of Object.entries(scene.definition.nodes)) {
        if (node.type === "action" && node.action === id)
          references.push(`${scene.definition.id}/${nodeId}`);
      }
    }
    if (references.length > 0) {
      setError(
        `立绘动作 ${id} 仍被 ${references.length} 个节点引用（${references
          .slice(0, 8)
          .join("、")}${references.length > 8 ? "…" : ""}），不能删除。`,
      );
      return;
    }
    const file = (currentProject.actions ?? []).find(
      (candidate) => candidate.definition.id === id,
    );
    if (file === undefined) return;
    if (!window.confirm(`从项目清单移除立绘动作 ${id}？YAML 文件会保留。`))
      return;
    commit((draft) => {
      draft.actions = (draft.actions ?? []).filter(
        (candidate) => candidate.definition.id !== id,
      );
      draft.manifest.actions = (draft.manifest.actions ?? []).filter(
        (path) => path !== file.path,
      );
    });
  };

  const duplicateSpriteAction = (id: string): void => {
    const currentProject = editorStateRef.current.project ?? project;
    const source = (currentProject.actions ?? []).find(
      (file) => file.definition.id === id,
    );
    if (source === undefined) return;
    const used = new Set(
      (currentProject.actions ?? []).map((file) => file.definition.id),
    );
    let nextId = `${id}_copy`;
    let index = 2;
    while (
      used.has(nextId) ||
      currentProject.manifest.assets[nextId] !== undefined ||
      (currentProject.animations ?? []).some(
        (file) => file.definition.id === nextId,
      )
    ) {
      nextId = `${id}_copy_${index++}`;
    }
    const path = `actions/${nextId.replaceAll(".", "_")}.yaml`;
    const definition = structuredClone(source.definition);
    definition.id = nextId;
    definition.name = `${definition.name}（副本）`;
    commit((draft) => {
      draft.manifest.actions ??= [];
      draft.manifest.actions.push(path);
      draft.actions ??= [];
      draft.actions.push({ path, definition });
    });
    setNotice(`已复制立绘动作 ${id} → ${nextId}。`);
  };

  const duplicateButtonTemplate = (id: string): void => {
    const source = (project.buttons ?? []).find(
      (candidate) => candidate.definition.id === id,
    );
    if (source === undefined) return;
    const used = new Set(
      (project.buttons ?? []).map((file) => file.definition.id),
    );
    let index = 2;
    let nextId = `${id}_copy`;
    while (used.has(nextId)) nextId = `${id}_copy_${index++}`;
    const path = `ui/buttons/${nextId.replaceAll(".", "_")}.yaml`;
    commit((draft) => {
      draft.manifest.buttons ??= [];
      draft.manifest.buttons.push(path);
      draft.buttons ??= [];
      draft.buttons.push({
        path,
        definition: { ...structuredClone(source.definition), id: nextId },
      });
    });
    setButtonTarget(nextId);
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
  if (
    longTextTarget !== null &&
    longTextScene !== undefined &&
    longTextNode?.type === "long_text"
  ) {
    return (
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
              if (flushBeforeNavigation()) setLongTextTarget(null);
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
        {error !== null && (
          <div className="error-toast" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} type="button">
              关闭
            </button>
          </div>
        )}
        {notice !== null && <div className="notice-toast">{notice}</div>}
      </>
    );
  }
  if (
    mapWorkspace &&
    project.chapter_map !== null &&
    project.chapter_map !== undefined
  ) {
    return (
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
            setMapWorkspace(false);
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
              .then(() => setNotice("章节地图已通过 Rust 权威校验。"))
              .catch((reason: unknown) => reportCommandError(reason));
          }}
          redoAvailable={future.length > 0}
          sceneIds={project.scenes.map((file) => file.definition.id)}
          selectionId={mapSelectionId}
          undoAvailable={past.length > 0}
        />
      </Suspense>
    );
  }
  if (buttonTarget !== null && buttonFile !== undefined) {
    return (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <ButtonWorkspace
            animationMap={animationMap}
            assets={project.assets}
            dirty={dirty}
            file={buttonFile}
            onBack={() => {
              if (flushBeforeNavigation()) setButtonTarget(null);
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
          />
        </Suspense>
        {error !== null && (
          <div className="error-toast" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} type="button">
              关闭
            </button>
          </div>
        )}
        {notice !== null && <div className="notice-toast">{notice}</div>}
      </>
    );
  }
  if (actionTarget !== null && actionFile !== undefined) {
    return (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <ActionWorkspace
            animationMap={animationMap}
            assets={project.assets}
            definition={actionFile.definition}
            dirty={dirty}
            onBack={() => {
              if (flushBeforeNavigation()) setActionTarget(null);
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
            onValidate={() => {
              if (!flushEditorEdits()) {
                setError("动作工作区存在未提交或无效输入，请修正后再校验。");
                return;
              }
              const current = projectRef.current;
              if (current === null) return;
              void editorApi
                .validateProject(projectRequest(current, activeImportTokens))
                .then(() => setNotice("立绘动作已通过 Rust 权威校验。"))
                .catch((reason: unknown) => reportCommandError(reason));
            }}
            path={actionFile.path}
          />
        </Suspense>
        {error !== null && (
          <div className="error-toast" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} type="button">
              关闭
            </button>
          </div>
        )}
        {notice !== null && <div className="notice-toast">{notice}</div>}
      </>
    );
  }

  if (uiMotionTarget !== null && uiMotionFile !== undefined) {
    return (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <UiMotionWorkspace
            animationMap={animationMap}
            assets={project.assets}
            dirty={dirty}
            file={uiMotionFile}
            onBack={() => {
              if (flushBeforeNavigation()) setUiMotionTarget(null);
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
          />
        </Suspense>
        {error !== null && (
          <div className="error-toast" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} type="button">
              关闭
            </button>
          </div>
        )}
        {notice !== null && <div className="notice-toast">{notice}</div>}
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
    return (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <TimelineWorkspace
            assets={project.assets}
            dirty={dirty}
            importTokens={activeImportTokens}
            futureAvailable={future.length > 0}
            node={timelineNode}
            nodeId={timelineTarget.nodeId}
            onBack={() => {
              if (flushBeforeNavigation()) setTimelineTarget(null);
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
        {error !== null && (
          <div className="error-toast" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} type="button">
              关闭
            </button>
          </div>
        )}
        {notice !== null && <div className="notice-toast">{notice}</div>}
      </>
    );
  }

  return (
    <main
      className={`editor-shell${panelsVisible ? "" : " panels-hidden"}`}
      style={
        {
          "--left-sidebar-width": `${panelSizes.left}px`,
          "--right-sidebar-width": `${panelSizes.right}px`,
        } as CSSProperties
      }
    >
      <header className="app-toolbar">
        <div className="toolbar-brand">
          <span>V</span>
          <div>
            <strong>VECTSPACE</strong>
            <small>STORY EDITOR</small>
          </div>
        </div>
        <div className="toolbar-project">
          <strong>{project.root.split(/[\\/]/).at(-1)}</strong>
          <small>{activeSceneId}</small>
          {dirty && <span className="dirty-dot" title="有未保存的更改" />}
        </div>
        <div className="toolbar-actions">
          <button
            aria-pressed={!panelsVisible}
            onClick={() => setPanelsVisible((visible) => !visible)}
            title="收起两侧面板，扩大编辑区域"
            type="button"
          >
            {panelsVisible ? "专注编辑" : "显示面板"}
          </button>
          <button
            disabled={busy}
            onClick={() => openChapterMapWorkspace()}
            type="button"
          >
            章节地图
          </button>
          <button
            disabled={busy}
            onClick={() => void openProject()}
            type="button"
          >
            打开
          </button>
          <button
            disabled={past.length === 0}
            onClick={undo}
            title="Ctrl+Z"
            type="button"
          >
            撤销
          </button>
          <button
            disabled={future.length === 0}
            onClick={redo}
            title="Ctrl+Y"
            type="button"
          >
            重做
          </button>
          <button
            className="primary-button"
            disabled={busy || !dirty}
            onClick={() => void saveProject()}
            title="Ctrl+S"
            type="button"
          >
            {busy ? "处理中…" : "保存项目"}
          </button>
        </div>
      </header>

      <ProjectSidebar
        selectedAssetId={assetSelectionId}
        activeTab={sidebarTab}
        activeSceneId={activeSceneId}
        diagnostics={diagnostics}
        onAddScene={addScene}
        onDeleteScene={deleteScene}
        onImportAssets={importAssets}
        onManifestChange={(manifest: ContentManifest) =>
          commit((draft) => void (draft.manifest = manifest))
        }
        onRemoveAsset={(id) => {
          const currentProject = editorStateRef.current.project ?? project;
          const references = findAssetReferences(currentProject, id);
          if (references.length > 0) {
            setError(
              `素材 ${id} 仍被 ${references.length} 处内容引用（${references
                .slice(0, 8)
                .join(
                  "、",
                )}${references.length > 8 ? "…" : ""}），不能从清单移除。`,
            );
            return false;
          }
          commit((draft) => {
            const animationId = draft.manifest.assets[id]?.animation;
            Reflect.deleteProperty(draft.manifest.assets, id);
            draft.assets = draft.assets.filter((asset) => asset.id !== id);
            if (animationId === undefined) return;
            // An animation document is only reachable through its asset, so
            // removing the asset removes the document in the same commit.
            // A hand-authored manifest may share one document between assets;
            // keep it while another asset still references it.
            const shared = Object.values(draft.manifest.assets).some(
              (definition) => definition.animation === animationId,
            );
            if (shared) return;
            const file = (draft.animations ?? []).find(
              (candidate) => candidate.definition.id === animationId,
            );
            draft.animations = (draft.animations ?? []).filter(
              (candidate) => candidate.definition.id !== animationId,
            );
            draft.manifest.animations = (
              draft.manifest.animations ?? []
            ).filter((path) => path !== file?.path);
          });
          return true;
        }}
        onCreateImageAnimation={createImageAnimation}
        onSelectAsset={(id) => {
          setAssetSelectionId(id);
          setSidebarTab("assets");
        }}
        onAddVariable={(id, definition) => {
          if (
            !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
            project.manifest.variables[id] !== undefined
          ) {
            setError("变量 ID 非法或已经存在。");
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
          const currentProject = editorStateRef.current.project ?? project;
          const references = countVariableReferences(currentProject, id);
          if (references > 0) {
            setError(`变量 ${id} 仍被 ${references} 处剧情引用，不能删除。`);
            return;
          }
          commit((draft) => {
            Reflect.deleteProperty(draft.manifest.variables, id);
          });
        }}
        onRenameScene={(previousId, nextId) => {
          const currentProject = editorStateRef.current.project ?? project;
          if (!/^[A-Za-z0-9._-]{1,128}$/.test(nextId)) {
            setError("场景 ID 非法。");
            return false;
          }
          if (
            nextId !== previousId &&
            currentProject.scenes.some((file) => file.definition.id === nextId)
          ) {
            setError("场景 ID 已经存在。");
            return false;
          }
          if (
            !window.confirm("重命名场景会更改文件路径并影响既有存档。继续吗？")
          )
            return true;
          commit((draft) =>
            renameScene(currentPlainProject(draft), previousId, nextId),
          );
          setActiveSceneId(nextId);
          return true;
        }}
        onRenameVariable={(previousId, nextId) => {
          const currentProject = editorStateRef.current.project ?? project;
          if (
            !/^[A-Za-z0-9._-]{1,128}$/.test(nextId) ||
            currentProject.manifest.variables[nextId] !== undefined
          ) {
            setError("新变量 ID 非法或已经存在。");
            return false;
          }
          commit((draft) =>
            renameVariable(currentPlainProject(draft), previousId, nextId),
          );
          return true;
        }}
        onAddCharacter={(id, definition) => {
          const currentProject = editorStateRef.current.project ?? project;
          if (
            !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
            currentProject.manifest.characters[id] !== undefined
          ) {
            setError("角色 ID 非法或已经存在。");
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
          const currentProject = editorStateRef.current.project ?? project;
          const references = countCharacterReferences(currentProject, id);
          if (references > 0) {
            setError(`角色 ${id} 仍被 ${references} 句对话引用，不能删除。`);
            return;
          }
          commit((draft) => {
            Reflect.deleteProperty(draft.manifest.characters, id);
          });
        }}
        onRenameCharacter={(previousId, nextId) => {
          const currentProject = editorStateRef.current.project ?? project;
          if (
            !/^[A-Za-z0-9._-]{1,128}$/.test(nextId) ||
            currentProject.manifest.characters[nextId] !== undefined
          ) {
            setError("新角色 ID 非法或已经存在。");
            return false;
          }
          commit((draft) =>
            renameCharacter(currentPlainProject(draft), previousId, nextId),
          );
          return true;
        }}
        onCreateUiMotion={openCreateUiMotion}
        onEditUiMotion={(motionId) => {
          if (!flushBeforeNavigation()) return;
          setUiMotionTarget(motionId);
        }}
        onDeleteUiMotion={deleteUiMotion}
        onCreateButtonTemplate={openCreateButton}
        onEditButtonTemplate={(buttonId) => {
          if (!flushBeforeNavigation()) return;
          setButtonTarget(buttonId);
        }}
        onDuplicateButtonTemplate={duplicateButtonTemplate}
        onDeleteButtonTemplate={deleteButtonTemplate}
        onCreateAction={(id) => {
          if (!flushBeforeNavigation()) return false;
          return createSpriteAction(id);
        }}
        onChangeAction={(id, definition) =>
          commit((draft) => {
            const file = (draft.actions ?? []).find(
              (candidate) => candidate.definition.id === id,
            );
            if (file !== undefined) file.definition = definition;
          })
        }
        onRenameAction={(previousId, nextId) => {
          const currentProject = editorStateRef.current.project ?? project;
          const normalized = nextId.trim();
          if (
            !/^[A-Za-z0-9._-]{1,128}$/.test(normalized) ||
            (currentProject.actions ?? []).some(
              (file) =>
                file.definition.id !== previousId &&
                file.definition.id === normalized,
            ) ||
            currentProject.manifest.assets[normalized] !== undefined ||
            (currentProject.animations ?? []).some(
              (file) => file.definition.id === normalized,
            )
          ) {
            setError("动作 ID 非法、已经存在或与素材/图片动画冲突。");
            return false;
          }
          const existingPath = (currentProject.actions ?? []).find(
            (file) => file.definition.id === previousId,
          )?.path;
          const nextPath = `actions/${normalized.replaceAll(".", "_")}.yaml`;
          if (
            existingPath !== undefined &&
            (currentProject.actions ?? []).some(
              (file) => file.path === nextPath && file.path !== existingPath,
            )
          ) {
            setError(`动作文件路径 ${nextPath} 已经存在。`);
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
          setActionTarget(id);
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
        project={project}
        scrollStore={sidebarScrollRef}
        sectionOpen={sidebarSections}
      />
      <ResizeHandle axis="left" onStart={startResize} onStep={resizeBy} />

      <section className="workspace">
        <div className="workspace-toolbar">
          <div className="view-switch" role="group" aria-label="场景视图">
            <button
              className={sceneViewMode === "graph" ? "active" : ""}
              onClick={() => {
                if (!flushBeforeNavigation()) return;
                setSceneViewMode("graph");
              }}
              type="button"
            >
              剧情图
            </button>
            <button
              className={sceneViewMode === "script" ? "active" : ""}
              onClick={() => {
                if (!flushBeforeNavigation()) return;
                setSceneViewMode("script");
              }}
              type="button"
            >
              脚本
            </button>
          </div>
          <select
            aria-label="新节点类型"
            value={addType}
            onChange={(event) =>
              setAddType(event.currentTarget.value as NodeType)
            }
          >
            {NODE_TYPES.map((candidate) => (
              <option key={candidate.type} value={candidate.type}>
                {candidate.group} · {candidate.label}
              </option>
            ))}
          </select>
          <button onClick={addNode} type="button">
            ＋ 添加节点
          </button>
        </div>
        {activeScene !== undefined && sceneViewMode === "graph" ? (
          <StoryGraph
            diagnostics={diagnostics}
            layout={project.layout.scenes[activeSceneId]}
            onCopy={copyNode}
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
                ensureSceneLayout(draft.layout, activeSceneId).nodes =
                  positions;
              })
            }
            onMoveNode={(nodeId, position: NodePosition) =>
              commit((draft) => {
                ensureSceneLayout(draft.layout, activeSceneId).nodes[nodeId] =
                  position;
              })
            }
            onPaste={pasteNode}
            onQuickInsert={quickInsertNode}
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
                setLongTextTarget(null);
                setTimelineTarget({ sceneId: activeSceneId, nodeId });
              } else if (node?.type === "long_text") {
                setTimelineTarget(null);
                setUiMotionTarget(null);
                setLongTextTarget({ sceneId: activeSceneId, nodeId });
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
            setTimelineTarget(null);
            setUiMotionTarget(null);
            setLongTextTarget({ sceneId: activeSceneId, nodeId });
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
          onRename={(previousId, nextId) => {
            if (
              !/^[A-Za-z0-9._-]{1,128}$/.test(nextId) ||
              activeScene.nodes[nextId] !== undefined
            ) {
              setError("新节点 ID 非法或已经存在。");
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
      <footer className="editor-statusbar">
        <span className={dirty ? "status-unsaved" : "status-saved"}>
          {dirty ? "● 未保存" : "● 已保存"}
        </span>
        <span title={activeSceneId}>{activeSceneId}</span>
        <span>{Object.keys(activeScene?.nodes ?? {}).length} 个节点</span>
        <span className="status-help">右键节点查看更多操作 · Ctrl+S 保存</span>
        <button
          onClick={() => {
            setPanelsVisible(true);
            setSidebarTab("problems");
          }}
          type="button"
        >
          {diagnostics.length === 0
            ? "检查通过"
            : `${diagnostics.length} 个问题`}
        </button>
      </footer>

      {error !== null && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} type="button">
            关闭
          </button>
        </div>
      )}
      {notice !== null && <div className="notice-toast">{notice}</div>}
      {uiMotionDialog !== null && (
        <UiMotionEntryDialog
          initialValue={uiMotionDialog}
          onCancel={() => setUiMotionDialog(null)}
          onSubmit={(value) => {
            if (createUiMotion(value)) setUiMotionDialog(null);
          }}
        />
      )}
      {buttonDialog !== null && (
        <ButtonEntryDialog
          initialValue={buttonDialog}
          onCancel={() => setButtonDialog(null)}
          onSubmit={(value) => {
            if (createButtonTemplate(value)) setButtonDialog(null);
          }}
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
    </main>
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

function UiMotionEntryDialog({
  initialValue,
  onSubmit,
  onCancel,
}: {
  initialValue: string;
  onSubmit(value: string): void;
  onCancel(): void;
}): ReactElement {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div
      aria-label="创建 UI 动效"
      className="editor-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <form
        aria-modal="true"
        className="editor-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
        role="dialog"
      >
        <h3>新 UI 动效 ID</h3>
        <input
          ref={inputRef}
          aria-label="UI 动效 ID"
          onChange={(event) => setValue(event.currentTarget.value)}
          value={value}
        />
        <small className="muted">
          只能使用 ASCII 字母、数字、点、下划线或连字符。
        </small>
        <div className="editor-dialog-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-button" type="submit">
            创建
          </button>
        </div>
      </form>
    </div>
  );
}

function ButtonEntryDialog({
  initialValue,
  onSubmit,
  onCancel,
}: {
  initialValue: string;
  onSubmit(value: string): void;
  onCancel(): void;
}): ReactElement {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div
      aria-label="创建按钮模板"
      className="editor-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <form
        aria-modal="true"
        className="editor-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(value);
        }}
        role="dialog"
      >
        <h3>新按钮模板 ID</h3>
        <input
          ref={inputRef}
          aria-label="按钮模板 ID"
          onChange={(event) => setValue(event.currentTarget.value)}
          value={value}
        />
        <small className="muted">
          默认尺寸 200 × 80；可在模板工作区配置三态素材和动画。
        </small>
        <div className="editor-dialog-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button className="primary-button" type="submit">
            创建
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteNodesDialog({
  nodeIds,
  options,
  onConfirm,
  onCancel,
}: {
  nodeIds: string[];
  options: { id: string; label: string }[];
  onConfirm(fallback: string): void;
  onCancel(): void;
}): ReactElement {
  const [fallback, setFallback] = useState(options[0]?.id ?? "");
  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);
  return (
    <div
      aria-label="选择删除后的继承节点"
      className="editor-dialog-backdrop"
      role="presentation"
    >
      <form
        aria-modal="true"
        className="editor-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (fallback !== "") onConfirm(fallback);
        }}
        role="dialog"
      >
        <h3>删除并重连</h3>
        <p>
          将删除 {nodeIds.length}{" "}
          个连续节点。请选择受影响入口要连接的后继节点；跨场景跳转也会一并更新。
        </p>
        <label>
          保留节点
          <select
            aria-label="删除后继节点"
            onChange={(event) => setFallback(event.currentTarget.value)}
            value={fallback}
          >
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <div className="editor-dialog-actions">
          <button onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="danger-button"
            disabled={fallback === ""}
            type="submit"
          >
            删除并重连
          </button>
        </div>
      </form>
    </div>
  );
}
