// @vitest-environment jsdom
/**
 * Unit tests for the shared gameplay font facility.
 *
 * They pin the two things a preview depends on: the family name the face is
 * registered under (so a host's own `:root` font can never shadow gameplay
 * text) and the readiness contract (immediately ready without a face API or a
 * configured URL, held while the face loads, released on failure).
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  GAMEPLAY_FONT_FAMILY,
  selectGameplayFont,
  useGameplayFont,
} from "./gameplayFont";

interface FontFaceStub {
  family: string;
  source: string;
  descriptors: FontFaceDescriptors | undefined;
  load(): Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
}

interface FontFaceEnv {
  faces: FontFaceStub[];
  added: FontFaceStub[];
  deleted: FontFaceStub[];
  restore(): void;
}

const fontsDescriptor = Object.getOwnPropertyDescriptor(document, "fonts");

let env: FontFaceEnv | null = null;

/** Install a controllable `FontFace` + `document.fonts` into jsdom. */
function installFontFace(): FontFaceEnv {
  const faces: FontFaceStub[] = [];
  const added: FontFaceStub[] = [];
  const deleted: FontFaceStub[] = [];

  class StubFontFace implements FontFaceStub {
    family: string;
    source: string;
    descriptors: FontFaceDescriptors | undefined;
    private readonly promise: Promise<void>;
    private settleLoad!: () => void;
    private settleReject!: (reason: unknown) => void;

    constructor(
      family: string,
      source: string,
      descriptors?: FontFaceDescriptors,
    ) {
      this.family = family;
      this.source = source;
      this.descriptors = descriptors;
      this.promise = new Promise<void>((resolve, reject) => {
        this.settleLoad = resolve;
        this.settleReject = reject;
      });
      faces.push(this);
    }

    load(): Promise<void> {
      return this.promise;
    }

    resolve(): void {
      this.settleLoad();
    }

    reject(reason: unknown): void {
      this.settleReject(reason);
    }
  }

  (globalThis as { FontFace?: unknown }).FontFace = StubFontFace;
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: (face: FontFaceStub) => added.push(face),
      delete: (face: FontFaceStub) => deleted.push(face),
      ready: Promise.resolve(),
    },
  });

  env = {
    faces,
    added,
    deleted,
    restore(): void {
      delete (globalThis as { FontFace?: unknown }).FontFace;
      if (fontsDescriptor === undefined) {
        delete (document as { fonts?: unknown }).fonts;
      } else {
        Object.defineProperty(document, "fonts", fontsDescriptor);
      }
    },
  };
  return env;
}

afterEach(() => {
  // Unmount first (the hook deletes its face on cleanup), then restore the
  // jsdom globals so a later test sees the real absence of FontFace.
  cleanup();
  env?.restore();
  env = null;
});

describe("selectGameplayFont", () => {
  const sources = [
    { id: "font.other", kind: "font" },
    { id: "font.fusion_pixel", kind: "font" },
    { id: "sprite.a", kind: "sprite" },
  ];

  it("prefers the explicit default_font", () => {
    expect(selectGameplayFont("font.other", sources)).toBe(sources[0]);
  });

  it("falls back to the conventional fusion pixel font", () => {
    expect(selectGameplayFont(null, sources)).toBe(sources[1]);
  });

  it("falls back to the first font asset", () => {
    expect(
      selectGameplayFont(null, [{ id: "font.custom", kind: "font" }])?.id,
    ).toBe("font.custom");
  });

  it("returns undefined when no font asset exists", () => {
    expect(selectGameplayFont(null, [sources[2]])).toBeUndefined();
  });
});

describe("useGameplayFont", () => {
  it("is immediately ready without a font URL", () => {
    const { result } = renderHook(() => useGameplayFont(undefined));
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("treats a host without the FontFace API as a ready system fallback", () => {
    // jsdom default: no FontFace / document.fonts installed.
    const { result } = renderHook(() => useGameplayFont("asset://font.ttf"));
    expect(result.current.ready).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("registers the shared family and reports readiness after load", async () => {
    const faceEnv = installFontFace();
    const { result } = renderHook(() => useGameplayFont("asset://font.ttf"));
    expect(result.current.ready).toBe(false);
    expect(faceEnv.added).toHaveLength(1);
    expect(faceEnv.added[0]?.family).toBe(GAMEPLAY_FONT_FAMILY);
    expect(faceEnv.added[0]?.source).toContain("asset://font.ttf");

    await act(async () => {
      faceEnv.faces[0]?.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBeNull();
  });

  it("releases readiness with a non-fatal error when the face rejects", async () => {
    const faceEnv = installFontFace();
    const { result } = renderHook(() => useGameplayFont("asset://missing.ttf"));
    await act(async () => {
      faceEnv.faces[0]?.reject(new Error("boom"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBe("boom");
  });

  it("resets readiness and drops the stale face when the URL changes", async () => {
    const faceEnv = installFontFace();
    const { result, rerender } = renderHook(
      ({ url }: { url: string }) => useGameplayFont(url),
      { initialProps: { url: "asset://a.ttf" } },
    );
    expect(result.current.ready).toBe(false);

    rerender({ url: "asset://b.ttf" });
    expect(faceEnv.deleted).toHaveLength(1);
    expect(result.current.ready).toBe(false);
    expect(faceEnv.added[1]?.source).toContain("asset://b.ttf");

    await act(async () => {
      faceEnv.faces[1]?.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  it("removes the face on unmount", () => {
    const faceEnv = installFontFace();
    const { unmount } = renderHook(() => useGameplayFont("asset://font.ttf"));
    unmount();
    expect(faceEnv.deleted).toHaveLength(1);
  });
});
