import { useCallback, useReducer } from "react";

import {
  EMPTY_LIVE_STATE,
  reduceLiveState,
  type LiveState,
} from "@vectspace/presentation-core/live-update";
import type { RuntimeUpdate } from "@vectspace/presentation-core/types";

type LiveAction =
  /** A host update, merged by kind (story / state_refresh / effect). */
  | { type: "incoming"; update: RuntimeUpdate }
  /** A window-level replacement: bootstrap, boundary, recovery, clear. */
  | { type: "replace"; update: RuntimeUpdate | null };

function liveReducer(state: LiveState, action: LiveAction): LiveState {
  if (action.type === "replace") {
    return action.update === null
      ? EMPTY_LIVE_STATE
      : { update: action.update, effects: [] };
  }
  return reduceLiveState(state, action.update);
}

/**
 * The window's presentation state.  `update` is the story update that owns the
 * presentation (stable across refreshes, always carrying the newest snapshot);
 * `effects` are the timer effects to run beside it.
 *
 * Every transition goes through a reducer so updates applied back to back in
 * one tick are merged in order - none is lost to React batching.
 */
export function useLiveUpdate(): {
  update: RuntimeUpdate | null;
  effects: readonly RuntimeUpdate[];
  receive(update: RuntimeUpdate): void;
  setUpdate(update: RuntimeUpdate | null): void;
} {
  const [live, dispatch] = useReducer(liveReducer, EMPTY_LIVE_STATE);
  const receive = useCallback(
    (update: RuntimeUpdate): void => dispatch({ type: "incoming", update }),
    [],
  );
  const setUpdate = useCallback(
    (update: RuntimeUpdate | null): void =>
      dispatch({ type: "replace", update }),
    [],
  );
  return { update: live.update, effects: live.effects, receive, setUpdate };
}
