import { open } from "@tauri-apps/plugin-dialog";
import { useMemo, useState, type ReactElement } from "react";
import { assetUrl } from "../api";
import type {
  AssetKind,
  ContentManifest,
  EditorAsset,
  EditorDiagnostic,
  EditorProject,
} from "../types";

interface ProjectSidebarProps {
  project: EditorProject;
  activeSceneId: string;
  diagnostics: EditorDiagnostic[];
  onSelectScene(sceneId: string): void;
  onAddScene(id: string): void;
  onRenameScene(previousId: string, nextId: string): void;
  onDeleteScene(sceneId: string): void;
  onManifestChange(manifest: ContentManifest): void;
  onImportAsset(id: string, kind: AssetKind, sourcePath: string): Promise<void>;
  onRemoveAsset(id: string): void;
}

type SidebarTab = "scenes" | "assets" | "project";

export function ProjectSidebar({
  project,
  activeSceneId,
  diagnostics,
  onSelectScene,
  onAddScene,
  onRenameScene,
  onDeleteScene,
  onManifestChange,
  onImportAsset,
  onRemoveAsset,
}: ProjectSidebarProps): ReactElement {
  const [tab, setTab] = useState<SidebarTab>("scenes");
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
      </div>
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
          assets={project.assets}
          manifest={project.manifest}
          onImportAsset={onImportAsset}
          onRemoveAsset={onRemoveAsset}
        />
      )}
      {tab === "project" && (
        <ProjectPanel
          manifest={project.manifest}
          onChange={onManifestChange}
          project={project}
        />
      )}
    </aside>
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
  onAddScene(id: string): void;
  onDeleteScene(sceneId: string): void;
  onRenameScene(previousId: string, nextId: string): void;
  onSelectScene(sceneId: string): void;
  project: EditorProject;
}): ReactElement {
  const [query, setQuery] = useState("");
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
            const id = window.prompt("新场景 ID", "new_scene")?.trim();
            if (id) onAddScene(id);
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
                    const next = window.prompt("新的场景 ID", scene.id)?.trim();
                    if (next && next !== scene.id)
                      onRenameScene(scene.id, next);
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
    </div>
  );
}

function AssetsPanel({
  assets,
  manifest,
  onImportAsset,
  onRemoveAsset,
}: {
  assets: EditorAsset[];
  manifest: ContentManifest;
  onImportAsset(id: string, kind: AssetKind, sourcePath: string): Promise<void>;
  onRemoveAsset(id: string): void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const shown = useMemo(
    () =>
      assets.filter((asset) =>
        asset.id.toLowerCase().includes(query.toLowerCase()),
      ),
    [assets, query],
  );
  const selectedAsset = assets.find((asset) => asset.id === selected);
  const handleImport = async (): Promise<void> => {
    const picked = await open({
      multiple: false,
      directory: false,
      title: "选择素材文件",
    });
    if (typeof picked !== "string") return;
    const id = window.prompt("素材逻辑 ID", "asset.new")?.trim();
    if (!id) return;
    const kind = window.prompt(
      "素材类型：background / sprite / gui / bgm / sfx / font",
      "background",
    ) as AssetKind | null;
    if (
      !kind ||
      !["background", "sprite", "gui", "bgm", "sfx", "font"].includes(kind)
    ) {
      window.alert("素材类型无效");
      return;
    }
    setImporting(true);
    try {
      await onImportAsset(id, kind, picked);
      setSelected(id);
    } finally {
      setImporting(false);
    }
  };
  return (
    <div className="sidebar-body asset-sidebar">
      <div className="sidebar-search-row">
        <input
          aria-label="搜索素材"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索素材…"
          value={query}
        />
        <button
          disabled={importing}
          onClick={() => void handleImport()}
          title="导入素材"
          type="button"
        >
          ＋
        </button>
      </div>
      <div className="asset-list">
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
              <small>{manifest.assets[asset.id]?.path ?? asset.path}</small>
            </span>
          </button>
        ))}
      </div>
      {selectedAsset !== undefined && (
        <div className="asset-detail">
          <AssetPreview asset={selectedAsset} />
          <strong>{selectedAsset.id}</strong>
          <code>{selectedAsset.path}</code>
          <button
            className="danger-button"
            onClick={() => {
              if (window.confirm("从 manifest 移除此素材？磁盘文件会保留。")) {
                onRemoveAsset(selectedAsset.id);
                setSelected(null);
              }
            }}
            type="button"
          >
            从清单移除
          </button>
        </div>
      )}
    </div>
  );
}

function AssetPreview({ asset }: { asset: EditorAsset }): ReactElement {
  const url = assetUrl(asset.absolute_path);
  if (["background", "sprite", "gui"].includes(asset.kind)) {
    return <img alt={asset.id} className="asset-preview" src={url} />;
  }
  if (asset.kind === "bgm" || asset.kind === "sfx") {
    return <audio className="asset-audio" controls src={url} />;
  }
  return (
    <div className="font-preview" style={{ fontFamily: `url(${url})` }}>
      Aa 数学 123
    </div>
  );
}

function ProjectPanel({
  manifest,
  onChange,
  project,
}: {
  manifest: ContentManifest;
  onChange(manifest: ContentManifest): void;
  project: EditorProject;
}): ReactElement {
  return (
    <div className="sidebar-body project-settings">
      <label>
        <span>内容版本</span>
        <input
          value={manifest.content_version}
          onChange={(event) =>
            onChange({
              ...manifest,
              content_version: event.currentTarget.value,
            })
          }
        />
        <small>改变后旧存档将不再兼容</small>
      </label>
      <label>
        <span>默认语言</span>
        <input
          value={manifest.default_locale}
          onChange={(event) =>
            onChange({ ...manifest, default_locale: event.currentTarget.value })
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
    </div>
  );
}
