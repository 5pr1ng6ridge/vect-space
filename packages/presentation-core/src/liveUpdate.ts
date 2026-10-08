/**
 * Live presentation state of one game window.
 *
 * The desktop host publishes three kinds of update (see `RuntimeUpdateKind`).
 * Only a `story` update replaces what the window is presenting; a
 * `state_refresh` re-derives the live snapshot (variables, the current choice
 * set, interpolated text, titles, blocks, timers) and an `effect` additionally
 * carries timer cues that run beside the story.  This reducer is the single
 * place that keeps those apart, so a refresh can never cancel the running
 * presentation, orphan its acknowledgement or restart the text on screen:
 *
 * - the *story update* keeps its identity (`update_id`, cues, `requires_ack`)
 *   across refreshes, because that identity is what the presentation, the
 *   pending acknowledgement and the text occurrence are keyed by;
 * - the snapshot inside it is always the newest one, so choices, buttons,
 *   revisions used by commands and interaction state are never stale.
 */

import type {
  AdvanceBlock,
  RuntimeSnapshot,
  RuntimeUpdate,
  RuntimeUpdateKind,
} from "./types";

/** Effects are consumed right after each render; the cap only bounds a stall. */
export const MAX_PENDING_EFFECTS = 64;

export interface LiveState {
  /**
   * The story update that owns the presentation, carrying the newest snapshot.
   * Its identity changes only for a real story update (or a resync).
   */
  update: RuntimeUpdate | null;
  /** Timer effect updates received since that story update, oldest first. */
  effects: readonly RuntimeUpdate[];
}

export const EMPTY_LIVE_STATE: LiveState = { update: null, effects: [] };

/** Old hosts and editor fixtures omit `kind`: that always meant a story. */
function updateKind(update: RuntimeUpdate): RuntimeUpdateKind {
  return update.kind ?? "story";
}

export function reduceLiveState(
  state: LiveState,
  incoming: RuntimeUpdate,
): LiveState {
  const base = state.update;
  const kind = updateKind(incoming);
  const sameSession = base !== null && base.session_id === incoming.session_id;

  if (kind === "story") {
    // Gap recovery re-sends the still-unacknowledged story update; presenting
    // it twice would replay its cues and restart its text.  Only a sequenced
    // update can be such a re-send: update ids of fixtures without sequence
    // numbers are not guaranteed to be unique.
    if (
      incoming.seq !== undefined &&
      sameSession &&
      base.update_id === incoming.update_id
    ) {
      return state;
    }
    return { update: incoming, effects: [] };
  }

  if (base === null || !sameSession) {
    // No story to refresh (first update, or another session): it can only be
    // adopted as the presentation itself.
    return { update: { ...incoming, kind: "story" }, effects: [] };
  }

  if (kind === "state_refresh") {
    if (promptReplaced(base, incoming)) {
      // The prompt on screen is not the one this refresh describes (a gap
      // swallowed real story updates): resynchronise like a story update, but
      // without cues, so nothing one-shot is replayed.
      return { update: { ...incoming, kind: "story" }, effects: [] };
    }
    return {
      update: withSnapshot(base, incoming.snapshot),
      effects: state.effects,
    };
  }

  return {
    update: withSnapshot(base, incoming.snapshot),
    effects: [...state.effects, incoming].slice(-MAX_PENDING_EFFECTS),
  };
}

function withSnapshot(
  base: RuntimeUpdate,
  next: RuntimeSnapshot,
): RuntimeUpdate {
  return { ...base, snapshot: shareStructure(base.snapshot, next) };
}

function promptReplaced(base: RuntimeUpdate, incoming: RuntimeUpdate): boolean {
  const before = base.snapshot.interaction?.prompt_instance ?? "";
  const after = incoming.snapshot.interaction?.prompt_instance ?? "";
  if (before !== "" && after !== "") return before !== after;
  const left = base.snapshot.prompt;
  const right = incoming.snapshot.prompt;
  return (
    left.kind !== right.kind ||
    ("prompt_id" in left && "prompt_id" in right
      ? left.prompt_id !== right.prompt_id
      : false)
  );
}

/**
 * Keeps the previous reference for every part of the snapshot that did not
 * change.  A refresh is frequent (every timer tick), and the dialogue box, the
 * long-text panel and the choice layer derive memoised layout and reveal plans
 * from these objects: handing them structurally equal but fresh objects would
 * make every refresh look like new content.
 */
function shareStructure(
  previous: RuntimeSnapshot,
  next: RuntimeSnapshot,
): RuntimeSnapshot {
  const shared: Record<string, unknown> = { ...next };
  for (const key of Object.keys(next) as (keyof RuntimeSnapshot)[]) {
    if (key === "revision") continue;
    if (deepEqual(previous[key], next[key])) shared[key] = previous[key];
  }
  return shared as unknown as RuntimeSnapshot;
}

/** Structural equality that, unlike JSON, understands bigint scalars. */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        deepEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

// -- prompt occurrence and advance blocks ------------------------------------

/**
 * Stable identity of the prompt on screen.
 *
 * `prompt_instance` changes only when a new Say / long-text step / Choice is
 * really entered, so a refresh, a data revision or a presentation `update_id`
 * can never restart the reveal.  Hosts that predate it fall back to the story
 * update's id, which is what the windows keyed by before.
 */
export function promptOccurrence(update: RuntimeUpdate): string {
  const instance = update.snapshot.interaction?.prompt_instance;
  return instance !== undefined && instance !== ""
    ? instance
    : update.update_id;
}

const NO_BLOCKS: readonly AdvanceBlock[] = [];

function advanceBlocks(snapshot: RuntimeSnapshot): readonly AdvanceBlock[] {
  return snapshot.interaction?.blocks ?? NO_BLOCKS;
}

/** True while any script block forbids turning the page in this window. */
export function isAdvanceBlocked(
  snapshot: RuntimeSnapshot | undefined,
): boolean {
  return snapshot !== undefined && advanceBlocks(snapshot).length > 0;
}

/** Visible hints of the active blocks (blocks without a message stay silent). */
export function advanceBlockMessages(snapshot: RuntimeSnapshot): string[] {
  const messages: string[] = [];
  for (const block of advanceBlocks(snapshot)) {
    if (block.message !== "" && !messages.includes(block.message)) {
      messages.push(block.message);
    }
  }
  return messages;
}

/** Ids of the timers that are active in the live snapshot, or null if unknown. */
export function activeTimerIds(snapshot: RuntimeSnapshot): string[] | null {
  const timers = snapshot.interaction?.timers;
  return timers === undefined ? null : Object.keys(timers);
}
