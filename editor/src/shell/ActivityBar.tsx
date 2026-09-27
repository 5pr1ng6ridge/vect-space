import {
  Braces,
  Clapperboard,
  Images,
  Library,
  Settings2,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ReactElement } from "react";

import type { SidebarTab } from "../components/ProjectSidebar";
import { Tip } from "../ui/Tooltip";

const ITEMS: { tab: SidebarTab; label: string; icon: LucideIcon }[] = [
  { tab: "scenes", label: "场景", icon: Clapperboard },
  { tab: "assets", label: "素材", icon: Images },
  { tab: "characters", label: "角色", icon: Users },
  { tab: "variables", label: "变量", icon: Braces },
  { tab: "library", label: "资源库", icon: Library },
  { tab: "problems", label: "问题", icon: TriangleAlert },
];

/**
 * Vertical switcher for the left panel.  Clicking the active item collapses
 * the panel, like the activity bar of most desktop editors.
 */
export function ActivityBar({
  activeTab,
  panelVisible,
  problemCount,
  errorCount,
  onSelect,
}: {
  activeTab: SidebarTab;
  panelVisible: boolean;
  problemCount: number;
  errorCount: number;
  onSelect(tab: SidebarTab): void;
}): ReactElement {
  const renderItem = (
    tab: SidebarTab,
    label: string,
    Icon: LucideIcon,
  ): ReactElement => {
    const active = panelVisible && activeTab === tab;
    const count = tab === "problems" ? problemCount : 0;
    return (
      <Tip content={label} key={tab} side="right">
        <button
          aria-label={count > 0 ? `${label}（${count}）` : label}
          aria-pressed={active}
          className={`shell-activity-item${active ? " is-active" : ""}`}
          onClick={() => onSelect(tab)}
          type="button"
        >
          <Icon aria-hidden="true" />
          {count > 0 && (
            <span
              className={`shell-activity-count${errorCount > 0 ? " is-error" : ""}`}
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </Tip>
    );
  };
  return (
    <nav aria-label="面板" className="shell-activity">
      {ITEMS.map((item) => renderItem(item.tab, item.label, item.icon))}
      <span className="shell-activity-spacer" />
      {renderItem("project", "项目设置", Settings2)}
    </nav>
  );
}
