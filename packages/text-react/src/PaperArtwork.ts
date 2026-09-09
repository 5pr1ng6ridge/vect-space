import { useEffect, useState } from "react";

/** Keep decoded images alive while CSS backgrounds reuse their resources. */
const images = new Map<
  string,
  { image: HTMLImageElement; ready: Promise<boolean> }
>();

function load(url: string): Promise<boolean> {
  const cached = images.get(url);
  if (cached) return cached.ready;
  const image = new Image();
  const ready = new Promise<boolean>((resolve) => {
    image.onload = () => {
      void image.decode().then(
        () => resolve(true),
        () => resolve(false),
      );
    };
    image.onerror = () => resolve(false);
  });
  images.set(url, { image, ready });
  image.src = url;
  return ready;
}

export function usePaperArtwork(url: string | null | undefined): {
  ready: boolean;
  url: string | undefined;
} {
  const [result, setResult] = useState<{ url: string; loaded: boolean }>();
  useEffect(() => {
    if (typeof url !== "string") return;
    let active = true;
    void load(url).then((loaded) => {
      if (active) setResult({ url, loaded });
    });
    return () => {
      active = false;
    };
  }, [url]);
  const settled = typeof url === "string" && result?.url === url;
  return {
    ready: url === undefined || settled,
    url: settled && result.loaded ? url : undefined,
  };
}
