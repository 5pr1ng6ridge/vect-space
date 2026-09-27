import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

/** Quiet, one-line context at the bottom of the window. */
export function StatusBar({
  selection,
  sceneNodeCount,
  errorCount,
  warningCount,
  onShowProblems,
}: {
  selection: ReactNode;
  sceneNodeCount: number;
  errorCount: number;
  warningCount: number;
  onShowProblems(): void;
}): ReactElement {
  const clean = errorCount === 0 && warningCount === 0;
  return (
    <footer className="shell-statusbar">
      <span className="shell-status-item">{selection}</span>
      <span className="shell-status-item">{sceneNodeCount} 个节点</span>
      <button
        className={`shell-status-problems${errorCount > 0 ? " has-errors" : ""}`}
        onClick={onShowProblems}
        type="button"
      >
        {clean ? (
          <>
            <CircleCheck aria-hidden="true" />
            检查通过
          </>
        ) : (
          <>
            <CircleAlert aria-hidden="true" />
            {errorCount} 个错误
            <TriangleAlert aria-hidden="true" />
            {warningCount} 个警告
          </>
        )}
      </button>
    </footer>
  );
}
