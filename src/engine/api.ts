import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type {
  BootstrapPayload,
  DialogueHistoryEntry,
  AdvanceSource,
  ResolvedAsset,
  RuntimeSnapshot,
  RuntimeUpdate,
  SaveSlotSummary,
  Settings,
  PresentationOutcome,
  ChapterMapSnapshot,
} from "./types";
import type { WireU64 } from "../../shared/generated/WireU64";
import type { AnimationSource } from "@vectspace/presentation-core/image-animation";
import { toCommandError } from "../../shared/commandError";

async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    // Rust deliberately keeps scalar and u64 values in lossless wire form.
    // Decode the tagged scalar values once at the transport boundary so the
    // game/presentation code only sees domain values (not `{ kind, value }`
    // transport envelopes).  The recursive walk is safe for RuntimeUpdate
    // cues because no cue payload uses this exact two-key scalar shape.
    return decodeWireValue(await invoke<unknown>(name, args)) as T;
  } catch (error) {
    throw toCommandError(error);
  }
}

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function decodeWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWireValue);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length === 2 &&
    typeof record.kind === "string" &&
    Object.prototype.hasOwnProperty.call(record, "value")
  ) {
    switch (record.kind) {
      case "boolean":
        if (typeof record.value !== "boolean")
          throw new Error("wire boolean 必须是布尔值");
        return record.value;
      case "string":
        if (typeof record.value !== "string")
          throw new Error("wire string 必须是字符串");
        return record.value;
      case "number":
        if (typeof record.value !== "number" || !Number.isFinite(record.value))
          throw new Error("wire number 必须是有限数字");
        return record.value;
      case "integer": {
        if (
          typeof record.value !== "string" ||
          !/^(?:0|-?[1-9][0-9]*)$/.test(record.value)
        )
          throw new Error("wire integer 必须是规范十进制字符串");
        const integer = BigInt(record.value);
        if (integer < I64_MIN || integer > I64_MAX)
          throw new Error("wire integer 超出 i64 范围");
        return integer;
      }
      default:
        break;
    }
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [key, decodeWireValue(child)]),
  );
}

export const engineApi = {
  bootstrap: () => command<BootstrapPayload>("bootstrap"),
  startNewGame: (expectedSessionId: WireU64) =>
    command<RuntimeUpdate>("start_new_game", {
      expectedSessionId,
    }),
  advance: (
    expectedRevision: WireU64,
    source: AdvanceSource,
    expectedSessionId: WireU64,
  ) =>
    command<RuntimeUpdate>("advance", {
      expectedRevision,
      source,
      expectedSessionId,
    }),
  choose: (
    choiceId: string,
    expectedRevision: WireU64,
    expectedSessionId: WireU64,
  ) =>
    command<RuntimeUpdate>("choose", {
      choiceId,
      expectedRevision,
      expectedSessionId,
    }),
  clickButton: (
    instanceId: string,
    expectedRevision: WireU64,
    expectedSessionId: WireU64,
  ) =>
    command<RuntimeUpdate>("click_button", {
      instanceId,
      expectedRevision,
      expectedSessionId,
    }),
  presentationComplete: (
    updateId: WireU64,
    outcome: PresentationOutcome,
    expectedSessionId: WireU64,
  ) =>
    command<RuntimeUpdate>("presentation_complete", {
      updateId,
      outcome,
      expectedSessionId,
    }),
  getSnapshot: () => command<RuntimeSnapshot>("get_snapshot"),
  getDialogueHistory: () =>
    command<DialogueHistoryEntry[]>("get_dialogue_history"),
  clearDialogueHistory: (expectedSessionId: WireU64) =>
    command<unknown>("clear_dialogue_history", {
      expectedSessionId,
    }),
  getChapterMap: () => command<ChapterMapSnapshot | null>("get_chapter_map"),
  startSceneReplay: (sceneId: string, expectedSessionId: WireU64) =>
    command<RuntimeUpdate>("start_scene_replay", {
      sceneId,
      expectedSessionId,
    }),
  exitSceneReplay: (expectedSessionId: WireU64) =>
    command<WireU64>("exit_scene_replay", {
      expectedSessionId,
    }),
  invalidateSession: (expectedSessionId: WireU64) =>
    command<WireU64>("invalidate_session", {
      expectedSessionId,
    }),
  resolveAssets: (assetIds: string[]) =>
    command<ResolvedAsset[]>("resolve_assets", { assetIds }),
  listSaveSlots: () => command<SaveSlotSummary[]>("list_save_slots"),
  saveSlot: (
    slot: string,
    thumbnailDataUrl: string | null,
    expectedSessionId: WireU64,
  ) =>
    command<SaveSlotSummary>("save_slot", {
      request: { slot, thumbnail_data_url: thumbnailDataUrl },
      expectedSessionId,
    }),
  loadSlot: (slot: string, expectedSessionId: WireU64) =>
    command<RuntimeUpdate>("load_slot", {
      slot,
      expectedSessionId,
    }),
  loadSettings: () => command<Settings>("load_settings"),
  saveSettings: (settings: Settings) =>
    command<Settings>("save_settings", { settings }),
  // -- secondary window -----------------------------------------------------
  // The host routes by the WebView label it assigned, so these are gameplay
  // only: the secondary has no save, settings, history, chapter-map or replay
  // transport at all.
  secondaryBootstrap: () => command<BootstrapPayload>("secondary_bootstrap"),
  secondarySnapshot: () => command<RuntimeSnapshot>("secondary_snapshot"),
  secondaryAdvance: (
    expectedRevision: WireU64,
    source: AdvanceSource,
    expectedSessionId: WireU64,
  ) =>
    command<RuntimeUpdate>("secondary_advance", {
      expectedRevision,
      source,
      expectedSessionId,
    }),
  secondaryChoose: (
    choiceId: string,
    expectedRevision: WireU64,
    expectedSessionId: WireU64,
  ) =>
    command<RuntimeUpdate>("secondary_choose", {
      choiceId,
      expectedRevision,
      expectedSessionId,
    }),
  secondaryClickButton: (
    instanceId: string,
    expectedRevision: WireU64,
    expectedSessionId: WireU64,
  ) =>
    command<RuntimeUpdate>("secondary_click_button", {
      instanceId,
      expectedRevision,
      expectedSessionId,
    }),
  secondaryPresentationComplete: (
    updateId: WireU64,
    outcome: PresentationOutcome,
    expectedSessionId: WireU64,
  ) =>
    command<RuntimeUpdate>("secondary_presentation_complete", {
      updateId,
      outcome,
      expectedSessionId,
    }),
};

export function resolvedAssetsToUrls(
  assets: ResolvedAsset[],
): Record<string, string> {
  return Object.fromEntries(
    assets.map((asset) => [asset.id, convertFileSrc(asset.absolute_path)]),
  );
}

/**
 * Frame lists for every animated asset, keyed by logical asset id.
 *
 * A static asset is deliberately absent: the shared image resolver falls back
 * to the plain url map, so nothing about existing content changes.
 */
export function resolvedAssetsToAnimations(
  assets: ResolvedAsset[],
): Record<string, AnimationSource> {
  const animations: Record<string, AnimationSource> = {};
  for (const asset of assets) {
    const animation = asset.animation;
    if (animation == null || animation.frames.length === 0) continue;
    animations[asset.id] = {
      id: animation.id,
      width: animation.width,
      height: animation.height,
      total_duration_ms: animation.total_duration_ms,
      frames: animation.frames.map((frame) => ({
        asset: frame.asset,
        duration_ms: frame.duration_ms,
        url: convertFileSrc(frame.absolute_path),
      })),
    };
  }
  return animations;
}
