/** Recently opened project folders (per machine, most recent first). */
const RECENT_KEY = "vectspace-editor:recent-projects";
const LIMIT = 6;

export function loadRecentProjects(): string[] {
  try {
    const stored = JSON.parse(
      localStorage.getItem(RECENT_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(stored)
      ? stored
          .filter((item): item is string => typeof item === "string")
          .slice(0, LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function rememberRecentProject(root: string): void {
  try {
    const next = [
      root,
      ...loadRecentProjects().filter((item) => item !== root),
    ];
    localStorage.setItem(RECENT_KEY, JSON.stringify(next.slice(0, LIMIT)));
  } catch {
    // Remembering projects is a convenience only.
  }
}

/** Last path segment, for display. */
export function projectFolderName(root: string): string {
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root;
}
