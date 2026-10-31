import type { ReactElement } from "react";
import { VARIABLE_SCOPE_LABELS, VARIABLE_TYPE_LABELS } from "../../labels";
import type { VariableDefinition, VariableType } from "../../types";
import { defaultScalar } from "../inspector/model";
import { VariableDefaultInput } from "./projectInputs";
import { SidebarItemCard } from "./SidebarItemCard";

export function VariableCard({
  definition,
  id,
  onChange,
  onDelete,
  onRename,
  onToggle,
  open,
}: {
  definition: VariableDefinition;
  id: string;
  onChange(definition: VariableDefinition): void;
  onDelete(): void;
  onRename(): void;
  onToggle(): void;
  open: boolean;
}): ReactElement {
  return (
    <SidebarItemCard
      id={id}
      itemKey={`variable:${id}`}
      noun="变量"
      onDelete={onDelete}
      onRename={onRename}
      onToggle={onToggle}
      open={open}
    >
      <label>
        <span>作用域</span>
        <select
          value={definition.scope}
          onChange={(event) =>
            onChange({
              ...definition,
              scope: event.currentTarget.value as VariableDefinition["scope"],
            })
          }
        >
          <option value="save">{VARIABLE_SCOPE_LABELS.save}</option>
          <option value="profile">{VARIABLE_SCOPE_LABELS.profile}</option>
        </select>
      </label>
      <label>
        <span>类型</span>
        <select
          value={definition.type}
          onChange={(event) => {
            const type = event.currentTarget.value as VariableType;
            onChange({ ...definition, type, default: defaultScalar(type) });
          }}
        >
          <option value="boolean">{VARIABLE_TYPE_LABELS.boolean}</option>
          <option value="integer">{VARIABLE_TYPE_LABELS.integer}</option>
          <option value="number">{VARIABLE_TYPE_LABELS.number}</option>
          <option value="string">{VARIABLE_TYPE_LABELS.string}</option>
        </select>
      </label>
      <label>
        <span>默认值</span>
        <VariableDefaultInput
          definition={definition}
          onChange={(defaultValue) =>
            onChange({ ...definition, default: defaultValue })
          }
        />
      </label>
    </SidebarItemCard>
  );
}
