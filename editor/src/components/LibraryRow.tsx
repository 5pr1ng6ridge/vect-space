import { MoreHorizontal, Pencil, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { IconButton } from "../ui/Button";
import { DropdownMenu, type MenuItemSpec } from "../ui/Menu";

/**
 * One entry of a sidebar library list (UI motion, button template, sprite
 * action…): name, a short meta line, an "edit" button and a menu with the
 * less frequent actions.  Double-clicking the row also opens it.
 */
export function LibraryRow({
  icon: Icon,
  title,
  meta,
  editLabel,
  onOpen,
  actions,
}: {
  icon: LucideIcon;
  title: ReactNode;
  meta?: ReactNode;
  /** Accessible name of the edit button, e.g. 「编辑 UI 动效 fade」. */
  editLabel: string;
  onOpen(): void;
  actions: MenuItemSpec[];
}): ReactElement {
  return (
    <article className="library-row" onDoubleClick={onOpen}>
      <span className="library-row-icon">
        <Icon aria-hidden="true" />
      </span>
      <span className="library-row-text">
        <strong>{title}</strong>
        {meta !== undefined && <small>{meta}</small>}
      </span>
      <IconButton
        icon={Pencil}
        label={editLabel}
        onClick={onOpen}
        size="sm"
        tooltip="打开编辑器"
      />
      <DropdownMenu
        align="end"
        entries={actions}
        label="更多操作"
        trigger={
          <IconButton icon={MoreHorizontal} label="更多操作" size="sm" />
        }
      />
    </article>
  );
}
