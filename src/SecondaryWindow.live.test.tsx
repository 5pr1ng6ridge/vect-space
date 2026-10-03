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
 * Live synchronisation of the secondary window: refreshes, timer effects,
 * block hints, ordering of responses against events, and session replacement.
 * The host is a scripted fake; the gameplay components are the real ones.
 */

interface SyncRequest {
  args: Record<string, unknown>;
  resolve(batch: unknown): void;
}

const host = vi.hoisted(() => {
  const commands: { command: string; args: Record<string, unknown> }[] = [];
  const listeners: Record<string, (event: unknown) => void> = {};
  const listenTargets: Record<string, unknown> = {};
  const syncs: SyncRequest[] = [];
  const canvas: { props: Record<string, unknown> | null; renders: number } = {
    props: null,
    renders: 0,
  };
  const advanceResponse: unknown = null;
  return {
    token: 11,
    commands,
    listeners,
    /** The `target` option each listener was registered with. */
    listenTargets,
    /** Pending `secondary_sync_updates` calls, answered by the test. */
    syncs,
    /** What the next `secondary_advance` answers. */
    advanceResponse,
    /** The props of the latest SceneCanvas render. */
    canvas,
  };
});

vi.mock("@tauri-apps/api/event", () => ({
  listen: (
    name: string,
    handler: (event: unknown) => void,
    options?: { target?: unknown },
  ) => {
    host.listeners[name] = handler;
    host.listenTargets[name] = options?.target;
    return Promise.resolve(() => {
      Reflect.deleteProperty(host.listeners, name);
    });
  },
}));

vi.mock("@vectspace/presentation-react/gameplay", async (importOriginal) => {
  const react = await import("react");
  const SceneCanvas = react.forwardRef(function SceneCanvas(
    props: Record<string, unknown>,
    ref: Ref<SceneCanvasHandle>,
  ): null {
    host.canvas.props = props;
    host.canvas.renders += 1;
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
    if (command === "secondary_bootstrap") {
      return {
        update: bootstrapUpdate(),
        asset_ids: [],
        content_version: "test",
        chapter_map_available: false,
        default_font: null,
      };
    }
    if (command === "resolve_assets") return [];
    if (command === "secondary_sync_updates") {
      return await new Promise((resolve) => {
        host.syncs.push({ args, resolve });
      });
    }
    if (command === "secondary_set_story_pause") {
      return { ok: true, paused: args.active === true };
    }
    if (command === "secondary_advance") return host.advanceResponse;
    if (command === "secondary_choose") return host.advanceResponse;
    if (command === "secondary_presentation_complete")
      return host.advanceResponse;
    throw new Error(`unexpected command from the secondary window: ${command}`);
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

function base(options: Options): Omit<RuntimeUpdate, "snapshot"> {
  return {
    session_id: String(options.token ?? host.token),
    mode: "secondary",
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    ...(options.seq === undefined ? {} : { seq: options.seq }),
    update_id: options.id ?? "1",
    requires_ack: options.requiresAck ?? false,
    cues: (options.cues ?? []) as RuntimeUpdate["cues"],
  };
}

function world() {
  return {
    background: null,
    sprites: {},
    buttons: {},
    camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
    persistent_effects: [],
    dialogue_ui_visible: true,
    ui_motion_bindings: {},
  };
}

function snapshotBase(options: Options) {
  return {
    revision: options.revision ?? options.id ?? "1",
    location: { scene_id: "lab", node_id: "intro" },
    variables: {},
    world: world(),
    audio: { bgm: null },
    playback: { auto: "normal", ctrl_fast_forward: "allow" },
    interaction: options.interaction ?? { prompt_instance: "1" },
  };
}

function dialogueUpdate(
  text = "副窗口台词",
  options: Options = {},
): RuntimeUpdate {
  return {
    ...base(options),
    snapshot: {
      ...snapshotBase(options),
      prompt: {
        kind: "dialogue",
        prompt_id: "lab/intro",
        speaker_id: null,
        speaker: null,
        name_color: null,
        text_color: null,
        text,
        is_read: false,
      },
    },
  } as unknown as RuntimeUpdate;
}

function choiceUpdate(ids: string[], options: Options = {}): RuntimeUpdate {
  return {
    ...base(options),
    snapshot: {
      ...snapshotBase(options),
      prompt: {
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
      },
    },
  } as unknown as RuntimeUpdate;
}

async function renderSecondary(): Promise<void> {
  const { default: SecondaryWindow } = await import("./SecondaryWindow");
  render(<SecondaryWindow />);
  await waitFor(() => {
    expect(document.querySelector(".game-viewport")).not.toBeNull();
    expect(
      host.commands.some((entry) => entry.command === "resolve_assets"),
    ).toBe(true);
  });
  await waitFor(() => {
    expect(host.canvas.props?.update).not.toBeNull();
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
  return host.canvas.props?.update as RuntimeUpdate;
}

function canvasEffects(): RuntimeUpdate[] {
  return host.canvas.props?.effects as RuntimeUpdate[];
}

function commandsNamed(name: string): { args: Record<string, unknown> }[] {
  return host.commands.filter((entry) => entry.command === name);
}

function clickViewport(): void {
  document
    .querySelector(".game-viewport")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
}

beforeEach(() => {
  host.token = 11;
  host.commands = [];
  host.listeners = {};
  host.syncs = [];
  host.advanceResponse = null;
  host.canvas.props = null;
  host.canvas.renders = 0;
  bootstrapUpdate = () => dialogueUpdate("副窗口台词", { seq: "0" });
});

afterEach(cleanup);

it("registers the update listener before the bootstrap and adopts its position", async () => {
  await renderSecondary();
  expect(host.listeners["vectspace://runtime-updated"]).toBeTypeOf("function");
  // Only this window's notices: the main window's session id would otherwise
  // look like a newer session and re-bootstrap (remount) this window.
  expect(host.listenTargets["vectspace://runtime-updated"]).toBe("secondary");
  const order = host.commands.map((entry) => entry.command);
  expect(order.indexOf("secondary_bootstrap")).toBeGreaterThanOrEqual(0);
  // The window only reads what it was told about: no speculative sync.
  expect(order).not.toContain("secondary_sync_updates");
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
  const added = await screen.findByRole("button", { name: "选项 b" });
  expect(added).toBeDefined();
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
  const onSettled = host.canvas.props?.onSettled as (
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

  notify("2");
  await answerSync(
    [
      dialogueUpdate("正在打字的一句话", {
        kind: "effect",
        seq: "1",
        id: "4",
        revision: "4",
        cues: [{ cue_id: "1", gate: "none", type: "delay", duration_ms: 100 }],
      }),
      dialogueUpdate("正在打字的一句话", {
        kind: "effect",
        seq: "2",
        id: "5",
        revision: "5",
        cues: [{ cue_id: "1", gate: "none", type: "delay", duration_ms: 100 }],
      }),
    ],
    "2",
  );
  await waitFor(() => {
    expect(canvasEffects().map((effect) => effect.update_id)).toEqual([
      "4",
      "5",
    ]);
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
  await waitFor(() => {
    expect(document.querySelector(".dialogue-surface")).not.toBeNull();
  });
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
  host.token = 12;
  bootstrapUpdate = () => dialogueUpdate("新场景", { seq: "0", token: 12 });
  act(() => host.listeners["vectspace://secondary-session"]?.({}));
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
