import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeUpdate } from "./engine/types";

const host = vi.hoisted(() => ({
  id: 1,
  mode: "story",
  calls: [] as string[],
}));
vi.mock("./components/SceneCanvas", () => ({ SceneCanvas: () => null }));
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
        story_flow_available: false,
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
afterEach(cleanup);

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
  expect(screen.queryByText(/bad session/)).toBeNull();
});
