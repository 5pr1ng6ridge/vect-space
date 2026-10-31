import type { ReactElement } from "react";
import { Plus } from "lucide-react";
import { IconButton } from "../../ui/Button";
import { DeferredInput } from "../Fields";
import type { CharacterDefinition, EditorAsset } from "../../types";
import { CharacterColorInput, DeferredTextInput } from "./projectInputs";
import { CharacterExpressionEditor } from "./CharacterExpressionEditor";
import { SidebarItemCard } from "./SidebarItemCard";

function withoutKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([candidate]) => candidate !== key),
  );
}

export function CharacterCard({
  assets,
  defaultExpressionSprite,
  definition,
  id,
  onChange,
  onDelete,
  onRename,
  onToggle,
  open,
}: {
  assets: readonly EditorAsset[];
  /** First visible sprite asset, used to seed a new expression; null disables adding. */
  defaultExpressionSprite: string | null;
  definition: CharacterDefinition;
  id: string;
  onChange(definition: CharacterDefinition): void;
  onDelete(): void;
  onRename(): void;
  onToggle(): void;
  open: boolean;
}): ReactElement {
  const expressions = definition.expressions ?? {};
  return (
    <SidebarItemCard
      className="variable-card character-card"
      id={id}
      itemKey={`character:${id}`}
      noun="角色"
      onDelete={onDelete}
      onRename={onRename}
      onToggle={onToggle}
      open={open}
    >
      <label>
        <span>显示名</span>
        <DeferredTextInput
          maxLength={64}
          value={definition.display_name}
          onCommit={(display_name) => onChange({ ...definition, display_name })}
        />
      </label>
      <CharacterColorInput
        label="姓名色"
        onChange={(name_color) => onChange({ ...definition, name_color })}
        value={definition.name_color}
      />
      <CharacterColorInput
        label="正文色"
        onChange={(text_color) => onChange({ ...definition, text_color })}
        value={definition.text_color}
      />
      <label>
        <span>默认表情</span>
        <select
          value={definition.default_expression ?? ""}
          onChange={(event) =>
            onChange({
              ...definition,
              default_expression: event.currentTarget.value || null,
            })
          }
        >
          <option value="">无（由节点指定素材）</option>
          {Object.keys(expressions).map((expressionId) => (
            <option key={expressionId} value={expressionId}>
              {expressionId}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>默认缩放</span>
        <DeferredInput
          min={0.01}
          onCommit={(raw) => {
            const value = Number(raw);
            if (!Number.isFinite(value) || value <= 0) return false;
            onChange({ ...definition, default_scale: value });
          }}
          step={0.05}
          type="number"
          value={String(definition.default_scale ?? 1)}
        />
      </label>
      <div className="character-expression-list">
        <header>
          <span>表情图</span>
          <IconButton
            disabled={defaultExpressionSprite === null}
            onClick={() => {
              if (defaultExpressionSprite === null) return;
              const next = { ...expressions };
              let index = Object.keys(next).length + 1;
              let expressionId = `expression_${index}`;
              while (next[expressionId] !== undefined) {
                index += 1;
                expressionId = `expression_${index}`;
              }
              next[expressionId] = {
                asset: defaultExpressionSprite,
                anchor_x: 0.5,
                anchor_y: 1,
                offset_x: 0,
                offset_y: 0,
                scale: 1,
              };
              onChange({ ...definition, expressions: next });
            }}
            icon={Plus}
            label="添加表情"
            tooltip={
              defaultExpressionSprite === null
                ? "没有可用的立绘素材（或全部已隐藏）"
                : "添加表情"
            }
            size="sm"
            variant="ghost"
          />
        </header>
        {Object.entries(expressions).map(([expressionId, expression]) => (
          <CharacterExpressionEditor
            assets={assets}
            expression={expression}
            expressionId={expressionId}
            key={expressionId}
            onChange={(next) =>
              onChange({
                ...definition,
                expressions: { ...expressions, [expressionId]: next },
              })
            }
            onDelete={() =>
              onChange({
                ...definition,
                expressions: withoutKey(expressions, expressionId),
                default_expression:
                  definition.default_expression === expressionId
                    ? null
                    : definition.default_expression,
              })
            }
          />
        ))}
        {Object.keys(expressions).length === 0 && (
          <small>添加 sprite 素材后，可为角色注册表情。</small>
        )}
      </div>
    </SidebarItemCard>
  );
}
