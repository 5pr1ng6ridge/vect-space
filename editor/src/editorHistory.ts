/**
 * Editor content history.
 *
 * The editor document and its Immer-patch undo/redo stack used to live inside
 * `App.tsx`.  Keeping the state machine in its own module lets hosts (and
 * integration tests) drive the exact same history semantics the application
 * uses, without duplicating or mocking them.  The reducer is intentionally
 * pure: every action evaluates its mutation against the latest project, which
 * is why batched pointer/text events stop overwriting each other.
 */
import {
  applyPatches,
  enablePatches,
  produceWithPatches,
  type Patch,
} from "immer";

import type { EditorProject } from "./types";

enablePatches();

export interface HistoryEntry {
  label: string;
  redo: Patch[];
  undo: Patch[];
  beforeRevision: number;
  afterRevision: number;
}

export interface ActiveEdit {
  id: string;
  label: string;
  forward: Patch[];
  inverse: Patch[];
  drafts: Record<string, string>;
  invalidDrafts: Record<string, string>;
  errors: Record<string, string>;
}

export interface EditorState {
  project: EditorProject | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  dirty: boolean;
  // Layout/preview preferences intentionally stay out of the content undo
  // stack, but they still make the project dirty until the next save.
  ephemeralDirty: boolean;
  currentRevision: number;
  savedRevision: number;
  nextRevision: number;
  activeEdit: ActiveEdit | null;
}

/**
 * Mutations are kept in the reducer action instead of being evaluated in the
 * component.  React may batch several pointer/text events before rendering;
 * evaluating against the component's captured project in that situation
 * would make the later event overwrite the earlier one.  Running the recipe
 * in the reducer guarantees that every queued action sees the latest project.
 */
export type EditorMutation = (draft: EditorProject) => unknown;

export type EditorAction =
  | { type: "load"; project: EditorProject }
  | {
      type: "mark_saved";
      project: EditorProject;
      snapshot?: EditorProject;
      revision?: number;
    }
  | {
      type: "edit";
      mutation: EditorMutation;
      history: boolean;
      label: string;
      /**
       * Keep the mutation in the currently open gesture.  This is used only
       * for compound commands such as Enter on a Say row (commit text and
       * insert the next row as one undo item).  Ordinary controls must first
       * close a pending focus/drag edit so a select or button gets its own
       * history entry.
       */
      mergeActive?: boolean;
    }
  | { type: "begin_edit"; id: string; label: string }
  | { type: "update_edit"; id: string; mutation: EditorMutation }
  | {
      type: "set_edit_draft";
      id: string;
      key: string;
      value: string;
      invalid?: boolean;
    }
  | { type: "clear_edit_draft"; id: string; key: string }
  | {
      type: "set_edit_error";
      id: string;
      key: string;
      message: string | null;
    }
  | { type: "commit_edit"; id: string }
  | { type: "cancel_edit"; id: string }
  | { type: "undo" }
  | { type: "redo" };

export const INITIAL_EDITOR_STATE: EditorState = {
  project: null,
  past: [],
  future: [],
  dirty: false,
  ephemeralDirty: false,
  currentRevision: 0,
  savedRevision: 0,
  nextRevision: 0,
  activeEdit: null,
};

/**
 * Finalise the explicit gesture currently owned by the reducer.  Keeping this
 * transition in one place is important: a field can lose focus because the
 * author clicked another inspector, pressed a shortcut, or changed workspace.
 * All of those paths must create exactly one patch entry and advance the same
 * revision counter.
 *
 * Invalid drafts are deliberately not finalised.  They are represented by
 * `invalidDrafts` rather than by a typed project value, so silently committing
 * them would make the saved document disagree with what the input displays.
 */
export function finalizeActiveEdit(state: EditorState): EditorState {
  const active = state.activeEdit;
  if (active === null || Object.keys(active.invalidDrafts).length > 0)
    return state;
  if (active.forward.length === 0) {
    return {
      ...state,
      activeEdit: null,
      dirty:
        state.currentRevision !== state.savedRevision || state.ephemeralDirty,
    };
  }
  const afterRevision = state.nextRevision + 1;
  const entry: HistoryEntry = {
    label: active.label,
    redo: active.forward,
    undo: active.inverse,
    beforeRevision: state.currentRevision,
    afterRevision,
  };
  return {
    ...state,
    activeEdit: null,
    past: [...state.past.slice(-99), entry],
    future: [],
    currentRevision: afterRevision,
    nextRevision: afterRevision,
    dirty: afterRevision !== state.savedRevision || state.ephemeralDirty,
  };
}

export function editorReducer(
  state: EditorState,
  action: EditorAction,
): EditorState {
  switch (action.type) {
    case "load":
      return {
        project: action.project,
        past: [],
        future: [],
        dirty: false,
        ephemeralDirty: false,
        currentRevision: 0,
        savedRevision: 0,
        nextRevision: 0,
        activeEdit: null,
      };
    case "mark_saved": {
      // Edits can continue while I/O is in flight. Never replace a newer
      // document with the save response for an older snapshot. Only rebase its
      // fingerprint and published asset paths; a later save persists the edits.
      const unchanged =
        action.snapshot === undefined || state.project === action.snapshot;
      const current = state.project;
      const published = new Map(
        action.project.assets.map((asset) => [asset.id, asset]),
      );
      return {
        ...state,
        project: unchanged
          ? action.project
          : current === null
            ? null
            : {
                ...current,
                fingerprint: action.project.fingerprint,
                assets: current.assets.map((asset) => {
                  const saved = published.get(asset.id);
                  return saved !== undefined &&
                    current.manifest.assets[asset.id]?.path ===
                      action.project.manifest.assets[asset.id]?.path
                    ? saved
                    : asset;
                }),
              },
        savedRevision: action.revision ?? state.currentRevision,
        dirty:
          !unchanged ||
          state.currentRevision !== (action.revision ?? state.currentRevision),
        ephemeralDirty: unchanged ? false : state.ephemeralDirty,
        activeEdit: unchanged ? null : state.activeEdit,
      };
    }
    case "edit":
      if (state.project === null) return state;
      {
        if (state.activeEdit !== null && !action.mergeActive) {
          const committed = finalizeActiveEdit(state);
          // An invalid draft is a hard boundary.  The caller will surface its
          // inline validation error; do not apply an unrelated control action
          // on top of it.
          if (committed.activeEdit !== null) return state;
          state = committed;
        }
        const currentProject = state.project;
        if (currentProject === null) return state;
        const [project, redo, undo] = produceWithPatches(
          currentProject,
          (draft) => {
            const result = action.mutation(draft);
            if (result === undefined) return undefined;
            return result as EditorProject;
          },
        );
        if (redo.length === 0) return state;
        if (!action.history) {
          // Ephemeral layout changes (viewport and preview preferences) still
          // need to be persisted, but do not pollute the content undo stack.
          return { ...state, project, dirty: true, ephemeralDirty: true };
        }
        if (state.activeEdit !== null && action.mergeActive) {
          // Discrete edits made while an explicit gesture is open belong to
          // that gesture.  This keeps Enter-insert and pointer operations
          // atomic without evaluating recipes against a stale render.
          const activeEdit: ActiveEdit = {
            ...state.activeEdit,
            forward: [...state.activeEdit.forward, ...redo],
            inverse: [...undo, ...state.activeEdit.inverse],
          };
          return { ...state, project, activeEdit, dirty: true };
        }
        const afterRevision = state.nextRevision + 1;
        const entry: HistoryEntry = {
          label: action.label,
          redo,
          undo,
          beforeRevision: state.currentRevision,
          afterRevision,
        };
        return {
          ...state,
          project,
          past: [...state.past.slice(-99), entry],
          future: [],
          currentRevision: afterRevision,
          nextRevision: afterRevision,
          dirty: afterRevision !== state.savedRevision || state.ephemeralDirty,
        };
      }
    case "begin_edit": {
      if (state.project === null) return state;
      if (state.activeEdit?.id === action.id) return state;
      // A valid edit may be superseded by a new field/gesture.  Finalise it
      // before opening the next one so patches cannot leak into the wrong
      // history label.  An invalid draft remains a hard boundary; callers
      // surface the validation error and the original input stays active.
      const committed = finalizeActiveEdit(state);
      if (committed.activeEdit !== null) return state;
      return {
        ...committed,
        activeEdit: {
          id: action.id,
          label: action.label,
          forward: [],
          inverse: [],
          drafts: {},
          invalidDrafts: {},
          errors: {},
        },
        dirty: true,
      };
    }
    case "update_edit":
      if (state.project === null || state.activeEdit?.id !== action.id)
        return state;
      {
        const [project, redo, undo] = produceWithPatches(
          state.project,
          (draft) => {
            const result = action.mutation(draft);
            if (result === undefined) return undefined;
            return result as EditorProject;
          },
        );
        if (redo.length === 0) return state;
        return {
          ...state,
          project,
          activeEdit: {
            ...state.activeEdit,
            forward: [...state.activeEdit.forward, ...redo],
            inverse: [...undo, ...state.activeEdit.inverse],
          },
          dirty: true,
        };
      }
    case "set_edit_draft":
      if (state.activeEdit?.id !== action.id) return state;
      {
        const drafts = {
          ...state.activeEdit.drafts,
          [action.key]: action.value,
        };
        const invalidDrafts = { ...state.activeEdit.invalidDrafts };
        if (action.invalid === false)
          Reflect.deleteProperty(invalidDrafts, action.key);
        else invalidDrafts[action.key] = action.value;
        return {
          ...state,
          activeEdit: { ...state.activeEdit, drafts, invalidDrafts },
          dirty: true,
        };
      }
    case "clear_edit_draft":
      if (state.activeEdit?.id !== action.id) return state;
      {
        const drafts = { ...state.activeEdit.drafts };
        Reflect.deleteProperty(drafts, action.key);
        const invalidDrafts = { ...state.activeEdit.invalidDrafts };
        Reflect.deleteProperty(invalidDrafts, action.key);
        const errors = { ...state.activeEdit.errors };
        Reflect.deleteProperty(errors, action.key);
        return {
          ...state,
          activeEdit: { ...state.activeEdit, drafts, invalidDrafts, errors },
          dirty: true,
        };
      }
    case "set_edit_error":
      if (state.activeEdit?.id !== action.id) return state;
      {
        const errors = { ...state.activeEdit.errors };
        if (action.message === null) Reflect.deleteProperty(errors, action.key);
        else errors[action.key] = action.message;
        return { ...state, activeEdit: { ...state.activeEdit, errors } };
      }
    case "commit_edit":
      if (state.activeEdit?.id !== action.id) return state;
      if (Object.keys(state.activeEdit.invalidDrafts).length > 0) return state;
      return finalizeActiveEdit(state);
    case "cancel_edit":
      if (state.activeEdit?.id !== action.id) return state;
      return {
        ...state,
        project:
          state.project === null || state.activeEdit.inverse.length === 0
            ? state.project
            : applyPatches(state.project, state.activeEdit.inverse),
        activeEdit: null,
        dirty:
          state.currentRevision !== state.savedRevision || state.ephemeralDirty,
      };
    case "undo": {
      // Ctrl+Z first closes a valid focus/gesture edit, then undoes that
      // freshly-created history entry.  This makes keyboard undo behave like
      // the toolbar and avoids losing the last keystroke to React batching.
      // With an invalid draft there is no safe typed value to commit; cancel
      // only that active edit and leave older history untouched.  Returning
      // the state unchanged here used to leave the editor permanently dirty
      // and made Ctrl+Z appear broken until the user manually fixed the field.
      if (state.activeEdit !== null) {
        if (Object.keys(state.activeEdit.invalidDrafts).length > 0) {
          return {
            ...state,
            project:
              state.project === null || state.activeEdit.inverse.length === 0
                ? state.project
                : applyPatches(state.project, state.activeEdit.inverse),
            activeEdit: null,
            dirty:
              state.currentRevision !== state.savedRevision ||
              state.ephemeralDirty,
          };
        }
        state = finalizeActiveEdit(state);
      }
      const previous = state.past[state.past.length - 1];
      if (state.project === null || previous === undefined) return state;
      return {
        ...state,
        project: applyPatches(state.project, previous.undo),
        past: state.past.slice(0, -1),
        future: [previous, ...state.future].slice(0, 100),
        currentRevision: previous.beforeRevision,
        dirty:
          previous.beforeRevision !== state.savedRevision ||
          state.ephemeralDirty,
      };
    }
    case "redo": {
      if (state.activeEdit !== null) return state;
      const next = state.future[0];
      if (state.project === null || next === undefined) return state;
      return {
        ...state,
        project: applyPatches(state.project, next.redo),
        past: [...state.past.slice(-99), next],
        future: state.future.slice(1),
        currentRevision: next.afterRevision,
        dirty:
          next.afterRevision !== state.savedRevision || state.ephemeralDirty,
      };
    }
  }
}
