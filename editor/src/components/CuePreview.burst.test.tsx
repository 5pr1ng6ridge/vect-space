// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryKit,
  createMemoryTextureLoader,
  type MemoryKit,
} from "@vectspace/presentation-core/scene-test-kit";
import { SceneSurface } from "@vectspace/presentation-core/scene-surface";
import type { ParticleDefinition } from "@vectspace/presentation-core/particles";

import { PARTICLE_FIXTURE } from "../../../packages/presentation-core/src/visualTestKit";
import { CuePreview, type BurstCue } from "./CuePreview";
import { PreviewFrameClock } from "./previewFrameClock";
import { buildWorldPreviewRequest } from "../presentationPreview";
import type { EditorAsset } from "../types";
import type { EditorVisualResources } from "../visualResources";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DOT_URL = "C:/game/dot.png";
const ASSETS: EditorAsset[] = [
  { id: "dot", kind: "gui", path: "dot.png", absolute_path: DOT_URL },
];

function definition(
  lifetimeMax: number,
  patch: Partial<ParticleDefinition> = {},
): ParticleDefinition {
  return {
    ...PARTICLE_FIXTURE,
    rate: 0,
    burst_count: 5,
    max_particles: 20,
    lifetime_ms: { min: Math.min(40, lifetimeMax), max: lifetimeMax },
    ...patch,
  };
}

function visualsFor(particle: ParticleDefinition): EditorVisualResources {
  return { textBlocks: {}, particles: { [particle.id]: particle } };
}

function burstCue(particle: ParticleDefinition): BurstCue {
  return {
    cue_id: "test.burst",
    gate: "none",
    type: "particle_state",
    emitter_id: "fx",
    emitter: {
      particle: particle.id,
      seed: particle.seed,
      generation: 1,
      space: "world",
      x: 960,
      y: 540,
      scale: 1,
      rotation_deg: 0,
      opacity: 1,
      z: 0,
    },
    burst: true,
  };
}

function staticRequest() {
  return buildWorldPreviewRequest({
    sprites: {},
    emitters: {},
    camera: { x: 0, y: 0, zoom: 1, rotation_deg: 0 },
  });
}

function loader(
  gate?: Promise<void>,
): ReturnType<typeof createMemoryTextureLoader> {
  const inner = createMemoryTextureLoader({ [DOT_URL]: { width: 64, height: 64 } });
  if (gate === undefined) return inner;
  return {
    ...inner,
    load: async (url) => {
      await gate;
      return inner.load(url);
    },
  };
}

interface Harness {
  kit: MemoryKit;
  view: ReturnType<typeof render>;
  rerender(particle: ParticleDefinition, request?: ReturnType<typeof staticRequest>): void;
}

function renderBurst(
  particle: ParticleDefinition,
  options: { gate?: Promise<void>; onError?: (message: string) => void } = {},
): Harness {
  const kit = createMemoryKit();
  const textures = loader(options.gate);
  const element = (
    next: ParticleDefinition,
    request: ReturnType<typeof staticRequest>,
  ) => (
    <>
      <input aria-label="备注" />
      <CuePreview
        assets={ASSETS}
        decorationTransport={{
          durationMs: Math.ceil(next.lifetime_ms.max),
          burst: burstCue(next),
        }}
        environment={{ kit: kit.kit, textureLoader: textures.load }}
        label="粒子预览"
        onError={options.onError}
        request={request}
        visuals={visualsFor(next)}
      />
    </>
  );
  const request = staticRequest();
  const view = render(element(particle, request));
  return {
    kit,
    view,
    rerender: (next, nextRequest = staticRequest()) =>
      view.rerender(element(next, nextRequest)),
  };
}

function readout(): { ms: number; total: number; finished: boolean } {
  const text =
    document.querySelector(".cue-preview-burst-transport code")?.textContent ??
    "";
  const match = /(\d+) \/ (\d+) ms/.exec(text);
  return {
    ms: Number(match?.[1] ?? Number.NaN),
    total: Number(match?.[2] ?? Number.NaN),
    finished: text.includes("已结束"),
  };
}

function space(
  target: EventTarget = document.body,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = createEvent.keyDown(target as Element, {
    key: " ",
    code: "Space",
    ...init,
  });
  fireEvent(target as Element, event);
  return event as KeyboardEvent;
}

function liveBatches(kit: MemoryKit) {
  return kit.particleBatches.filter((batch) => !batch.node.destroyed);
}

/** The transport stays busy from a request until its newest launch is done. */
function transportBusy(): boolean {
  return (
    document
      .querySelector(".cue-preview-burst-transport")
      ?.getAttribute("aria-busy") === "true"
  );
}

/**
 * Holds every burst cue back, like a first texture decode that takes a while:
 * the cue promise only settles after `release()`.
 */
function deferRunCue(): { release(): void } {
  const original = SceneSurface.prototype.runCue;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(SceneSurface.prototype, "runCue").mockImplementation(function (
    this: SceneSurface,
    cue,
    context,
  ) {
    return gate.then(() => original.call(this, cue, context));
  });
  return { release };
}

async function settled(kit: MemoryKit): Promise<void> {
  await waitFor(() => expect(readout().finished).toBe(true), { timeout: 4000 });
  // The surface released the transient batch together with the transport.
  expect(liveBatches(kit)).toHaveLength(0);
}

describe("CuePreview transient burst transport", () => {
  it("keeps transport busy until decoding finishes and starts lifetime from that instant", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runCue = vi.spyOn(SceneSurface.prototype, "runCue");
    const resume = vi.spyOn(PreviewFrameClock.prototype, "resume");
    const { kit } = renderBurst(definition(120), { gate });
    await waitFor(() => expect(runCue).toHaveBeenCalled());

    const play = screen.getByRole("button", { name: /播放|暂停/ });
    expect(play).toBeDisabled();
    expect(screen.getByRole("button", { name: /重播爆发/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /停止/ })).toBeDisabled();
    expect(screen.getByRole("slider")).toBeDisabled();
    fireEvent.click(play);
    space();
    // Decode outlasts the burst lifetime; neither action starts the clock.
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(resume).not.toHaveBeenCalled();
    expect(kit.particleBatches).toHaveLength(0);
    expect(readout()).toMatchObject({ ms: 0, finished: false });

    release();
    await waitFor(() => expect(liveBatches(kit)).toHaveLength(1), { interval: 5 });
    expect(readout().ms).toBeLessThan(120);
    await settled(kit);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest seek target visible while launching without drawing an empty frame", async () => {
    const { kit } = renderBurst(definition(5000));
    await waitFor(() => expect(readout().ms).toBeGreaterThan(20));
    fireEvent.click(screen.getByRole("button", { name: /暂停/ }));
    const rendered = kit.renderCount();
    const realRunCue = SceneSurface.prototype.runCue;
    const releases: (() => void)[] = [];
    vi.spyOn(SceneSurface.prototype, "runCue").mockImplementation(
      async function (this: SceneSurface, cue, context) {
        await new Promise<void>((resolve) => releases.push(resolve));
        await realRunCue.call(this, cue, context);
      },
    );
    const slider = screen.getByRole("slider");
    fireEvent.change(slider, { target: { value: "80" } });
    await waitFor(() => expect(releases).toHaveLength(1));
    expect(slider).toHaveValue("80");
    expect(readout().ms).toBe(80);
    expect(screen.getByRole("button", { name: /播放|暂停/ })).toBeDisabled();
    expect(kit.renderCount()).toBe(rendered);

    fireEvent.change(slider, { target: { value: "150" } });
    await waitFor(() => expect(releases).toHaveLength(2));
    releases[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(slider).toHaveValue("150");
    expect(readout().ms).toBe(150);
    expect(kit.renderCount()).toBe(rendered);

    releases[1]?.();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /播放/ })).toBeEnabled(),
    );
    expect(slider).toHaveValue("150");
    expect(readout().ms).toBe(150);
    expect(liveBatches(kit)).toHaveLength(1);
    expect(kit.renderCount()).toBeGreaterThan(rendered);
  });

  it("drives the burst from the shared clock to the maximum lifetime", async () => {
    const { kit } = renderBurst(definition(60));
    await screen.findByLabelText("粒子预览");

    // The cue resolved as soon as the emitter existed; the burst is still
    // alive and playing, it was not frozen or finished by that resolution.
    await waitFor(() => expect(kit.particleBatches).toHaveLength(1));
    expect(kit.particleBatches[0]?.node.destroyed).toBe(false);

    await settled(kit);
    expect(readout()).toMatchObject({ ms: 60, total: 60, finished: true });
    expect(kit.particleBatches).toHaveLength(1);
  });

  it("pauses and resumes the live burst", async () => {
    const { kit } = renderBurst(definition(5000));
    await waitFor(() => expect(readout().ms).toBeGreaterThan(20), {
      timeout: 4000,
    });

    fireEvent.click(screen.getByRole("button", { name: /暂停/ }));
    const frozen = readout().ms;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(readout().ms).toBe(frozen);
    expect(liveBatches(kit)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: /播放/ }));
    await waitFor(() => expect(readout().ms).toBeGreaterThan(frozen), {
      timeout: 4000,
    });
  });

  it("replays with Space after the burst completed, from zero", async () => {
    const { kit } = renderBurst(definition(60));
    await settled(kit);
    expect(kit.particleBatches).toHaveLength(1);

    const event = space();
    expect(event.defaultPrevented).toBe(true);
    // The released transient batch is recreated for the replay.
    await waitFor(() => expect(kit.particleBatches).toHaveLength(2));
    expect(kit.particleBatches[0]?.node.destroyed).toBe(true);
    await settled(kit);

    // Replaying again after another completion keeps working.
    space();
    await waitFor(() => expect(kit.particleBatches).toHaveLength(3));
    await settled(kit);
  });

  it("restarts a running or paused burst from zero instead of pausing or resuming", async () => {
    const { kit } = renderBurst(definition(5000));
    await waitFor(() => expect(readout().ms).toBeGreaterThan(150), {
      timeout: 4000,
    });
    const before = readout().ms;

    space();
    await waitFor(() => expect(kit.particleBatches).toHaveLength(2));
    expect(readout().ms).toBeLessThan(before);
    // Still playing: Space never toggled the transport.
    expect(screen.getByRole("button", { name: /暂停/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /暂停/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /播放/ })).toBeInTheDocument(),
    );
    space();
    await waitFor(() => expect(kit.particleBatches).toHaveLength(3));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /暂停/ })).toBeInTheDocument(),
    );
    expect(liveBatches(kit)).toHaveLength(1);
  });

  it("ignores repeats, modifiers, IME, text fields and a Space typed in an input", async () => {
    const { kit } = renderBurst(definition(60));
    await settled(kit);

    space(document.body, { repeat: true });
    space(document.body, { ctrlKey: true });
    space(document.body, { shiftKey: true });
    space(document.body, { isComposing: true });
    const note = screen.getByLabelText("备注");
    const typed = space(note);
    expect(typed.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(kit.particleBatches).toHaveLength(1);
  });

  it("replays once for a focused transport button and cancels the native click", async () => {
    const { kit } = renderBurst(definition(60));
    await settled(kit);

    const replay = screen.getByRole("button", { name: /重播爆发/ });
    const down = space(replay);
    // Prevented keydown: the focused button must not also fire its own click.
    expect(down.defaultPrevented).toBe(true);
    const up = createEvent.keyUp(replay, { key: " ", code: "Space" });
    fireEvent(replay, up);
    expect(up.defaultPrevented).toBe(true);
    await waitFor(() => expect(kit.particleBatches).toHaveLength(2));
    await settled(kit);
    expect(kit.particleBatches).toHaveLength(2);

    // A held key replays once; its repeats are only kept from scrolling.
    const first = space(replay);
    expect(first.defaultPrevented).toBe(true);
    const repeat = space(replay, { repeat: true });
    expect(repeat.defaultPrevented).toBe(true);
    await waitFor(() => expect(kit.particleBatches).toHaveLength(3));
    fireEvent.keyUp(replay, { key: " ", code: "Space" });
    await settled(kit);
    expect(kit.particleBatches).toHaveLength(3);
  });

  it("seeks deterministically by recreating the transient batch", async () => {
    const { kit } = renderBurst(definition(200));
    await waitFor(() => expect(kit.particleBatches).toHaveLength(1));
    const slider = screen.getByLabelText("粒子预览播放头");

    const snapshot = (): number[] => {
      const batch = liveBatches(kit).at(-1);
      if (batch?.data == null) return [];
      return Array.from(batch.data.slice(0, batch.count * 5));
    };
    const seekTo = async (value: number): Promise<number[]> => {
      fireEvent.change(slider, { target: { value: String(value) } });
      await waitFor(() => expect(readout().ms).toBe(value));
      await waitFor(() => expect(transportBusy()).toBe(false));
      // The clock is frozen at the requested playhead.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(readout().ms).toBe(value);
      return snapshot();
    };

    const first = await seekTo(80);
    expect(first.length).toBeGreaterThan(0);
    await seekTo(150);
    const again = await seekTo(80);
    expect(again).toEqual(first);
    expect(screen.getByRole("button", { name: /播放/ })).toBeInTheDocument();

    // Seeking to the end shows the finished state; playing then replays.
    fireEvent.change(slider, { target: { value: "200" } });
    await waitFor(() => expect(readout().finished).toBe(true));
    const before = kit.particleBatches.length;
    fireEvent.click(screen.getByRole("button", { name: /播放/ }));
    await waitFor(() => expect(kit.particleBatches.length).toBeGreaterThan(before));
  });

  it("installs the resource maps before every prepare and builds with the latest definition", async () => {
    const resources = vi.spyOn(SceneSurface.prototype, "setVisualResources");
    const prepare = vi.spyOn(SceneSurface.prototype, "prepare");
    const { kit, rerender } = renderBurst(definition(60));
    await waitFor(() => expect(kit.particleBatches).toHaveLength(1));
    expect(kit.particleBatches[0]?.capacity).toBe(20);

    rerender(definition(60, { max_particles: 30 }));
    await waitFor(() => expect(kit.particleBatches).toHaveLength(2));
    // The replacement burst was created from the replacement definition: its
    // map was installed on the surface before the world was prepared.
    expect(kit.particleBatches[1]?.capacity).toBe(30);

    expect(prepare.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(resources.mock.calls.length).toBe(prepare.mock.calls.length);
    for (const [index, order] of prepare.mock.invocationCallOrder.entries()) {
      const installed = resources.mock.invocationCallOrder[index];
      expect(installed).toBeDefined();
      expect(installed ?? Number.MAX_SAFE_INTEGER).toBeLessThan(order);
    }
  });

  it("never commits a burst from a superseded build", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { kit, rerender } = renderBurst(definition(5000), { gate });
    // Give the first build time to reach its (gated) texture load.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(kit.particleBatches).toHaveLength(0);

    // A second authored revision supersedes the first while it is loading.
    rerender(definition(5000), staticRequest());
    await new Promise((resolve) => setTimeout(resolve, 60));
    release();

    await waitFor(() => expect(kit.particleBatches).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Only the newest build created a batch; the stale one stayed silent.
    expect(kit.particleBatches).toHaveLength(1);
    expect(liveBatches(kit)).toHaveLength(1);
  });

  it("reports a failing burst and leaves the preview retryable", async () => {
    const onError = vi.fn();
    const particle = definition(60);
    const kit = createMemoryKit();
    const textures = createMemoryTextureLoader({ [DOT_URL]: { width: 64, height: 64 } });
    render(
      <CuePreview
        assets={ASSETS}
        decorationTransport={{ durationMs: 60, burst: burstCue(particle) }}
        environment={{ kit: kit.kit, textureLoader: textures.load }}
        label="粒子预览"
        onError={onError}
        request={staticRequest()}
        // The particle map does not know the cue's particle.
        visuals={{ textBlocks: {}, particles: {} }}
      />,
    );
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("预览构建失败")),
    );
    expect(await screen.findByRole("button", { name: "重试" })).toBeEnabled();
    expect(kit.particleBatches).toHaveLength(0);
  });

  it("keeps the continuous transport unchanged and gives Space no meaning there", async () => {
    const particle = definition(3000, { rate: 40 });
    const kit = createMemoryKit();
    const textures = createMemoryTextureLoader({ [DOT_URL]: { width: 64, height: 64 } });
    render(
      <CuePreview
        assets={ASSETS}
        decorationTransport={{ durationMs: 6000 }}
        environment={{ kit: kit.kit, textureLoader: textures.load }}
        label="粒子预览"
        request={staticRequest()}
        visuals={visualsFor(particle)}
      />,
    );
    const pause = await screen.findByRole("button", { name: /暂停/ });
    await waitFor(() => expect(pause).toBeEnabled());
    expect(screen.queryByRole("button", { name: /重播爆发/ })).toBeNull();

    const event = space();
    expect(event.defaultPrevented).toBe(false);
    expect(kit.particleBatches).toHaveLength(0);
  });

  it("stays busy while the first emitter is still being created and keeps the burst in step with the clock", async () => {
    const defer = deferRunCue();
    const { kit } = renderBurst(definition(60));
    await screen.findByLabelText("粒子预览");
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The cue has not resolved: nothing exists to pause or resume yet.
    expect(transportBusy()).toBe(true);
    const toggle = screen.getByRole("button", { name: /播放|暂停/ });
    expect(toggle).toBeDisabled();
    expect(screen.getByRole("button", { name: /重播爆发/ })).toBeDisabled();
    fireEvent.click(toggle);
    // A clock resumed by that click would run ahead of the particles now.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(kit.particleBatches).toHaveLength(0);

    defer.release();
    await waitFor(() => expect(kit.particleBatches).toHaveLength(1));
    // The particles live exactly as long as the playhead: when the readout
    // reaches the lifetime, the batch is already released, not frozen midway.
    await settled(kit);
    expect(readout()).toMatchObject({ ms: 60, total: 60, finished: true });
    expect(transportBusy()).toBe(false);
  });

  it("does not let pause or play touch the clock while a replay is being created", async () => {
    const { kit } = renderBurst(definition(60));
    await settled(kit);

    const defer = deferRunCue();
    space();
    await waitFor(() => expect(transportBusy()).toBe(true));
    const toggle = screen.getByRole("button", { name: /播放|暂停/ });
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The finished readout is not shown for a replay that has not started.
    expect(readout().finished).toBe(false);

    defer.release();
    await waitFor(() => expect(kit.particleBatches).toHaveLength(2));
    await settled(kit);
    expect(readout()).toMatchObject({ ms: 60, total: 60, finished: true });
  });

  it("keeps the slider on the requested target while the burst is rebuilt, latest request winning", async () => {
    const { kit } = renderBurst(definition(200));
    await waitFor(() => expect(kit.particleBatches).toHaveLength(1));
    await waitFor(() => expect(transportBusy()).toBe(false));
    const slider = screen.getByLabelText<HTMLInputElement>("粒子预览播放头");

    // The rebuild restarts the clock at zero while the cue is still being
    // created; the controlled slider must not follow it back to 0.
    const defer = deferRunCue();
    fireEvent.change(slider, { target: { value: "80" } });
    expect(slider.value).toBe("80");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(slider.value).toBe("80");
    expect(readout().ms).toBe(80);
    expect(transportBusy()).toBe(true);

    // A newer request supersedes the first while it is still pending.
    fireEvent.change(slider, { target: { value: "150" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(slider.value).toBe("150");
    expect(readout().ms).toBe(150);

    defer.release();
    await waitFor(() => expect(transportBusy()).toBe(false));
    expect(slider.value).toBe("150");
    expect(readout()).toMatchObject({ ms: 150, finished: false });
    // Only the newest request created a batch, frozen at its target.
    expect(liveBatches(kit)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(readout().ms).toBe(150);
    expect(slider.value).toBe("150");
    expect(screen.getByRole("button", { name: /播放/ })).toBeEnabled();
  });

  describe("with a third-party document handler that consumes Space first", () => {
    // Like the story graph's key-press hook: a document-level bubble listener
    // that prevents the default action of Space before any bubbling window
    // listener could judge the key.
    let seen = 0;
    const consume = (event: KeyboardEvent): void => {
      if (event.key !== " ") return;
      seen += 1;
      event.preventDefault();
    };
    afterEach(() => {
      document.removeEventListener("keydown", consume);
      seen = 0;
    });

    it("still replays on a bare page, without stopping propagation", async () => {
      document.addEventListener("keydown", consume);
      const { kit } = renderBurst(definition(60));
      await settled(kit);
      expect(kit.particleBatches).toHaveLength(1);

      const event = space();
      // The shortcut ran before the third-party handler and let it run too.
      expect(event.defaultPrevented).toBe(true);
      expect(seen).toBe(1);
      await waitFor(() => expect(kit.particleBatches).toHaveLength(2));
      await settled(kit);
    });

    it("replays once for a focused transport button and cancels its keyup activation", async () => {
      document.addEventListener("keydown", consume);
      const { kit } = renderBurst(definition(60));
      await settled(kit);

      const replay = screen.getByRole("button", { name: /重播爆发/ });
      const down = space(replay);
      expect(down.defaultPrevented).toBe(true);
      const up = createEvent.keyUp(replay, { key: " ", code: "Space" });
      fireEvent(replay, up);
      // Prevented by the shortcut itself: some engines click a focused button
      // on keyup, which would replay a second time.
      expect(up.defaultPrevented).toBe(true);
      await waitFor(() => expect(kit.particleBatches).toHaveLength(2));
      await settled(kit);
      expect(kit.particleBatches).toHaveLength(2);
    });

    it("keeps every exclusion: text fields, outside controls, modifiers, repeats", async () => {
      document.addEventListener("keydown", consume);
      const { kit } = renderBurst(definition(60));
      await settled(kit);

      const outside = document.createElement("button");
      document.body.append(outside);
      space(screen.getByLabelText("备注"));
      space(outside);
      space(document.body, { ctrlKey: true });
      space(document.body, { repeat: true });
      outside.remove();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(kit.particleBatches).toHaveLength(1);
    });
  });
});
