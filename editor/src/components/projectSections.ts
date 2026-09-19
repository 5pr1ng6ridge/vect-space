import type { SidebarTab } from "./ProjectSidebar";

/**
 * Sidebar view preferences shared between the App shell (which owns them) and
 * the sidebar panels (which render them).  Kept out of ProjectSidebar.tsx so
 * that file keeps exporting components only (react-refresh).
 */

/** The five collapsible sections of the project tab, in render order. */
export const PROJECT_SECTION_IDS = [
  "ui-motion",
  "button-template",
  "sprite-action",
  "character",
  "variable",
] as const;

export type ProjectSectionId = (typeof PROJECT_SECTION_IDS)[number];

export type ProjectSectionOpenState = Record<ProjectSectionId, boolean>;

/** Host-owned default: every project section starts expanded. */
export function createProjectSectionState(): ProjectSectionOpenState {
  return {
    "ui-motion": true,
    "button-template": true,
    "sprite-action": true,
    character: true,
    variable: true,
  };
}

/**
 * In-memory sidebar scroll offsets keyed by tab.  Shaped like a React ref so
 * the host (App) can own the storage and refresh it on every scroll without a
 * re-render.  This is ephemeral UI state: it is deliberately not part of the
 * manifest or the layout payload, so scrolling never marks content dirty.
 */
export interface SidebarScrollStore {
  current: Partial<Record<SidebarTab, number>>;
}
