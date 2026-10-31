import { useState } from "react";

import { useGameplayFont } from "@vectspace/presentation-react/gameplay";

/**
 * Loads the project's gameplay font and reports a failed load once through
 * `report`; text keeps its system fallback. Returns whether text measurement
 * may proceed (the face settled, or failed and the fallback is final).
 */
export function useDefaultFont(
  fontUrl: string | undefined,
  report: (message: string) => void,
): boolean {
  const { ready, error } = useGameplayFont(fontUrl);
  const [reported, setReported] = useState<string | null>(null);
  if (error !== reported) {
    // Adjusted during render (like a derived value) rather than in an effect.
    setReported(error);
    if (error !== null) report(`中文字体加载失败，已使用系统字体：${error}`);
  }
  return ready;
}
