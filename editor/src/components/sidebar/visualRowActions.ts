import { CopyPlus, Pencil, Trash2 } from "lucide-react";
import type { VisualKind } from "../../app/visualLibrary";
import type { MenuItemSpec } from "../../ui/Menu";
import type { VisualLibraryHandlers } from "./types";

/** Rename / copy / remove menu shared by every fixed-text and particle row. */
export function visualRowActions(
  visual: VisualKind,
  id: string,
  library: VisualLibraryHandlers,
  onRename: () => void,
): MenuItemSpec[] {
  return [
    { id: "rename", label: "重命名 ID…", icon: Pencil, onSelect: onRename },
    {
      id: "duplicate",
      label: "创建副本",
      icon: CopyPlus,
      onSelect: () => library.onDuplicate(visual, id),
    },
    { kind: "separator", id: "sep" },
    {
      id: "delete",
      label: "从项目移除",
      icon: Trash2,
      danger: true,
      onSelect: () => library.onDelete(visual, id),
    },
  ];
}
