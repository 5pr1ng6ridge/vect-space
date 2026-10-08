/**
 * Bounded waits on a `<video>` element for `TimelineSession`: metadata, seek
 * and presented-frame settling, each abortable and each releasing its listeners
 * on every exit path.
 */

/** Diagnostic bound for a scrub seek on the media element. */
export const VIDEO_SCRUB_TIMEOUT_MS = 2_000;
const VIDEO_METADATA_TIMEOUT_MS = 15_000;
export const VIDEO_LOAD_SEEK_TIMEOUT_MS = 8_000;
const PRESENTED_FRAME_TIMEOUT_MS = 250;

export function releaseElement(element: HTMLVideoElement): void {
  element.removeAttribute("src");
  element.load();
}

export function waitForVideoMetadata(
  element: HTMLVideoElement,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
    return Promise.resolve();
  }
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        element.removeEventListener("loadedmetadata", loaded);
        element.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const loaded = (): void => {
        cleanup();
        resolve();
      };
      const failed = (): void => {
        cleanup();
        reject(new Error(videoErrorMessage(element, "视频元数据加载失败")));
      };
      const aborted = (): void => {
        cleanup();
        resolve();
      };
      element.addEventListener("loadedmetadata", loaded, { once: true });
      element.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      element.load();
    }),
    VIDEO_METADATA_TIMEOUT_MS,
    "视频元数据加载超时",
  );
}

export function seekElement(
  element: HTMLVideoElement,
  targetSeconds: number,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  const target = Math.max(0, targetSeconds);
  if (signal.aborted) return Promise.resolve();
  if (Math.abs(element.currentTime - target) < 0.001) return Promise.resolve();
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        element.removeEventListener("seeked", seeked);
        element.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
      };
      const seeked = (): void => {
        cleanup();
        resolve();
      };
      const failed = (): void => {
        cleanup();
        reject(new Error(videoErrorMessage(element, "视频定位失败")));
      };
      const aborted = (): void => {
        cleanup();
        resolve();
      };
      element.addEventListener("seeked", seeked, { once: true });
      element.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      element.currentTime = target;
    }),
    timeoutMs,
    "视频定位超时",
  );
}

export function waitForPresentedFrame(
  element: HTMLVideoElement,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  if (typeof element.requestVideoFrameCallback === "function") {
    return withTimeout(
      new Promise<void>((resolve) => {
        let handle = 0;
        const finish = (): void => {
          if (typeof element.cancelVideoFrameCallback === "function") {
            element.cancelVideoFrameCallback(handle);
          }
          signal.removeEventListener("abort", finish);
          resolve();
        };
        handle = element.requestVideoFrameCallback(() => finish());
        signal.addEventListener("abort", finish, { once: true });
      }),
      PRESENTED_FRAME_TIMEOUT_MS,
      "视频帧呈现超时",
    ).catch(() => undefined);
  }
  if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve();
  }
  return withTimeout(
    new Promise<void>((resolve) => {
      const finish = (): void => {
        element.removeEventListener("seeked", finish);
        element.removeEventListener("canplay", finish);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      element.addEventListener("seeked", finish, { once: true });
      element.addEventListener("canplay", finish, { once: true });
      signal.addEventListener("abort", finish, { once: true });
    }),
    PRESENTED_FRAME_TIMEOUT_MS,
    "视频帧呈现超时",
  ).catch(() => undefined);
}

function videoErrorMessage(element: HTMLVideoElement, prefix: string): string {
  const code = element.error?.code;
  return code === undefined
    ? prefix
    : `${prefix}（MediaError ${code}: ${element.error?.message ?? ""}）`;
}

/**
 * Resolves once a seek lands (`seeked`), the element errors, the wait is
 * aborted, or the scrub timeout elapses — whichever happens first.
 *
 * The wait owns its timeout instead of wrapping the listener promise in
 * `withTimeout`: every exit path runs the same cleanup, so a timeout removes
 * the `seeked`/`error`/`abort` listeners and clears the timer.  Wrapping it
 * would leave those listeners attached to a media element that never settles,
 * and repeated terminal holds would accumulate them.
 *
 * The caller must attach this *before* assigning `currentTime`: a seek that
 * lands synchronously (a cached or already-presented frame) would otherwise
 * fire before the listener exists and this wait would hang until the timeout.
 * The wait never rejects; after a timeout the caller still presents the best
 * available frame.
 */
export function waitForSeeked(
  element: HTMLVideoElement,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: number | null = null;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) window.clearTimeout(timer);
      element.removeEventListener("error", finish);
      element.removeEventListener("seeked", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = window.setTimeout(finish, VIDEO_SCRUB_TIMEOUT_MS);
    element.addEventListener("seeked", finish);
    element.addEventListener("error", finish);
    signal.addEventListener("abort", finish);
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  durationMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(message)),
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
