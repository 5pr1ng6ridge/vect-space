import {
  ArrowLeft,
  Redo2,
  Save,
  ShieldCheck,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Button, IconButton } from "../ui/Button";

/**
 * The one header every full-screen workspace uses: a way back, what is being
 * edited, the workspace's own tools, and history/save in the same place as
 * the main editor's top bar.
 */
export function WorkspaceHeader({
  icon: Icon,
  kind,
  title,
  backLabel = "返回剧情图",
  onBack,
  dirty,
  undoAvailable,
  redoAvailable,
  onUndo,
  onRedo,
  onSave,
  onValidate,
  children,
  className,
}: {
  icon: LucideIcon;
  /** What kind of thing is edited, e.g. 「按钮模板」. */
  kind: string;
  /** Which one, e.g. its id. */
  title: ReactNode;
  backLabel?: string;
  onBack(): void;
  dirty: boolean;
  undoAvailable: boolean;
  redoAvailable: boolean;
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
  onValidate?(): void;
  /** Workspace-specific tools, shown in the middle of the header. */
  children?: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <header
      className={`workspace-header-bar${className === undefined ? "" : ` ${className}`}`}
    >
      <Button icon={ArrowLeft} onClick={onBack} size="sm" variant="ghost">
        {backLabel}
      </Button>
      <span aria-hidden="true" className="shell-divider" />
      <div className="workspace-header-title">
        <Icon aria-hidden="true" />
        <span>{kind}</span>
        <strong>{title}</strong>
      </div>
      <div className="workspace-header-tools">{children}</div>
      <div className="workspace-header-actions">
        {onValidate !== undefined && (
          <Button
            icon={ShieldCheck}
            onClick={onValidate}
            size="sm"
            variant="ghost"
          >
            校验
          </Button>
        )}
        <IconButton
          disabled={!undoAvailable}
          icon={Undo2}
          label="撤销"
          onClick={onUndo}
          shortcut="Ctrl+Z"
          size="sm"
        />
        <IconButton
          disabled={!redoAvailable}
          icon={Redo2}
          label="重做"
          onClick={onRedo}
          shortcut="Ctrl+Y"
          size="sm"
        />
        <span
          className={`shell-save-state${dirty ? " is-dirty" : ""}`}
          role="status"
        >
          {dirty ? "未保存" : "已保存"}
        </span>
        <Button
          disabled={!dirty}
          icon={Save}
          onClick={onSave}
          size="sm"
          title="Ctrl+S"
          variant="primary"
        >
          保存
        </Button>
      </div>
    </header>
  );
}
