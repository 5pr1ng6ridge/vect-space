/**
 * Registry of focused fields that hold an uncommitted draft.
 *
 * Several inspector inputs are uncontrolled and only commit on blur/Enter.
 * Keyboard shortcuts (Ctrl+S, Ctrl+Z, navigation) do not blur the field, so
 * without this registry the last typed value was silently left out of a save.
 * A field registers its commit while focused; `flushPendingCommits()` runs
 * every registered commit and is called from the editor's single flush point.
 */
import { useEffect, useLayoutEffect, useRef } from "react";

type Commit = () => void;

const pending = new Set<{ current: Commit }>();

export function flushPendingCommits(): void {
  for (const entry of [...pending]) entry.current();
}

/** Test/diagnostic helper: number of fields currently holding a draft slot. */
export function pendingCommitCount(): number {
  return pending.size;
}

/**
 * Returns focus/blur handlers for a commit-on-blur field.  Spread them on the
 * input (the returned `onBlur` also runs the commit):
 *
 *   const pendingCommit = usePendingCommit(commit);
 *   <input {...pendingCommit} />
 */
export function usePendingCommit(commit: Commit): {
  onFocus(): void;
  onBlur(): void;
} {
  const commitRef = useRef(commit);
  const entryRef = useRef<{ current: Commit } | null>(null);
  useLayoutEffect(() => {
    commitRef.current = commit;
  });
  useEffect(
    () => () => {
      if (entryRef.current !== null) pending.delete(entryRef.current);
      entryRef.current = null;
    },
    [],
  );
  return {
    onFocus: () => {
      if (entryRef.current !== null) return;
      const entry = { current: () => commitRef.current() };
      entryRef.current = entry;
      pending.add(entry);
    },
    onBlur: () => {
      if (entryRef.current !== null) pending.delete(entryRef.current);
      entryRef.current = null;
      commitRef.current();
    },
  };
}
