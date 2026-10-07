/**
 * Pure commands for the fixed-text-block and image-particle libraries.
 *
 * Like `libraryCommands.ts` they take a plain project (queries, renames that
 * return a new project) or an Immer draft (mutations) and never touch React
 * state.  Every reference that can name a definition is kept in one place so
 * delete protection, rename and the sidebar's usage count agree.
 */
import type {
  EditorProject,
  ParticleDefinition,
  ParticleFile,
  SceneNode,
  TextBlockDefinition,
  TextBlockFile,
} from "../types";
import { libraryFilePath, uniqueId } from "./ids";

export type VisualKind = "textBlock" | "particle";
export type VisualFile = TextBlockFile | ParticleFile;

export const VISUAL_KIND_LABELS: Record<VisualKind, string> = {
  textBlock: "固定文本块",
  particle: "粒子效果",
};

export function newTextBlockFile(id: string): TextBlockFile {
  const definition: TextBlockDefinition = {
    schema_version: 2,
    id,
    content: "固定文本内容，支持行内公式 $E=mc^2$ 与换行。",
    width: 640,
    height: 160,
    font: null,
    font_size: 32,
    line_height: 1.4,
    color: "#FFFFFF",
    align: "left",
    vertical_align: "top",
    padding: 16,
    background: null,
  };
  return { path: libraryFilePath("textBlock", id), definition };
}

export function newParticleFile(id: string, image: string): ParticleFile {
  const definition: ParticleDefinition = {
    schema_version: 2,
    id,
    image,
    area: { type: "rectangle", width: 1920, height: 0 },
    rate: 30,
    burst_count: 40,
    max_particles: 300,
    lifetime_ms: { min: 3000, max: 6000 },
    velocity_x: { min: -20, max: 20 },
    velocity_y: { min: 40, max: 120 },
    gravity_x: 0,
    gravity_y: 0,
    size: { min: 0.3, max: 0.8 },
    rotation_deg: { min: 0, max: 360 },
    angular_velocity_deg: { min: -45, max: 45 },
    alpha_start: 1,
    alpha_end: 0,
    blend: "normal",
    seed: 1,
  };
  return { path: libraryFilePath("particle", id), definition };
}

function files(project: EditorProject, kind: VisualKind): VisualFile[] {
  return kind === "textBlock" ? (project.text_blocks ?? []) : (project.particles ?? []);
}

export function findVisualFile(
  project: EditorProject,
  kind: VisualKind,
  id: string,
): VisualFile | undefined {
  return files(project, kind).find((file) => file.definition.id === id);
}

/**
 * Register a new definition.  `sceneIds` files a text block under those scenes
 * in the same commit (see `pinTextBlock`); particles ignore it.
 */
export function addVisualDocument(
  draft: EditorProject,
  kind: VisualKind,
  file: VisualFile,
  options: { sceneIds?: readonly string[] } = {},
): void {
  if (kind === "textBlock") {
    draft.manifest.text_blocks ??= [];
    draft.manifest.text_blocks.push(file.path);
    draft.text_blocks ??= [];
    draft.text_blocks.push(file as TextBlockFile);
    for (const sceneId of options.sceneIds ?? [])
      pinTextBlock(draft, sceneId, file.definition.id);
  } else {
    draft.manifest.particles ??= [];
    draft.manifest.particles.push(file.path);
    draft.particles ??= [];
    draft.particles.push(file as ParticleFile);
  }
}

/** Replace one definition in place; a missing id is a no-op. */
export function updateVisualDefinition(
  draft: EditorProject,
  kind: VisualKind,
  id: string,
  definition: TextBlockDefinition | ParticleDefinition,
): void {
  const file = files(draft, kind).find((candidate) => candidate.definition.id === id);
  if (file !== undefined) file.definition = definition;
}

/** Every scene location that would break if the definition disappeared. */
export function visualReferences(
  project: EditorProject,
  kind: VisualKind,
  id: string,
): string[] {
  const references: string[] = [];
  for (const scene of project.scenes) {
    for (const [nodeId, node] of Object.entries(scene.definition.nodes)) {
      const location = `${scene.definition.id}/${nodeId}`;
      if (kind === "particle") {
        if (node.type === "particle" && node.particle === id) references.push(location);
        continue;
      }
      if (nodeTextBlockIds(node).includes(id))
        references.push(node.type === "timeline" ? `${location} · 时间线` : location);
    }
  }
  return references;
}

export function duplicateVisualFile(
  project: EditorProject,
  kind: VisualKind,
  id: string,
  isTaken: (id: string) => boolean,
): VisualFile | null {
  const source = findVisualFile(project, kind, id);
  if (source === undefined) return null;
  const nextId = uniqueId(`${id}_copy`, (candidate) =>
    isTaken(candidate) || files(project, kind).some((file) => file.path === libraryFilePath(kind, candidate)));
  const definition = structuredClone(source.definition);
  definition.id = nextId;
  return { path: libraryFilePath(kind, nextId), definition } as VisualFile;
}

export function removeVisualDocument(
  draft: EditorProject,
  kind: VisualKind,
  id: string,
): void {
  const file = findVisualFile(draft, kind, id);
  if (file === undefined) return;
  if (kind === "textBlock") {
    draft.text_blocks = (draft.text_blocks ?? []).filter((candidate) => candidate !== file);
    draft.manifest.text_blocks = (draft.manifest.text_blocks ?? []).filter((path) => path !== file.path);
    unpinTextBlock(draft, id);
  } else {
    draft.particles = (draft.particles ?? []).filter((candidate) => candidate !== file);
    draft.manifest.particles = (draft.manifest.particles ?? []).filter((path) => path !== file.path);
  }
}

/**
 * Rename one definition, its file path and every scene reference in a draft.
 * The caller validates the id first (`idUnavailableReason`).
 */
export function renameVisualDocument(
  draft: EditorProject,
  kind: VisualKind,
  previousId: string,
  nextId: string,
): void {
  const file = findVisualFile(draft, kind, previousId);
  if (file === undefined || previousId === nextId) return;
  const oldPath = file.path;
  const newPath = libraryFilePath(kind, nextId);
  file.definition.id = nextId;
  file.path = newPath;
  if (kind === "textBlock") {
    draft.manifest.text_blocks = (draft.manifest.text_blocks ?? []).map((path) => path === oldPath ? newPath : path);
    for (const scene of Object.values(draft.layout.scenes)) {
      const pins = scene.text_block_ids;
      if (pins?.includes(previousId) === true)
        scene.text_block_ids = [...new Set(pins.map((pin) => (pin === previousId ? nextId : pin)))];
    }
  } else {
    draft.manifest.particles = (draft.manifest.particles ?? []).map((path) => path === oldPath ? newPath : path);
  }
  for (const scene of draft.scenes) {
    for (const node of Object.values(scene.definition.nodes)) {
      if (kind === "particle") {
        if (node.type === "particle" && node.particle === previousId) node.particle = nextId;
        continue;
      }
      if (node.type === "sprite" && node.source?.type === "text" && node.source.text_block === previousId)
        node.source = { type: "text", text_block: nextId };
      if (node.type === "timeline") {
        for (const track of node.tracks) {
          if (track.type === "sprite" && track.source?.type === "text" && track.source.text_block === previousId)
            track.source = { type: "text", text_block: nextId };
        }
      }
    }
  }
}

// ---------------------------------------------------- Scene text organisation

/**
 * Text block ids a node actually uses: a Sprite's own source or the sources of
 * a timeline's sprite tracks.  The single matcher behind delete protection and
 * the scene grouping below.
 */
function nodeTextBlockIds(node: SceneNode): string[] {
  if (node.type === "sprite")
    return node.source?.type === "text" ? [node.source.text_block] : [];
  if (node.type !== "timeline") return [];
  const ids: string[] = [];
  for (const track of node.tracks)
    if (track.type === "sprite" && track.source?.type === "text")
      ids.push(track.source.text_block);
  return ids;
}

/** A text block used (or filed) by more than one scene. */
export interface SharedTextBlock {
  id: string;
  sceneIds: readonly string[];
}

/** Where every fixed text block is listed in the sidebar, exactly once. */
export interface TextBlockGroups {
  /** Every scene id to its own text ids, in definition order (maybe empty). */
  scenes: ReadonlyMap<string, readonly string[]>;
  /** Claimed by two or more scenes; still one definition. */
  shared: readonly SharedTextBlock[];
  /** Claimed by no scene, including after its only scene was deleted. */
  unassigned: readonly string[];
}

/**
 * Scenes that claim each text block: the union of the explicit pins in
 * `layout.scenes[id].text_block_ids` and the Sprite / timeline references in
 * the scene's real nodes.  Legacy projects therefore group themselves with no
 * migration edit, and pins to unknown scenes or unknown texts are ignored.
 */
function textBlockClaims(project: EditorProject): Map<string, string[]> {
  const known = new Set((project.text_blocks ?? []).map((file) => file.definition.id));
  const claims = new Map<string, string[]>();
  for (const scene of project.scenes) {
    const sceneId = scene.definition.id;
    const claimed = new Set<string>(project.layout.scenes[sceneId]?.text_block_ids ?? []);
    for (const node of Object.values(scene.definition.nodes))
      for (const id of nodeTextBlockIds(node)) claimed.add(id);
    for (const id of claimed) {
      if (!known.has(id)) continue;
      const owners = claims.get(id);
      if (owners === undefined) claims.set(id, [sceneId]);
      else owners.push(sceneId);
    }
  }
  return claims;
}

/** The scenes that list `id`, in project scene order. */
export function textBlockSceneIds(project: EditorProject, id: string): string[] {
  return textBlockClaims(project).get(id) ?? [];
}

export function textBlockGroups(project: EditorProject): TextBlockGroups {
  const claims = textBlockClaims(project);
  const scenes = new Map<string, string[]>(
    project.scenes.map((scene) => [scene.definition.id, []]),
  );
  const shared: SharedTextBlock[] = [];
  const unassigned: string[] = [];
  for (const { definition } of project.text_blocks ?? []) {
    const owners = claims.get(definition.id) ?? [];
    if (owners.length === 0) unassigned.push(definition.id);
    else if (owners.length === 1) scenes.get(owners[0])?.push(definition.id);
    else shared.push({ id: definition.id, sceneIds: owners });
  }
  return { scenes, shared, unassigned };
}

/** File a text block under a scene.  An unknown scene is a no-op. */
export function pinTextBlock(
  draft: EditorProject,
  sceneId: string,
  textBlockId: string,
): void {
  if (!draft.scenes.some((scene) => scene.definition.id === sceneId)) return;
  const layout = (draft.layout.scenes[sceneId] ??= { nodes: {}, viewport: null });
  const pins = (layout.text_block_ids ??= []);
  if (!pins.includes(textBlockId)) pins.push(textBlockId);
}

/**
 * Drop every pin of a text block.  Emptied lists are removed so an untouched
 * layout stays byte-identical on disk.
 */
export function unpinTextBlock(draft: EditorProject, textBlockId: string): void {
  for (const scene of Object.values(draft.layout.scenes)) {
    const pins = scene.text_block_ids;
    if (pins === undefined || !pins.includes(textBlockId)) continue;
    const rest = pins.filter((pin) => pin !== textBlockId);
    if (rest.length > 0) scene.text_block_ids = rest;
    else Reflect.deleteProperty(scene, "text_block_ids");
  }
}

/** First free `text_N` / `particle_N` suggestion for a create dialog. */
export function suggestVisualId(
  project: EditorProject,
  kind: VisualKind,
  isTaken: (id: string) => boolean,
): string {
  const base = kind === "textBlock" ? "text" : "particle";
  let index = files(project, kind).length + 1;
  while (isTaken(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}
