import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Ref } from "react";
import type { RuntimeUpdate } from "@vectspace/presentation-core/types";
import type { SceneCanvasHandle } from "@vectspace/presentation-react/gameplay";

const host = vi.hoisted(() => {
  const listeners: Record<string, (event: unknown) => void> = {};
  const advanceCalls: { expectedSessionId?: unknown }[] = [];
  return {
    /** Secondary wire token the host reports for the current instance. */
    token: 11,
    commands: [] as string[],
    /** Observable order of subscriptions and commands. */
    order: [] as string[],
    /** When set, the next advance fails with a stale-session error. */
    staleAdvance: false,
    /** When set, advances never settle until `resolveAdvance` is called. */
    deferAdvance: false,
    resolveAdvance: null as ((update: unknown) => void) | null,
    /** Commands that must never be issued from the secondary window. */
    forbidden: [
      "bootstrap",
      "load_settings",
      "save_settings",
      "list_save_slots",
      "save_slot",
      "load_slot",
      "get_dialogue_history",
      "clear_dialogue_history",
      "get_chapter_map",
      "start_scene_replay",
      "exit_scene_replay",
      "invalidate_session",
      "start_new_game",
    ],
    listeners,
    advanceCalls,
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: unknown) => void) =>
    new Promise((resolve) => {
      // A real subscription is an IPC round trip, so the listener only becomes
      // observable after a macrotask boundary.
      setTimeout(() => {
        host.order.push("listen");
        host.listeners[name] = handler;
        resolve(() => {
          Reflect.deleteProperty(host.listeners, name);
        });
      }, 5);
    }),
}));

vi.mock("@vectspace/presentation-react/gameplay", async (importOriginal) => {
  const react = await import("react");
  const SceneCanvas = react.forwardRef(function SceneCanvas(
    _props: unknown,
    ref: Ref<SceneCanvasHandle>,
  ): null {
    react.useImperativeHandle(ref, () => ({
      captureThumbnail: () => null,
      unlockAudio: () => Promise.resolve(),
      skipCurrentPresentation: () => false,
      cancelCurrentPresentation: () => undefined,
      applySnapshotImmediately: () => Promise.resolve(),
      coverSession: () => Promise.resolve(),
      revealSession: () => Promise.resolve(),
      applySessionSnapshot: () => Promise.resolve(),
      isPresentationCurrent: () => false,
    }));
    return null;
  });
  return { ...(await importOriginal<object>()), SceneCanvas };
});

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    await Promise.resolve();
    host.commands.push(command);
    host.order.push(command);
    if (command === "secondary_bootstrap") {
      return {
        update: secondaryUpdate(),
        asset_ids: [],
        content_version: "test",
        chapter_map_available: false,
        default_font: null,
      };
    }
    if (command === "resolve_assets") return [];
    if (command === "secondary_advance") {
      host.advanceCalls.push(args);
      if (host.staleAdvance) {
        // The real WebView rejects an invoke with the serialized wire error
        // (a plain object with `message`/`code`), never an `Error` instance;
        // `src/engine/api.ts` normalizes it into a `CommandError`. Throwing
        // the wire shape here keeps the mock faithful to the transport.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw { message: "副窗口会话已切换", code: "stale_session" };
      }
      if (host.deferAdvance) {
        return await new Promise((resolve) => {
          host.resolveAdvance = resolve;
        });
      }
      return secondaryUpdate(Number(args.expectedRevision) + 1);
    }
    throw new Error(`unexpected command from the secondary window: ${command}`);
  },
}));

function secondaryUpdate(
  revision = 1,
  token: string | number = host.token,
): RuntimeUpdate {
  return {
    session_id: String(token),
    mode: "secondary",
    update_id: String(revision),
    requires_ack: false,
    cues: [],
    snapshot: {
      revision: String(revision),
      location: { scene_id: "ambience_lab", node_id: "intro" },
      variables: {},
      world: {
        background: null,
        sprites: {},
        buttons: {},
        camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
        persistent_effects: [],
        dialogue_ui_visible: true,
        ui_motion_bindings: {},
      },
      audio: { bgm: null },
      playback: { auto: "normal", ctrl_fast_forward: "allow" },
      prompt: {
        kind: "dialogue",
        prompt_id: "ambience_lab/intro",
        speaker_id: null,
        speaker: null,
        name_color: null,
        text_color: null,
        text: "副窗口台词",
        is_read: false,
      },
    },
  } as unknown as RuntimeUpdate;
}

async function renderSecondary() {
  const { default: SecondaryWindow } = await import("./SecondaryWindow");
  render(<SecondaryWindow />);
  await waitFor(() => {
    expect(host.commands).toContain("secondary_bootstrap");
  });
  return SecondaryWindow;
}

beforeEach(() => {
  host.token = 11;
  host.commands = [];
  host.order = [];
  host.staleAdvance = false;
  host.deferAdvance = false;
  host.resolveAdvance = null;
  host.advanceCalls = [];
  host.listeners = {};
});

afterEach(cleanup);

it("bootstraps and plays only through the secondary command surface", async () => {
  await renderSecondary();
  await waitFor(() => {
    expect(host.commands).toContain("resolve_assets");
  });
  for (const forbidden of host.forbidden) {
    expect(host.commands, `${forbidden} must not be used`).not.toContain(
      forbidden,
    );
  }
  // The host only ever sends the secondary its own gameplay commands.
  expect(new Set(host.commands)).toEqual(
    new Set(["secondary_bootstrap", "resolve_assets"]),
  );
});

it("renders no save, settings, history, title or chapter-map controls", async () => {
  await renderSecondary();
  for (const label of [
    "存档 / 读档",
    "设置",
    "历史",
    "标题",
    "全屏",
    "开始演示",
    "继续",
    "读取存档",
    "章节地图",
    "自动：关",
  ]) {
    expect(screen.queryByText(label), `${label} must not render`).toBeNull();
  }
  expect(document.querySelector(".game-toolbar")).toBeNull();
  expect(document.querySelector(".title-screen")).toBeNull();
  expect(document.querySelector(".modal-panel")).toBeNull();
});

it("routes player advances to the secondary session token", async () => {
  await renderSecondary();
  await waitFor(() => {
    expect(document.querySelector(".dialogue-surface")).not.toBeNull();
  });
  const canvas = document.querySelector(".game-viewport");
  expect(canvas).not.toBeNull();
  canvas?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  await waitFor(() => {
    expect(host.advanceCalls.length).toBeGreaterThan(0);
  });
  expect(host.advanceCalls[0]?.expectedSessionId).toBe(String(host.token));
  expect(
    host.commands.filter((command) => command === "secondary_advance").length,
  ).toBe(host.advanceCalls.length);
});

it("re-bootstraps under the new token when the host replaces the scene", async () => {
  await renderSecondary();
  const listener = host.listeners["vectspace://secondary-session"];
  expect(listener).toBeTypeOf("function");
  host.token = 12;
  const before = host.commands.filter(
    (command) => command === "secondary_bootstrap",
  ).length;
  listener?.({ event: "vectspace://secondary-session", payload: null });
  await waitFor(() => {
    expect(
      host.commands.filter((command) => command === "secondary_bootstrap")
        .length,
    ).toBe(before + 1);
  });
  // The replacement token is adopted, so a later command uses it.
  await waitFor(() => {
    expect(document.querySelector(".dialogue-surface")).not.toBeNull();
  });
  document
    .querySelector(".game-viewport")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  await waitFor(() => {
    expect(host.advanceCalls.length).toBeGreaterThan(0);
  });
  expect(
    host.advanceCalls[host.advanceCalls.length - 1]?.expectedSessionId,
  ).toBe("12");
});

it("subscribes to the replacement event before the first bootstrap", async () => {
  await renderSecondary();
  const subscribed = host.order.indexOf("listen");
  const bootstrapped = host.order.indexOf("secondary_bootstrap");
  expect(subscribed).toBeGreaterThan(-1);
  expect(bootstrapped).toBeGreaterThan(-1);
  // A replacement that lands while the window is still starting up must not be
  // missed because the listener was registered asynchronously afterwards.
  expect(subscribed).toBeLessThan(bootstrapped);
});

it("does not let an in-flight command wedge the replaced session", async () => {
  await renderSecondary();
  await waitFor(() => {
    expect(document.querySelector(".dialogue-surface")).not.toBeNull();
  });
  // A command that never settles while the host re-points this window.
  host.deferAdvance = true;
  document
    .querySelector(".game-viewport")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  await waitFor(() => {
    expect(host.advanceCalls.length).toBe(1);
  });

  host.token = 12;
  host.listeners["vectspace://secondary-session"]?.({});
  await waitFor(() => {
    expect(
      host.commands.filter((command) => command === "secondary_bootstrap")
        .length,
    ).toBe(2);
  });

  // The replaced UI is interactive: `busy` was reset with the new generation
  // instead of waiting for a command that can never finish for it.
  host.deferAdvance = false;
  await waitFor(() => {
    expect(document.querySelector(".dialogue-surface")).not.toBeNull();
  });
  document
    .querySelector(".game-viewport")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  await waitFor(() => {
    expect(host.advanceCalls.length).toBe(2);
  });
  expect(
    host.advanceCalls[host.advanceCalls.length - 1]?.expectedSessionId,
  ).toBe("12");

  // The late response of the old command belongs to the old instance and must
  // not be applied on top of the new one.
  host.resolveAdvance?.(secondaryUpdate(99, "11"));
  await waitFor(() => {
    expect(document.querySelector(".dialogue-surface")).not.toBeNull();
  });
  expect(document.querySelector(".title-screen")).toBeNull();
  document
    .querySelector(".game-viewport")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  await waitFor(() => {
    expect(host.advanceCalls.length).toBe(3);
  });
  expect(
    host.advanceCalls[host.advanceCalls.length - 1]?.expectedSessionId,
  ).toBe("12");
});

it("re-bootstraps instead of failing when the host reports a stale session", async () => {
  await renderSecondary();
  await waitFor(() => {
    expect(document.querySelector(".dialogue-surface")).not.toBeNull();
  });
  // The replacement event was missed (it was emitted before this instance could
  // listen), so the next command is rejected with `stale_session`.
  host.staleAdvance = true;
  host.token = 12;
  document
    .querySelector(".game-viewport")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  await waitFor(() => {
    expect(
      host.commands.filter((command) => command === "secondary_bootstrap")
        .length,
    ).toBe(2);
  });
  // The recovery is deterministic: the window continues on the new session
  // rather than showing a failure screen the player cannot act on.
  expect(document.querySelector(".title-screen")).toBeNull();
  host.staleAdvance = false;
  await waitFor(() => {
    expect(document.querySelector(".dialogue-surface")).not.toBeNull();
  });
  document
    .querySelector(".game-viewport")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  await waitFor(() => {
    expect(host.advanceCalls.length).toBeGreaterThan(1);
  });
  expect(
    host.advanceCalls[host.advanceCalls.length - 1]?.expectedSessionId,
  ).toBe("12");
});
