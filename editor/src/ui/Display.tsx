import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

/** Keyboard shortcut chip. */
export function Kbd({ children }: { children: ReactNode }): ReactElement {
  return <kbd className="vs-kbd">{children}</kbd>;
}

export type BadgeTone = "neutral" | "accent" | "info" | "warning" | "danger";

/** Small status label. */
export function Badge({
  children,
  tone = "neutral",
  icon: Icon,
  title,
}: {
  children?: ReactNode;
  tone?: BadgeTone;
  icon?: LucideIcon;
  title?: string;
}): ReactElement {
  return (
    <span className={`vs-badge vs-badge-${tone}`} title={title}>
      {Icon !== undefined && <Icon aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Centered placeholder for an empty list, panel or selection. */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  compact = false,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}): ReactElement {
  return (
    <div className={`vs-empty${compact ? " vs-empty-compact" : ""}`}>
      {Icon !== undefined && (
        <Icon aria-hidden="true" className="vs-empty-icon" />
      )}
      <p className="vs-empty-title">{title}</p>
      {children !== undefined && <p className="vs-empty-body">{children}</p>}
      {action}
    </div>
  );
}

/** Indeterminate progress indicator. */
export function Spinner({
  label = "处理中",
}: {
  label?: string;
}): ReactElement {
  return <span aria-label={label} className="vs-spinner" role="status" />;
}
