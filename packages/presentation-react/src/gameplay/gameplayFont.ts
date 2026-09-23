import { useEffect, useState } from "react";

/**
 * The single family name the shared gameplay surface asks the browser for.
 *
 * The game bootstrap and every editor preview register the project's font asset
 * under exactly this family (see `gameplay.css`, which declares it on the
 * shared dialogue/long-text rules).  Naming the face once keeps a preview from
 * silently rendering in the host's UI font, which would change text metrics and
 * therefore line wrapping, reveal geometry and the pagination cache key.
 */
export const GAMEPLAY_FONT_FAMILY = "VECT Pixel";

/**
 * Conventional fallback used when a manifest does not declare `default_font`.
 * Mirrors the Rust bootstrap (`runtime::bootstrap`).
 */
export const GAMEPLAY_FALLBACK_FONT_ID = "font.fusion_pixel";

/** Minimal shape of an asset record needed to choose the gameplay font. */
export interface GameplayFontSource {
  id: string;
  kind: string;
}

/**
 * Pick the font asset a project renders with, mirroring the runtime bootstrap:
 * the explicit `default_font`, then the conventional `font.fusion_pixel`, then
 * the first font asset.  Keeping the rule here means the game and every editor
 * preview resolve the same face and the same layout-cache identity.
 */
export function selectGameplayFont<T extends GameplayFontSource>(
  defaultFontId: string | null | undefined,
  sources: readonly T[],
): T | undefined {
  return (
    sources.find((source) => source.id === defaultFontId) ??
    sources.find(
      (source) =>
        source.id === GAMEPLAY_FALLBACK_FONT_ID && source.kind === "font",
    ) ??
    sources.find((source) => source.kind === "font")
  );
}

export interface GameplayFontState {
  /**
   * True once the face is usable.  Also true when the host cannot load faces
   * (jsdom, minimal WebViews) or no font was configured, so text measurement is
   * never deadlocked behind an API that does not exist.
   */
  ready: boolean;
  /** Non-fatal load failure message, or null.  Rendering always falls back. */
  error: string | null;
}

interface FontLoadState {
  url: string;
  error: string | null;
}

/**
 * Environments without the `FontFace` API or `document.fonts` cannot register a
 * face; they render the declared system fallback immediately.
 */
function canLoadFaces(): boolean {
  return (
    typeof FontFace !== "undefined" &&
    typeof document !== "undefined" &&
    document.fonts !== undefined
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Register the project's gameplay font under {@link GAMEPLAY_FONT_FAMILY} and
 * report when it is ready for text measurement.
 *
 * - `url === undefined`, or a host without the FontFace API, is immediately
 *   ready as the system fallback;
 * - a new URL (project switch) resets readiness until the new face settles;
 * - a rejected load is non-fatal: the surface keeps its declared fallback
 *   family, `ready` releases and `error` carries the message.
 *
 * The loaded face is removed on cleanup, so switching projects or unmounting
 * never leaves a stale face registered under the shared family.
 */
export function useGameplayFont(url: string | undefined): GameplayFontState {
  const [state, setState] = useState<FontLoadState | null>(null);

  useEffect(() => {
    if (url === undefined || !canLoadFaces()) return undefined;
    let active = true;
    const face = new FontFace(
      GAMEPLAY_FONT_FAMILY,
      `url(${JSON.stringify(url)})`,
      { display: "swap" },
    );
    try {
      document.fonts.add(face);
    } catch (reason: unknown) {
      // A duplicate family/descriptor or an unusable font set must not break
      // the preview; report it and keep the fallback geometry.
      setState({ url, error: errorMessage(reason) });
      return undefined;
    }
    void face
      .load()
      .then(async () => {
        // `FontFace.load()` resolves when this face is usable, while the
        // document-wide promise also accounts for companion faces that
        // KaTeX/layout may have queued.
        await document.fonts.ready;
        if (active) setState({ url, error: null });
      })
      .catch((reason: unknown) => {
        if (active) setState({ url, error: errorMessage(reason) });
      });
    return () => {
      active = false;
      document.fonts.delete(face);
    };
  }, [url]);

  const current = state?.url === url ? state : null;
  return {
    ready: url === undefined || !canLoadFaces() || current !== null,
    error: current?.error ?? null,
  };
}
