import type { ReactElement, ReactNode } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { IconButton } from "../../ui/Button";

/** Collapsible character / variable card: id toggle, rename and delete. */
export function SidebarItemCard({
  children,
  className = "variable-card",
  id,
  noun,
  onDelete,
  onRename,
  onToggle,
  open,
  itemKey,
}: {
  children: ReactNode;
  className?: string;
  id: string;
  /** "角色" / "变量": completes the accessible names. */
  noun: string;
  onDelete(): void;
  onRename(): void;
  onToggle(): void;
  open: boolean;
  itemKey: string;
}): ReactElement {
  const contentId = `sidebar-item-content-${encodeURIComponent(itemKey)}`;
  return (
    <article className={className}>
      <header>
        <button
          aria-controls={contentId}
          aria-expanded={open}
          aria-label={`${open ? "收起" : "展开"}${noun} ${id}`}
          className="sidebar-item-toggle"
          onClick={onToggle}
          type="button"
        >
          <span aria-hidden="true" className="sidebar-item-caret">
            {open ? "▾" : "▸"}
          </span>
          <code>{id}</code>
        </button>
        <div>
          <IconButton
            onClick={onRename}
            icon={Pencil}
            label={`重命名${noun} ID`}
            size="sm"
            variant="ghost"
          />
          <IconButton
            onClick={onDelete}
            icon={Trash2}
            label={`删除${noun}`}
            size="sm"
          />
        </div>
      </header>
      <div className="sidebar-item-content" hidden={!open} id={contentId}>
        {children}
      </div>
    </article>
  );
}
