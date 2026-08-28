import { open } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { editorApi } from "./api";
import { NodeInspector } from "./components/NodeInspector";
import { ProjectSidebar, type SidebarTab } from "./components/ProjectSidebar";
import { StoryGraph } from "./components/StoryGraph";
import { TimelineWorkspace } from "./components/TimelineWorkspace";
import {
  NODE_TYPES,
  cloneProject,
  countCharacterReferences,
  countVariableReferences,
  defaultNode,
  ensureSceneLayout,
  findScene,
  insertNode,
  newSceneFile,
  nodeLabel,
  outputPorts,
  projectRequest,
  renameCharacter,
  renameNode,
  renameScene,
  renameVariable,
  setPortTarget,
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
  const [project, setProject] = useState<EditorProject | null>(null);
  const [past, setPast] = useState<EditorProject[]>([]);
  const [future, setFuture] = useState<EditorProject[]>([]);
  const [dirty, setDirty] = useState(false);
  const [activeSceneId, setActiveSceneId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [addType, setAddType] = useState<NodeType>("say");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("scenes");
  const [timelineTarget, setTimelineTarget] = useState<{
    sceneId: string;
    nodeId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(DEFAULT_PANEL_SIZES);
  const [resizeState, setResizeState] = useState<ResizeState | null>(null);

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
    setPast([]);
    setFuture([]);
    setDirty(false);
  };

  const commit = useCallback(
    (mutator: (draft: EditorProject) => void, history = true): void => {
      setProject((current) => {
        if (current === null) return current;
        const next = cloneProject(current);
        mutator(next);
        if (history) {
          setPast((items) => [...items.slice(-99), cloneProject(current)]);
          setFuture([]);
        }
        setDirty(true);
        return next;
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
      setProject(loaded);
      const initialScene =
        loaded.manifest.entry_scene || loaded.scenes[0]?.definition.id || "";
      setActiveSceneId(initialScene);
      setSelectedNodeId(null);
      setTimelineTarget(null);
      resetHistory();
      localStorage.setItem("vectspace-editor:last-project", loaded.root);
      setNotice(`已打开 ${loaded.root}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveProject = useCallback(async (): Promise<void> => {
    if (project === null) return;
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
      const saved = await editorApi.saveProject(projectRequest(project));
      setProject(saved);
      resetHistory();
      setNotice("项目已安全保存；备份文件保留在原文件旁。 ");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [project]);

  const undo = useCallback((): void => {
    if (project === null || past.length === 0) return;
    const previous = past[past.length - 1];
    setPast((items) => items.slice(0, -1));
    setFuture((items) => [cloneProject(project), ...items].slice(0, 100));
    setProject(cloneProject(previous));
    setDirty(true);
  }, [past, project]);

  const redo = useCallback((): void => {
    if (project === null || future.length === 0) return;
    const next = future[0];
    setFuture((items) => items.slice(1));
    setPast((items) => [...items.slice(-99), cloneProject(project)]);
    setProject(cloneProject(next));
    setDirty(true);
  }, [future, project]);

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
    setPast((items) => [...items.slice(-99), cloneProject(project)]);
    setFuture([]);
    setProject(result.project);
    setDirty(true);
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
    });
    const next =
      project.scenes.find((file) => file.definition.id !== sceneId)?.definition
        .id ?? "";
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
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const navigate = (sceneId: string | null, nodeId: string | null): void => {
    if (sceneId !== null && findScene(project, sceneId) !== undefined) {
      setActiveSceneId(sceneId);
      setSidebarTab("scenes");
    }
    setSelectedNodeId(nodeId);
  };

  const timelineScene = findScene(project, timelineTarget?.sceneId ?? "");
  const timelineNode =
    timelineTarget === null
      ? undefined
      : timelineScene?.definition.nodes[timelineTarget.nodeId];
  if (timelineTarget !== null && timelineNode?.type === "timeline") {
    const previewKey = `${timelineTarget.sceneId}/${timelineTarget.nodeId}`;
    return (
      <>
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
          setPast((items) => [...items.slice(-99), cloneProject(project)]);
          setFuture([]);
          setProject(renameScene(project, previousId, nextId));
          setDirty(true);
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
          setPast((items) => [...items.slice(-99), cloneProject(project)]);
          setFuture([]);
          setProject(renameVariable(project, previousId, nextId));
          setDirty(true);
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
          setPast((items) => [...items.slice(-99), cloneProject(project)]);
          setFuture([]);
          setProject(renameCharacter(project, previousId, nextId));
          setDirty(true);
        }}
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
            onQuickInsert={quickInsertNode}
            onOpen={(nodeId) => {
              if (activeScene.nodes[nodeId]?.type === "timeline") {
                setTimelineTarget({ sceneId: activeSceneId, nodeId });
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
          onRename={(previousId, nextId) => {
            if (
              !/^[A-Za-z0-9._-]{1,128}$/.test(nextId) ||
              activeScene.nodes[nextId] !== undefined
            ) {
              setError("新节点 ID 非法或已经存在。");
              return;
            }
            setPast((items) => [...items.slice(-99), cloneProject(project)]);
            setFuture([]);
            setProject(renameNode(project, activeSceneId, previousId, nextId));
            setSelectedNodeId(nextId);
            setDirty(true);
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
