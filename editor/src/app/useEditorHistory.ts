import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ActionDispatch,
} from "react";
import { flushSync } from "react-dom";

import {
  type EditorAction,
  type EditorMutation,
  type EditorState,
} from "../editorHistory";
import type { EditorProject } from "../types";
import { flushPendingCommits } from "../ui/pendingCommits";
import { useToast } from "../ui/feedbackContext";

/**
 * The document, its undo/redo stack and the explicit "edit session" API that
 * inspectors and pointer gestures use to merge many updates into one history
 * entry.  The reducer lives in `editorHistory.ts`; this hook adds the
 * synchronous-lock and flush rules around it.
 */
export function useEditorHistory({
  editorState,
  dispatchEditor,
  setError,
}: {
  editorState: EditorState;
  dispatchEditor: ActionDispatch<[EditorAction]>;
  setError(message: string | null): void;
}) {
  const toast = useToast();
  const { project } = editorState;
  const [busy, setBusy] = useState(false);
  // Keep a synchronous lock alongside React state.  Pointer/text callbacks
  // can run before the next render while an async open is in flight;
  // the reducer entry points consult this ref to reject those late edits.
  const busyRef = useRef(false);
  const projectRef = useRef<EditorProject | null>(null);
  const editorStateRef = useRef(editorState);

  const setEditorBusy = useCallback((value: boolean): void => {
    busyRef.current = value;
    setBusy(value);
  }, []);

  useLayoutEffect(() => {
    projectRef.current = project;
    editorStateRef.current = editorState;
  }, [editorState, project]);

  const getLatestProject = useCallback(
    (): EditorProject | null => editorStateRef.current.project,
    [],
  );

  const flushEditorEdits = useCallback((): boolean => {
    let valid = true;
    flushSync(() => {
      // Commit-on-blur inspector fields keep their draft in the DOM; a
      // shortcut does not blur them, so flush their registered commits first.
      flushPendingCommits();
    });
    flushSync(() => {
      // All raw drafts and in-flight gestures live in the reducer now.  A
      // single active edit is therefore enough to flush both ScriptView and
      // ChapterMapWorkspace without querying component-local refs.
      const active = editorStateRef.current.activeEdit;
      if (active === null) return;
      valid = Object.keys(active.invalidDrafts).length === 0;
      if (valid) dispatchEditor({ type: "commit_edit", id: active.id });
    });
    return valid;
  }, [dispatchEditor]);

  const flushBeforeNavigation = useCallback((): boolean => {
    const valid = flushEditorEdits();
    if (!valid) {
      setError("存在未提交或无效的编辑内容，请修正后再离开当前视图。");
    }
    return valid;
  }, [flushEditorEdits, setError]);

  const commit = useCallback(
    (
      mutator: (draft: EditorProject) => unknown,
      history = true,
      label = "编辑项目",
      mergeActive = false,
    ): void => {
      // Opening another project replaces the document; saving only captures a
      // snapshot and does not prevent new edits.
      if (busyRef.current) return;
      dispatchEditor({
        type: "edit",
        mutation: mutator,
        history,
        label,
        mergeActive,
      });
    },
    [dispatchEditor],
  );

  /**
   * Apply an undoable change right away and offer 撤销 in a toast instead of
   * asking first.  The toast only undoes this exact change: if anything was
   * edited since, it asks the author to use the history instead.
   */
  const commitUndoable = (
    mutation: (draft: EditorProject) => unknown,
    label: string,
    message: string,
  ): void => {
    flushSync(() => commit(mutation, true, label));
    const revision = editorStateRef.current.currentRevision;
    toast.show({
      tone: "success",
      message,
      action: {
        label: "撤销",
        onAction: () => {
          if (editorStateRef.current.currentRevision !== revision) {
            setError("之后已有新的编辑；请用顶栏的撤销按钮逐步撤销。");
            return;
          }
          dispatchEditor({ type: "undo" });
        },
      },
    });
  };

  const beginEdit = useCallback(
    (id: string, label: string): void => {
      if (busyRef.current) return;
      const current = editorStateRef.current;
      const active = current.activeEdit;
      if (active !== null && active.id !== id) {
        if (Object.keys(active.invalidDrafts).length > 0) {
          setError("请先修正当前输入，再编辑其他属性。");
          return;
        }
        // Focus/pointer transitions can arrive in one React batch.  Commit the
        // previous valid gesture synchronously before opening the next one;
        // otherwise both mutations would be attributed to whichever callback
        // happens to render first.
        flushSync(() => {
          dispatchEditor({ type: "commit_edit", id: active.id });
          dispatchEditor({ type: "begin_edit", id, label });
        });
        return;
      }
      // Focus/pointer handlers and the first input event may be delivered in
      // the same browser task.  Commit the ownership transition synchronously
      // so an immediately-following update_edit cannot be dropped because the
      // component still holds the previous reducer snapshot.
      flushSync(() => dispatchEditor({ type: "begin_edit", id, label }));
    },
    [dispatchEditor, setError],
  );

  const updateEdit = useCallback(
    (id: string, mutation: EditorMutation): void => {
      if (busyRef.current) return;
      dispatchEditor({ type: "update_edit", id, mutation });
    },
    [dispatchEditor],
  );

  const commitEdit = useCallback(
    (id: string, clearedKey?: string): boolean => {
      if (busyRef.current) return false;
      const current = editorStateRef.current;
      if (current.activeEdit?.id !== id) return true;
      const invalidKeys = Object.keys(current.activeEdit.invalidDrafts).filter(
        (key) => key !== clearedKey,
      );
      // A map inspector clears its raw field and commits in one browser blur
      // turn.  React dispatches both actions together, so inspect the key that
      // is about to be cleared rather than the stale ref from before the blur.
      if (clearedKey !== undefined)
        dispatchEditor({ type: "clear_edit_draft", id, key: clearedKey });
      const valid = invalidKeys.length === 0;
      dispatchEditor({ type: "commit_edit", id });
      // Returning the projected validity keeps callers from leaving the
      // workspace after an invalid blur, while allowing a corrected field to
      // clear-and-commit atomically.
      return valid;
    },
    [dispatchEditor],
  );

  const cancelEdit = useCallback(
    (id: string): void => {
      if (busyRef.current) return;
      dispatchEditor({ type: "cancel_edit", id });
    },
    [dispatchEditor],
  );

  const setEditDraft = useCallback(
    (id: string, key: string, value: string, invalid = true): void => {
      if (busyRef.current) return;
      dispatchEditor({ type: "set_edit_draft", id, key, value, invalid });
    },
    [dispatchEditor],
  );

  const setEditError = useCallback(
    (id: string, key: string, message: string | null): void => {
      if (busyRef.current) return;
      dispatchEditor({ type: "set_edit_error", id, key, message });
    },
    [dispatchEditor],
  );

  const undo = useCallback((): void => {
    const current = editorStateRef.current;
    if (
      current.activeEdit !== null &&
      Object.keys(current.activeEdit.invalidDrafts).length > 0
    ) {
      // An invalid numeric draft has no typed project value to undo.  Cancel
      // the owning editor session (and ask the workspace to restore its raw
      // input) instead of touching an older history entry.
      dispatchEditor({ type: "cancel_edit", id: current.activeEdit.id });
      return;
    }
    if (!flushEditorEdits()) return;
    dispatchEditor({ type: "undo" });
  }, [dispatchEditor, flushEditorEdits]);

  const redo = useCallback((): void => {
    if (!flushEditorEdits()) return;
    dispatchEditor({ type: "redo" });
  }, [dispatchEditor, flushEditorEdits]);

  return {
    busy,
    busyRef,
    setEditorBusy,
    projectRef,
    editorStateRef,
    getLatestProject,
    flushEditorEdits,
    flushBeforeNavigation,
    commit,
    commitUndoable,
    beginEdit,
    updateEdit,
    commitEdit,
    cancelEdit,
    setEditDraft,
    setEditError,
    undo,
    redo,
  };
}

export type EditorHistory = ReturnType<typeof useEditorHistory>;
