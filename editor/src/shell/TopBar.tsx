import {
  ChevronDown,
  CircleCheck,
  FolderOpen,
  Map as MapIcon,
  PanelLeft,
  PanelRight,
  Play,
  Redo2,
  Save,
  Settings2,
  ShieldCheck,
  Undo2,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Button, IconButton } from "../ui/Button";
import { DropdownMenu, type MenuItemSpec } from "../ui/Menu";

export interface TopBarProps {
  /** Centre slot, e.g. the project search. */
  search?: ReactNode;
  projectName: string;
  sceneId: string;
  sceneIds: readonly string[];
  entrySceneId: string;
  dirty: boolean;
  saving: boolean;
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
  onSelectScene(sceneId: string): void;
  onOpenProject(): void;
  onOpenSettings(): void;
  onValidate(): void;
  onToggleLeftPanel(): void;
  onToggleRightPanel(): void;
  onOpenMap(): void;
  onPreview(): void;
  onUndo(): void;
  onRedo(): void;
  onSave(): void;
}

/**
 * The editor's single top bar: where you are (project › scene), how to move
 * between the big views, and history/save — the same place on every screen.
 */
export function TopBar(props: TopBarProps): ReactElement {
  const projectMenu: MenuItemSpec[] = [
    {
      id: "open",
      label: "打开其他项目…",
      icon: FolderOpen,
      onSelect: props.onOpenProject,
    },
    {
      id: "settings",
      label: "项目设置",
      icon: Settings2,
      onSelect: props.onOpenSettings,
    },
    {
      id: "validate",
      label: "完整校验项目",
      icon: ShieldCheck,
      onSelect: props.onValidate,
    },
  ];
  const sceneMenu: MenuItemSpec[] = props.sceneIds.map((id) => ({
    id,
    label: id === props.entrySceneId ? `${id}（入口）` : id,
    icon: id === props.sceneId ? CircleCheck : undefined,
    onSelect: () => props.onSelectScene(id),
  }));
  return (
    <header className="shell-topbar">
      <div className="shell-topbar-location">
        <span aria-hidden="true" className="shell-logo">
          V
        </span>
        <DropdownMenu
          entries={projectMenu}
          label="项目菜单"
          trigger={
            <button
              aria-label={`项目 ${props.projectName}`}
              className="shell-crumb"
              disabled={props.busy}
              type="button"
            >
              <strong>{props.projectName}</strong>
              <ChevronDown aria-hidden="true" />
            </button>
          }
        />
        <span aria-hidden="true" className="shell-crumb-separator">
          /
        </span>
        <DropdownMenu
          entries={sceneMenu}
          label="切换场景"
          trigger={
            <button
              aria-label={`当前场景 ${props.sceneId}`}
              className="shell-crumb"
              type="button"
            >
              <span>{props.sceneId || "（无场景）"}</span>
              <ChevronDown aria-hidden="true" />
            </button>
          }
        />
      </div>
      <div className="shell-topbar-search">{props.search}</div>
      <div className="shell-topbar-actions">
        <IconButton
          active={props.leftPanelVisible}
          icon={PanelLeft}
          label={props.leftPanelVisible ? "隐藏左侧面板" : "显示左侧面板"}
          onClick={props.onToggleLeftPanel}
          shortcut="Ctrl+B"
        />
        <IconButton
          active={props.rightPanelVisible}
          icon={PanelRight}
          label={props.rightPanelVisible ? "隐藏检查器" : "显示检查器"}
          onClick={props.onToggleRightPanel}
          shortcut="Ctrl+Alt+B"
        />
        <span aria-hidden="true" className="shell-divider" />
        <Button
          disabled={props.busy}
          icon={MapIcon}
          onClick={props.onOpenMap}
          variant="ghost"
        >
          章节地图
        </Button>
        <Button
          disabled={props.busy}
          icon={Play}
          onClick={props.onPreview}
          title="用真实运行时预览当前场景或所选节点（Ctrl+Enter）"
          variant="ghost"
        >
          游戏预览
        </Button>
        <span aria-hidden="true" className="shell-divider" />
        <IconButton
          disabled={!props.canUndo}
          icon={Undo2}
          label="撤销"
          onClick={props.onUndo}
          shortcut="Ctrl+Z"
        />
        <IconButton
          disabled={!props.canRedo}
          icon={Redo2}
          label="重做"
          onClick={props.onRedo}
          shortcut="Ctrl+Y"
        />
        <span
          className={`shell-save-state${props.dirty ? " is-dirty" : ""}`}
          role="status"
        >
          {props.saving ? "保存中…" : props.dirty ? "未保存" : "已保存"}
        </span>
        <Button
          disabled={props.busy || props.saving || !props.dirty}
          icon={Save}
          onClick={props.onSave}
          title="Ctrl+S"
          variant="primary"
        >
          保存项目
        </Button>
      </div>
    </header>
  );
}
