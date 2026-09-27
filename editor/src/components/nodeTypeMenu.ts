/** Story node types as grouped menu entries (add / insert / change type). */
import {
  NODE_CATEGORY,
  NODE_CATEGORY_LABELS,
  NODE_CATEGORY_ORDER,
} from "../labels";
import { NODE_TYPES } from "../story";
import type { NodeType } from "../types";
import type { MenuItemSpec } from "../ui/Menu";
import { NODE_ICONS } from "../ui/nodeIcons";

/** Node types grouped by category, as menu entries. */
export function nodeTypeEntries(
  onPick: (type: NodeType) => void,
): MenuItemSpec[] {
  return NODE_CATEGORY_ORDER.flatMap((category): MenuItemSpec[] => {
    const types = NODE_TYPES.filter(
      (candidate) => NODE_CATEGORY[candidate.type] === category,
    );
    if (types.length === 0) return [];
    return [
      {
        kind: "label",
        id: `label:${category}`,
        label: NODE_CATEGORY_LABELS[category],
      },
      ...types.map((candidate) => ({
        id: candidate.type,
        label: candidate.label,
        icon: NODE_ICONS[candidate.type],
        onSelect: () => onPick(candidate.type),
      })),
    ];
  });
}
