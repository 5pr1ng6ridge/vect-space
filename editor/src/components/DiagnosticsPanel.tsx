import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import type { ReactElement, Ref, UIEventHandler } from "react";

import type { EditorDiagnostic } from "../types";
import { EmptyState } from "../ui/Display";

const SEVERITY_ICON = {
  error: CircleX,
  warning: TriangleAlert,
  info: Info,
} as const;

function groupTitle(diagnostic: EditorDiagnostic): string {
  if (diagnostic.workspace === "map") return "章节地图";
  return diagnostic.scene_id ?? "项目";
}

/**
 * Validation problems grouped by scene (or project / chapter map), errors
 * first.  The message is the headline; the location and the machine code
 * stay as quiet detail.  Clicking a problem jumps to it.
 */
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
        <EmptyState compact icon={CircleCheck} title="当前项目没有发现问题">
          保存前编辑器会再用游戏运行时做一次完整校验。
        </EmptyState>
      </div>
    );
  }
  const rank = (diagnostic: EditorDiagnostic): number =>
    diagnostic.severity === "error"
      ? 0
      : diagnostic.severity === "warning"
        ? 1
        : 2;
  const groups = new Map<string, EditorDiagnostic[]>();
  for (const diagnostic of [...diagnostics].sort(
    (left, right) => rank(left) - rank(right),
  )) {
    const key = groupTitle(diagnostic);
    groups.set(key, [...(groups.get(key) ?? []), diagnostic]);
  }
  return (
    <div
      className="diagnostic-list"
      data-sidebar-scroller="problems"
      onScroll={onScroll}
      ref={scrollRef}
    >
      {[...groups.entries()].map(([title, items]) => (
        <section className="diagnostic-group" key={title}>
          <h3>
            {title}
            <span>{items.length}</span>
          </h3>
          {items.map((diagnostic, index) => {
            const Icon = SEVERITY_ICON[diagnostic.severity] ?? Info;
            const location = [diagnostic.node_id, diagnostic.flow_element_id]
              .filter(Boolean)
              .join(" · ");
            return (
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
                title={diagnostic.code}
                type="button"
              >
                <Icon aria-hidden="true" className="diagnostic-icon" />
                <span className="diagnostic-text">
                  <span>{diagnostic.message}</span>
                  {location !== "" && <small>{location}</small>}
                </span>
              </button>
            );
          })}
        </section>
      ))}
    </div>
  );
}
