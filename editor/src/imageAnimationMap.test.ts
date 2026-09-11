import { describe, expect, it, vi } from "vitest";

import { buildAnimationMap } from "./imageAnimationMap";
import type { EditorAsset } from "./types";

// The preview builder converts absolute paths into asset-protocol urls; the
// editor test environment has no Tauri host.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => path,
  invoke: () => Promise.resolve(undefined),
}));

function metadata(width: number, height: number) {
  return {
    format: "png",
    width,
    height,
    duration_ms: null,
    channels: null,
    sample_rate: null,
    font_family: null,
    font_style: null,
  };
}

function asset(overrides: Partial<EditorAsset> & { id: string }): EditorAsset {
  return {
    kind: "gui",
    absolute_path: `C:/project/assets/${overrides.id}.png`,
    ...overrides,
  };
}

describe("buildAnimationMap", () => {
  it("returns nothing when the project has no animations", () => {
    expect(buildAnimationMap([asset({ id: "gui.frame" })], undefined)).toEqual(
      {},
    );
    expect(buildAnimationMap([asset({ id: "gui.frame" })], [])).toEqual({});
  });

  it("joins an animated asset with its document and frame urls", () => {
    const map = buildAnimationMap(
      [
        asset({
          id: "img.pulse_a",
          metadata: metadata(200, 80),
        }),
        asset({ id: "img.pulse_b" }),
        asset({
          id: "gui.pulse",
          animation: "anim.pulse",
          metadata: metadata(200, 80),
        }),
      ],
      [
        {
          path: "animations/pulse.yaml",
          definition: {
            schema_version: 1,
            id: "anim.pulse",
            frames: [
              { asset: "img.pulse_a", duration_ms: 400 },
              { asset: "img.pulse_b", duration_ms: 600 },
            ],
          },
        },
      ],
    );
    expect(Object.keys(map)).toEqual(["gui.pulse"]);
    const resolved = map["gui.pulse"];
    expect(resolved?.id).toBe("anim.pulse");
    expect(resolved?.width).toBe(200);
    expect(resolved?.height).toBe(80);
    expect(resolved?.total_duration_ms).toBe(1000);
    expect(resolved?.frames.map((frame) => frame.asset)).toEqual([
      "img.pulse_a",
      "img.pulse_b",
    ]);
    expect(resolved?.frames[0]?.url).toContain("img.pulse_a.png");
  });

  it("skips frames whose image is not registered yet", () => {
    const map = buildAnimationMap(
      [asset({ id: "gui.pulse", animation: "anim.pulse" })],
      [
        {
          path: "animations/pulse.yaml",
          definition: {
            schema_version: 1,
            id: "anim.pulse",
            frames: [
              { asset: "img.missing", duration_ms: 100 },
              { asset: "gui.pulse", duration_ms: 100 },
            ],
          },
        },
      ],
    );
    expect(map["gui.pulse"]?.frames).toHaveLength(1);
    expect(map["gui.pulse"]?.frames[0]?.asset).toBe("gui.pulse");
  });

  it("ignores an asset whose animation document is not loaded", () => {
    const map = buildAnimationMap(
      [asset({ id: "gui.pulse", animation: "anim.absent" })],
      [
        {
          path: "animations/other.yaml",
          definition: {
            schema_version: 1,
            id: "anim.other",
            frames: [{ asset: "gui.pulse", duration_ms: 100 }],
          },
        },
      ],
    );
    expect(map).toEqual({});
  });
});
