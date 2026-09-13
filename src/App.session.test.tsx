import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Ref } from "react";
import type { RuntimeUpdate } from "./engine/types";
import type { SceneCanvasHandle } from "./components/SceneCanvas";

const host = vi.hoisted(() => {
  const failures: Record<string, number> = {};
  return {
    id: 1,
    mode: "story",
    calls: [] as string[],
    /** Forced one-shot failures per command, consumed on use. */
    failures,
    /** Forced one-shot `applySnapshotImmediately` rejections. */
    alignFailures: 0,
  };
});
vi.mock("./components/SceneCanvas", async () => {
  const react = await import("react");
  const SceneCanvas = react.forwardRef(function SceneCanvas(
    _props: unknown,
    ref: Ref<SceneCanvasHandle>,
  ): null {
    react.useImperativeHandle(ref, () => ({
      captureThumbnail: () => null,
      unlockAudio: () => Promise.resolve(),
      skipCurrentPresentation: () => false,
      cancelCurrentPresentation: () => {
        host.calls.push("cancelCurrentPresentation");
      },
      applySnapshotImmediately: () => {
        host.calls.push("applySnapshotImmediately");
        if (host.alignFailures > 0) {
          host.alignFailures -= 1;
          return Promise.reject(new Error("forced alignment failure"));
        }
        return Promise.resolve();
      },
      coverSession: () => {
        host.calls.push("coverSession");
        return Promise.resolve();
      },
      revealSession: () => {
        host.calls.push("revealSession");
        return Promise.resolve();
      },
      applySessionSnapshot: () => {
        host.calls.push("applySessionSnapshot");
        return Promise.resolve();
      },
      isPresentationCurrent: () => false,
    }));
    return null;
  });
  return { SceneCanvas };
});
vi.mock("./components/ChapterMapPage", () => ({
  ChapterMapPage: ({ onReplay }: { onReplay(id: string): void }) => (
    <button onClick={() => onReplay("prologue")}>测试重演</button>
  ),
}));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    await Promise.resolve();
    const update = (end = false): RuntimeUpdate => ({
      session_id: String(host.id),
      mode: host.mode as "story" | "replay",
      update_id: String(host.id),
      requires_ack: false,
      cues: [],
      snapshot: {
        revision: String(host.id),
        location: { scene_id: "prologue", node_id: "choice" },
        variables: {},
        world: {
          background: null,
          sprites: {},
          camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
          persistent_effects: [],
          dialogue_ui_visible: true,
          ui_motion_bindings: {},
        },
        audio: { bgm: null },
        playback: { auto: "normal", ctrl_fast_forward: "allow" },
        prompt: end
          ? { kind: "end", prompt_id: "end" }
          : {
              kind: "choice",
              prompt_id: "choice",
              choices: [{ id: "done", label: "结束重演", enabled: true }],
            },
      },
    });
    if (command === "bootstrap")
      return {
        update: update(),
        asset_ids: [],
        content_version: "test",
        chapter_map_available: true,
        default_font: null,
      };
    if (command === "resolve_assets") return [];
    if (command === "load_settings")
      return {
        master_volume: 1,
        bgm_volume: 1,
        sfx_volume: 1,
        video_volume: 1,
        text_speed_cps: 30,
        text_reveal_animation: "typewriter",
        skip_mode: "read_only",
      };
    if (command === "list_save_slots") return [{ slot: "auto", exists: true }];
    if (command === "get_chapter_map")
      return {
        width: 1920,
        height: 1080,
        view_x: 960,
        view_y: 540,
        background: null,
        hotspots: [],
        decorations: [],
      };
    if (args.expectedSessionId !== String(host.id))
      throw new Error(`bad session for ${command}`);
    host.calls.push(command);
    const forced = host.failures[command] ?? 0;
    if (forced > 0) {
      host.failures[command] = forced - 1;
      throw new Error(`forced failure: ${command}`);
    }
    if (command === "clear_dialogue_history") return;
    if (command === "choose") return update(true);
    host.id++;
    if (command === "start_scene_replay") host.mode = "replay";
    else host.mode = "story";
    if (command === "invalidate_session" || command === "exit_scene_replay")
      return String(host.id);
    return update();
  },
}));

import App from "./App";
afterEach(async () => {
  cleanup();
  // Drain in-flight mocked host commands and frame-scheduled transitions so
  // their session-id increments cannot leak into the next test's bootstrap.
  await new Promise((resolve) => setTimeout(resolve, 32));
});
beforeEach(() => {
  // The App caches its startup payload module-wide, so every test boots from
  // the first bootstrap's session id; keep the mocked runtime in sync.
  host.id = 1;
  host.calls = [];
  host.failures = {};
  host.alignFailures = 0;
  host.mode = "story";
});

it("retains host identity across title, load and repeated replay transitions", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "开始演示" }));
  fireEvent.click(await screen.findByRole("button", { name: "标题" }));
  fireEvent.click(await screen.findByRole("button", { name: "开始演示" }));
  fireEvent.click(await screen.findByRole("button", { name: "标题" }));
  fireEvent.click(await screen.findByRole("button", { name: "继续" }));
  fireEvent.click(await screen.findByRole("button", { name: "标题" }));
  fireEvent.click(await screen.findByRole("button", { name: "章节地图" }));
  fireEvent.click(await screen.findByRole("button", { name: "测试重演" }));
  fireEvent.click(await screen.findByRole("button", { name: "结束重演" }));
  fireEvent.click(await screen.findByRole("button", { name: "测试重演" }));
  fireEvent.click(await screen.findByRole("button", { name: "标题" }));
  fireEvent.click(await screen.findByRole("button", { name: "开始演示" }));
  await waitFor(() =>
    expect(host.calls.filter((call) => call === "start_new_game")).toHaveLength(
      3,
    ),
  );
  expect(
    host.calls.filter((call) => call === "exit_scene_replay"),
  ).toHaveLength(2);
  // Every world-replacing session switch goes through the host-only curtain:
  // three new games, one load and two replay starts.
  expect(
    host.calls.filter((call) => call === "applySessionSnapshot"),
  ).toHaveLength(6);
  expect(screen.queryByText(/bad session/)).toBeNull();
});

/** Title screen, story session, then the chapter map ready for a replay. */
async function enterReplayThroughMap(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "开始演示" }));
  await screen.findByRole("button", { name: "结束重演" });
  fireEvent.click(screen.getByRole("button", { name: "标题" }));
  fireEvent.click(await screen.findByRole("button", { name: "章节地图" }));
  fireEvent.click(await screen.findByRole("button", { name: "测试重演" }));
  await screen.findByRole("button", { name: "结束重演" });
}

/**
 * The three same-session recovery paths that keep the retained update visible
 * after a failed host command.  They used to be wrapped in a full
 * cover/align/reveal session curtain (~500ms of black for a switch that never
 * happened); they must stay an instant hard align plus a forced reveal.
 */
it("hard-aligns and forces a reveal when returning to the title fails", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "开始演示" }));
  await screen.findByRole("button", { name: "结束重演" });
  host.failures.invalidate_session = 1;

  fireEvent.click(screen.getByRole("button", { name: "标题" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain(
    "forced failure: invalidate_session",
  );
  const alignIndex = host.calls.indexOf("applySnapshotImmediately");
  const revealIndex = host.calls.indexOf("revealSession");
  expect(alignIndex).toBeGreaterThanOrEqual(0);
  expect(revealIndex).toBeGreaterThan(alignIndex);
  expect(host.calls.filter((call) => call === "coverSession")).toHaveLength(0);
  // Only the new-game boundary used the session curtain; the failed recovery
  // did not add a second one.
  expect(
    host.calls.filter((call) => call === "applySessionSnapshot"),
  ).toHaveLength(1);
  // The retained update stays interactive for a retry.
  expect(screen.getByRole("button", { name: "结束重演" })).toBeDefined();
});

it("hard-aligns and forces a reveal when leaving a replay to the title fails", async () => {
  render(<App />);
  await enterReplayThroughMap();
  host.failures.exit_scene_replay = 1;

  fireEvent.click(screen.getByRole("button", { name: "标题" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain(
    "forced failure: exit_scene_replay",
  );
  const alignIndex = host.calls.indexOf("applySnapshotImmediately");
  const revealIndex = host.calls.indexOf("revealSession");
  expect(alignIndex).toBeGreaterThanOrEqual(0);
  expect(revealIndex).toBeGreaterThan(alignIndex);
  expect(host.calls.filter((call) => call === "coverSession")).toHaveLength(0);
  // New game + replay start boundaries; the recovery added no third curtain.
  expect(
    host.calls.filter((call) => call === "applySessionSnapshot"),
  ).toHaveLength(2);
  expect(screen.getByRole("button", { name: "结束重演" })).toBeDefined();
});

it("hard-aligns and forces a reveal when finishing a replay fails", async () => {
  render(<App />);
  await enterReplayThroughMap();
  host.failures.exit_scene_replay = 1;

  // The replay's end prompt schedules `finishSceneReplay` on the next frame.
  fireEvent.click(screen.getByRole("button", { name: "结束重演" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain(
    "forced failure: exit_scene_replay",
  );
  const alignIndex = host.calls.indexOf("applySnapshotImmediately");
  const revealIndex = host.calls.indexOf("revealSession");
  expect(alignIndex).toBeGreaterThanOrEqual(0);
  expect(revealIndex).toBeGreaterThan(alignIndex);
  expect(host.calls.filter((call) => call === "coverSession")).toHaveLength(0);
  expect(
    host.calls.filter((call) => call === "applySessionSnapshot"),
  ).toHaveLength(2);
});

it("still forces a reveal when the hard alignment itself fails", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "开始演示" }));
  await screen.findByRole("button", { name: "结束重演" });
  host.failures.invalidate_session = 1;
  host.alignFailures = 1;

  // The recovery is intentionally fire-and-forget at the four call sites, so a
  // failed hard alignment surfaces as an unhandled rejection by design (the
  // alignment error is preserved, not replaced by a curtain error).  Capture
  // it here so Vitest can still fail the suite on every other rejection.
  const captured = await captureFloatingRejections(async () => {
    fireEvent.click(screen.getByRole("button", { name: "标题" }));
    await waitFor(() =>
      expect(
        host.calls.filter((call) => call === "revealSession"),
      ).toHaveLength(1),
    );
  });
  expect(captured.map((reason) => (reason as Error).message)).toContain(
    "forced alignment failure",
  );
  const alignIndex = host.calls.indexOf("applySnapshotImmediately");
  const revealIndex = host.calls.indexOf("revealSession");
  expect(alignIndex).toBeGreaterThanOrEqual(0);
  expect(revealIndex).toBeGreaterThan(alignIndex);
  expect(host.calls.filter((call) => call === "coverSession")).toHaveLength(0);
});

/**
 * Runs a fire-and-forget UI interaction while collecting unhandled rejections.
 *
 * Vitest treats every unhandled rejection as a suite error; the recovery
 * helpers intentionally leave their promise floating, so the one rejection a
 * failed recovery produces is collected here and asserted by the caller.
 */
interface RejectionProcess {
  listeners(event: string): ((reason: unknown) => void)[];
  removeAllListeners(event: string): void;
  on(event: string, listener: (reason: unknown) => void): void;
}

async function captureFloatingRejections(
  body: () => Promise<void>,
): Promise<unknown[]> {
  const captured: unknown[] = [];
  const nodeProcess = (globalThis as { process?: RejectionProcess }).process;
  const listeners = nodeProcess?.listeners("unhandledRejection") ?? [];
  nodeProcess?.removeAllListeners("unhandledRejection");
  nodeProcess?.on("unhandledRejection", (reason) => {
    captured.push(reason);
  });
  try {
    await body();
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    nodeProcess?.removeAllListeners("unhandledRejection");
    for (const listener of listeners) {
      nodeProcess?.on("unhandledRejection", listener);
    }
  }
  return captured;
}
