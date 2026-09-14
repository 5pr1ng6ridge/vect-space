import { describe, expect, it } from "vitest";

import type { EditorProject } from "../types";
import { findAssetReferences } from "./assetReferences";

function projectWithExpression(): EditorProject {
  return {
    root: "C:/game",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: "main",
      default_locale: "zh-CN",
      variables: {},
      characters: {
        alice: {
          display_name: "Alice",
          expressions: {
            happy: { asset: "sprite.alice.happy" },
          },
        },
      },
      assets: {
        "sprite.alice.happy": {
          kind: "sprite",
          path: "sprites/alice-happy.png",
        },
      },
      scenes: [],
      ui_motions: [],
      ui_motion_defaults: {},
    },
    scenes: [],
    ui_motions: [],
    layout: { version: 1, scenes: {} },
    assets: [
      {
        id: "sprite.alice.happy",
        kind: "sprite",
        path: "sprites/alice-happy.png",
        absolute_path: "C:/game/sprites/alice-happy.png",
      },
    ],
    diagnostics: [],
    fingerprint: "fingerprint",
  };
}

describe("asset reference traversal", () => {
  it("protects character expression assets from deletion", () => {
    expect(
      findAssetReferences(projectWithExpression(), "sprite.alice.happy"),
    ).toEqual(["manifest / characters:alice / expression:happy"]);
  });
});
