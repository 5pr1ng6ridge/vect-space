import { open } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { editorApi } from "./api";
import { DiagnosticsPanel } from "./components/DiagnosticsPanel";
import { NodeInspector } from "./components/NodeInspector";
import { PreviewPanel } from "./components/PreviewPanel";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { StoryGraph } from "./components/StoryGraph";
import { YamlPanel } from "./components/YamlPanel";
import {
  NODE_TYPES,
  cloneProject,
  defaultNode,
  ensureSceneLayout,
  findScene,
  newSceneFile,
  outputPorts,
  projectRequest,
  renameNode,
  renameScene,
  setPortTarget,
  uniqueNodeId,
} from "./story";
import type {
  AssetKind,
  ContentManifest,
  EditorProject,
  NodePosition,
  NodeType,
  SceneDefinition,
  SceneNode,
} from "./types";
import { validateLive } from "./validation";

type BottomTab = "problems" | "yaml" | "preview";

export function App(): ReactElement {
  const [project, setProject] = useState<EditorProject | null>(null);
  const [past, setPast] = useState<EditorProject[]>([]);
  const [future, setFuture] = useState<EditorProject[]>([]);
  const [dirty, setDirty] = useState(false);
  const [activeSceneId, setActiveSceneId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [addType, setAddType] = useState<NodeType>("say");
  const [bottomTab, setBottomTab] = useState<BottomTab>("problems");
  const [bottomOpen, setBottomOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const diagnostics = useMemo(
    () => (project === null ? [] : validateLive(project)),
    [project],
  );
  const errorCount = diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
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
      setBottomOpen(true);
      setBottomTab("problems");
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
    if (sceneId !== null && findScene(project, sceneId) !== undefined)
      setActiveSceneId(sceneId);
    setSelectedNodeId(nodeId);
  };

  return (
    <main className={`editor-shell${bottomOpen ? " bottom-open" : ""}`}>
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
        onSelectScene={(sceneId) => {
          setActiveSceneId(sceneId);
          setSelectedNodeId(null);
        }}
        project={project}
      />

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
            从节点右侧端口拖到目标节点，即可修改 YAML 跳转字段
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

      <section className={`bottom-panel${bottomOpen ? " open" : " collapsed"}`}>
        <header className="bottom-tabs">
          <button
            className={bottomTab === "problems" ? "active" : ""}
            onClick={() => {
              setBottomTab("problems");
              setBottomOpen(true);
            }}
            type="button"
          >
            问题{" "}
            <span className={errorCount > 0 ? "count-error" : ""}>
              {diagnostics.length}
            </span>
          </button>
          <button
            className={bottomTab === "yaml" ? "active" : ""}
            onClick={() => {
              setBottomTab("yaml");
              setBottomOpen(true);
            }}
            type="button"
          >
            YAML
          </button>
          <button
            className={bottomTab === "preview" ? "active" : ""}
            onClick={() => {
              setBottomTab("preview");
              setBottomOpen(true);
            }}
            type="button"
          >
            剧情试玩
          </button>
          <button
            className="bottom-toggle"
            onClick={() => setBottomOpen((value) => !value)}
            type="button"
          >
            {bottomOpen ? "⌄" : "⌃"}
          </button>
        </header>
        {bottomOpen && (
          <div className="bottom-content">
            {bottomTab === "problems" && (
              <DiagnosticsPanel
                diagnostics={diagnostics}
                onNavigate={navigate}
              />
            )}
            {bottomTab === "yaml" && activeScene !== undefined && (
              <YamlPanel
                onApply={(scene: SceneDefinition) => {
                  if (scene.id !== activeSceneId) {
                    setError(
                      "请使用场景重命名功能更改场景 ID，而不是直接修改 YAML 的 id。 ",
                    );
                    return;
                  }
                  commit((draft) => {
                    const file = findScene(draft, activeSceneId);
                    if (file !== undefined) file.definition = scene;
                  });
                }}
                scene={activeScene}
              />
            )}
            {bottomTab === "preview" && (
              <PreviewPanel
                assets={project.assets}
                dirty={dirty}
                onNavigate={(sceneId, nodeId) => navigate(sceneId, nodeId)}
              />
            )}
          </div>
        )}
      </section>

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
