import type { ReactElement, ReactNode } from "react";

export function CollapsibleSection({
  id,
  title,
  toggleLabel,
  className,
  open,
  onToggle,
  actions,
  children,
}: {
  /** A project section id, or a stable key for a nested group. */
  id: string;
  title: string;
  /** Accessible name of the toggle when the visible title repeats (per scene). */
  toggleLabel?: string;
  className?: string;
  open: boolean;
  onToggle(): void;
  actions?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const contentId = `project-section-content-${id}`;
  return (
    <section
      className={`variable-settings project-section${
        open ? "" : " collapsed"
      }${className === undefined ? "" : ` ${className}`}`}
    >
      <header>
        <button
          aria-controls={contentId}
          aria-expanded={open}
          aria-label={toggleLabel}
          className="project-section-toggle"
          onClick={onToggle}
          type="button"
        >
          <span aria-hidden="true" className="project-section-caret">
            {open ? "▾" : "▸"}
          </span>
          <strong>{title}</strong>
        </button>
        {actions !== undefined && (
          <div className="project-section-actions">{actions}</div>
        )}
      </header>
      <div className="project-section-content" hidden={!open} id={contentId}>
        {children}
      </div>
    </section>
  );
}
