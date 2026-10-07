// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState, type ComponentProps, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorDiagnostic, EditorProject } from "../types";
import { ProjectSidebar, type SidebarTab } from "./ProjectSidebar";
import {
  createProjectSectionState,
  PROJECT_SECTION_IDS,
  type ProjectSectionId,
  type SidebarScrollStore,
} from "./projectSections";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

afterEach(cleanup);

const SECTION_LABELS: Record<ProjectSectionId, string> = {
  "ui-motion": "UI 动效",
  "button-template": "按钮模板",
  "sprite-action": "立绘动作库",
  particle: "粒子效果",
  character: "角色",
  variable: "剧情变量",
};

function createProject(): EditorProject {
  return {
    root: "C:/game",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: "main",
      default_locale: "zh-CN",
      variables: {
        affection: { scope: "save", type: "integer", default: 0 },
        courage: { scope: "save", type: "integer", default: 1 },
      },
      characters: {
        lumi: {
          display_name: "露米",
          name_color: "#ffffff",
          text_color: "#ffffff",
        },
        sora: {
          display_name: "空",
          name_color: "#ffffff",
          text_color: "#ffffff",
        },
      },
      assets: {},
      scenes: ["scenes/main.yaml"],
      ui_motions: ["ui_motions/fade.yaml"],
      ui_motion_defaults: {},
    },
    scenes: [
      {
        path: "scenes/main.yaml",
        definition: {
          schema_version: 2,
          id: "main",
          entry: "start",
          nodes: {},
        },
      },
    ],
    ui_motions: [
      {
        path: "ui_motions/fade.yaml",
        definition: {
          schema_version: 1,
          id: "fade",
          duration_ms: 300,
          tracks: [],
        },
      },
    ],
    buttons: [
      {
        path: "buttons/primary.yaml",
        definition: {
          schema_version: 1,
          id: "primary",
          width: 320,
          height: 72,
          asset_mode: "separate",
          fit: "contain",
          animations: {},
        },
      },
    ],
    actions: [
      {
        path: "actions/bounce.yaml",
        definition: {
          schema_version: 1,
          id: "sprite.bounce",
          name: "小跳",
          duration_ms: 600,
          channels: {},
        },
      },
    ],
    layout: { version: 1, scenes: {} },
    assets: [],
    diagnostics: [],
    fingerprint: "fingerprint",
  };
}

const SIDEBAR_CALLBACKS = {
  onAddCharacter: () => true,
  onAddScene: () => true,
  onAddVariable: () => true,
  onChangeCharacter: () => undefined,
  onChangeVariable: () => undefined,
  onCreateAction: () => true,
  onCreateButtonTemplate: () => undefined,
  onCreateImageAnimation: () => true,
  onCreateUiMotion: () => undefined,
  onDeleteAction: () => undefined,
  onDeleteButtonTemplate: () => undefined,
  onDeleteCharacter: () => undefined,
  onDeleteScene: () => undefined,
  onDeleteUiMotion: () => undefined,
  onDeleteVariable: () => undefined,
  onDuplicateAction: () => undefined,
  onDuplicateButtonTemplate: () => undefined,
  onEditActionKeyframes: () => undefined,
  onEditButtonTemplate: () => undefined,
  onEditUiMotion: () => undefined,
  onImportAssets: () => Promise.resolve(),
  onManifestChange: () => undefined,
  onNavigate: () => undefined,
  onRemoveAsset: () => false,
  onRenameAction: () => true,
  onRenameCharacter: () => true,
  onRenameScene: () => true,
  onRenameVariable: () => true,
  onSelectAsset: () => undefined,
  visualLibrary: {
    onCreate: () => true,
    onRename: () => true,
    onDuplicate: () => undefined,
    onDelete: () => undefined,
    onEdit: () => undefined,
  },
  onSelectScene: () => undefined,
};

/** Mimics App: the host owns the section-open state and passes it down. */
function ProjectHarness({
  project,
  overrides,
}: {
  project: EditorProject;
  overrides?: Partial<ComponentProps<typeof ProjectSidebar>>;
}): ReactElement {
  const [sections, setSections] = useState(createProjectSectionState);
  const [itemsOpen, setItemsOpen] = useState<Record<string, boolean>>({});
  return (
    <ProjectSidebar
      {...SIDEBAR_CALLBACKS}
      activeSceneId="main"
      activeTab="project"
      diagnostics={[]}
      onToggleSection={(sectionId) =>
        setSections((current) => ({
          ...current,
          [sectionId]: !current[sectionId],
        }))
      }
      onToggleSidebarItem={(key) =>
        setItemsOpen((current) => ({
          ...current,
          [key]: !(current[key] ?? true),
        }))
      }
      project={project}
      sidebarItemOpen={itemsOpen}
      sectionOpen={sections}
      {...overrides}
    />
  );
}

/**
 * Mimics the App shell: the sidebar can be unmounted (keyframe/full-screen
 * workspace) while the host that owns tab, section, and scroll state stays
 * mounted.
 */
function RoundTripHarness({
  project,
  diagnostics,
  store,
  onScrollOffset,
  overrides,
}: {
  project: EditorProject;
  diagnostics: EditorDiagnostic[];
  store: SidebarScrollStore;
  onScrollOffset?(tab: SidebarTab, offset: number): void;
  overrides?: Partial<ComponentProps<typeof ProjectSidebar>>;
}): ReactElement {
  const [sections, setSections] = useState(createProjectSectionState);
  const [itemsOpen, setItemsOpen] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<SidebarTab>("scenes");
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button onClick={() => setVisible((current) => !current)} type="button">
        切换侧栏
      </button>
      {visible && (
        <ProjectSidebar
          {...SIDEBAR_CALLBACKS}
          activeSceneId="main"
          activeTab={tab}
          diagnostics={diagnostics}
          onScrollOffset={onScrollOffset}
          onTabChange={setTab}
          onToggleSection={(sectionId) =>
            setSections((current) => ({
              ...current,
              [sectionId]: !current[sectionId],
            }))
          }
          onToggleSidebarItem={(key) =>
            setItemsOpen((current) => ({
              ...current,
              [key]: !(current[key] ?? true),
            }))
          }
          project={project}
          scrollStore={store}
          sidebarItemOpen={itemsOpen}
          sectionOpen={sections}
          {...overrides}
        />
      )}
    </>
  );
}

function sectionRegion(label: string): HTMLElement {
  const toggle = screen.getByRole("button", { name: label });
  const contentId = toggle.getAttribute("aria-controls") ?? "";
  const region = document.getElementById(contentId);
  if (region === null) throw new Error(`missing region for ${label}`);
  return region;
}

function scroller(tab: SidebarTab): HTMLElement {
  const node = document.querySelector(`[data-sidebar-scroller="${tab}"]`);
  if (node === null) throw new Error(`missing scroller for ${tab}`);
  return node as HTMLElement;
}

function scrollTo(tab: SidebarTab, offset: number): void {
  const node = scroller(tab);
  node.scrollTop = offset;
  fireEvent.scroll(node);
}

describe("project panel sections", () => {
  it("collapses characters and variables independently", () => {
    render(<ProjectHarness project={createProject()} />);

    const lumi = screen.getByRole("button", { name: "收起角色 lumi" });
    const sora = screen.getByRole("button", { name: "收起角色 sora" });
    const affection = screen.getByRole("button", {
      name: "收起变量 affection",
    });
    const courage = screen.getByRole("button", { name: "收起变量 courage" });
    const regionFor = (button: HTMLElement): HTMLElement => {
      const region = document.getElementById(
        button.getAttribute("aria-controls") ?? "",
      );
      if (region === null) throw new Error("missing item content region");
      return region;
    };

    fireEvent.click(lumi);
    expect(lumi).toHaveAttribute("aria-expanded", "false");
    expect(regionFor(lumi)).toHaveAttribute("hidden");
    expect(sora).toHaveAttribute("aria-expanded", "true");
    expect(regionFor(sora)).not.toHaveAttribute("hidden");

    fireEvent.click(affection);
    expect(affection).toHaveAttribute("aria-expanded", "false");
    expect(regionFor(affection)).toHaveAttribute("hidden");
    expect(courage).toHaveAttribute("aria-expanded", "true");
    expect(regionFor(courage)).not.toHaveAttribute("hidden");
  });

  it("starts every section expanded and toggles each one independently", () => {
    render(<ProjectHarness project={createProject()} />);

    for (const id of PROJECT_SECTION_IDS) {
      const label = SECTION_LABELS[id];
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(sectionRegion(label)).not.toHaveAttribute("hidden");
    }

    fireEvent.click(screen.getByRole("button", { name: "角色" }));
    expect(screen.getByRole("button", { name: "角色" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(sectionRegion("角色")).toHaveAttribute("hidden");
    for (const label of ["UI 动效", "按钮模板", "立绘动作库", "剧情变量"]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      expect(sectionRegion(label)).not.toHaveAttribute("hidden");
    }

    fireEvent.click(screen.getByRole("button", { name: "剧情变量" }));
    expect(screen.getByRole("button", { name: "剧情变量" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "角色" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // Collapsed bodies stay mounted, so their ids keep resolving.
    expect(screen.getByText("affection")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "剧情变量" }));
    expect(screen.getByRole("button", { name: "剧情变量" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(sectionRegion("剧情变量")).not.toHaveAttribute("hidden");
  });

  it("uses native focusable toggles wired to hidden regions and keeps action buttons independent", () => {
    const onCreateUiMotion = vi.fn();
    render(
      <ProjectHarness
        overrides={{ onCreateUiMotion }}
        project={createProject()}
      />,
    );

    const toggle = screen.getByRole("button", { name: "UI 动效" });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle.getAttribute("aria-controls")).toBe(
      sectionRegion("UI 动效").id,
    );
    toggle.focus();
    expect(toggle).toHaveFocus();

    const section = toggle.closest("section");
    if (section === null) throw new Error("missing section element");
    fireEvent.click(
      within(section).getByRole("button", { name: "新建 UI 动效" }),
    );
    expect(onCreateUiMotion).toHaveBeenCalledTimes(1);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(sectionRegion("UI 动效")).toHaveAttribute("hidden");
    // The ＋ action is a sibling of the toggle, so it still works collapsed.
    fireEvent.click(
      within(section).getByRole("button", { name: "新建 UI 动效" }),
    );
    expect(onCreateUiMotion).toHaveBeenCalledTimes(2);
  });

  it("keeps individual item collapse state across sidebar unmounts", () => {
    render(
      <RoundTripHarness
        diagnostics={[]}
        project={createProject()}
        store={{ current: {} }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "项目" }));
    fireEvent.click(screen.getByRole("button", { name: "收起角色 lumi" }));
    fireEvent.click(screen.getByRole("button", { name: "场景" }));
    fireEvent.click(screen.getByRole("button", { name: "项目" }));
    expect(
      screen.getByRole("button", { name: "展开角色 lumi" }),
    ).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "切换侧栏" }));
    fireEvent.click(screen.getByRole("button", { name: "切换侧栏" }));
    fireEvent.click(screen.getByRole("button", { name: "项目" }));
    expect(
      screen.getByRole("button", { name: "展开角色 lumi" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps host-owned collapse state across a sidebar unmount/remount round trip", () => {
    render(
      <RoundTripHarness
        diagnostics={[]}
        project={createProject()}
        store={{ current: {} }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "项目" }));
    fireEvent.click(screen.getByRole("button", { name: "角色" }));
    expect(screen.getByRole("button", { name: "角色" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Leaving the project tab (which unmounts ProjectPanel) keeps the choice.
    fireEvent.click(screen.getByRole("button", { name: "场景" }));
    fireEvent.click(screen.getByRole("button", { name: "项目" }));
    expect(screen.getByRole("button", { name: "角色" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "切换侧栏" }));
    expect(screen.queryByRole("button", { name: "角色" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "切换侧栏" }));
    expect(screen.getByRole("button", { name: "角色" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "剧情变量" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

describe("sidebar scroll restoration", () => {
  it("records and restores every tab's own scroll offset across an unmount/remount", () => {
    const store: SidebarScrollStore = { current: {} };
    const onManifestChange = vi.fn();
    const onScrollOffset = (tab: SidebarTab, offset: number): void => {
      store.current[tab] = offset;
    };
    render(
      <RoundTripHarness
        diagnostics={[
          {
            severity: "info",
            code: "TEST_INFO",
            message: "示例诊断",
            scene_id: "main",
            node_id: null,
          },
        ]}
        onScrollOffset={onScrollOffset}
        overrides={{ onManifestChange }}
        project={createProject()}
        store={store}
      />,
    );

    scrollTo("scenes", 140);
    fireEvent.click(screen.getByRole("button", { name: "素材" }));
    scrollTo("assets", 60);
    fireEvent.click(screen.getByRole("button", { name: "项目" }));
    scrollTo("project", 220);
    fireEvent.click(screen.getByRole("button", { name: /^问题/ }));
    scrollTo("problems", 30);

    expect(store.current).toMatchObject({
      scenes: 140,
      assets: 60,
      project: 220,
      problems: 30,
    });
    // Scrolling and collapsing must never look like content edits.
    expect(onManifestChange).not.toHaveBeenCalled();

    // Enter and leave a full-screen workspace: the host stays mounted, the
    // sidebar does not.
    fireEvent.click(screen.getByRole("button", { name: "切换侧栏" }));
    fireEvent.click(screen.getByRole("button", { name: "切换侧栏" }));

    expect(scroller("problems")).toHaveClass("diagnostic-list");
    expect(scroller("problems").scrollTop).toBe(30);
    fireEvent.click(screen.getByRole("button", { name: "场景" }));
    expect(scroller("scenes")).toHaveClass("scene-list");
    expect(scroller("scenes").scrollTop).toBe(140);
    fireEvent.click(screen.getByRole("button", { name: "素材" }));
    expect(scroller("assets")).toHaveClass("asset-list");
    expect(scroller("assets").scrollTop).toBe(60);
    fireEvent.click(screen.getByRole("button", { name: "项目" }));
    // The project tab scrolls in the panel root, not in a nested list.
    expect(scroller("project")).toHaveClass("project-settings");
    expect(scroller("project").scrollTop).toBe(220);
    expect(onManifestChange).not.toHaveBeenCalled();
  });

  it("restores the problems offset across a plain tab switch without remounting the sidebar", () => {
    const store: SidebarScrollStore = { current: {} };
    render(
      <RoundTripHarness
        diagnostics={[
          {
            severity: "warning",
            code: "TEST_WARN",
            message: "示例诊断",
            scene_id: "main",
            node_id: null,
          },
        ]}
        onScrollOffset={(tab, offset) => {
          store.current[tab] = offset;
        }}
        project={createProject()}
        store={store}
      />,
    );

    // Open Problems and scroll it.  The panel mounts on an ordinary tab
    // switch while ProjectSidebar itself stays mounted the whole time.
    fireEvent.click(screen.getByRole("button", { name: /^问题/ }));
    scrollTo("problems", 180);
    expect(scroller("problems").scrollTop).toBe(180);
    expect(store.current.problems).toBe(180);

    fireEvent.click(screen.getByRole("button", { name: "场景" }));
    expect(scroller("scenes")).toHaveClass("scene-list");
    expect(scroller("scenes").scrollTop).toBe(0);

    // Returning must restore the remembered offset even though the sidebar
    // never unmounted and the hook dependencies did not change.
    fireEvent.click(screen.getByRole("button", { name: /^问题/ }));
    expect(scroller("problems")).toHaveClass("diagnostic-list");
    expect(scroller("problems").scrollTop).toBe(180);

    // A second round trip keeps working (idempotent remount restore).
    fireEvent.click(screen.getByRole("button", { name: "素材" }));
    fireEvent.click(screen.getByRole("button", { name: /^问题/ }));
    expect(scroller("problems").scrollTop).toBe(180);
  });
});
