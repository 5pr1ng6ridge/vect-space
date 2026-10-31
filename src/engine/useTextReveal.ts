import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  DialoguePrompt,
  LongTextPrompt,
  RuntimeUpdate,
  TextRevealAnimation,
} from "@vectspace/presentation-core/types";
import { useTextOccurrence } from "./textOccurrence";

interface LockedTextSettings {
  instanceKey: string;
  defaultCps: number;
  initialCps: number;
  animation: TextRevealAnimation;
}

export interface TextRevealState {
  instanceKey: string | null;
  hasRevealCue: boolean;
  cps: number;
  defaultCps: number;
  animation: TextRevealAnimation;
}

/**
 * Reveal identity and settings of the active text prompt.
 *
 * The cue's speed and animation (or the player's defaults) are locked for the
 * whole prompt occurrence, so changing the settings or refreshing the update
 * never restarts a line that is already revealing.
 */
export function useTextReveal(
  update: RuntimeUpdate | null,
  textPrompt: DialoguePrompt | LongTextPrompt | null,
  defaults: { cps: number; animation: TextRevealAnimation },
): TextRevealState & { resetLocked(): void } {
  const occurrence = useTextOccurrence(update, textPrompt);
  const cueCps = occurrence?.speedCps;
  const cueAnimation = occurrence?.animation ?? null;
  const instanceKey = occurrence?.key ?? null;
  const hasPrompt = textPrompt !== null;
  const current = useMemo<LockedTextSettings | null>(() => {
    if (!hasPrompt) return null;
    return {
      instanceKey: instanceKey ?? "none",
      defaultCps: defaults.cps,
      initialCps: cueCps ?? defaults.cps,
      animation: cueAnimation ?? defaults.animation,
    };
  }, [
    cueAnimation,
    cueCps,
    defaults.animation,
    defaults.cps,
    hasPrompt,
    instanceKey,
  ]);
  const [locked, setLocked] = useState<LockedTextSettings | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setLocked((previous) =>
        current === null || previous?.instanceKey !== current.instanceKey
          ? current
          : previous,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [current]);
  const resetLocked = useCallback(() => setLocked(null), []);
  const effective =
    locked?.instanceKey === current?.instanceKey ? locked : current;
  return {
    instanceKey,
    hasRevealCue: occurrence?.hasRevealCue ?? false,
    cps: effective?.initialCps ?? defaults.cps,
    defaultCps: effective?.defaultCps ?? defaults.cps,
    animation: effective?.animation ?? defaults.animation,
    resetLocked,
  };
}
