/**
 * Dropdown and context menus.  Both share one visual (`.vs-menu`) and the
 * same item API so a node's right-click menu and its "…" button can render
 * identical entries.
 *
 * The desktop browser guard blocks native `contextmenu` events outside
 * `[data-allow-context-menu]`; `ContextMenuArea` always sets that marker on
 * its trigger, and callers should keep triggers tight so WebView2's own menu
 * never appears on unrelated chrome.
 */
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Kbd } from "./Display";

export interface MenuEntry {
  kind?: "item";
  id: string;
  label: ReactNode;
  icon?: LucideIcon;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** Short reason shown when the entry is disabled. */
  hint?: string;
  onSelect(): void;
}

export interface MenuSubmenu {
  kind: "submenu";
  id: string;
  label: ReactNode;
  icon?: LucideIcon;
  entries: MenuItemSpec[];
}

export interface MenuSeparator {
  kind: "separator";
  id: string;
}

export interface MenuLabel {
  kind: "label";
  id: string;
  label: ReactNode;
}

export type MenuItemSpec = MenuEntry | MenuSubmenu | MenuSeparator | MenuLabel;

type Primitives = typeof DropdownMenuPrimitive | typeof ContextMenuPrimitive;

function renderEntries(
  primitives: Primitives,
  entries: readonly MenuItemSpec[],
): ReactNode {
  const P = primitives;
  return entries.map((entry) => {
    if (entry.kind === "separator")
      return <P.Separator className="vs-menu-separator" key={entry.id} />;
    if (entry.kind === "label")
      return (
        <P.Label className="vs-menu-label" key={entry.id}>
          {entry.label}
        </P.Label>
      );
    if (entry.kind === "submenu") {
      const Icon = entry.icon;
      return (
        <P.Sub key={entry.id}>
          <P.SubTrigger className="vs-menu-item">
            <span className="vs-menu-item-icon">
              {Icon !== undefined && <Icon aria-hidden="true" />}
            </span>
            <span className="vs-menu-item-label">{entry.label}</span>
            <ChevronRight aria-hidden="true" className="vs-menu-chevron" />
          </P.SubTrigger>
          <P.Portal>
            <P.SubContent
              className="vs-menu"
              collisionPadding={8}
              sideOffset={4}
            >
              {renderEntries(primitives, entry.entries)}
            </P.SubContent>
          </P.Portal>
        </P.Sub>
      );
    }
    const Icon = entry.icon;
    return (
      <P.Item
        className={`vs-menu-item${entry.danger === true ? " is-danger" : ""}`}
        disabled={entry.disabled}
        key={entry.id}
        onSelect={() => entry.onSelect()}
        title={entry.disabled === true ? entry.hint : undefined}
      >
        <span className="vs-menu-item-icon">
          {Icon !== undefined && <Icon aria-hidden="true" />}
        </span>
        <span className="vs-menu-item-label">{entry.label}</span>
        {entry.shortcut !== undefined && <Kbd>{entry.shortcut}</Kbd>}
      </P.Item>
    );
  });
}

/** A button-triggered menu. `trigger` must be a single focusable element. */
export function DropdownMenu({
  trigger,
  entries,
  align = "start",
  side = "bottom",
  label,
}: {
  trigger: ReactElement;
  entries: readonly MenuItemSpec[];
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  /** Accessible name of the menu surface. */
  label?: string;
}): ReactElement {
  return (
    <DropdownMenuPrimitive.Root modal={false}>
      <DropdownMenuPrimitive.Trigger asChild>
        {trigger}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align={align}
          aria-label={label}
          className="vs-menu"
          collisionPadding={8}
          side={side}
          sideOffset={4}
        >
          {renderEntries(DropdownMenuPrimitive, entries)}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

/**
 * Right-click menu for a region.  `entries` is evaluated when the menu opens
 * so it can depend on what was under the pointer (see `onOpen`).
 */
export function ContextMenuArea({
  children,
  entries,
  label,
  onOpen,
  disabled = false,
}: {
  children: ReactElement;
  entries: readonly MenuItemSpec[];
  label?: string;
  /** Called with the native event before the menu opens. */
  onOpen?(event: React.MouseEvent): void;
  disabled?: boolean;
}): ReactElement {
  return (
    <ContextMenuPrimitive.Root modal={false}>
      <ContextMenuPrimitive.Trigger
        asChild
        data-allow-context-menu="true"
        disabled={disabled}
        onContextMenu={onOpen}
      >
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          aria-label={label}
          className="vs-menu"
          collisionPadding={8}
        >
          {renderEntries(ContextMenuPrimitive, entries)}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
