import { useState, type ReactElement } from "react";
import { nodeLabel } from "../../story";
import type { SceneNode } from "../../types";
import { DeferredInput } from "../Fields";
import {
  Clapperboard,
  CopyPlus,
  Flag,
  MoreHorizontal,
  Pencil,
  Replace,
  Trash2,
} from "lucide-react";
import { NODE_CATEGORY } from "../../labels";
import { Badge } from "../../ui/Display";
import { IconButton } from "../../ui/Button";
import { DropdownMenu, type MenuItemSpec } from "../../ui/Menu";
import { NODE_ICONS } from "../../ui/nodeIcons";
import { useConfirm } from "../../ui/feedbackContext";
import { nodeTypeEntries } from "../nodeTypeMenu";

export function InspectorHeader({
  node,
  nodeId,
  isEntry,
  onRename,
  onChangeType,
  onSetEntry,
  onDuplicate,
  onDelete,
  onConvertToTimeline,
  onConvertActionToTimeline,
}: {
  node: SceneNode;
  nodeId: string;
  isEntry: boolean;
  onRename(next: string): void;
  onChangeType(type: SceneNode["type"]): void;
  onSetEntry(): void;
  onDuplicate(): void;
  onDelete(): void;
  onConvertToTimeline?(): void;
  onConvertActionToTimeline?(): void;
}): ReactElement {
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  const Icon = NODE_ICONS[node.type];
  const category = NODE_CATEGORY[node.type];
  const requestRename = (raw: string): boolean => {
    const next = raw.trim();
    if (next === "" || next === nodeId) {
      setRenaming(false);
      return true;
    }
    void confirm({
      title: `把节点 ${nodeId} 重命名为 ${next}？`,
      description:
        "本项目中指向它的连线、跳转与预览设置会一并更新；但玩家已有存档中记录的旧 ID 将无法恢复到这个节点。",
      confirmLabel: "重命名并更新引用",
    }).then((accepted) => {
      if (accepted) onRename(next);
      setRenaming(false);
    });
    return true;
  };
  const entries: MenuItemSpec[] = [
    {
      id: "entry",
      label: "设为场景入口",
      icon: Flag,
      disabled: isEntry,
      hint: "已经是场景入口",
      onSelect: onSetEntry,
    },
    {
      id: "rename",
      label: "重命名 ID…",
      icon: Pencil,
      onSelect: () => setRenaming(true),
    },
    {
      id: "duplicate",
      label: "创建副本",
      icon: CopyPlus,
      onSelect: onDuplicate,
    },
  ];
  if (
    onConvertToTimeline !== undefined ||
    onConvertActionToTimeline !== undefined
  )
    entries.push({ kind: "separator", id: "sep-convert" });
  if (onConvertToTimeline !== undefined)
    entries.push({
      id: "convert",
      label: "转为关键帧时间线",
      icon: Clapperboard,
      onSelect: onConvertToTimeline,
    });
  if (onConvertActionToTimeline !== undefined)
    entries.push({
      id: "convert-action",
      label: "展开为关键帧时间线",
      icon: Clapperboard,
      onSelect: onConvertActionToTimeline,
    });
  entries.push(
    { kind: "separator", id: "sep-type" },
    {
      kind: "submenu",
      id: "type",
      label: "更改类型",
      icon: Replace,
      entries: nodeTypeEntries((type) => {
        if (type === node.type) return;
        void confirm({
          title: `把这个节点改为「${nodeLabel(type)}」？`,
          description:
            "切换类型会清空该节点的专有设置，只保留节点 ID 与位置。可以撤销。",
          confirmLabel: "更改类型",
          danger: true,
        }).then((accepted) => {
          if (accepted) onChangeType(type);
        });
      }),
    },
    { kind: "separator", id: "sep-delete" },
    {
      id: "delete",
      label: "删除节点",
      icon: Trash2,
      danger: true,
      shortcut: "Delete",
      onSelect: onDelete,
    },
  );
  return (
    <header className={`inspector-header story-cat-${category}`}>
      <span className="inspector-type-icon">
        <Icon aria-hidden="true" />
      </span>
      <div className="inspector-heading">
        <h2>{nodeLabel(node.type)}</h2>
        {renaming ? (
          <DeferredInput
            aria-label="节点 ID"
            autoFocus
            className="inspector-id-input"
            onCommit={requestRename}
            onKeyDown={(event) => {
              if (event.key === "Escape") setRenaming(false);
            }}
            spellCheck={false}
            value={nodeId}
          />
        ) : (
          <button
            aria-label={`节点 ID ${nodeId}，点击重命名`}
            className="inspector-id"
            onClick={() => setRenaming(true)}
            title="点击重命名（存档会引用此 ID）"
            type="button"
          >
            <code>{nodeId}</code>
            <Pencil aria-hidden="true" />
          </button>
        )}
      </div>
      {isEntry && (
        <Badge icon={Flag} tone="accent">
          入口
        </Badge>
      )}
      <DropdownMenu
        align="end"
        entries={entries}
        label="节点操作"
        trigger={<IconButton icon={MoreHorizontal} label="节点操作" />}
      />
    </header>
  );
}
