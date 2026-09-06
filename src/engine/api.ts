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
  StoryFlowSnapshot,
} from "./types";
import type { WireU64 } from "../../shared/generated/WireU64";
import { toCommandError } from "../../shared/commandError";

async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw toCommandError(error);
  }
}

export const engineApi = {
  bootstrap: () => command<BootstrapPayload>("bootstrap"),
  startNewGame: () => command<RuntimeUpdate>("start_new_game"),
  advance: (expectedRevision: WireU64, source: AdvanceSource) =>
    command<RuntimeUpdate>("advance", { expectedRevision, source }),
  choose: (choiceId: string, expectedRevision: WireU64) =>
    command<RuntimeUpdate>("choose", { choiceId, expectedRevision }),
  presentationComplete: (updateId: WireU64, outcome: PresentationOutcome) =>
    command<RuntimeUpdate>("presentation_complete", { updateId, outcome }),
  getSnapshot: () => command<RuntimeSnapshot>("get_snapshot"),
  getDialogueHistory: () =>
    command<DialogueHistoryEntry[]>("get_dialogue_history"),
  getStoryFlow: () => command<StoryFlowSnapshot | null>("get_story_flow"),
  resolveAssets: (assetIds: string[]) =>
    command<ResolvedAsset[]>("resolve_assets", { assetIds }),
  listSaveSlots: () => command<SaveSlotSummary[]>("list_save_slots"),
  saveSlot: (slot: string, thumbnailDataUrl: string | null) =>
    command<SaveSlotSummary>("save_slot", {
      request: { slot, thumbnail_data_url: thumbnailDataUrl },
    }),
  loadSlot: (slot: string) => command<RuntimeUpdate>("load_slot", { slot }),
  loadSettings: () => command<Settings>("load_settings"),
  saveSettings: (settings: Settings) =>
    command<Settings>("save_settings", { settings }),
};

export function resolvedAssetsToUrls(
  assets: ResolvedAsset[],
): Record<string, string> {
  return Object.fromEntries(
    assets.map((asset) => [asset.id, convertFileSrc(asset.absolute_path)]),
  );
}
