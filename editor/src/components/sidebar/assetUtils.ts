import { assetUrl } from "../../api";
import { animationSourceId } from "../../imageAnimation";
import type { AssetFolderNode } from "../../assetLibrary";
import type {
  AnimationFile,
  AssetKind,
  ContentManifest,
  EditorAsset,
  EditorLayout,
  AssetInspection,
  AssetMetadata,
} from "../../types";
import type { AssetFolderChoice } from "./types";

/** Flat folder list (id + display path) for folder selects. */
export function findFolderNode(
  nodes: readonly AssetFolderNode[],
  id: string,
): AssetFolderNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findFolderNode(node.children, id);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function flattenAssetFolders(layout: EditorLayout): AssetFolderChoice[] {
  const folders = layout.asset_folders ?? {};
  const pathOf = (id: string): string[] => {
    const seen = new Set<string>();
    const names: string[] = [];
    let current: string | null = id;
    while (current !== null && !seen.has(current)) {
      const folder: { parent_id: string | null; name: string } | undefined =
        folders[current];
      if (folder === undefined) break;
      seen.add(current);
      names.unshift(folder.name);
      current = folder.parent_id ?? null;
    }
    return names;
  };
  return Object.keys(folders)
    .map((id) => ({ id, path: pathOf(id).join(" / ") }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function readAssetDragPayload(event: {
  dataTransfer: DataTransfer | null;
}): {
  assetId?: string;
  assetIds?: string[];
  folderId?: string;
} {
  const data = event.dataTransfer;
  if (data === null || data === undefined) return {};
  const assetId = data.getData("application/x-vect-asset");
  const folderId = data.getData("application/x-vect-folder");
  let assetIds: string[] | undefined;
  try {
    const parsed: unknown = JSON.parse(
      data.getData("application/x-vect-assets"),
    );
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((id) => typeof id === "string")
    ) {
      assetIds = parsed.filter((id) => id === assetId);
      // Only accept a multi-drag that includes its actual drag origin.
      if (assetIds.length !== 1) assetIds = undefined;
      else assetIds = parsed;
    }
  } catch {
    /* Old single-item payload. */
  }
  return {
    assetId: assetId === "" ? undefined : assetId,
    assetIds,
    folderId: folderId === "" ? undefined : folderId,
  };
}

/**
 * Actual container format families.  The host re-decodes the upload and
 * rejects a mismatch; this map is the editor's friendly pre-check so the
 * dialog can explain the problem before staging anything.
 */
const EXTENSION_FAMILIES: Record<string, string> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
  ogg: "ogg",
  wav: "wav",
  mp3: "mp3",
  flac: "flac",
  mp4: "mp4",
  ttf: "font",
  otf: "font",
};

export function extensionFamily(fileNameOrPath: string): string {
  const extension = fileNameOrPath.split(".").at(-1)?.toLowerCase() ?? "";
  return EXTENSION_FAMILIES[extension] ?? extension;
}

/** Case-insensitive comparison key for an asset-relative path. */
export function collisionKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/**
 * A replacement must never target the current registration, the original
 * on-disk binary, or any earlier staged replacement path.  The host reserves
 * all of them, so the picker pre-checks the same set and suggests a free name.
 */
export function replacementError(
  asset: EditorAsset,
  fileName: string,
  inspection: AssetInspection | undefined,
  forbidden: ReadonlySet<string>,
): string | undefined {
  const errors: string[] = [];
  const currentPath = asset.path ?? "";
  const destination = `${assetFolder(asset.kind)}/${fileName}`;
  const destinationKey = collisionKey(destination);
  if (collisionKey(currentPath) === destinationKey)
    errors.push("新文件路径必须与当前登记路径不同。");
  else if (forbidden.has(destinationKey))
    errors.push(
      "该目标路径已被原始文件或先前暂存的替换保留，请改用新的文件名（例如加 _v2）。",
    );
  if (!supportedImportExtension(asset.kind, fileName))
    errors.push("文件扩展名与素材类型不匹配。");
  else if (extensionFamily(fileName) !== extensionFamily(currentPath))
    errors.push(
      `新文件必须与旧文件格式一致（当前：${currentPath.split(".").at(-1) ?? "?"}）。`,
    );
  const inspectionError = inspection?.diagnostics
    .filter((diagnostic) => diagnostic.severity === "error")
    .map((diagnostic) => diagnostic.message)
    .join("；");
  if (inspectionError !== undefined && inspectionError !== "")
    errors.push(inspectionError);
  return errors.length > 0 ? errors.join("；") : undefined;
}

/** First free `stem_vN.ext` name for a replacement destination. */
export function suggestReplacementFileName(
  asset: EditorAsset,
  preferred: string,
  forbidden: ReadonlySet<string>,
): string {
  const folder = assetFolder(asset.kind);
  const dot = preferred.lastIndexOf(".");
  const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
  const extension = dot > 0 ? preferred.slice(dot) : "";
  let candidate = preferred;
  let index = 2;
  while (
    forbidden.has(collisionKey(`${folder}/${candidate}`)) &&
    index <= 999
  ) {
    candidate = `${stem}_v${index}${extension}`;
    index += 1;
  }
  return candidate;
}

export const ASSET_KINDS: AssetKind[] = [
  "background",
  "sprite",
  "gui",
  "bgm",
  "ambience",
  "sfx",
  "video",
  "font",
];

export function inferAssetKind(fileName: string): AssetKind {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const stem = fileName
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.[^.]+$/, "")
    .toLowerCase();
  const tokens = stem?.split(/[^a-z0-9]+/).filter(Boolean) ?? [];
  // Audio containers do not encode their authored role.  Keep the historic
  // SFX fallback, but recognize the explicit ambience naming convention so a
  // file such as ambience.forest.ogg enters the import queue with the right
  // initial kind.
  if (tokens.some((token) => token === "ambience" || token === "ambient"))
    return "ambience";
  if (["ttf", "otf"].includes(extension)) return "font";
  // The runtime currently guarantees MP4/H.264 playback.  Do not classify
  // WebM/MOV as video only to make the later staged-import validation fail.
  if (extension === "mp4") return "video";
  if (["ogg", "wav", "mp3", "flac"].includes(extension)) return "sfx";
  return "background";
}

export function assetFolder(kind: AssetKind): string {
  switch (kind) {
    case "background":
      return "backgrounds";
    case "sprite":
      return "sprites";
    case "gui":
      return "gui";
    case "bgm":
    case "ambience":
    case "sfx":
      return "audio";
    case "video":
      return "videos";
    case "font":
      return "fonts";
  }
}

export function supportedImportExtension(
  kind: AssetKind,
  fileName: string,
): boolean {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  const allowed: Record<AssetKind, string[]> = {
    background: ["png", "jpg", "jpeg", "webp"],
    sprite: ["png", "jpg", "jpeg", "webp"],
    gui: ["png", "jpg", "jpeg", "webp"],
    bgm: ["ogg", "wav", "mp3", "flac"],
    ambience: ["ogg", "wav", "mp3", "flac"],
    sfx: ["ogg", "wav", "mp3", "flac"],
    video: ["mp4"],
    font: ["ttf", "otf"],
  };
  return allowed[kind].includes(extension);
}

export function formatAssetSize(
  size: string | number | bigint | undefined,
): string {
  if (size === undefined) return "大小未知";
  try {
    const bytes =
      typeof size === "string"
        ? BigInt(size)
        : typeof size === "bigint"
          ? size
          : Number.isFinite(size) && size >= 0
            ? BigInt(Math.trunc(size))
            : null;
    if (bytes === null || bytes < 0n) return "大小未知";
    if (bytes < 1024n) return `${bytes} B`;
    if (bytes < 1024n * 1024n)
      return `${(Number(bytes) / 1024).toFixed(1)} KiB`;
    return `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;
  } catch {
    return "大小未知";
  }
}

export function formatInspectionSize(size: string): string {
  try {
    const bytes = BigInt(size);
    if (bytes < 1024n) return `${bytes} B`;
    if (bytes < 1024n * 1024n)
      return `${(Number(bytes) / 1024).toFixed(1)} KiB`;
    return `${(Number(bytes) / (1024 * 1024)).toFixed(1)} MiB`;
  } catch {
    return "大小未知";
  }
}

export function formatAssetMetadata(
  metadata: AssetMetadata | null | undefined,
): string {
  if (metadata === null || metadata === undefined) return "规格未知";
  const dimensions =
    metadata.width !== null &&
    metadata.width !== undefined &&
    metadata.height !== null &&
    metadata.height !== undefined
      ? `${metadata.width}×${metadata.height}px`
      : null;
  const duration =
    metadata.duration_ms !== null && metadata.duration_ms !== undefined
      ? `${formatDurationMs(metadata.duration_ms)}s`
      : null;
  const audio =
    metadata.sample_rate !== null && metadata.sample_rate !== undefined
      ? `${metadata.sample_rate}Hz${metadata.channels === null || metadata.channels === undefined ? "" : `/${metadata.channels}ch`}`
      : null;
  const font = metadata.font_family ?? null;
  return (
    [dimensions, duration, audio, font].filter(Boolean).join(" · ") ||
    "规格未知"
  );
}

function formatDurationMs(value: bigint | number | string): string {
  if (typeof value === "string") {
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return "?";
    try {
      return formatDurationMs(BigInt(value));
    } catch {
      return "?";
    }
  }
  if (typeof value === "bigint") {
    if (value < 0n) return "?";
    const seconds = value / 1000n;
    const hundredths = (value % 1000n) / 10n;
    return `${seconds.toString()}.${hundredths.toString().padStart(2, "0")}`;
  }
  return Number.isFinite(value) && value >= 0 ? (value / 1000).toFixed(2) : "?";
}

export function uniqueAssetId(
  stem: string,
  kind: AssetKind,
  assets: EditorAsset[],
): string {
  const prefix =
    kind === "background"
      ? "bg"
      : kind === "sprite"
        ? "sprite"
        : kind === "gui"
          ? "gui"
          : kind;
  const base = `${prefix}.${
    stem
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "_")
      .replace(/^\.+|\.+$/g, "") || "new"
  }`;
  const used = new Set(assets.map((asset) => asset.id));
  if (!used.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const candidate = `${base}_${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Human label for the small list line: static path or animation reference. */
export function assetDescription(
  asset: EditorAsset,
  manifest: ContentManifest,
): string {
  const declared = manifest.assets[asset.id];
  if (asset.animation !== undefined) return `动画 ${asset.animation}`;
  return declared?.path ?? asset.path ?? "（未登记路径）";
}

export function assetSize(
  asset: EditorAsset,
): { width: number; height: number } | undefined {
  const metadata = asset.metadata;
  if (metadata === undefined || metadata === null) return undefined;
  if (metadata.width === null || metadata.height === null) return undefined;
  return { width: metadata.width, height: metadata.height };
}

/** Resolved frames of one animation document, in document order. */
export function previewFramesFor(
  file: AnimationFile,
  assets: readonly EditorAsset[],
): { asset: string; url: string; duration_ms: number }[] {
  return file.definition.frames.map((frame) => ({
    asset: frame.asset,
    url: assetUrl(
      assets.find((candidate) => candidate.id === frame.asset)?.absolute_path ??
        "",
    ),
    duration_ms: frame.duration_ms,
  }));
}

export function animationSummary(
  asset: EditorAsset,
  assets: readonly EditorAsset[],
  animations: readonly AnimationFile[],
): string {
  const file = animationSourceId(asset.animation ?? "", animations);
  if (file === undefined) return "动画描述文件缺失，保存前请修正。";
  const frames = file.definition.frames;
  const seen = new Set<string>();
  let decoded = 0;
  for (const frame of frames) {
    if (seen.has(frame.asset)) continue;
    seen.add(frame.asset);
    const size = assetSize(
      assets.find((candidate) => candidate.id === frame.asset) ?? asset,
    );
    if (size !== undefined) decoded += size.width * size.height * 4;
  }
  const size = assetSize(asset);
  return `${frames.length} 帧 · 总时长 ${frames.reduce((sum, frame) => sum + frame.duration_ms, 0)} ms · ${
    size === undefined ? "尺寸未知" : `${size.width} × ${size.height}`
  } · 解码约 ${Math.round(decoded / (1024 * 1024))} MiB`;
}
