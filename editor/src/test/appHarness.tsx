/**
 * Shared harness for tests that render the whole editor `<App/>`.
 *
 * Each test file still owns its `vi.mock("../api")` call (Vitest hoists mocks
 * per file); this module supplies the fixture project, jsdom stubs and the
 * "open the project" gesture every App-level test starts with.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect } from "vitest";

import {
  newButtonFile,
  newSpriteActionFile,
  newUiMotionFile,
} from "../app/libraryCommands";
import { defaultNode } from "../story";
import type { EditorProject } from "../types";

class ResizeObserverStub {
  observe(): void {
    /* jsdom never measures; layout-driven code only needs the API. */
  }
  unobserve(): void {
    /* no-op */
  }
  disconnect(): void {
    /* no-op */
  }
}

class DOMMatrixReadOnlyStub {
  m22 = 1;
}

/** Browser APIs React Flow and the stage-fit code expect but jsdom lacks. */
export function installDomStubs(): void {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
  });
  Object.defineProperty(window, "DOMMatrixReadOnly", {
    configurable: true,
    value: DOMMatrixReadOnlyStub,
  });
}

/** A small but complete project: one scene with a say chain and an end. */
export function fixtureProject(): EditorProject {
  return {
    root: "C:/work/game",
    manifest: {
      schema_version: 2,
      content_version: "1",
      entry_scene: "main",
      default_locale: "zh-CN",
      variables: {
        affection: { scope: "save", type: "integer", default: 0n },
      },
      characters: {
        lumi: {
          display_name: "露米",
          name_color: "#ffffff",
          text_color: "#ffffff",
        },
      },
      assets: {},
      scenes: ["scenes/main.yaml"],
      ui_motions: [],
      ui_motion_defaults: {},
    },
    scenes: [
      {
        path: "scenes/main.yaml",
        definition: {
          schema_version: 2,
          id: "main",
          entry: "start",
          nodes: {
            start: {
              type: "say",
              speaker: "lumi",
              text: "你好",
              speed_cps: null,
              next: "second",
            },
            second: {
              type: "say",
              speaker: null,
              text: "第二句",
              speed_cps: null,
              next: "finish",
            },
            finish: { type: "end" },
          },
        },
      },
    ],
    ui_motions: [],
    layout: {
      version: 1,
      scenes: {
        main: {
          nodes: {
            start: { x: 0, y: 0 },
            second: { x: 320, y: 0 },
            finish: { x: 640, y: 0 },
          },
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      },
    },
    assets: [],
    diagnostics: [],
    fingerprint: "fixture",
  };
}

/**
 * Render the App and open the fixture through the welcome screen.  The mocked
 * `editorApi.pickProjectDirectory` / `openProject` must already be configured.
 */
export async function renderOpenedApp(app: ReactElement): Promise<void> {
  render(app);
  fireEvent.click(screen.getByRole("button", { name: "打开项目目录" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /保存项目/ })).toBeTruthy(),
  );
}

/**
 * Install the real Tauri browser guard (it is a no-op outside Tauri) so tests
 * observe the same contextmenu/shortcut filtering the desktop app applies.
 * Returns a cleanup that removes the Tauri marker; the listeners themselves
 * are process-wide, so call this once per test file.
 */
export async function withTauriGuard(): Promise<() => void> {
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    value: {},
  });
  const { installBrowserGuards } =
    await import("@vectspace/presentation-core/browser-guards");
  installBrowserGuards(true);
  return () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  };
}

/**
 * The basic fixture plus one of every object that opens a workspace: a
 * timeline and a long-text node, a UI motion, a button template and a sprite
 * action.
 */
export function workspaceFixtureProject(): EditorProject {
  const project = fixtureProject();
  const scene = project.scenes[0].definition;
  scene.nodes.cam = defaultNode("timeline", "finish");
  scene.nodes.lecture = defaultNode("long_text", "finish");
  const layout = project.layout.scenes.main;
  layout.nodes.cam = { x: 0, y: 320 };
  layout.nodes.lecture = { x: 320, y: 320 };
  const motion = newUiMotionFile("ui.fade");
  project.ui_motions.push(motion);
  project.manifest.ui_motions.push(motion.path);
  const button = newButtonFile("button.main");
  project.buttons = [button];
  project.manifest.buttons = [button.path];
  const action = newSpriteActionFile("sprite.hop");
  project.actions = [action];
  project.manifest.actions = [action.path];
  return project;
}
