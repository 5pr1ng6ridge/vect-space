import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type {
  BootstrapPayload,
  AdvanceSource,
  ResolvedAsset,
  RuntimeSnapshot,
  RuntimeUpdate,
  SaveSlotSummary,
  Settings,
  PresentationOutcome,
} from "./types";

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function command<T>(
  name: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (error) {
    throw new Error(messageFrom(error));
  }
}

export const engineApi = {
  bootstrap: () => command<BootstrapPayload>("bootstrap"),
  startNewGame: () => command<RuntimeUpdate>("start_new_game"),
  advance: (expectedRevision: number, source: AdvanceSource) =>
    command<RuntimeUpdate>("advance", { expectedRevision, source }),
  choose: (choiceId: string, expectedRevision: number) =>
    command<RuntimeUpdate>("choose", { choiceId, expectedRevision }),
  presentationComplete: (updateId: number, outcome: PresentationOutcome) =>
    command<RuntimeUpdate>("presentation_complete", { updateId, outcome }),
  getSnapshot: () => command<RuntimeSnapshot>("get_snapshot"),
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
