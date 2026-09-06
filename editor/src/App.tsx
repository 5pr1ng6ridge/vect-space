import { open } from "@tauri-apps/plugin-dialog";
import {
  applyPatches,
  enablePatches,
  original,
  produceWithPatches,
  type Patch,
} from "immer";
import {
  useCallback,
  useEffect,
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
import { ProjectSidebar, type SidebarTab } from "./components/ProjectSidebar";
import { StoryGraph } from "./components/StoryGraph";
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
  renameScene,
  renameVariable,
  setPortTarget,
  splitDialogueAt,
  uniqueNodeId,
} from "./story";
import type {
  AssetKind,
  ContentManifest,
  EditorProject,
  NodePosition,
  NodeType,
  SceneNode,
} from "./types";
import { validateLive } from "./validation";

type ResizeAxis = "left" | "right";

enablePatches();

function currentPlainProject(draft: EditorProject): EditorProject {
  // Rename helpers intentionally return a complete project.  When they are
  // used from an Immer recipe, unwrap the proxy first so their defensive
  // structuredClone remains safe and, importantly, sees queued edits.
  return original(draft) ?? draft;
}

interface HistoryEntry {
  label: string;
  redo: Patch[];
  undo: Patch[];
  beforeRevision: number;
  afterRevision: number;
}

interface EditorState {
  project: EditorProject | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  dirty: boolean;
  // Layout/preview preferences intentionally stay out of the content undo
  // stack, but they still make the project dirty until the next save.
  ephemeralDirty: boolean;
  currentRevision: number;
  savedRevision: number;
  nextRevision: number;
}

/**
 * Mutations are kept in the reducer action instead of being evaluated in the
 * component.  React may batch several pointer/text events before rendering;
 * evaluating against the component's captured project in that situation
 * would make the later event overwrite the earlier one.  Running the recipe
 * in the reducer guarantees that every queued action sees the latest project.
 */
type EditorMutation = (draft: EditorProject) => unknown;

type EditorAction =
  | { type: "load"; project: EditorProject }
  | { type: "reset_history" }
  | {
      type: "edit";
      mutation: EditorMutation;
      history: boolean;
      label: string;
    }
  | { type: "undo" }
  | { type: "redo" };

const INITIAL_EDITOR_STATE: EditorState = {
  project: null,
  past: [],
  future: [],
  dirty: false,
  ephemeralDirty: false,
  currentRevision: 0,
  savedRevision: 0,
  nextRevision: 0,
};

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      return {
        project: action.project,
        past: [],
        future: [],
        dirty: false,
        ephemeralDirty: false,
        currentRevision: 0,
        savedRevision: 0,
        nextRevision: 0,
      };
    case "reset_history":
      return {
        ...state,
        past: [],
        future: [],
        dirty: false,
        ephemeralDirty: false,
        currentRevision: 0,
        savedRevision: 0,
        nextRevision: 0,
      };
    case "edit":
      if (state.project === null) return state;
      {
        const [project, redo, undo] = produceWithPatches(
          state.project,
          (draft) => {
            const result = action.mutation(draft);
            if (result === undefined) return undefined;
            return result as EditorProject;
          },
        );
        if (redo.length === 0) return state;
        if (!action.history) {
          // Ephemeral layout changes (viewport and preview preferences) still
          // need to be persisted, but do not pollute the content undo stack.
          return { ...state, project, dirty: true, ephemeralDirty: true };
        }
        const afterRevision = state.nextRevision + 1;
        const entry: HistoryEntry = {
          label: action.label,
          redo,
          undo,
          beforeRevision: state.currentRevision,
          afterRevision,
        };
        return {
          ...state,
          project,
          past: [...state.past.slice(-99), entry],
          future: [],
          currentRevision: afterRevision,
          nextRevision: afterRevision,
          dirty: afterRevision !== state.savedRevision || state.ephemeralDirty,
        };
      }
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (state.project === null || previous === undefined) return state;
      return {
        ...state,
        project: applyPatches(state.project, previous.undo),
        past: state.past.slice(0, -1),
        future: [previous, ...state.future].slice(0, 100),
        currentRevision: previous.beforeRevision,
        dirty:
          previous.beforeRevision !== state.savedRevision ||
          state.ephemeralDirty,
      };
    }
    case "redo": {
      const next = state.future[0];
      if (state.project === null || next === undefined) return state;
      return {
        ...state,
        project: applyPatches(state.project, next.redo),
        past: [...state.past.slice(-99), next],
        future: state.future.slice(1),
        currentRevision: next.afterRevision,
        dirty:
          next.afterRevision !== state.savedRevision || state.ephemeralDirty,
      };
    }
  }
}

const StoryFlowWorkspace = lazy(() =>
  import("./components/StoryFlowWorkspace").then((module) => ({
    default: module.StoryFlowWorkspace,
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
  left: 278,
  right: 370,
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
  const { project, past, future, dirty } = editorState;
  const [activeSceneId, setActiveSceneId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [addType, setAddType] = useState<NodeType>("say");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("scenes");
  const [timelineTarget, setTimelineTarget] = useState<{
    sceneId: string;
    nodeId: string;
  } | null>(null);
  const [longTextTarget, setLongTextTarget] = useState<{
    sceneId: string;
    nodeId: string;
  } | null>(null);
  const [uiMotionTarget, setUiMotionTarget] = useState<string | null>(null);
  const [flowWorkspace, setFlowWorkspace] = useState(false);
  const [flowSelectionId, setFlowSelectionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(DEFAULT_PANEL_SIZES);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);
  const nodeClipboardRef = useRef<NodeClipboard | null>(null);
  const savedContentRef = useRef("");
  const savedContentVersionRef = useRef("");

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

  const resetHistory = (): void => {
    dispatchEditor({ type: "reset_history" });
  };

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
    ): void => {
      dispatchEditor({
        type: "edit",
        mutation: mutator,
        history,
        label,
      });
    },
    [],
  );

  const openProject = async (preferred?: string): Promise<void> => {
    if (
      dirty &&
      !window.confirm("当前项目有未保存的更改，仍要打开其他项目吗？")
    )
      return;
    let root = preferred;
    if (root === undefined) {
      const picked = await open({
        directory: true,
        multiple: false,
        title: "选择 VECTSPACE 项目或 game 目录",
      });
      if (typeof picked !== "string") return;
      root = picked;
    }
    setBusy(true);
    setError(null);
    try {
      const loaded = await editorApi.openProject(root);
      dispatchEditor({ type: "load", project: loaded });
      savedContentRef.current = contentDocumentFingerprint(loaded);
      savedContentVersionRef.current = loaded.manifest.content_version;
      const initialScene =
        loaded.manifest.entry_scene || loaded.scenes[0]?.definition.id || "";
      setActiveSceneId(initialScene);
      setSelectedNodeId(null);
      setTimelineTarget(null);
      setLongTextTarget(null);
      setUiMotionTarget(null);
      setFlowWorkspace(false);
      setFlowSelectionId(null);
      resetHistory();
      localStorage.setItem("vectspace-editor:last-project", loaded.root);
      setNotice(`已打开 ${loaded.root}`);
    } catch (reason) {
      reportCommandError(reason);
    } finally {
      setBusy(false);
    }
  };

  const saveProject = useCallback(async (): Promise<void> => {
    if (project === null) return;
    if (
      contentDocumentFingerprint(project) !== savedContentRef.current &&
      project.manifest.content_version === savedContentVersionRef.current &&
      !window.confirm(
        "剧情、动效或流程内容已经改变，但 content_version 没有更新。继续保存会保留旧的已读、历史和完成状态。仍要保存吗？",
      )
    ) {
      return;
    }
    const currentDiagnostics = validateLive(project);
    const errors = currentDiagnostics.filter(
      (diagnostic) => diagnostic.severity === "error",
    );
    if (errors.length > 0) {
      setSidebarTab("problems");
      setError(`存在 ${errors.length} 个错误，修复后才能保存。`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await editorApi.validateProject(projectRequest(project));
      const result = await editorApi.saveProject(projectRequest(project));
      const saved = result.project;
      dispatchEditor({ type: "load", project: saved });
      savedContentRef.current = contentDocumentFingerprint(saved);
      savedContentVersionRef.current = saved.manifest.content_version;
      resetHistory();
      const changed = result.changed_paths.length;
      setNotice(
        changed === 0
          ? "项目没有需要写入的文件。"
          : `项目已安全保存（${changed} 个文件）。备份位于 .vectspace/backups。`,
      );
    } catch (reason) {
      reportCommandError(reason);
    } finally {
      setBusy(false);
    }
  }, [project, reportCommandError]);

  const undo = useCallback((): void => {
    dispatchEditor({ type: "undo" });
  }, []);

  const redo = useCallback((): void => {
    dispatchEditor({ type: "redo" });
  }, []);

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
      if (scene !== undefined) scene.definition.nodes[nodeId] = node;
    });
  };

  const convertNodeToTimeline = (nodeId: string): void => {
    const sceneId = activeSceneId;
    const sourceNode = findScene(project, sceneId)?.definition.nodes[nodeId];
    if (sourceNode === undefined) return;
    setError(null);
    try {
      const converted = convertQuickNodeToTimeline(sourceNode);
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

  const splitDialogue = (
    nodeId: string,
    offset: number,
    textOverride?: string,
  ): void => {
    const scene = activeScene;
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
    commit((draft) => {
      const file = findScene(draft, activeSceneId);
      if (file === undefined) return;
      file.definition.nodes[nodeId] = result.first;
      file.definition.nodes[result.continuationId] = result.continuation;
      const layout = ensureSceneLayout(draft.layout, activeSceneId);
      const origin = layout.nodes[nodeId] ?? { x: 0, y: 0 };
      layout.nodes[result.continuationId] = {
        x: origin.x + 320,
        y: origin.y,
      };
    });
    setSelectedNodeId(result.continuationId);
    setNotice("已拆成两个对话段；可在它们之间插入动画节点。");
  };

  const addNode = (): void => {
    if (activeScene === undefined) return;
    const id = uniqueNodeId(activeScene, addType);
    const fallback =
      activeScene.entry || Object.keys(activeScene.nodes)[0] || id;
    commit((draft) => {
      const file = findScene(draft, activeSceneId);
      if (file === undefined) return;
      file.definition.nodes[id] = defaultNode(addType, fallback);
      const sceneLayout = ensureSceneLayout(draft.layout, activeSceneId);
      const count = Object.keys(file.definition.nodes).length;
      sceneLayout.nodes[id] = {
        x: (count % 4) * 300,
        y: Math.floor(count / 4) * 210,
      };
    });
    setSelectedNodeId(id);
  };

  const quickInsertNode = (
    sourceId: string,
    side: "left" | "right",
    type: NodeType,
  ): void => {
    if (project === null) return;
    const result = insertNode(project, activeSceneId, sourceId, side, type);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    commit(() => result.project);
    setSelectedNodeId(result.nodeId);
    setNotice(
      `已在${side === "left" ? "左" : "右"}侧插入${nodeLabel(type)}节点。`,
    );
  };

  const deleteNode = (nodeId: string): void => {
    if (
      activeScene === undefined ||
      Object.keys(activeScene.nodes).length <= 1
    ) {
      setError("场景至少需要保留一个节点。");
      return;
    }
    if (!window.confirm(`删除节点 ${nodeId}？所有指向它的本场景连线将重定向。`))
      return;
    const node = activeScene.nodes[nodeId];
    if (node === undefined) return;
    const fallback =
      outputPorts(node).find(
        (port) => port.target !== nodeId && port.targetScene === null,
      )?.target ??
      Object.keys(activeScene.nodes).find((candidate) => candidate !== nodeId);
    if (fallback === undefined) return;
    commit((draft) => {
      const target = findScene(draft, activeSceneId);
      if (target === undefined) return;
      Reflect.deleteProperty(target.definition.nodes, nodeId);
      if (target.definition.entry === nodeId)
        target.definition.entry = fallback;
      for (const file of draft.scenes) {
        for (const [candidateId, candidate] of Object.entries(
          file.definition.nodes,
        )) {
          let changed = candidate;
          if (file.definition.id === activeSceneId) {
            for (const port of outputPorts(changed)) {
              if (port.targetScene === null && port.target === nodeId) {
                changed = setPortTarget(changed, port.id, fallback);
              }
            }
          }
          if (
            changed.type === "jump" &&
            (changed.scene ?? file.definition.id) === activeSceneId &&
            changed.target === nodeId
          ) {
            changed = { ...changed, target: fallback };
          }
          file.definition.nodes[candidateId] = changed;
        }
      }
      Reflect.deleteProperty(
        ensureSceneLayout(draft.layout, activeSceneId).nodes,
        nodeId,
      );
      if (draft.layout.timeline_previews !== undefined) {
        Reflect.deleteProperty(
          draft.layout.timeline_previews,
          `${activeSceneId}/${nodeId}`,
        );
        for (const settings of Object.values(draft.layout.timeline_previews)) {
          settings.choices = settings.choices.filter(
            (choice) =>
              choice.scene_id !== activeSceneId || choice.node_id !== nodeId,
          );
        }
      }
    });
    setSelectedNodeId(null);
    if (
      longTextTarget?.sceneId === activeSceneId &&
      longTextTarget.nodeId === nodeId
    ) {
      setLongTextTarget(null);
    }
  };

  const duplicateNode = (nodeId: string): void => {
    if (activeScene === undefined) return;
    const id = uniqueNodeId(activeScene, `${nodeId}_copy`);
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
    const node = activeScene?.nodes[nodeId];
    if (node === undefined) return;
    const sourceCharacterId =
      node.type === "say" &&
      node.speaker !== null &&
      project.manifest.characters[node.speaker] !== undefined
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
    if (clipboard === null || activeScene === undefined) {
      setNotice("还没有复制节点。");
      return;
    }
    const id = uniqueNodeId(activeScene, `${clipboard.sourceNodeId}_copy`);
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
      );
      ensureSceneLayout(draft.layout, activeSceneId).nodes[id] = snapped;
    });
    setSelectedNodeId(id);
    setNotice(`已粘贴为 ${id}；流程连接已清空。`);
  };

  const addScene = (id: string): void => {
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
      findScene(project, id) !== undefined
    ) {
      setError("场景 ID 非法或已经存在。");
      return;
    }
    commit((draft) => {
      const file = newSceneFile(id);
      draft.scenes.push(file);
      draft.manifest.scenes.push(file.path);
      ensureSceneLayout(draft.layout, id).nodes.start = { x: 120, y: 120 };
    });
    setActiveSceneId(id);
    setSelectedNodeId("start");
  };

  const deleteScene = (sceneId: string): void => {
    if (project.manifest.entry_scene === sceneId) {
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
      if (draft.story_flow !== null) {
        Reflect.deleteProperty(draft.story_flow.definition.nodes, sceneId);
        draft.story_flow.definition.edges =
          draft.story_flow.definition.edges.filter(
            (edge) => edge.from !== sceneId && edge.to !== sceneId,
          );
      }
    });
    const next =
      project.scenes.find((file) => file.definition.id !== sceneId)?.definition
        .id ?? "";
    if (longTextTarget?.sceneId === sceneId) setLongTextTarget(null);
    setActiveSceneId(next);
    setSelectedNodeId(null);
  };

  const importAsset = async (
    id: string,
    kind: AssetKind,
    sourcePath: string,
  ): Promise<void> => {
    try {
      const imported = await editorApi.importAsset(id, kind, sourcePath);
      commit((draft) => {
        draft.manifest.assets[id] = { kind, path: imported.path };
        draft.assets.push(imported);
      });
      setNotice(`已导入素材 ${id}；保存项目后写入 manifest。`);
    } catch (reason) {
      reportCommandError(reason);
    }
  };

  const navigate = (
    sceneId: string | null,
    nodeId: string | null,
    workspace?: "story" | "flow",
    flowElementId?: string | null,
  ): void => {
    if (workspace === "flow") {
      setFlowSelectionId(flowElementId ?? null);
      setFlowWorkspace(true);
      return;
    }
    if (sceneId !== null && findScene(project, sceneId) !== undefined) {
      setActiveSceneId(sceneId);
      setSidebarTab("scenes");
    }
    setSelectedNodeId(nodeId);
  };

  const createUiMotion = (): void => {
    const id = window.prompt("新 UI 动效 ID", "ui.dialogue.motion")?.trim();
    if (!id) return;
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
      project.ui_motions.some((file) => file.definition.id === id)
    ) {
      setError("UI 动效 ID 非法或已经存在。");
      return;
    }
    const path = `ui/motions/${id.replaceAll(".", "_")}.yaml`;
    if (project.ui_motions.some((file) => file.path === path)) {
      setError(`动效文件路径 ${path} 已经存在。`);
      return;
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
  };

  const uiMotionFile = project.ui_motions.find(
    (file) => file.definition.id === uiMotionTarget,
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
            assets={project.assets}
            dirty={dirty}
            node={longTextNode}
            nodeId={longTextTarget.nodeId}
            onBack={() => setLongTextTarget(null)}
            onChange={(next) => changeNode(longTextTarget.nodeId, next)}
            onRedo={redo}
            onSave={() => void saveProject()}
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
  if (flowWorkspace && project.story_flow !== null) {
    return (
      <Suspense fallback={<WorkspaceFallback />}>
        <StoryFlowWorkspace
          projectManifest={project.manifest}
          sceneIds={project.scenes.map((file) => file.definition.id)}
          flow={project.story_flow.definition}
          dirty={dirty}
          initialSelectionId={flowSelectionId}
          onClose={() => setFlowWorkspace(false)}
          onChange={(definition) =>
            commit((draft) => {
              if (draft.story_flow !== null)
                draft.story_flow.definition = definition;
            })
          }
          onSave={() => void saveProject()}
          onValidate={() => {
            void editorApi
              .validateProject(projectRequest(project))
              .then(() => setNotice("总流程已通过 Rust 权威校验。"))
              .catch((reason: unknown) => reportCommandError(reason));
          }}
          onUndo={undo}
          onRedo={redo}
          undoAvailable={past.length > 0}
          redoAvailable={future.length > 0}
        />
      </Suspense>
    );
  }
  if (uiMotionTarget !== null && uiMotionFile !== undefined) {
    return (
      <>
        <Suspense fallback={<WorkspaceFallback />}>
          <UiMotionWorkspace
            assets={project.assets}
            dirty={dirty}
            file={uiMotionFile}
            onBack={() => setUiMotionTarget(null)}
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
            futureAvailable={future.length > 0}
            node={timelineNode}
            nodeId={timelineTarget.nodeId}
            onBack={() => setTimelineTarget(null)}
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
      className="editor-shell"
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
            disabled={busy}
            onClick={() => {
              if (project.story_flow === null) {
                commit((draft) => {
                  const entry = draft.manifest.entry_scene;
                  draft.manifest.story_flow = "story-flow.yaml";
                  draft.story_flow = {
                    path: "story-flow.yaml",
                    definition: {
                      schema_version: 1,
                      nodes: {
                        [entry]: {
                          title: entry,
                          x: 240,
                          y: 540,
                          reveal: { mode: "completed" },
                        },
                      },
                      edges: [],
                    },
                  };
                });
              }
              setFlowWorkspace(true);
            }}
            type="button"
          >
            总流程
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
        activeTab={sidebarTab}
        activeSceneId={activeSceneId}
        diagnostics={diagnostics}
        onAddScene={addScene}
        onDeleteScene={deleteScene}
        onImportAsset={importAsset}
        onManifestChange={(manifest: ContentManifest) =>
          commit((draft) => void (draft.manifest = manifest))
        }
        onRemoveAsset={(id) =>
          commit((draft) => {
            Reflect.deleteProperty(draft.manifest.assets, id);
            draft.assets = draft.assets.filter((asset) => asset.id !== id);
          })
        }
        onAddVariable={(id, definition) =>
          commit((draft) => {
            draft.manifest.variables[id] = definition;
          })
        }
        onChangeVariable={(id, definition) =>
          commit((draft) => {
            draft.manifest.variables[id] = definition;
          })
        }
        onDeleteVariable={(id) => {
          const references = countVariableReferences(project, id);
          if (references > 0) {
            setError(`变量 ${id} 仍被 ${references} 处剧情引用，不能删除。`);
            return;
          }
          commit((draft) => {
            Reflect.deleteProperty(draft.manifest.variables, id);
          });
        }}
        onRenameScene={(previousId, nextId) => {
          if (!/^[A-Za-z0-9._-]{1,128}$/.test(nextId)) {
            setError("场景 ID 非法。");
            return;
          }
          if (
            !window.confirm("重命名场景会更改文件路径并影响既有存档。继续吗？")
          )
            return;
          commit((draft) =>
            renameScene(currentPlainProject(draft), previousId, nextId),
          );
          setActiveSceneId(nextId);
        }}
        onRenameVariable={(previousId, nextId) => {
          if (
            !/^[A-Za-z0-9._-]{1,128}$/.test(nextId) ||
            project.manifest.variables[nextId] !== undefined
          ) {
            setError("新变量 ID 非法或已经存在。");
            return;
          }
          commit((draft) =>
            renameVariable(currentPlainProject(draft), previousId, nextId),
          );
        }}
        onAddCharacter={(id, definition) =>
          commit((draft) => {
            draft.manifest.characters[id] = definition;
          })
        }
        onChangeCharacter={(id, definition) =>
          commit((draft) => {
            draft.manifest.characters[id] = definition;
          })
        }
        onDeleteCharacter={(id) => {
          const references = countCharacterReferences(project, id);
          if (references > 0) {
            setError(`角色 ${id} 仍被 ${references} 句对话引用，不能删除。`);
            return;
          }
          commit((draft) => {
            Reflect.deleteProperty(draft.manifest.characters, id);
          });
        }}
        onRenameCharacter={(previousId, nextId) => {
          if (
            !/^[A-Za-z0-9._-]{1,128}$/.test(nextId) ||
            project.manifest.characters[nextId] !== undefined
          ) {
            setError("新角色 ID 非法或已经存在。");
            return;
          }
          commit((draft) =>
            renameCharacter(currentPlainProject(draft), previousId, nextId),
          );
        }}
        onCreateUiMotion={createUiMotion}
        onEditUiMotion={setUiMotionTarget}
        onDeleteUiMotion={deleteUiMotion}
        onSelectScene={(sceneId) => {
          setActiveSceneId(sceneId);
          setSelectedNodeId(null);
        }}
        onNavigate={navigate}
        onTabChange={setSidebarTab}
        project={project}
      />
      <ResizeHandle axis="left" onStart={startResize} onStep={resizeBy} />

      <section className="workspace">
        <div className="workspace-toolbar">
          <select
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
          <span className="workspace-hint">
            节点左侧的 ＋ 可快速插入；右侧 ＋ 同时是 next
            连线点，右键节点或插入点可选择类型
          </span>
        </div>
        {activeScene !== undefined ? (
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
              const node = activeScene.nodes[nodeId];
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
          onSplitDialogue={splitDialogue}
          onOpenLongTextWorkspace={(nodeId) => {
            setTimelineTarget(null);
            setUiMotionTarget(null);
            setLongTextTarget({ sceneId: activeSceneId, nodeId });
          }}
          uiMotions={project.ui_motions}
          onRename={(previousId, nextId) => {
            if (
              !/^[A-Za-z0-9._-]{1,128}$/.test(nextId) ||
              activeScene.nodes[nextId] !== undefined
            ) {
              setError("新节点 ID 非法或已经存在。");
              return;
            }
            commit(() =>
              renameNode(project, activeSceneId, previousId, nextId),
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

      {error !== null && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} type="button">
            关闭
          </button>
        </div>
      )}
      {notice !== null && <div className="notice-toast">{notice}</div>}
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
      story_flow: project.story_flow,
    },
    (_key, value: unknown) =>
      typeof value === "bigint"
        ? { __vectspace_integer__: value.toString() }
        : value,
  );
}
