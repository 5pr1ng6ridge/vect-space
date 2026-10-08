import { useMemo, useState, type ReactElement } from "react";
import type { EditorProject } from "../../types";

export function ProjectSearch({
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
