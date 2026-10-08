import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Ref } from "react";
import type {
  InteractionSnapshot,
  RuntimeUpdate,
  RuntimeUpdateKind,
} from "@vectspace/presentation-core/types";
import type { SceneCanvasHandle } from "@vectspace/presentation-react/gameplay";

/**
 * The secondary window against a scripted host: command surface, session
 * replacement, and the live synchronisation of refreshes, timer effects, block
 * hints and the ordering of responses against events. The gameplay components
 * are the real ones; only the Pixi canvas is stubbed.
 */

interface SyncRequest {
  args: Record<string, unknown>;
  resolve(batch: unknown): void;
}

const host = vi.hoisted(() => {
  const listeners: Record<string, (event: unknown) => void> = {};
  const listenTargets: Record<string, unknown> = {};
  const advanceResponse: unknown = null;
  return {
    /** Secondary wire token the host reports for the current instance. */
    token: 11,
    /** Commit sequence of the current session; restarts with every bootstrap. */
    seq: 0,
    commands: [] as { command: string; args: Record<string, unknown> }[],
    /** Observable order of subscriptions (`listen:<event>`) and commands. */
    order: [] as string[],
    listeners,
    /** The `target` option each listener was registered with. */
    listenTargets,
    /** Pending `secondary_sync_updates` calls, answered by the test. */
    syncs: [] as SyncRequest[],
    /** What the next advance / choose / presentation_complete answers. */
    advanceResponse,
    /** When set, the next advance fails with a stale-session error. */
    staleAdvance: false,
    /** When set, advances never settle until `resolveAdvance` is called. */
    deferAdvance: false,
    resolveAdvance: null as ((update: unknown) => void) | null,
    /** The props of the latest SceneCanvas render. */
    canvasProps: null as Record<string, unknown> | null,
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (
    name: string,
    handler: (event: unknown) => void,
    options?: { target?: unknown },
  ) =>
    new Promise((resolve) => {
      // A real subscription is an IPC round trip, so the listener only becomes
      // observable after a macrotask boundary.
      setTimeout(() => {
        host.order.push(`listen:${name}`);
        host.listeners[name] = handler;
        host.listenTargets[name] = options?.target;
        resolve(() => {
          Reflect.deleteProperty(host.listeners, name);
        });
      }, 5);
    }),
}));

vi.mock("@vectspace/presentation-react/gameplay", async (importOriginal) => {
  const react = await import("react");
  const SceneCanvas = react.forwardRef(function SceneCanvas(
    props: Record<string, unknown>,
    ref: Ref<SceneCanvasHandle>,
  ): null {
    host.canvasProps = props;
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
    host.commands.push({ command, args });
    host.order.push(command);
    switch (command) {
      case "secondary_bootstrap":
        host.seq = 0;
        return {
          update: bootstrapUpdate(),
          asset_ids: [],
          content_version: "test",
          chapter_map_available: false,
          default_font: null,
        };
      case "resolve_assets":
        return [];
      case "secondary_sync_updates":
        return await new Promise((resolve) => {
          host.syncs.push({ args, resolve });
        });
      case "secondary_set_story_pause":
        return { ok: true, paused: args.active === true };
      case "secondary_advance":
      case "secondary_choose":
      case "secondary_presentation_complete":
        if (command === "secondary_advance" && host.staleAdvance) {
          // The real WebView rejects an invoke with the serialized wire error
          // (a plain object with `message`/`code`), never an `Error` instance;
          // `src/engine/api.ts` normalizes it into a `CommandError`.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw { message: "副窗口会话已切换", code: "stale_session" };
        }
        if (command === "secondary_advance" && host.deferAdvance) {
          return await new Promise((resolve) => {
            host.resolveAdvance = resolve;
          });
        }
        return (
          host.advanceResponse ??
          dialogueUpdate("下一句", {
            seq: String((host.seq += 1)),
            id: String(Number(args.expectedRevision) + 1),
          })
        );
      default:
        throw new Error(
          `unexpected command from the secondary window: ${command}`,
        );
    }
  },
}));

let bootstrapUpdate: () => RuntimeUpdate = () => dialogueUpdate();

interface Options {
  kind?: RuntimeUpdateKind;
  seq?: string;
  id?: string;
  revision?: string;
  token?: string | number;
  interaction?: InteractionSnapshot;
  requiresAck?: boolean;
  cues?: unknown[];
}

function snapshotBase(options: Options) {
  return {
    revision: options.revision ?? options.id ?? "1",
    location: { scene_id: "lab", node_id: "intro" },
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
    interaction: options.interaction ?? { prompt_instance: "1" },
  };
}

function update(options: Options, prompt: unknown): RuntimeUpdate {
  return {
    session_id: String(options.token ?? host.token),
    mode: "secondary",
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.seq === undefined ? {} : { seq: options.seq }),
    update_id: options.id ?? "1",
    requires_ack: options.requiresAck ?? false,
    cues: (options.cues ?? []) as RuntimeUpdate["cues"],
    snapshot: { ...snapshotBase(options), prompt },
  } as unknown as RuntimeUpdate;
}

function dialogueUpdate(
  text = "副窗口台词",
  options: Options = {},
): RuntimeUpdate {
  return update(options, {
    kind: "dialogue",
    prompt_id: "lab/intro",
    speaker_id: null,
    speaker: null,
    name_color: null,
    text_color: null,
    text,
    is_read: false,
  });
}

function choiceUpdate(ids: string[], options: Options = {}): RuntimeUpdate {
  return update(options, {
    kind: "choice",
    prompt_id: "lab/pick",
    layout: {
      stage_width: 1920,
      stage_height: 1080,
      anchor_x: 960,
      anchor_y: 540,
      direction: "vertical",
      gap: 20,
      x: 470,
      y: 300,
      width: 980,
      height: 92,
    },
    diagnostics: [],
    choices: ids.map((id, index) => ({
      id,
      label: `选项 ${id}`,
      enabled: true,
      template: { kind: "fallback" },
      x: 470,
      y: 300 + index * 112,
      width: 980,
      height: 92,
    })),
  });
}

async function renderSecondary(): Promise<void> {
  const { default: SecondaryWindow } = await import("./SecondaryWindow");
  render(<SecondaryWindow />);
  await waitFor(() => {
    expect(document.querySelector(".game-viewport")).not.toBeNull();
    expect(commandsNamed("resolve_assets")).toHaveLength(1);
  });
  await waitFor(() => {
    expect(host.canvasProps?.update).not.toBeNull();
  });
}

function notify(latest: string, token: string | number = host.token): void {
  const listener = host.listeners["vectspace://runtime-updated"];
  expect(listener).toBeTypeOf("function");
  act(() => {
    listener?.({
      event: "vectspace://runtime-updated",
      payload: { session_id: String(token), latest_seq: latest },
    });
  });
}

async function answerSync(
  updates: RuntimeUpdate[],
  latest: string,
  token: string | number = host.token,
): Promise<void> {
  await waitFor(() => {
    expect(host.syncs.length).toBeGreaterThan(0);
  });
  const request = host.syncs.shift();
  await act(async () => {
    request?.resolve({
      session_id: String(token),
      latest_seq: latest,
      updates,
      gap: false,
    });
    await Promise.resolve();
  });
}

function canvasUpdate(): RuntimeUpdate {
  return host.canvasProps?.update as RuntimeUpdate;
}

function canvasEffects(): RuntimeUpdate[] {
  return host.canvasProps?.effects as RuntimeUpdate[];
}

function commandsNamed(name: string): { args: Record<string, unknown> }[] {
  return host.commands.filter((entry) => entry.command === name);
}

function lastAdvanceSession(): unknown {
  const advances = commandsNamed("secondary_advance");
  return advances[advances.length - 1]?.args.expectedSessionId;
}

function clickViewport(): void {
  document
    .querySelector(".game-viewport")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
}

/** The host re-points this window at a new scene (a repeated `open_window`). */
function replaceSession(token: number): void {
  host.token = token;
  act(() => host.listeners["vectspace://secondary-session"]?.({}));
}

beforeEach(() => {
  host.token = 11;
  host.seq = 0;
  host.commands = [];
  host.order = [];
  host.listeners = {};
  host.listenTargets = {};
  host.syncs = [];
  host.advanceResponse = null;
  host.staleAdvance = false;
  host.deferAdvance = false;
  host.resolveAdvance = null;
  host.canvasProps = null;
  bootstrapUpdate = () => dialogueUpdate("副窗口台词", { seq: "0" });
});

afterEach(cleanup);

it("plays only through the secondary command surface and renders no main-window controls", async () => {
  await renderSecondary();
  expect(new Set(host.commands.map((entry) => entry.command))).toEqual(
    new Set(["secondary_bootstrap", "resolve_assets"]),
  );
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

it("registers both listeners before the first bootstrap and reads only what it was told about", async () => {
  await renderSecondary();
  const bootstrapped = host.order.indexOf("secondary_bootstrap");
  expect(bootstrapped).toBeGreaterThan(-1);
  // A replacement or update that lands while the window is still starting up
  // must not be missed because a listener was registered afterwards.
  for (const event of [
    "listen:vectspace://runtime-updated",
    "listen:vectspace://secondary-session",
  ]) {
    const subscribed = host.order.indexOf(event);
    expect(subscribed, event).toBeGreaterThan(-1);
    expect(subscribed, event).toBeLessThan(bootstrapped);
  }
  // Only this window's notices: the main window's session id would otherwise
  // look like a newer session and re-bootstrap (remount) this window.
  expect(host.listenTargets["vectspace://runtime-updated"]).toBe("secondary");
  expect(host.order).not.toContain("secondary_sync_updates");
});

it("routes advances to its session token and re-bootstraps when the host replaces the scene", async () => {
  await renderSecondary();
  clickViewport();
  await waitFor(() => {
    expect(commandsNamed("secondary_advance")).toHaveLength(1);
  });
  expect(lastAdvanceSession()).toBe("11");

  replaceSession(12);
  await waitFor(() => {
    expect(commandsNamed("secondary_bootstrap")).toHaveLength(2);
  });
  await waitFor(() => {
    expect(canvasUpdate().session_id).toBe("12");
  });
  clickViewport();
  await waitFor(() => {
    expect(commandsNamed("secondary_advance")).toHaveLength(2);
  });
  expect(lastAdvanceSession()).toBe("12");
});

it("does not let an in-flight command wedge the replaced session", async () => {
  await renderSecondary();
  // A command that never settles while the host re-points this window.
  host.deferAdvance = true;
  clickViewport();
  await waitFor(() => {
    expect(commandsNamed("secondary_advance")).toHaveLength(1);
  });

  replaceSession(12);
  await waitFor(() => {
    expect(commandsNamed("secondary_bootstrap")).toHaveLength(2);
  });

  // The replaced UI is interactive: `busy` was reset with the new generation
  // instead of waiting for a command that can never finish for it.
  host.deferAdvance = false;
  await waitFor(() => {
    expect(canvasUpdate().session_id).toBe("12");
  });
  clickViewport();
  await waitFor(() => {
    expect(commandsNamed("secondary_advance")).toHaveLength(2);
  });
  expect(lastAdvanceSession()).toBe("12");

  // The late response of the old command belongs to the old instance and must
  // not be applied on top of the new one.
  host.resolveAdvance?.(dialogueUpdate("旧场景", { id: "99", token: 11 }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(canvasUpdate().session_id).toBe("12");
  expect(document.querySelector(".title-screen")).toBeNull();
  clickViewport();
  await waitFor(() => {
    expect(commandsNamed("secondary_advance")).toHaveLength(3);
  });
  expect(lastAdvanceSession()).toBe("12");
});

it("re-bootstraps instead of failing when the host reports a stale session", async () => {
  await renderSecondary();
  // The replacement event was missed (it was emitted before this instance could
  // listen), so the next command is rejected with `stale_session`.
  host.staleAdvance = true;
  host.token = 12;
  clickViewport();
  await waitFor(() => {
    expect(commandsNamed("secondary_bootstrap")).toHaveLength(2);
  });
  // The recovery is deterministic: the window continues on the new session
  // rather than showing a failure screen the player cannot act on.
  expect(document.querySelector(".title-screen")).toBeNull();
  host.staleAdvance = false;
  await waitFor(() => {
    expect(canvasUpdate().session_id).toBe("12");
  });
  clickViewport();
  await waitFor(() => {
    expect(commandsNamed("secondary_advance")).toHaveLength(2);
  });
  expect(lastAdvanceSession()).toBe("12");
});

it("shows a choice that another window made available without remounting", async () => {
  bootstrapUpdate = () =>
    choiceUpdate(["a"], {
      seq: "0",
      id: "4",
      interaction: { prompt_instance: "4" },
    });
  await renderSecondary();
  const first = await screen.findByRole("button", { name: "选项 a" });
  first.focus();
  const layer = document.querySelector(".choice-layer");
  const storyId = canvasUpdate().update_id;

  notify("1");
  await answerSync(
    [
      choiceUpdate(["a", "b"], {
        kind: "state_refresh",
        seq: "1",
        id: "5",
        revision: "5",
        interaction: { prompt_instance: "4" },
      }),
    ],
    "1",
  );

  // The new option appears at once; nothing else was disturbed.
  expect(await screen.findByRole("button", { name: "选项 b" })).toBeDefined();
  expect(screen.getByRole("button", { name: "选项 a" })).toBe(first);
  expect(document.querySelector(".choice-layer")).toBe(layer);
  expect(document.activeElement).toBe(first);
  // The presentation still belongs to the original story update.
  expect(canvasUpdate().update_id).toBe(storyId);
  // Commands from now on carry the refreshed revision.
  host.advanceResponse = choiceUpdate(["a", "b"], { seq: "2", id: "6" });
  act(() => first.click());
  await waitFor(() => {
    expect(commandsNamed("secondary_choose")).toHaveLength(1);
  });
  expect(commandsNamed("secondary_choose")[0]?.args.expectedRevision).toBe("5");
});

it("keeps the pending acknowledgement of a gated story across a refresh", async () => {
  bootstrapUpdate = () =>
    dialogueUpdate("门控", {
      seq: "0",
      id: "5",
      requiresAck: true,
      cues: [{ cue_id: "1", gate: "runtime", type: "delay", duration_ms: 400 }],
    });
  await renderSecondary();
  notify("1");
  await answerSync(
    [
      dialogueUpdate("门控", {
        kind: "state_refresh",
        seq: "1",
        id: "6",
        revision: "6",
      }),
    ],
    "1",
  );
  await waitFor(() => {
    expect((canvasUpdate().snapshot as { revision: string }).revision).toBe(
      "6",
    );
  });
  // The gate, its cues and its update_id survived the refresh...
  expect(canvasUpdate().update_id).toBe("5");
  expect(canvasUpdate().requires_ack).toBe(true);
  expect(canvasUpdate().cues).toHaveLength(1);

  // ...so settling the original presentation still acknowledges update 5.
  host.advanceResponse = dialogueUpdate("门后", { seq: "2", id: "7" });
  const onSettled = host.canvasProps?.onSettled as (
    update: RuntimeUpdate,
    outcome: string,
  ) => void;
  act(() => onSettled(canvasUpdate(), "completed"));
  await waitFor(() => {
    expect(commandsNamed("secondary_presentation_complete")).toHaveLength(1);
  });
  expect(commandsNamed("secondary_presentation_complete")[0]?.args).toEqual(
    expect.objectContaining({ updateId: "5", outcome: "completed" }),
  );
});

it("runs timer effects beside a typing line without restarting it", async () => {
  bootstrapUpdate = () =>
    dialogueUpdate("正在打字的一句话", {
      seq: "0",
      id: "3",
      cues: [
        {
          cue_id: "1",
          gate: "none",
          type: "dialogue_reveal",
          prompt_id: "lab/intro",
          speed_cps: 10,
        },
      ],
    });
  await renderSecondary();
  const text = await waitFor(() => {
    const node = document.querySelector(".dialogue-text");
    expect(node).not.toBeNull();
    return node;
  });
  const box = document.querySelector(".dialogue-box");
  const storyId = canvasUpdate().update_id;
  const effect = (seq: string, id: string) =>
    dialogueUpdate("正在打字的一句话", {
      kind: "effect",
      seq,
      id,
      revision: id,
      cues: [{ cue_id: "1", gate: "none", type: "delay", duration_ms: 100 }],
    });

  notify("2");
  await answerSync([effect("1", "4"), effect("2", "5")], "2");
  await waitFor(() => {
    expect(canvasEffects().map((entry) => entry.update_id)).toEqual(["4", "5"]);
  });
  // Both effects reach the canvas in order; the story presentation, the
  // dialogue box and its text node are exactly the ones that were typing.
  expect(canvasUpdate().update_id).toBe(storyId);
  expect(document.querySelector(".dialogue-box")).toBe(box);
  expect(document.querySelector(".dialogue-text")).toBe(text);
  expect(commandsNamed("secondary_presentation_complete")).toHaveLength(0);
});

it("applies a response that overtook its event exactly once and in order", async () => {
  await renderSecondary();
  // The host committed a refresh (seq 1) and then answered this advance (seq 2).
  host.advanceResponse = dialogueUpdate("下一句", {
    seq: "2",
    id: "9",
    interaction: { prompt_instance: "9" },
  });
  clickViewport();
  clickViewport();
  await waitFor(() => {
    expect(commandsNamed("secondary_advance")).toHaveLength(1);
  });
  // The response is parked until the missing update is fetched.
  await waitFor(() => {
    expect(commandsNamed("secondary_sync_updates")).toHaveLength(1);
  });
  expect(commandsNamed("secondary_sync_updates")[0]?.args).toEqual(
    expect.objectContaining({ expectedSessionId: "11", afterSeq: "0" }),
  );
  expect(canvasUpdate().update_id).toBe("1");

  await answerSync(
    [
      dialogueUpdate("副窗口台词", {
        kind: "state_refresh",
        seq: "1",
        id: "8",
        revision: "8",
      }),
      dialogueUpdate("下一句", {
        seq: "2",
        id: "9",
        interaction: { prompt_instance: "9" },
      }),
    ],
    "2",
  );
  await waitFor(() => {
    expect(canvasUpdate().update_id).toBe("9");
  });
  // The same response seen again through the event is a duplicate.
  notify("2");
  await act(async () => {
    await Promise.resolve();
  });
  expect(host.syncs).toHaveLength(0);
  expect(commandsNamed("secondary_sync_updates")).toHaveLength(1);
});

it("ignores a late sync batch of a replaced session", async () => {
  await renderSecondary();
  notify("3");
  await waitFor(() => {
    expect(host.syncs).toHaveLength(1);
  });
  const stale = host.syncs.shift();

  // The host replaces the scene while that sync is still in flight.
  bootstrapUpdate = () => dialogueUpdate("新场景", { seq: "0", token: 12 });
  replaceSession(12);
  await waitFor(() => {
    expect(commandsNamed("secondary_bootstrap")).toHaveLength(2);
  });
  await waitFor(() => {
    expect((canvasUpdate().snapshot.prompt as { text: string }).text).toBe(
      "新场景",
    );
  });

  await act(async () => {
    stale?.resolve({
      session_id: "11",
      latest_seq: "3",
      updates: [
        dialogueUpdate("旧场景", { seq: "1", token: 11, id: "70" }),
        dialogueUpdate("旧场景", { seq: "3", token: 11, id: "72" }),
      ],
      gap: false,
    });
    await Promise.resolve();
  });
  expect((canvasUpdate().snapshot.prompt as { text: string }).text).toBe(
    "新场景",
  );
  // The replacement session follows its own notifications.
  notify("1", 12);
  await waitFor(() => {
    expect(host.syncs).toHaveLength(1);
  });
  expect(host.syncs[0]?.args).toEqual(
    expect.objectContaining({ expectedSessionId: "12", afterSeq: "0" }),
  );
});

it("blocks only page turns and shows the interpolated hint", async () => {
  bootstrapUpdate = () =>
    dialogueUpdate("被阻挡的对话", {
      seq: "0",
      interaction: {
        prompt_instance: "1",
        blocks: [
          {
            id: "gate",
            source: "main",
            source_scene: "m",
            message: "等待主窗口：3",
          },
        ],
      },
    });
  await renderSecondary();
  expect(await screen.findByTestId("advance-block-notice")).toHaveTextContent(
    "等待主窗口",
  );
  for (let turn = 0; turn < 3; turn += 1) clickViewport();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(commandsNamed("secondary_advance")).toHaveLength(0);

  // The refresh that lifts the block lets the page turn again.
  notify("1");
  await answerSync(
    [
      dialogueUpdate("被阻挡的对话", {
        kind: "state_refresh",
        seq: "1",
        id: "2",
        revision: "2",
        interaction: { prompt_instance: "1" },
      }),
    ],
    "1",
  );
  await waitFor(() => {
    expect(screen.queryByTestId("advance-block-notice")).toBeNull();
  });
  host.advanceResponse = dialogueUpdate("继续", { seq: "2", id: "3" });
  clickViewport();
  clickViewport();
  await waitFor(() => {
    expect(commandsNamed("secondary_advance")).toHaveLength(1);
  });
});

it("keeps choices usable while page turns are blocked", async () => {
  bootstrapUpdate = () =>
    choiceUpdate(["a"], {
      seq: "0",
      interaction: {
        prompt_instance: "1",
        blocks: [
          { id: "gate", source: "main", source_scene: "m", message: "" },
        ],
      },
    });
  await renderSecondary();
  host.advanceResponse = choiceUpdate(["a"], { seq: "1", id: "2" });
  act(() => screen.getByRole("button", { name: "选项 a" }).click());
  await waitFor(() => {
    expect(commandsNamed("secondary_choose")).toHaveLength(1);
  });
});

it("reports only a really hidden document, never a focus change", async () => {
  await renderSecondary();
  act(() => {
    window.dispatchEvent(new Event("blur"));
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(commandsNamed("secondary_set_story_pause")).toHaveLength(0);

  let hidden = true;
  const spy = vi
    .spyOn(document, "hidden", "get")
    .mockImplementation(() => hidden);
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => {
    expect(commandsNamed("secondary_set_story_pause")).toHaveLength(1);
  });
  expect(commandsNamed("secondary_set_story_pause")[0]?.args).toEqual({
    expectedSessionId: "11",
    reason: "hidden",
    active: true,
  });
  hidden = false;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await waitFor(() => {
    expect(commandsNamed("secondary_set_story_pause")).toHaveLength(2);
  });
  expect(commandsNamed("secondary_set_story_pause")[1]?.args.active).toBe(
    false,
  );
  spy.mockRestore();
});

it("updates an interpolated line in place without restarting or remounting it", async () => {
  bootstrapUpdate = () => dialogueUpdate("数值是 1", { seq: "0", id: "3" });
  await renderSecondary();
  await waitFor(() => {
    expect(document.querySelector(".dialogue-text")?.textContent).toContain(
      "数值是 1",
    );
  });
  const box = document.querySelector(".dialogue-box");
  const text = document.querySelector(".dialogue-text");

  notify("1");
  await answerSync(
    [
      dialogueUpdate("数值是 2", {
        kind: "state_refresh",
        seq: "1",
        id: "4",
        revision: "4",
        interaction: { prompt_instance: "1" },
      }),
    ],
    "1",
  );
  await waitFor(() => {
    expect(document.querySelector(".dialogue-text")?.textContent).toContain(
      "数值是 2",
    );
  });
  expect(document.querySelector(".dialogue-box")).toBe(box);
  expect(document.querySelector(".dialogue-text")).toBe(text);
  // It was already read to the end, so it stays complete (a click advances).
  host.advanceResponse = dialogueUpdate("下一句", { seq: "2", id: "5" });
  clickViewport();
  await waitFor(() => {
    expect(commandsNamed("secondary_advance")).toHaveLength(1);
  });
  expect(commandsNamed("secondary_advance")[0]?.args.expectedRevision).toBe(
    "4",
  );
});
