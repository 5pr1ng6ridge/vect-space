import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { assetUrl, editorApi } from "../api";
import { isCanonicalIntegerText } from "../scalars";
import { useAssetFont } from "../useAssetFont";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { findAssetReferences } from "./assetReferences";
import type {
  AssetKind,
  CharacterDefinition,
  ContentManifest,
  EditorAsset,
  EditorDiagnostic,
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
  onNavigate(
    sceneId: string | null,
    nodeId: string | null,
    workspace?: "story" | "flow" | "map",
    flowElementId?: string | null,
  ): void;
  onTabChange?(tab: SidebarTab): void;
}

export type SidebarTab = "scenes" | "assets" | "project" | "problems";

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
  onNavigate,
  onTabChange,
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
          onSelectScene={onSelectScene}
          project={project}
        />
      )}
      {tab === "assets" && (
        <AssetsPanel
          project={project}
          onImportAssets={onImportAssets}
          onRemoveAsset={onRemoveAsset}
          selectedAssetId={selectedAssetId}
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
          project={project}
        />
      )}
      {tab === "problems" && (
        <DiagnosticsPanel diagnostics={diagnostics} onNavigate={onNavigate} />
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
    workspace?: "story" | "flow" | "map",
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
        if (`${asset.id} ${asset.path}`.toLowerCase().includes(needle))
          output.push({
            label: asset.id,
            detail: asset.path,
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
  onSelectScene,
  project,
}: {
  activeSceneId: string;
  diagnostics: EditorDiagnostic[];
  onAddScene(id: string): boolean;
  onDeleteScene(sceneId: string): void;
  onRenameScene(previousId: string, nextId: string): boolean;
  onSelectScene(sceneId: string): void;
  project: EditorProject;
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
      <div className="scene-list">
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
  selectedAssetId,
}: {
  project: EditorProject;
  onImportAssets(items: ImportDraft[]): Promise<void>;
  onRemoveAsset(id: string): boolean;
  selectedAssetId?: string | null;
}): ReactElement {
  const { assets, manifest } = project;
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importQueue, setImportQueue] = useState<ImportDraft[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
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
      assets.filter(
        (asset) =>
          (kindFilter === "all" || asset.kind === kindFilter) &&
          asset.id.toLowerCase().includes(query.toLowerCase()),
      ),
    [assets, kindFilter, query],
  );
  const selectedAsset = assets.find((asset) => asset.id === selected);
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
  const updateImport = (index: number, update: Partial<ImportDraft>): void => {
    setImportQueue((current) =>
      current === null
        ? null
        : current.map((item, candidate) =>
            candidate === index
              ? { ...item, ...update, error: undefined }
              : item,
          ),
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
      if (item.id in manifest.assets) errors.push("ID 已存在");
      if ((ids.get(item.id)?.length ?? 0) > 1) errors.push("清单中 ID 重复");
      const destination = `${assetFolder(item.kind)}/${item.fileName}`;
      if ((paths.get(destination.toLowerCase())?.length ?? 0) > 1)
        errors.push("目标路径重复");
      if (!supportedImportExtension(item.kind, item.fileName))
        errors.push("文件扩展名与素材类型不匹配");
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
        const paths = Array.from(event.dataTransfer.files)
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
      <div className="asset-list">
        {assets.length === 0 && (
          <p className="muted">将文件拖到这里，或点击 ＋ 批量导入</p>
        )}
        {shown.map((asset) => (
          <button
            className={selected === asset.id ? "active" : ""}
            key={asset.id}
            onClick={() => setSelected(asset.id)}
            type="button"
          >
            <span className={`asset-kind asset-kind-${asset.kind}`}>
              {asset.kind.slice(0, 2).toUpperCase()}
            </span>
            <span>
              <strong>{asset.id}</strong>
              <small>
                {manifest.assets[asset.id]?.path ?? asset.path} ·{" "}
                {formatAssetSize(asset.size_bytes)} ·{" "}
                {formatAssetMetadata(asset.metadata)} ·{" "}
                {references.get(asset.id)?.length ?? 0} 处引用
              </small>
            </span>
          </button>
        ))}
      </div>
      {selectedAsset !== undefined && (
        <div className="asset-detail">
          <AssetPreview asset={selectedAsset} />
          <strong>{selectedAsset.id}</strong>
          <code>{selectedAsset.path}</code>
          <small>
            大小：{formatAssetSize(selectedAsset.size_bytes)} ·{" "}
            {formatAssetMetadata(selectedAsset.metadata)} · 引用：
            {references.get(selectedAsset.id)?.length ?? 0} 处
          </small>
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
          aria-label="导入素材"
        >
          <header>
            <strong>导入素材 ({importQueue.length})</strong>
            <button onClick={() => setImportQueue(null)} type="button">
              取消
            </button>
          </header>
          <p>
            确认逻辑 ID、类型和文件名后一次导入。保存项目才会写入 manifest。
          </p>
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
                    updateImport(index, { fileName: event.currentTarget.value })
                  }
                  value={item.fileName}
                />
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
    </div>
  );
}

const ASSET_KINDS: AssetKind[] = [
  "background",
  "sprite",
  "gui",
  "bgm",
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

function AssetPreview({ asset }: { asset: EditorAsset }): ReactElement {
  const url = assetUrl(asset.absolute_path);
  const font = useAssetFont(
    asset.kind === "font" ? url : undefined,
    `Asset ${asset.id}`,
  );
  if (["background", "sprite", "gui"].includes(asset.kind)) {
    return <img alt={asset.id} className="asset-preview" src={url} />;
  }
  if (asset.kind === "bgm" || asset.kind === "sfx") {
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
  project,
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
  project: EditorProject;
}): ReactElement {
  const [dialog, setDialog] = useState<{
    title: string;
    value: string;
    kind:
      "character_add" | "character_rename" | "variable_add" | "variable_rename";
    previous?: string;
  } | null>(null);
  return (
    <div className="sidebar-body project-settings">
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
      <section className="variable-settings ui-motion-settings">
        <header>
          <strong>UI 动效</strong>
          <button onClick={onCreateUiMotion} type="button">
            ＋
          </button>
        </header>
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
      </section>
      <section className="variable-settings character-settings">
        <header>
          <strong>角色</strong>
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
        </header>
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
          </article>
        ))}
      </section>
      <section className="variable-settings">
        <header>
          <strong>剧情变量</strong>
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
        </header>
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
      </section>
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
