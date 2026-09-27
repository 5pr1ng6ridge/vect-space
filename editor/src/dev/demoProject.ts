/**
 * Dev-only demo project for the browser design preview (preview.html).
 * Built from the real node constructors so it always matches the schema.
 */
import {
  newButtonFile,
  newSpriteActionFile,
  newUiMotionFile,
} from "../app/libraryCommands";
import { defaultNode } from "../story";
import type { EditorProject, SceneNode } from "../types";

function withNext(node: SceneNode, next: string): SceneNode {
  return "next" in node ? { ...node, next } : node;
}

export function demoProject(): EditorProject {
  const nodes: Record<string, SceneNode> = {};
  const chain: [string, SceneNode][] = [
    ["bg_room", defaultNode("background", "x")],
    ["bgm_theme", defaultNode("bgm", "x")],
    [
      "intro",
      {
        type: "say",
        speaker: "lumi",
        text: "欢迎来到向量空间。今天我们来讨论线性映射。",
        speed_cps: null,
        next: "x",
      },
    ],
    [
      "follow",
      {
        type: "say",
        speaker: null,
        text: "黑板上写着 $f(x) = Ax + b$。",
        speed_cps: null,
        next: "x",
      },
    ],
    ["pick", defaultNode("choice", "x")],
  ];
  chain.forEach(([id, node], index) => {
    const next = chain[index + 1]?.[0] ?? "finish";
    nodes[id] = withNext(node, next);
  });
  nodes.cam = withNext(defaultNode("timeline", "finish"), "finish");
  nodes.lecture = withNext(defaultNode("long_text", "finish"), "finish");
  nodes.finish = { type: "end" };
  const pick = nodes.pick;
  if (pick.type === "choice") {
    pick.choices = pick.choices.map((choice, index) => ({
      ...choice,
      label: index === 0 ? "继续听讲" : "去黑板演算",
      next: index === 0 ? "cam" : "lecture",
    }));
  }

  const positions: Record<string, { x: number; y: number }> = {};
  chain.forEach(([id], index) => {
    positions[id] = { x: index * 340, y: 80 };
  });
  positions.cam = { x: 5 * 340, y: -60 };
  positions.lecture = { x: 5 * 340, y: 260 };
  positions.finish = { x: 6 * 340, y: 80 };

  const motion = newUiMotionFile("ui.dialogue.fade");
  const button = newButtonFile("button.main");
  const action = newSpriteActionFile("sprite.hop");
  return {
    root: "C:/demo/vectspace-game",
    manifest: {
      schema_version: 2,
      content_version: "1",
      entry_scene: "prologue",
      default_locale: "zh-CN",
      variables: {
        affection: { scope: "save", type: "integer", default: 0n },
        met_lumi: { scope: "save", type: "boolean", default: false },
      },
      characters: {
        lumi: {
          display_name: "露米",
          name_color: "#9FECD8",
          text_color: "#FFFFFF",
        },
        teacher: {
          display_name: "老师",
          name_color: "#FFD9A3",
          text_color: "#FFFFFF",
        },
      },
      assets: {
        "bg.classroom": {
          kind: "background",
          path: "backgrounds/classroom.png",
        },
        "bgm.theme": { kind: "bgm", path: "audio/theme.ogg" },
        "sprite.lumi.smile": { kind: "sprite", path: "sprites/lumi_smile.png" },
      },
      scenes: ["scenes/prologue.yaml", "scenes/chapter1.yaml"],
      ui_motions: [motion.path],
      ui_motion_defaults: {},
      buttons: [button.path],
      actions: [action.path],
    },
    scenes: [
      {
        path: "scenes/prologue.yaml",
        definition: {
          schema_version: 2,
          id: "prologue",
          entry: "bg_room",
          nodes,
        },
      },
      {
        path: "scenes/chapter1.yaml",
        definition: {
          schema_version: 2,
          id: "chapter1",
          entry: "start",
          nodes: { start: { type: "end" } },
        },
      },
    ],
    ui_motions: [motion],
    buttons: [button],
    actions: [action],
    layout: {
      version: 1,
      scenes: {
        prologue: { nodes: positions, viewport: { x: 40, y: 200, zoom: 1 } },
      },
    },
    assets: [
      {
        id: "bg.classroom",
        kind: "background",
        path: "backgrounds/classroom.png",
        absolute_path: "C:/demo/assets/backgrounds/classroom.png",
        size_bytes: "204800",
        metadata: null,
      },
      {
        id: "bgm.theme",
        kind: "bgm",
        path: "audio/theme.ogg",
        absolute_path: "C:/demo/assets/audio/theme.ogg",
        size_bytes: "1048576",
        metadata: null,
      },
      {
        id: "sprite.lumi.smile",
        kind: "sprite",
        path: "sprites/lumi_smile.png",
        absolute_path: "C:/demo/assets/sprites/lumi_smile.png",
        size_bytes: "102400",
        metadata: null,
      },
    ],
    diagnostics: [],
    fingerprint: "demo",
  };
}
