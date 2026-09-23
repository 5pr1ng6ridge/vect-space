import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from "react";
import { nodeLabel, outputPorts } from "../story";
import { buildScriptChainOptions } from "./scriptChains";
import {
  imeState,
  isEditableTarget,
  isInteractiveTarget,
  shouldIgnoreNodeDeletion,
} from "./nodeDeleteShortcut";
import type {
  CharacterDefinition,
  ContentManifest,
  SceneDefinition,
  SceneNode,
} from "../types";

export interface ScriptViewProps {
  scene: SceneDefinition;
  manifest: ContentManifest;
  selectedNodeId: string | null;
  onSelect(nodeId: string | null): void;
  onChange(nodeId: string, node: SceneNode): void;
  onInsertAfter(nodeId: string, portId?: string): void;
  /** Commit an in-flight say edit and insert the following say atomically. */
  onCommitAndInsertAfter?(nodeId: string, text: string): boolean;
  onInsertBatch(
    afterNodeId: string,
    rows: { speaker: string | null; text: string }[],
  ): void;
  onDelete(nodeId: string): void;
  onDeleteMany?(nodeIds: string[]): void;
  /** True while an App-level dialog or entry overlay owns the interaction. */
  deleteDisabled?: boolean;
  onBatchSpeaker?(nodeIds: string[], speaker: string | null): void;
  onOpenGraph(nodeId: string): void;
  /** Explicitly follow a terminal port without conflating it with selection. */
  onNavigateToNode?(sceneId: string | null, nodeId: string): void;
  onBeginEdit?(id: string, label: string): void;
  onSetEditDraft?(
    id: string,
    key: string,
    value: string,
    invalid?: boolean,
  ): void;
  onSetEditError?(id: string, key: string, message: string | null): void;
  onUpdateNode?(editId: string, nodeId: string, node: SceneNode): void;
  onEditText?(id: string, text: string): void;
  onCommitEdit?(id: string, clearedKey?: string): boolean;
  onCancelEdit?(id: string): void;
  activeEdit?: {
    id: string;
    drafts: Record<string, string>;
    invalidDrafts: Record<string, string>;
    errors: Record<string, string>;
  } | null;
}

interface ScriptRow {
  id: string;
  node: SceneNode;
  terminal: boolean;
  terminalLabel: string | null;
  ports: ReturnType<typeof outputPorts>;
}

/**
 * Returns one deterministic, non-repeating authoring chain.  A graph is not
 * silently flattened: branch/choice/jump nodes are emitted as a boundary and
 * the author can jump back to the graph to choose another path.
 */
function buildScriptRows(
  scene: SceneDefinition,
  startId: string = scene.entry,
): ScriptRow[] {
  const result: ScriptRow[] = [];
  const visited = new Set<string>();
  let current: string | undefined = startId;
  while (current !== undefined && scene.nodes[current] !== undefined) {
    if (visited.has(current)) {
      const row = result.at(-1);
      if (row !== undefined) {
        row.terminal = true;
        row.terminalLabel = "回到已展开节点，已停止展开";
      }
      break;
    }
    visited.add(current);
    const node = scene.nodes[current];
    const ports = outputPorts(node);
    const terminal =
      node.type === "choice" ||
      node.type === "condition" ||
      node.type === "jump" ||
      node.type === "end" ||
      ports.length !== 1;
    result.push({
      id: current,
      node,
      terminal,
      terminalLabel:
        node.type === "choice"
          ? "选择分支"
          : node.type === "condition"
            ? "条件分支"
            : node.type === "jump"
              ? "跳转"
              : node.type === "end"
                ? "剧情结束"
                : null,
      ports,
    });
    if (terminal) break;
    const next = ports[0]?.target;
    if (next === undefined || next.length === 0) break;
    current = next;
  }
  return result;
}

/** A selection id that is only trusted when the node still exists. */
function knownNodeId(
  candidate: string | null,
  nodes: Record<string, unknown>,
): string | null {
  return candidate !== null && nodes[candidate] !== undefined
    ? candidate
    : null;
}

export function ScriptView({
  scene,
  manifest,
  selectedNodeId,
  onSelect,
  onChange,
  onInsertAfter,
  onCommitAndInsertAfter,
  onInsertBatch,
  onDelete,
  onDeleteMany,
  deleteDisabled = false,
  onBatchSpeaker,
  onOpenGraph,
  onNavigateToNode,
  onBeginEdit,
  onSetEditDraft,
  onSetEditError,
  onUpdateNode,
  onEditText,
  onCommitEdit,
  onCancelEdit,
  activeEdit,
}: ScriptViewProps): ReactElement {
  // Selection is an inspection concern. Only the selector or an explicit
  // terminal-port click changes which chain is expanded.
  const initialChainStart = scene.entry;
  // A graph selection is the current inspection target, so it seeds both the
  // local multi-select set and the expanded chain on mount.  Switching from the
  // story graph to the script list must make Delete work on the node the author
  // selected there, without re-picking it in the list first.
  const initialSelectedNode = knownNodeId(selectedNodeId, scene.nodes);
  const [chainStartId, setChainStartId] = useState(
    () => initialSelectedNode ?? initialChainStart,
  );
  const [pastePreview, setPastePreview] = useState<{
    afterNodeId: string;
    rows: { speaker: string | null; text: string }[];
    errors: string[];
  } | null>(null);
  const lastSelectedId = useRef<string | null>(selectedNodeId);
  const previousSceneId = useRef(scene.id);
  const rows = useMemo(
    () => buildScriptRows(scene, chainStartId),
    [chainStartId, scene],
  );
  const chainOptions = useMemo(() => buildScriptChainOptions(scene), [scene]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialSelectedNode === null ? [] : [initialSelectedNode]),
  );
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The scoped Delete handler only sees keys that originate inside the list,
    // and the view switch can leave focus on the graph shell or the toolbar.
    // Move it into the list unless the author already focused something here.
    const root = rootRef.current;
    if (root !== null && !root.contains(document.activeElement)) root.focus();
  }, []);

  useEffect(() => {
    if (previousSceneId.current === scene.id) return;
    previousSceneId.current = scene.id;
    // A scene switch starts a fresh authoring chain.  Ordinary row selection
    // must not rebuild the chain, otherwise Ctrl/Shift multi-select hides the
    // rows that were selected earlier.
    // An explicit cross-scene port navigation carries a target node in
    // selectedNodeId.  Start that chain immediately; otherwise the selected
    // node can be outside the entry chain and appear to have disappeared.
    setChainStartId(
      selectedNodeId !== null && scene.nodes[selectedNodeId] !== undefined
        ? selectedNodeId
        : initialChainStart,
    );
    setSelected(new Set(selectedNodeId === null ? [] : [selectedNodeId]));
    lastSelectedId.current = selectedNodeId;
    setPastePreview(null);
  }, [initialChainStart, scene.id, scene.nodes, selectedNodeId]);

  // Edits can replace or remove the node that was used as the current chain
  // origin without changing the scene id (for example, a rename or a
  // contiguous delete in ScriptView).  Keep the chain selector valid instead
  // of rendering an empty list until the user manually picks another chain.
  useEffect(() => {
    if (
      scene.nodes[chainStartId] !== undefined ||
      chainStartId === initialChainStart
    ) {
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChainStartId(initialChainStart);
  }, [chainStartId, initialChainStart, scene.nodes]);

  const commitText = (id: string): void => {
    const node = scene.nodes[id];
    if (node?.type !== "say") return;
    onCommitEdit?.(`say:${scene.id}:${id}`, "text");
  };

  const visibleRows = rows.filter((row) => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return true;
    const text = row.node.type === "say" ? row.node.text : summarize(row.node);
    return `${row.id} ${text}`.toLowerCase().includes(needle);
  });

  const toggleSelected = (
    id: string,
    additive: boolean,
    range: boolean,
  ): void => {
    setSelected((current) => {
      if (range && lastSelectedId.current !== null) {
        const first = rows.findIndex(
          (row) => row.id === lastSelectedId.current,
        );
        const last = rows.findIndex((row) => row.id === id);
        if (first >= 0 && last >= 0) {
          const next = new Set(additive ? current : []);
          for (
            let index = Math.min(first, last);
            index <= Math.max(first, last);
            index++
          )
            next.add(rows[index].id);
          return next;
        }
      }
      const next = additive ? new Set(current) : new Set<string>();
      if (additive && next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastSelectedId.current = id;
    onSelect(id);
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (["TEXTAREA", "INPUT", "SELECT"].includes(target.tagName)) return;
    if (selectedNodeId === null || event.clipboardData.types.length === 0)
      return;
    const text = event.clipboardData.getData("text/plain");
    if (!text.includes("\n") && !text.includes("\t")) return;
    event.preventDefault();
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;
    const rowsToPaste = lines.map((line) => {
      const [speaker, ...lineText] = line.split("\t");
      return {
        speaker: lineText.length > 0 ? speaker.trim() || null : null,
        text: lineText.length > 0 ? lineText.join("\t") : line,
      };
    });
    setPastePreview({
      afterNodeId: selectedNodeId,
      rows: rowsToPaste,
      errors: rowsToPaste.flatMap((row, index) =>
        row.text.trim().length === 0 ? [`第 ${index + 1} 行正文为空`] : [],
      ),
    });
  };

  // Sets preserve click order, not document order.  Batch operations and
  // copied text must follow the visible script order so a Ctrl/Shift
  // selection is deterministic regardless of how the user clicked it.
  const selectedIds = rows
    .filter((row) => selected.has(row.id) && scene.nodes[row.id] !== undefined)
    .map((row) => row.id);
  const navigateToNode = (
    targetScene: string | null,
    targetNode: string,
  ): void => {
    if (targetScene === null || targetScene === scene.id) {
      setChainStartId(targetNode);
      setSelected(new Set([targetNode]));
      lastSelectedId.current = targetNode;
      onSelect(targetNode);
    }
    onNavigateToNode?.(targetScene, targetNode);
  };
  const handleScriptKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    const editing = isEditableTarget(target);
    // A destructive key is ignored for an editable field, an IME composition, a
    // held-down key, focus on an interactive control of this pane (a row or
    // summary button, a select, an open insert menu), an open App dialog
    // (`deleteDisabled`) and the local paste preview.
    const blocked =
      deleteDisabled ||
      pastePreview !== null ||
      shouldIgnoreNodeDeletion({
        target: event.target,
        repeat: event.repeat,
        ...imeState(event),
      }) ||
      isInteractiveTarget(event.target);
    if (
      !blocked &&
      (event.key === "Delete" || event.key === "Backspace") &&
      selectedIds.length > 0
    ) {
      event.preventDefault();
      // One key press deletes once: never let the same event reach another
      // handler (a workspace shortcut, or a future App-level listener).
      event.stopPropagation();
      if (selectedIds.length === 1) onDelete(selectedIds[0]);
      else onDeleteMany?.(selectedIds);
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "a" &&
      !editing
    ) {
      event.preventDefault();
      setSelected(new Set(rows.map((row) => row.id)));
      return;
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "c" &&
      !editing &&
      selectedIds.length > 0
    ) {
      const text = selectedIds
        .map((id) => scene.nodes[id])
        .filter(
          (node): node is Extract<SceneNode, { type: "say" }> =>
            node?.type === "say",
        )
        .map((node) => `${node.speaker ?? ""}\t${node.text}`)
        .join("\n");
      if (text.length > 0) void navigator.clipboard?.writeText(text);
    }
  };

  return (
    <div
      className="script-view"
      onKeyDown={handleScriptKeyDown}
      onPaste={handlePaste}
      ref={rootRef}
      tabIndex={0}
    >
      <div className="script-toolbar">
        <strong>脚本视图</strong>
        <label>
          链段起点
          <select
            aria-label="选择脚本链段"
            onChange={(event) => {
              if (activeEdit !== null && activeEdit !== undefined) {
                if (Object.keys(activeEdit.invalidDrafts).length > 0) return;
                onCommitEdit?.(activeEdit.id);
              }
              setChainStartId(event.currentTarget.value);
              setSelected(new Set([event.currentTarget.value]));
              lastSelectedId.current = event.currentTarget.value;
              onSelect(event.currentTarget.value);
            }}
            value={chainStartId}
          >
            {chainOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <span>{rows.length} 个连续节点</span>
        {selectedIds.length > 1 && <span>{selectedIds.length} 项已选</span>}
        {selectedIds.length > 1 && onBatchSpeaker !== undefined && (
          <select
            aria-label="批量修改角色"
            defaultValue=""
            onChange={(event) => {
              onBatchSpeaker(
                selectedIds,
                event.currentTarget.value === "__narrator"
                  ? null
                  : event.currentTarget.value || null,
              );
              event.currentTarget.value = "";
            }}
          >
            <option value="">批量改角色…</option>
            <option value="__narrator">旁白</option>
            {Object.entries(manifest.characters).map(([id, character]) => (
              <option key={id} value={id}>
                {character.display_name}
              </option>
            ))}
          </select>
        )}
        <input
          aria-label="搜索脚本"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="搜索节点或正文…"
          value={query}
        />
        <small>Enter 插入下一句 · Shift+Enter 换行 · Ctrl/⌘ 点击多选</small>
      </div>
      <div className="script-list">
        {visibleRows.map((row) => {
          const sayEditId = `say:${scene.id}:${row.id}`;
          const draftText =
            activeEdit?.id === sayEditId
              ? (activeEdit.drafts.text ??
                (row.node.type === "say" ? row.node.text : ""))
              : row.node.type === "say"
                ? row.node.text
                : "";
          return (
            <ScriptRowView
              characters={manifest.characters}
              key={row.id}
              node={row.node}
              nodeId={row.id}
              draftText={draftText}
              activeEdit={activeEdit}
              editIdBase={sayEditId}
              onDraftChange={(text) => {
                if (onEditText !== undefined) onEditText(row.id, text);
                else if (row.node.type === "say")
                  onChange(row.id, { ...row.node, text });
                if (onEditText === undefined)
                  onSetEditDraft?.(sayEditId, "text", text, false);
              }}
              onBeginEdit={(field, label) =>
                onBeginEdit?.(
                  field === undefined ? sayEditId : `${sayEditId}:${field}`,
                  label ?? "编辑对话",
                )
              }
              onCommitText={() => {
                commitText(row.id);
              }}
              onCancelDraft={() => {
                onCancelEdit?.(sayEditId);
              }}
              onCommitAndInsertAfter={
                onCommitAndInsertAfter === undefined
                  ? undefined
                  : () => {
                      const text = draftText;
                      const committed = onCommitAndInsertAfter(row.id, text);
                      if (!committed) return;
                      onCommitEdit?.(sayEditId, "text");
                    }
              }
              onChange={(node) => onChange(row.id, node)}
              onSetEditDraft={onSetEditDraft}
              onSetEditError={onSetEditError}
              onUpdateNode={(editId, node) =>
                onUpdateNode?.(editId, row.id, node)
              }
              onDelete={() => onDelete(row.id)}
              onInsertAfter={(portId) => onInsertAfter(row.id, portId)}
              onOpenGraph={() => onOpenGraph(row.id)}
              onNavigateToNode={navigateToNode}
              onSelect={(additive, range) =>
                toggleSelected(row.id, additive, range)
              }
              selected={selected.has(row.id)}
              terminal={row.terminal}
              terminalLabel={row.terminalLabel}
              ports={row.ports}
            />
          );
        })}
        {visibleRows.length === 0 && (
          <p className="script-empty">没有匹配的节点。</p>
        )}
      </div>
      {pastePreview !== null && (
        <div
          aria-label="批量粘贴预览"
          className="script-paste-preview"
          role="dialog"
        >
          <strong>批量粘贴预览</strong>
          <ol>
            {pastePreview.rows.map((row, index) => (
              <li key={`${index}-${row.text}`}>
                {row.speaker ?? "旁白"}：{row.text}
              </li>
            ))}
          </ol>
          {pastePreview.errors.map((message) => (
            <p className="inline-error" key={message}>
              {message}
            </p>
          ))}
          <button
            disabled={pastePreview.errors.length > 0}
            onClick={() => {
              onInsertBatch(pastePreview.afterNodeId, pastePreview.rows);
              setPastePreview(null);
            }}
            type="button"
          >
            确认插入
          </button>
          <button onClick={() => setPastePreview(null)} type="button">
            取消
          </button>
        </div>
      )}
    </div>
  );
}

function ScriptRowView({
  characters,
  node,
  nodeId,
  draftText,
  onDraftChange,
  onBeginEdit,
  onCommitText,
  onCommitAndInsertAfter,
  onCancelDraft,
  onCommitEdit,
  selected,
  terminal,
  terminalLabel,
  ports,
  onSelect,
  onChange,
  onSetEditDraft,
  onSetEditError,
  onUpdateNode,
  onInsertAfter,
  onDelete,
  onOpenGraph,
  onNavigateToNode,
  editIdBase,
  activeEdit,
}: {
  characters: Record<string, CharacterDefinition>;
  node: SceneNode;
  nodeId: string;
  draftText: string;
  onDraftChange(text: string): void;
  onBeginEdit?(field?: string, label?: string): void;
  onCommitText(): void;
  onCommitAndInsertAfter?(): void;
  onCancelDraft?(): void;
  selected: boolean;
  terminal: boolean;
  terminalLabel: string | null;
  ports: ReturnType<typeof outputPorts>;
  onSelect(additive: boolean, range: boolean): void;
  onChange(node: SceneNode): void;
  onSetEditDraft?(
    id: string,
    key: string,
    value: string,
    invalid?: boolean,
  ): void;
  onSetEditError?(id: string, key: string, message: string | null): void;
  onCommitEdit?(id: string, clearedKey?: string): boolean;
  onUpdateNode?(editId: string, node: SceneNode): void;
  onInsertAfter(portId?: string): void;
  onDelete(): void;
  onOpenGraph(): void;
  onNavigateToNode?(sceneId: string | null, nodeId: string): void;
  editIdBase?: string;
  activeEdit?: {
    id: string;
    drafts: Record<string, string>;
    invalidDrafts: Record<string, string>;
    errors: Record<string, string>;
  } | null;
}): ReactElement {
  // Other controls in the same row must carry the current central text draft
  // forward; otherwise a role/mode change dispatched in the next event can be
  // based on the previous render and silently put older text back into the
  // document.
  const changeRowValue = (next: SceneNode): SceneNode =>
    next.type === "say" && node.type === "say"
      ? { ...next, text: draftText }
      : next;
  const fieldId = (field: string): string =>
    `${editIdBase ?? `say:${nodeId}`}:${field}`;
  const fieldValue = (field: string, fallback: string): string =>
    activeEdit?.id === fieldId(field)
      ? (activeEdit.drafts[field] ?? fallback)
      : fallback;
  const fieldError = (field: string): string | null =>
    activeEdit?.id === fieldId(field)
      ? (activeEdit.errors[field] ?? null)
      : null;
  const updateField = (
    field: string,
    next: SceneNode,
    raw: string,
    invalid = false,
  ): void => {
    const id = fieldId(field);
    onBeginEdit?.(field, "编辑对话属性");
    onSetEditDraft?.(id, field, raw, invalid);
    if (invalid) {
      onSetEditError?.(
        id,
        field,
        field === "speed_cps" ? "文字速度必须是有限正数。" : "输入值无效。",
      );
      return;
    }
    onSetEditError?.(id, field, null);
    if (onUpdateNode !== undefined) onUpdateNode(id, next);
    else onChange(next);
  };
  const updateDiscreteField = (
    field: string,
    next: SceneNode,
    label: string,
  ): void => {
    const id = fieldId(field);
    onBeginEdit?.(field, label);
    if (onUpdateNode !== undefined) onUpdateNode(id, next);
    else onChange(next);
    onCommitEdit?.(id);
  };
  const commitField = (field: string): void => {
    onCommitEdit?.(fieldId(field), field);
  };
  const [insertMenuOpen, setInsertMenuOpen] = useState(false);
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancelDraft?.();
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    if (onCommitAndInsertAfter !== undefined) onCommitAndInsertAfter();
    else {
      onCommitText();
      onInsertAfter();
    }
  };
  return (
    <article
      className={`script-row${selected ? " selected" : ""}`}
      onClick={(event) =>
        onSelect(event.ctrlKey || event.metaKey, event.shiftKey)
      }
    >
      <div className="script-row-gutter">
        <code>{nodeId}</code>
        <span>{node.type === "say" ? "对话" : nodeLabel(node.type)}</span>
      </div>
      <div className="script-row-content">
        {node.type === "say" ? (
          <>
            <select
              aria-label={`${nodeId} 角色`}
              onChange={(event) =>
                updateDiscreteField(
                  "speaker",
                  changeRowValue({
                    ...node,
                    speaker: event.currentTarget.value || null,
                  }),
                  "修改角色",
                )
              }
              value={node.speaker ?? ""}
            >
              <option value="">旁白</option>
              {Object.entries(characters).map(([id, character]) => (
                <option key={id} value={id}>
                  {character.display_name} · {id}
                </option>
              ))}
              {node.speaker !== null &&
                characters[node.speaker] === undefined && (
                  <option value={node.speaker}>临时：{node.speaker}</option>
                )}
            </select>
            {((node.speaker !== null &&
              characters[node.speaker] === undefined) ||
              activeEdit?.id === fieldId("speaker")) && (
              <input
                aria-label={`${nodeId} 临时角色名`}
                onBlur={() => commitField("speaker")}
                onChange={(event) => {
                  const raw = event.currentTarget.value;
                  updateField(
                    "speaker",
                    changeRowValue({
                      ...node,
                      speaker: raw || null,
                    }),
                    raw,
                  );
                }}
                onFocus={() => onBeginEdit?.("speaker", "编辑临时角色")}
                placeholder="临时角色名"
                value={fieldValue("speaker", node.speaker ?? "")}
              />
            )}
            {fieldError("speaker") !== null && (
              <small className="inline-error">{fieldError("speaker")}</small>
            )}
            <select
              aria-label={`${nodeId} 显示模式`}
              onChange={(event) =>
                updateDiscreteField(
                  "mode",
                  changeRowValue({
                    ...node,
                    mode: event.currentTarget.value as "start" | "append",
                    page_id:
                      event.currentTarget.value === "append"
                        ? (node.page_id ?? `${nodeId}_page`)
                        : node.page_id,
                  }),
                  "修改显示模式",
                )
              }
              value={node.mode ?? "start"}
            >
              <option value="start">新对话段</option>
              <option value="append">接续对话段</option>
            </select>
            <select
              aria-label={`${nodeId} 揭示动画`}
              onChange={(event) =>
                updateDiscreteField(
                  "reveal_animation",
                  changeRowValue({
                    ...node,
                    reveal_animation:
                      event.currentTarget.value === "default"
                        ? null
                        : (event.currentTarget.value as
                            "line_sweep" | "typewriter" | "drop_fade"),
                  }),
                  "修改揭示动画",
                )
              }
              value={node.reveal_animation ?? "default"}
            >
              <option value="default">默认揭示</option>
              <option value="typewriter">打字机</option>
              <option value="line_sweep">逐行扫入</option>
              <option value="drop_fade">下落淡入</option>
            </select>
            <input
              aria-label={`${nodeId} 速度`}
              min="1"
              onBlur={() => commitField("speed_cps")}
              onChange={(event) => {
                const raw = event.currentTarget.value;
                const speed = raw.trim() === "" ? null : Number(raw);
                updateField(
                  "speed_cps",
                  { ...node, speed_cps: speed },
                  raw,
                  speed !== null && (!Number.isFinite(speed) || speed <= 0),
                );
              }}
              onFocus={() => onBeginEdit?.("speed_cps", "编辑打字速度")}
              placeholder="速度 cps"
              step="1"
              inputMode="decimal"
              type="text"
              value={fieldValue(
                "speed_cps",
                node.speed_cps === null || node.speed_cps === undefined
                  ? ""
                  : String(node.speed_cps),
              )}
            />
            {fieldError("speed_cps") !== null && (
              <small className="inline-error">{fieldError("speed_cps")}</small>
            )}
            <textarea
              aria-label={`${nodeId} 正文`}
              onBlur={onCommitText}
              onFocus={() => onBeginEdit?.()}
              onChange={(event) => onDraftChange(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              value={draftText}
            />
            <small className="script-row-hint">
              {node.mode === "append" ? "接续" : "新段"}
              {node.speaker !== null && characters[node.speaker] === undefined
                ? " · 临时名字"
                : ""}
            </small>
          </>
        ) : (
          <button
            className="script-summary"
            onClick={onOpenGraph}
            type="button"
          >
            {summarize(node)}
          </button>
        )}
      </div>
      <div className="script-row-actions">
        <button
          aria-label={`在 ${nodeId} 后插入对话`}
          onClick={(event) => {
            event.stopPropagation();
            if (ports.length > 1) setInsertMenuOpen((open) => !open);
            else onInsertAfter(ports[0]?.id);
          }}
          type="button"
        >
          ＋
        </button>
        <button aria-label={`删除 ${nodeId}`} onClick={onDelete} type="button">
          ×
        </button>
        {insertMenuOpen && ports.length > 1 && (
          <div aria-label={`${nodeId} 插入出口`} className="script-insert-menu">
            <span>选择插入出口</span>
            {ports.map((port) => (
              <button
                key={port.id}
                onClick={(event) => {
                  event.stopPropagation();
                  setInsertMenuOpen(false);
                  onInsertAfter(port.id);
                }}
                type="button"
              >
                {port.label} → {port.target}
              </button>
            ))}
            <button
              onClick={(event) => {
                event.stopPropagation();
                setInsertMenuOpen(false);
              }}
              type="button"
            >
              取消
            </button>
          </div>
        )}
      </div>
      {terminal && (
        <div className="script-boundary">
          <span>{terminalLabel ?? "执行边界"}</span>
          {ports.length > 0 && (
            <div className="script-ports">
              {ports.map((port) => (
                <button
                  key={port.id}
                  onClick={() => {
                    if (onNavigateToNode !== undefined)
                      onNavigateToNode(port.targetScene, port.target);
                    else onOpenGraph();
                  }}
                  type="button"
                >
                  {port.label} →{" "}
                  {port.targetScene === null
                    ? port.target
                    : `${port.targetScene}/${port.target}`}
                </button>
              ))}
            </div>
          )}
          <button onClick={onOpenGraph} type="button">
            在剧情图查看出口 →
          </button>
        </div>
      )}
    </article>
  );
}

function summarize(node: SceneNode): string {
  switch (node.type) {
    case "choice":
      return node.presentation == null
        ? `${node.choices.length} 个选项`
        : `${node.choices.length} 个选项 · ${node.presentation.template ?? "默认皮肤"} · ${node.presentation.direction === "horizontal" ? "横向" : "纵向"}`;
    case "condition":
      return "条件分支";
    case "jump":
      return `${node.scene ?? "本场景"} / ${node.target}`;
    case "open_window":
      return `副窗口 · ${node.scene}`;
    case "end":
      return "剧情终点";
    case "background":
      return `背景 · ${node.background ?? "清除"}`;
    case "curtain":
      return `幕布 · ${node.action === "cover" ? "落下" : "收起"}`;
    case "screen_effect":
      return node.effect.type === "flash" ? "闪光" : "震动";
    case "sprite":
      return `立绘 · ${node.action} ${node.sprite_id}`;
    case "long_text":
      return `长文本 · ${node.steps.length} 段`;
    case "timeline":
      return `时间线 · ${node.duration_ms} ms`;
    case "bgm":
      return `BGM · ${node.action}`;
    case "ambience":
      return `环境声 ${node.slot} · ${node.action}`;
    case "sfx":
      return `音效 · ${node.asset}`;
    case "wait":
      return `等待 · ${node.duration_ms} ms`;
    default:
      return node.type;
  }
}
