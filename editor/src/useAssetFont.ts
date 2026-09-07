import { useEffect, useMemo, useState } from "react";

export interface AssetFontState {
  fontFamily: string | undefined;
  error: string | null;
  /** True when loading finished, including the explicit system fallback path. */
  ready: boolean;
}

interface LoadState {
  url: string;
  loaded: boolean;
  error: string | null;
}

export function useAssetFont(
  url: string | undefined,
  label: string,
): AssetFontState {
  const family = useMemo(
    () => `VECTSPACE ${label.replace(/[^\p{L}\p{N}_-]+/gu, " ").trim()}`,
    [label],
  );
  const [state, setState] = useState<LoadState | null>(null);

  useEffect(() => {
    if (url === undefined) return;

    let active = true;
    const face = new FontFace(family, `url(${JSON.stringify(url)})`, {
      display: "swap",
    });
    document.fonts.add(face);
    void face.load().then(
      () => {
        if (active) setState({ url, loaded: true, error: null });
      },
      (reason: unknown) => {
        if (active) {
          setState({
            url,
            loaded: false,
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
      },
    );

    return () => {
      active = false;
      document.fonts.delete(face);
    };
  }, [family, url]);

  const current = state?.url === url ? state : null;
  return {
    fontFamily: current?.loaded === true ? family : undefined,
    error: current?.error ?? null,
    ready: url === undefined || current !== null,
  };
}
