import type {
  AnimationFile,
  AnimationFrame,
  AssetKind,
  EditorAsset,
  ImageAnimationDefinition,
} from "./types";

/**
 * Editor-side mirror of the Rust image-animation rules
 * (`crates/vectspace-core/src/content.rs`).  The panel and the live validator
 * share these constants so an author sees the same limits before a save
 * round-trip; Rust remains the authority and re-checks everything it receives.
 */
export const IMAGE_ANIMATION_SCHEMA_VERSION = 1;
export const IMAGE_ANIMATION_MAX_FRAMES = 512;
export const IMAGE_ANIMATION_MIN_FRAME_MS = 1;
export const IMAGE_ANIMATION_MAX_FRAME_MS = 60_000;
export const IMAGE_ANIMATION_MAX_DECODED_BYTES = 256 * 1024 * 1024;
const IMAGE_ANIMATION_MAX_EDGE = 8192;

/** Default frame hold used by 「创建帧动画」 until the author overrides it. */
export const DEFAULT_FRAME_DURATION_MS = 100;

/** Image kinds a frame may reference. */
export const ANIMATION_FRAME_KINDS: readonly AssetKind[] = [
  "background",
  "sprite",
  "gui",
];

/**
 * The single identifier rule used by every editable id in the project
 * (`validate_identifier` in Rust: non-empty, at most 128 characters, ASCII
 * letters/digits/dot/underscore/hyphen).  A leading digit is legal.
 */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function isFrameAssetKind(kind: AssetKind): boolean {
  return ANIMATION_FRAME_KINDS.includes(kind);
}

/** Static image assets that may become a frame: image kind, no animation. */
export function frameCandidates(assets: readonly EditorAsset[]): EditorAsset[] {
  return assets.filter(
    (asset) => isFrameAssetKind(asset.kind) && !asset.animation,
  );
}

/** Document path of one animation file, mirroring the ui-motion convention. */
export function animationFilePath(id: string): string {
  return `animations/${id.replaceAll(".", "_")}.yaml`;
}

export function animationSourceId(
  assetId: string,
  animations: readonly AnimationFile[],
): AnimationFile | undefined {
  return animations.find((file) => file.definition.id === assetId);
}

const naturalCollator = new Intl.Collator(["en"], {
  numeric: true,
  sensitivity: "base",
});

/**
 * File-name natural ordering: `blink2.png` sorts before `blink10.png`, which a
 * plain code-unit comparison would invert.  Case-insensitive ties fall back to
 * a deterministic code-unit comparison so the same list always has one order.
 */
function naturalCompare(left: string, right: string): number {
  const primary = naturalCollator.compare(left, right);
  if (primary !== 0) return primary;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sort key of one frame candidate: its file name, or its logical id. */
export function frameSortKey(asset: EditorAsset): string {
  const path = asset.path ?? "";
  const name = path.split(/[\\/]/).at(-1);
  return name === undefined || name === "" ? asset.id : name;
}

export function naturalSortFrameAssets(
  assets: readonly EditorAsset[],
): EditorAsset[] {
  return [...assets].sort((left, right) =>
    naturalCompare(frameSortKey(left), frameSortKey(right)),
  );
}

/** Reorders a frame id list by the file names of the assets behind it. */
export function naturalSortFrameIds(
  ids: readonly string[],
  byId: ReadonlyMap<string, EditorAsset>,
): string[] {
  return [...ids].sort((left, right) => {
    const leftKey = byId.get(left);
    const rightKey = byId.get(right);
    return naturalCompare(
      leftKey === undefined ? left : frameSortKey(leftKey),
      rightKey === undefined ? right : frameSortKey(rightKey),
    );
  });
}

/** Derives a legal, unused default id from one frame's file name. */
export function deriveAnimationId(
  asset: EditorAsset | undefined,
  taken: ReadonlySet<string>,
): string {
  const raw = asset === undefined ? "animation" : stemOf(frameSortKey(asset));
  const base = sanitizeIdentifier(raw) || "animation";
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Same rule for the logical asset that carries `animation: <id>`. */
export function deriveAnimationAssetId(
  animationId: string,
  taken: ReadonlySet<string>,
): string {
  const base = sanitizeIdentifier(`anim.${animationId}`) || "anim.animation";
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function stemOf(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, "");
  return stem === "" ? fileName : stem;
}

function sanitizeIdentifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return IDENTIFIER_PATTERN.test(cleaned) ? cleaned : "";
}

export function totalDurationMs(frames: readonly AnimationFrame[]): number {
  return frames.reduce((total, frame) => total + frame.duration_ms, 0);
}

export interface AnimationDraft {
  /** Animation document id. */
  id: string;
  /** Logical asset id that resolves to this animation. */
  assetId: string;
  kind: AssetKind;
  frames: AnimationFrame[];
}

interface AnimationDraftValidation {
  errors: string[];
  warnings: string[];
}

interface AnimationDraftContext {
  existingAssetIds: ReadonlySet<string>;
  existingAnimationIds: ReadonlySet<string>;
  existingAnimationPaths: ReadonlySet<string>;
  /** Metadata per frame asset id; `undefined` entries are unknown sizes. */
  sizeOf(assetId: string): { width: number; height: number } | undefined;
}

/**
 * Everything the panel must report *before* a save round-trip: id legality and
 * collisions, frame count, per-frame duration bounds, uniform frame geometry
 * and the decoded memory budget.
 */
export function validateAnimationDraft(
  draft: AnimationDraft,
  context: AnimationDraftContext,
): AnimationDraftValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!IDENTIFIER_PATTERN.test(draft.id)) {
    errors.push(
      "动画 ID 只能使用字母、数字、点、下划线或连字符（1–128 字符）。",
    );
  } else if (context.existingAnimationIds.has(draft.id)) {
    errors.push(`动画 ID ${draft.id} 已经存在。`);
  } else if (context.existingAssetIds.has(draft.id)) {
    errors.push(
      `动画 ID ${draft.id} 与素材 ID 冲突：动画 ID 必须独立于素材命名空间。`,
    );
  }
  if (!IDENTIFIER_PATTERN.test(draft.assetId)) {
    errors.push(
      "素材 ID 只能使用字母、数字、点、下划线或连字符（1–128 字符）。",
    );
  } else if (context.existingAssetIds.has(draft.assetId)) {
    errors.push(`素材 ID ${draft.assetId} 已经存在。`);
  }
  if (
    IDENTIFIER_PATTERN.test(draft.id) &&
    context.existingAnimationPaths.has(animationFilePath(draft.id))
  ) {
    errors.push(`动画文件路径 ${animationFilePath(draft.id)} 已经存在。`);
  }
  if (!isFrameAssetKind(draft.kind)) {
    errors.push("动画素材类型只能是 background、sprite 或 gui。");
  }
  if (draft.frames.length === 0) {
    errors.push("至少需要选择一帧图片。");
  }
  if (draft.frames.length > IMAGE_ANIMATION_MAX_FRAMES) {
    errors.push(
      `帧数 ${draft.frames.length} 超过上限 ${IMAGE_ANIMATION_MAX_FRAMES}。`,
    );
  }
  let shared: { width: number; height: number } | undefined;
  let firstFrameLabel = "";
  let unknown = 0;
  const decoded = new Set<string>();
  let decodedBytes = 0;
  for (const [index, frame] of draft.frames.entries()) {
    const position = index + 1;
    if (
      !Number.isInteger(frame.duration_ms) ||
      frame.duration_ms < IMAGE_ANIMATION_MIN_FRAME_MS ||
      frame.duration_ms > IMAGE_ANIMATION_MAX_FRAME_MS
    ) {
      errors.push(
        `第 ${position} 帧时长 ${frame.duration_ms}ms 必须在 ${IMAGE_ANIMATION_MIN_FRAME_MS}–${IMAGE_ANIMATION_MAX_FRAME_MS}ms 之间。`,
      );
    }
    const size = context.sizeOf(frame.asset);
    if (size === undefined) {
      unknown += 1;
      continue;
    }
    if (
      size.width > IMAGE_ANIMATION_MAX_EDGE ||
      size.height > IMAGE_ANIMATION_MAX_EDGE
    ) {
      errors.push(
        `第 ${position} 帧尺寸 ${size.width}×${size.height} 超过单边上限 ${IMAGE_ANIMATION_MAX_EDGE}。`,
      );
    }
    if (shared === undefined) {
      shared = size;
      firstFrameLabel = `第 ${position} 帧`;
    } else if (shared.width !== size.width || shared.height !== size.height) {
      errors.push(
        `第 ${position} 帧尺寸 ${size.width}×${size.height} 与${firstFrameLabel} ${shared.width}×${shared.height} 不一致。`,
      );
    }
    if (!decoded.has(frame.asset)) {
      decoded.add(frame.asset);
      decodedBytes += size.width * size.height * 4;
    }
  }
  if (unknown > 0) {
    warnings.push(
      `有 ${unknown} 帧缺少像素尺寸信息，保存时由宿主检查尺寸一致性。`,
    );
  }
  if (decodedBytes > IMAGE_ANIMATION_MAX_DECODED_BYTES) {
    errors.push(
      `解码内存 ${Math.floor(decodedBytes / (1024 * 1024))} MiB 超过预算 ${IMAGE_ANIMATION_MAX_DECODED_BYTES / (1024 * 1024)} MiB：请减少帧数或降低分辨率。`,
    );
  }
  return { errors, warnings };
}

export function animationDefinition(
  draft: AnimationDraft,
): ImageAnimationDefinition {
  return {
    schema_version: IMAGE_ANIMATION_SCHEMA_VERSION,
    id: draft.id,
    frames: draft.frames.map((frame) => ({
      asset: frame.asset,
      duration_ms: frame.duration_ms,
    })),
  };
}
