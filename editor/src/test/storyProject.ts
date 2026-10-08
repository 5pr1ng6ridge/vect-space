import type { EditorProject } from "../types";

/** A small valid project: a choice that branches to a jump and a say, both ending. */
export function storyProject(): EditorProject {
  return {
    root: "C:/project/game",
    fingerprint: "test",
    manifest: {
      schema_version: 2,
      content_version: "test",
      entry_scene: "main",
      default_locale: "zh-CN",
      variables: {
        score: { scope: "save", type: "integer", default: 0 },
      },
      characters: {
        alice: {
          display_name: "爱丽丝",
          name_color: "#80D8FF",
          text_color: "#FFFFFF",
        },
      },
      assets: {},
      scenes: ["scenes/main.yaml"],
      ui_motions: [],
      ui_motion_defaults: {},
    },
    scenes: [
      {
        path: "scenes/main.yaml",
        definition: {
          schema_version: 2,
          id: "main",
          entry: "start",
          nodes: {
            start: {
              type: "choice",
              choices: [
                { id: "left", label: "左", next: "left" },
                { id: "right", label: "右", next: "right" },
              ],
            },
            left: { type: "jump", scene: null, target: "end" },
            right: {
              type: "say",
              speaker: null,
              text: "R",
              speed_cps: null,
              next: "end",
            },
            end: { type: "end" },
          },
        },
      },
    ],
    ui_motions: [],
    layout: { version: 1, scenes: {} },
    assets: [],
    diagnostics: [],
  };
}
