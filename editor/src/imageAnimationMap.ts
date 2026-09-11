import { assetUrl } from "./api";
import type { AnimationFile, EditorAsset, EditorProject } from "./types";
import type {
  AnimationMap,
  AnimationSource,
  ImageAssetSource,
} from "@vectspace/presentation-core/image-animation";
import { resolveImageAsset } from "@vectspace/presentation-core/image-animation";

interface AnimationDocumentLike {
  id: string;
  frames: { asset: string; duration_ms: number }[];
}

/**
 * Builds the frame lists the editor preview renders.
 *
 * The preview is keyed by *asset id* (that is what scenes reference), while the
 * frames themselves live in a separate animation document; this joins the two
 * the same way the host payload does for the game.  A missing document or a
 * missing frame image simply yields no entry, so a broken draft cannot break
 * previewing the rest of the scene.
 */
export function buildAnimationMap(
  assets: EditorAsset[],
  animations: AnimationFile[] | undefined,
): AnimationMap {
  if (animations === undefined || animations.length === 0) return {};
  const urls = new Map<string, string>();
  const sizes = new Map<string, { width: number; height: number }>();
  for (const asset of assets) {
    urls.set(asset.id, assetUrl(asset.absolute_path));
    const width = asset.metadata?.width;
    const height = asset.metadata?.height;
    if (typeof width === "number" && typeof height === "number") {
      sizes.set(asset.id, { width, height });
    }
  }
  const documents = new Map<string, AnimationDocumentLike>();
  for (const file of animations) {
    documents.set(file.definition.id, file.definition);
  }
  const map: Record<string, AnimationSource> = {};
  for (const asset of assets) {
    const documentId = asset.animation;
    if (documentId === null || documentId === undefined) continue;
    const document = documents.get(documentId);
    if (document === undefined || document.frames.length === 0) continue;
    const frames = document.frames.flatMap((frame) => {
      const url = urls.get(frame.asset);
      if (url === undefined) return [];
      return [{ asset: frame.asset, duration_ms: frame.duration_ms, url }];
    });
    if (frames.length === 0) continue;
    // Every frame shares one pixel size, so the first resolvable frame defines
    // the layout box for the whole loop.
    const first = frames[0];
    const size = sizes.get(first?.asset ?? "") ??
      sizes.get(asset.id) ?? { width: 0, height: 0 };
    map[asset.id] = {
      id: document.id,
      width: size.width,
      height: size.height,
      total_duration_ms: frames.reduce(
        (total, frame) => total + frame.duration_ms,
        0,
      ),
      frames,
    };
  }
  return map;
}

/** Convenience wrapper for a whole editor project payload. */
export function projectAnimationMap(project: EditorProject): AnimationMap {
  return buildAnimationMap(project.assets, project.animations);
}

/** Resolve one editor asset through the same static/animated source shape used
 * by the game. Workspaces use this instead of reading `absolute_path` directly
 * so animated assets cannot silently degrade to their first frame. */
export function editorImageSource(
  asset: EditorAsset | undefined,
  assets: readonly EditorAsset[],
  animationMap: AnimationMap,
): ImageAssetSource | undefined {
  if (asset === undefined) return undefined;
  const urls = Object.fromEntries(
    assets.map((candidate) => [
      candidate.id,
      assetUrl(candidate.absolute_path),
    ]),
  );
  return resolveImageAsset(asset.id, urls, animationMap);
}
