import type { AnimationMap } from "@vectspace/presentation-core/image-animation";
import type {
  AssetUrlMap,
  BootstrapPayload,
  SaveSlotSummary,
  Settings,
} from "@vectspace/presentation-core/types";
import {
  engineApi,
  resolvedAssetsToAnimations,
  resolvedAssetsToUrls,
} from "./api";

export interface InitialAppState {
  bootstrap: BootstrapPayload;
  settings: Settings;
  slots: SaveSlotSummary[];
  assets: AssetUrlMap;
  animations: AnimationMap;
}

let initialAppStatePromise: Promise<InitialAppState> | null = null;

/**
 * The main window's startup state, shared by every caller of this module so a
 * remount (React StrictMode) reuses one in-flight load instead of bootstrapping
 * the host twice. A failed load is forgotten and may be retried.
 */
export function getInitialAppState(): Promise<InitialAppState> {
  initialAppStatePromise ??= loadInitialAppState().catch((reason: unknown) => {
    initialAppStatePromise = null;
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
  return initialAppStatePromise;
}

async function loadInitialAppState(attempt = 1): Promise<InitialAppState> {
  try {
    return await withStartupTimeout(loadInitialAppStateAttempt(), 6_000);
  } catch (reason) {
    if (attempt >= 3) {
      throw reason;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, attempt * 250);
    });
    return loadInitialAppState(attempt + 1);
  }
}

async function loadInitialAppStateAttempt(): Promise<InitialAppState> {
  const [bootstrap, settings, slots] = await Promise.all([
    engineApi.bootstrap(),
    engineApi.loadSettings(),
    engineApi.listSaveSlots(),
  ]);
  const resolved = await engineApi.resolveAssets(bootstrap.asset_ids);
  return {
    bootstrap,
    settings,
    slots,
    assets: resolvedAssetsToUrls(resolved),
    animations: resolvedAssetsToAnimations(resolved),
  };
}

function withStartupTimeout<T>(
  promise: Promise<T>,
  durationMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("连接 Rust 运行时超时，正在重试")),
      durationMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (reason: unknown) => {
        window.clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}
