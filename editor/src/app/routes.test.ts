import { describe, expect, it } from "vitest";

import { visualReturnScene, type VisualRoute } from "./routes";

const route = (sceneId?: string): VisualRoute => ({
  kind: "visual",
  visual: "textBlock",
  id: "label",
  ...(sceneId === undefined ? {} : { sceneId }),
});

describe("visualReturnScene", () => {
  const scenes = ["main", "side"];

  it("returns to the scene whose group opened the text", () => {
    expect(visualReturnScene(route("side"), scenes, "main")).toBe("side");
  });

  it("keeps the active scene when it already is the origin", () => {
    expect(visualReturnScene(route("main"), scenes, "main")).toBeNull();
  });

  it("keeps the active scene for fallback groups and particles", () => {
    expect(visualReturnScene(route(), scenes, "side")).toBeNull();
  });

  it("ignores an origin scene that no longer exists", () => {
    expect(visualReturnScene(route("gone"), scenes, "main")).toBeNull();
  });
});
