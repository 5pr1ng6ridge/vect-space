import type { ReactElement, Ref, UIEventHandler } from "react";
import type { EditorDiagnostic } from "../types";

export function DiagnosticsPanel({
  diagnostics,
  onNavigate,
  onScroll,
  scrollRef,
}: {
  diagnostics: EditorDiagnostic[];
  onNavigate(
    sceneId: string | null,
    nodeId: string | null,
    workspace?: "story" | "map",
    flowElementId?: string | null,
  ): void;
  scrollRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}): ReactElement {
  if (diagnostics.length === 0) {
    return (
      <div className="diagnostics-empty">
        <span>✓</span>
        当前项目没有发现问题
      </div>
    );
  }
  return (
    <div
      className="diagnostic-list"
      data-sidebar-scroller="problems"
      onScroll={onScroll}
      ref={scrollRef}
    >
      {diagnostics.map((diagnostic, index) => (
        <button
          className={`diagnostic-row diagnostic-${diagnostic.severity}`}
          key={`${diagnostic.code}-${diagnostic.scene_id}-${diagnostic.node_id}-${index}`}
          onClick={() =>
            onNavigate(
              diagnostic.scene_id,
              diagnostic.node_id,
              diagnostic.workspace,
              diagnostic.flow_element_id,
            )
          }
          type="button"
        >
          <span className="diagnostic-icon">
            {diagnostic.severity === "error"
              ? "×"
              : diagnostic.severity === "warning"
                ? "!"
                : "i"}
          </span>
          <code>{diagnostic.code}</code>
          <span>{diagnostic.message}</span>
          <small>
            {(() => {
              const location = [diagnostic.scene_id, diagnostic.node_id]
                .filter(Boolean)
                .join(" / ");
              return location !== ""
                ? location
                : (diagnostic.flow_element_id ?? "project");
            })()}
          </small>
        </button>
      ))}
    </div>
  );
}
