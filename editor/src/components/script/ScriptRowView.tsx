import { useState, type KeyboardEvent, type ReactElement } from "react";
import { Plus, Trash2 } from "lucide-react";

import { describeNode } from "../../nodeSummary";
import { nodeLabel, outputPorts } from "../../story";
import { IconButton } from "../../ui/Button";
import { NODE_ICONS } from "../../ui/nodeIcons";
import type { CharacterDefinition, SceneNode } from "../../types";

export function ScriptRowView({
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
  const TypeIcon = NODE_ICONS[node.type];
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
      className={`script-row script-row-${node.type === "say" ? "say" : "other"}${selected ? " selected" : ""}`}
      onClick={(event) =>
        onSelect(event.ctrlKey || event.metaKey, event.shiftKey)
      }
    >
      <div
        className="script-row-gutter"
        title={`${nodeLabel(node.type)} · ${nodeId}`}
      >
        <TypeIcon aria-hidden="true" />
        <code>{nodeId}</code>
      </div>
      <div className="script-row-content">
        {node.type === "say" ? (
          <>
            <div className="script-row-head">
              <select
                aria-label={`${nodeId} 角色`}
                className={`script-speaker${node.speaker === null ? " is-narrator" : ""}`}
                style={
                  node.speaker !== null &&
                  characters[node.speaker]?.name_color != null
                    ? {
                        color:
                          characters[node.speaker]?.name_color ?? undefined,
                      }
                    : undefined
                }
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
                    {character.display_name}
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
              {node.mode === "append" && (
                <span className="script-row-chip">接续上一段</span>
              )}
              {selected && (
                <div className="script-row-advanced">
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
                        speed !== null &&
                          (!Number.isFinite(speed) || speed <= 0),
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
                    <small className="inline-error">
                      {fieldError("speed_cps")}
                    </small>
                  )}
                </div>
              )}
            </div>
            <textarea
              aria-label={`${nodeId} 正文`}
              onBlur={onCommitText}
              onFocus={() => onBeginEdit?.()}
              onChange={(event) => onDraftChange(event.currentTarget.value)}
              onKeyDown={handleKeyDown}
              rows={2}
              value={draftText}
            />
          </>
        ) : node.type === "long_text" ? (
          <div className="script-long-text-readonly">
            <div className="script-long-text-heading">
              <span>
                {describeNode(node, { manifest: { characters } }).summary}
              </span>
              <button
                className="script-long-text-open"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(false, false);
                  onOpenGraph();
                }}
                type="button"
              >
                在剧情图中打开以进入长文本编辑器
              </button>
            </div>
            <ol className="script-long-text-steps">
              {node.steps.map((step, index) => (
                <li key={`${step.id}-${index}`}>
                  {step.page_break_before && (
                    <span className="script-long-text-page-break">分页符</span>
                  )}
                  <div className="script-long-text-step-text">{step.text}</div>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <button
            className="script-summary"
            onClick={onOpenGraph}
            type="button"
          >
            {describeNode(node, { manifest: { characters } }).summary}
          </button>
        )}
      </div>
      <div className="script-row-actions">
        <IconButton
          icon={Plus}
          label={`在 ${nodeId} 后插入对话`}
          onClick={(event) => {
            event.stopPropagation();
            if (ports.length > 1) setInsertMenuOpen((open) => !open);
            else onInsertAfter(ports[0]?.id);
          }}
          size="sm"
          tooltip="在后面插入一句对话"
        />
        <IconButton
          icon={Trash2}
          label={`删除 ${nodeId}`}
          onClick={onDelete}
          size="sm"
          tooltip="删除"
        />
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
