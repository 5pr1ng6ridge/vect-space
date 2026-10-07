import { produce } from "immer";
import { describe, expect, it } from "vitest";

import { editorReducer, INITIAL_EDITOR_STATE } from "../editorHistory";
import { defaultNode, renameScene } from "../story";
import { visualProject, type VisualProject } from "../test/visualFixtures";
import type { EditorProject, SceneNode } from "../types";
import { validateLive } from "../validation";
import { removeScene } from "./libraryCommands";
import {
  addVisualDocument,
  duplicateVisualFile,
  newTextBlockFile,
  pinTextBlock,
  removeVisualDocument,
  renameVisualDocument,
  textBlockGroups,
  textBlockSceneIds,
  unpinTextBlock,
  visualReferences,
} from "./visualLibrary";

function textSprite(textBlock: string, next = "finish"): SceneNode {
  return {
    ...(defaultNode("sprite", next) as Extract<SceneNode, { type: "sprite" }>),
    source: { type: "text", text_block: textBlock },
  };
}

function textTimeline(textBlock: string, next = "finish"): SceneNode {
  const timeline = defaultNode("timeline", next) as Extract<SceneNode, { type: "timeline" }>;
  timeline.tracks = [
    { type: "sprite", sprite_id: "caption", source: { type: "text", text_block: textBlock }, remove_at_end: false, channels: {} },
  ];
  return timeline;
}

/** `main` plus a second scene `side`; nothing references `label` yet. */
function twoSceneProject(): VisualProject {
  const project = visualProject();
  const side = structuredClone(project.scenes[0]);
  side.path = "scenes/side.yaml";
  side.definition.id = "side";
  project.scenes.push(side);
  project.manifest.scenes.push(side.path);
  return project;
}

function withSprite(project: VisualProject, sceneId: string, textBlock: string): void {
  const scene = project.scenes.find((file) => file.definition.id === sceneId);
  if (scene === undefined) throw new Error(`missing scene ${sceneId}`);
  scene.definition.nodes.caption = textSprite(textBlock);
}

function errors(project: EditorProject): unknown[] {
  return validateLive(project).filter((diagnostic) => diagnostic.severity === "error");
}

describe("text block grouping", () => {
  it("derives legacy single-scene ownership from Sprite and timeline references without edits", () => {
    const sprite = twoSceneProject();
    withSprite(sprite, "main", "label");
    const layoutBefore = structuredClone(sprite.layout);
    const grouped = textBlockGroups(sprite);
    expect(grouped.scenes.get("main")).toEqual(["label"]);
    expect(grouped.scenes.get("side")).toEqual([]);
    expect(grouped.shared).toEqual([]);
    expect(grouped.unassigned).toEqual([]);
    // Discovery is read-only: no pin was written to the layout.
    expect(sprite.layout).toEqual(layoutBefore);

    const timeline = twoSceneProject();
    timeline.scenes[1].definition.nodes.caption = textTimeline("label");
    expect(textBlockGroups(timeline).scenes.get("side")).toEqual(["label"]);
    expect(textBlockGroups(timeline).scenes.get("main")).toEqual([]);
  });

  it("lists an unreferenced text as unassigned until it is pinned to a scene", () => {
    const project = twoSceneProject();
    expect(textBlockGroups(project).unassigned).toEqual(["label"]);

    const pinned = produce(project, (draft) => pinTextBlock(draft, "side", "label"));
    expect(pinned.layout.scenes.side.text_block_ids).toEqual(["label"]);
    const grouped = textBlockGroups(pinned);
    expect(grouped.scenes.get("side")).toEqual(["label"]);
    expect(grouped.unassigned).toEqual([]);
    // Pinning edits only the layout; the scene graph and manifest are untouched.
    expect(pinned.scenes).toEqual(project.scenes);
    expect(pinned.manifest).toEqual(project.manifest);
    expect(errors(pinned)).toEqual([]);
  });

  it("keeps one definition for a shared text and reports every claiming scene in scene order", () => {
    const project = twoSceneProject();
    withSprite(project, "main", "label");
    withSprite(project, "side", "label");
    const grouped = textBlockGroups(project);
    expect(grouped.shared).toEqual([{ id: "label", sceneIds: ["main", "side"] }]);
    expect(grouped.scenes.get("main")).toEqual([]);
    expect(grouped.scenes.get("side")).toEqual([]);
    expect(project.text_blocks).toHaveLength(1);
    expect(textBlockSceneIds(project, "label")).toEqual(["main", "side"]);
  });

  it("merges explicit pins and real references into one union per scene", () => {
    const project = twoSceneProject();
    project.layout.scenes.main = { nodes: {}, viewport: null, text_block_ids: ["label"] };
    withSprite(project, "main", "label");
    expect(textBlockGroups(project).scenes.get("main")).toEqual(["label"]);
    expect(textBlockSceneIds(project, "label")).toEqual(["main"]);

    // A pin in one scene plus a use in another makes the text shared.
    withSprite(project, "side", "label");
    expect(textBlockGroups(project).shared).toEqual([{ id: "label", sceneIds: ["main", "side"] }]);
  });

  it("ignores pins to unknown texts, unknown scenes and duplicated ids", () => {
    const project = twoSceneProject();
    project.layout.scenes.main = { nodes: {}, viewport: null, text_block_ids: ["ghost", "label", "label"] };
    project.layout.scenes.gone = { nodes: {}, viewport: null, text_block_ids: ["label"] };
    const grouped = textBlockGroups(project);
    expect(grouped.scenes.get("main")).toEqual(["label"]);
    expect(grouped.scenes.has("gone")).toBe(false);
    expect(grouped.shared).toEqual([]);
    expect(grouped.unassigned).toEqual([]);
  });

  it("keeps the file order of definitions inside each group", () => {
    const project = twoSceneProject();
    const produced = produce(project, (draft) => {
      addVisualDocument(draft, "textBlock", newTextBlockFile("a_title"), { sceneIds: ["main"] });
      addVisualDocument(draft, "textBlock", newTextBlockFile("b_title"), { sceneIds: ["main"] });
      pinTextBlock(draft, "main", "label");
    });
    expect(textBlockGroups(produced).scenes.get("main")).toEqual(["label", "a_title", "b_title"]);
  });
});

describe("text block commands keep scene pins in step", () => {
  it("creates a pinned text in one commit without adding a graph node", () => {
    const project = twoSceneProject();
    const created = produce(project, (draft) => {
      addVisualDocument(draft, "textBlock", newTextBlockFile("title"), { sceneIds: ["main"] });
    });
    expect(created.manifest.text_blocks).toContain("text_blocks/title.yaml");
    expect(created.layout.scenes.main.text_block_ids).toEqual(["title"]);
    expect(Object.keys(created.scenes[0].definition.nodes)).toEqual(Object.keys(project.scenes[0].definition.nodes));
    expect(textBlockGroups(created).scenes.get("main")).toEqual(["title"]);
    expect(errors(created)).toEqual([]);

    // Without a scene the new text stays in the unassigned fallback group.
    const loose = produce(project, (draft) => addVisualDocument(draft, "textBlock", newTextBlockFile("loose")));
    expect(loose.layout).toEqual(project.layout);
    expect(textBlockGroups(loose).unassigned).toContain("loose");

    // An unknown scene is not invented in the layout.
    const missing = produce(project, (draft) =>
      addVisualDocument(draft, "textBlock", newTextBlockFile("orphan"), { sceneIds: ["nowhere"] }),
    );
    expect(missing.layout.scenes.nowhere).toBeUndefined();
  });

  it("undoes and redoes the definition and its pin as one history entry", () => {
    const project = twoSceneProject();
    let state = editorReducer(INITIAL_EDITOR_STATE, { type: "load", project });
    state = editorReducer(state, {
      type: "edit",
      history: true,
      label: "新建固定文本块",
      mutation: (draft) =>
        addVisualDocument(draft, "textBlock", newTextBlockFile("title"), { sceneIds: ["main"] }),
    });
    expect(state.past).toHaveLength(1);
    expect(state.dirty).toBe(true);
    expect(state.project?.layout.scenes.main.text_block_ids).toEqual(["title"]);

    state = editorReducer(state, { type: "undo" });
    expect(state.project).toEqual(project);
    expect(state.project?.layout.scenes.main?.text_block_ids).toBeUndefined();
    expect(state.dirty).toBe(false);

    state = editorReducer(state, { type: "redo" });
    expect(state.project?.text_blocks?.map((file) => file.definition.id)).toContain("title");
    expect(state.project?.layout.scenes.main.text_block_ids).toEqual(["title"]);
  });

  it("copies into every scene that lists the source and keeps the source untouched", () => {
    const project = twoSceneProject();
    withSprite(project, "main", "label");
    const copy = duplicateVisualFile(project, "textBlock", "label", () => false);
    expect(copy?.definition.id).toBe("label_copy");
    const sceneIds = textBlockSceneIds(project, "label");
    const copied = produce(project, (draft) => {
      if (copy !== null) addVisualDocument(draft, "textBlock", copy, { sceneIds });
    });
    expect(copied.layout.scenes.main.text_block_ids).toEqual(["label_copy"]);
    const grouped = textBlockGroups(copied);
    expect(grouped.scenes.get("main")).toEqual(["label", "label_copy"]);
    expect(copied.text_blocks?.[0].definition).toEqual(project.text_blocks?.[0].definition);

    // A shared source produces a shared copy; an unassigned one stays loose.
    const sharedSource = twoSceneProject();
    withSprite(sharedSource, "main", "label");
    withSprite(sharedSource, "side", "label");
    const sharedCopy = duplicateVisualFile(sharedSource, "textBlock", "label", () => false);
    const sharedResult = produce(sharedSource, (draft) => {
      if (sharedCopy !== null)
        addVisualDocument(draft, "textBlock", sharedCopy, { sceneIds: textBlockSceneIds(sharedSource, "label") });
    });
    expect(textBlockGroups(sharedResult).shared.map((entry) => entry.id)).toEqual(["label", "label_copy"]);

    const looseSource = twoSceneProject();
    expect(textBlockSceneIds(looseSource, "label")).toEqual([]);
  });

  it("renames the pin with the text and stays valid; the id stays unique in the list", () => {
    const project = twoSceneProject();
    withSprite(project, "main", "label");
    project.layout.scenes.main = { nodes: {}, viewport: null, text_block_ids: ["label"] };
    project.layout.scenes.side = { nodes: {}, viewport: null, text_block_ids: ["label", "other"] };
    const renamed = produce(project, (draft) => renameVisualDocument(draft, "textBlock", "label", "title"));
    expect(renamed.layout.scenes.main.text_block_ids).toEqual(["title"]);
    expect(renamed.layout.scenes.side.text_block_ids).toEqual(["title", "other"]);
    expect(renamed.manifest.text_blocks).toEqual(["text_blocks/title.yaml"]);
    expect(visualReferences(renamed, "textBlock", "title")).toEqual(["main/caption"]);
    expect(errors(renamed)).toEqual([]);

    // Renaming onto an id already pinned collapses the duplicate pin.
    const collapsing = twoSceneProject();
    collapsing.layout.scenes.main = { nodes: {}, viewport: null, text_block_ids: ["label", "title"] };
    const collapsed = produce(collapsing, (draft) => renameVisualDocument(draft, "textBlock", "label", "title"));
    expect(collapsed.layout.scenes.main.text_block_ids).toEqual(["title"]);
  });

  it("removes the text and every pin, leaving no empty list behind", () => {
    const project = twoSceneProject();
    project.layout.scenes.main = { nodes: {}, viewport: null, text_block_ids: ["label"] };
    project.layout.scenes.side = { nodes: {}, viewport: null, text_block_ids: ["label", "other"] };
    const removed = produce(project, (draft) => removeVisualDocument(draft, "textBlock", "label"));
    expect(removed.text_blocks).toEqual([]);
    expect(removed.manifest.text_blocks).toEqual([]);
    expect("text_block_ids" in removed.layout.scenes.main).toBe(false);
    expect(removed.layout.scenes.side.text_block_ids).toEqual(["other"]);

    const direct = produce(project, (draft) => unpinTextBlock(draft, "missing"));
    expect(direct.layout).toEqual(project.layout);
  });

  it("still blocks deleting a referenced text; a pin alone does not count as a reference", () => {
    const project = twoSceneProject();
    project.layout.scenes.main = { nodes: {}, viewport: null, text_block_ids: ["label"] };
    expect(visualReferences(project, "textBlock", "label")).toEqual([]);
    withSprite(project, "main", "label");
    expect(visualReferences(project, "textBlock", "label")).toEqual(["main/caption"]);
  });
});

describe("scene rename and delete never move or delete text resources", () => {
  it("scene rename carries the pins with the whole layout", () => {
    const project = twoSceneProject();
    project.layout.scenes.side = { nodes: {}, viewport: null, text_block_ids: ["label"] };
    const renamed = renameScene(project, "side", "epilogue");
    expect(renamed.layout.scenes.epilogue.text_block_ids).toEqual(["label"]);
    expect(renamed.layout.scenes.side).toBeUndefined();
    expect(textBlockGroups(renamed).scenes.get("epilogue")).toEqual(["label"]);
    expect(renamed.text_blocks).toEqual(project.text_blocks);
    expect(renamed.manifest.text_blocks).toEqual(project.manifest.text_blocks);
  });

  it("scene deletion keeps the text document and falls back to unassigned or shared", () => {
    const project = twoSceneProject();
    project.layout.scenes.side = { nodes: {}, viewport: null, text_block_ids: ["label"] };
    const deleted = produce(project, (draft) => removeScene(draft, "side"));
    expect(deleted.text_blocks).toEqual(project.text_blocks);
    expect(deleted.manifest.text_blocks).toEqual(project.manifest.text_blocks);
    expect(textBlockGroups(deleted).unassigned).toEqual(["label"]);

    // Deleting one of two claiming scenes moves the text into the survivor.
    const shared = twoSceneProject();
    withSprite(shared, "main", "label");
    shared.layout.scenes.side = { nodes: {}, viewport: null, text_block_ids: ["label"] };
    const survivor = produce(shared, (draft) => removeScene(draft, "side"));
    expect(textBlockGroups(survivor).scenes.get("main")).toEqual(["label"]);
    expect(textBlockGroups(survivor).shared).toEqual([]);
    expect(errors(survivor)).toEqual([]);
  });
});
