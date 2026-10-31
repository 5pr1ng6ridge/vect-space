import type { ReactElement } from "react";
import { AssetChooser } from "../AssetChooser";
import { Trash2 } from "lucide-react";
import { IconButton } from "../../ui/Button";
import type { CharacterExpression, EditorAsset } from "../../types";
import { NumberInput } from "./projectInputs";

export function CharacterExpressionEditor({
  assets,
  expression,
  expressionId,
  onChange,
  onDelete,
}: {
  assets: readonly EditorAsset[];
  expression: CharacterExpression;
  expressionId: string;
  onChange(value: CharacterExpression): void;
  onDelete(): void;
}): ReactElement {
  const spriteAssets = assets.filter((asset) => asset.kind === "sprite");
  return (
    <article className="character-expression-card">
      <header>
        <code>{expressionId}</code>
        <IconButton
          onClick={onDelete}
          icon={Trash2}
          label="删除表情"
          size="sm"
        />
      </header>
      <label>
        <span>素材</span>
        <AssetChooser
          assets={spriteAssets}
          kind="sprite"
          label="表情素材"
          onChange={(value) => onChange({ ...expression, asset: value ?? "" })}
          value={expression.asset || null}
        />
      </label>
      <div className="field-grid compact-grid">
        <NumberInput
          label="锚点 X"
          max={1}
          min={0}
          onChange={(anchor_x) => onChange({ ...expression, anchor_x })}
          step={0.01}
          value={expression.anchor_x ?? 0.5}
        />
        <NumberInput
          label="锚点 Y"
          max={1}
          min={0}
          onChange={(anchor_y) => onChange({ ...expression, anchor_y })}
          step={0.01}
          value={expression.anchor_y ?? 1}
        />
        <NumberInput
          label="偏移 X"
          onChange={(offset_x) => onChange({ ...expression, offset_x })}
          value={expression.offset_x ?? 0}
        />
        <NumberInput
          label="偏移 Y"
          onChange={(offset_y) => onChange({ ...expression, offset_y })}
          value={expression.offset_y ?? 0}
        />
        <NumberInput
          label="表情倍率"
          min={0.01}
          onChange={(scale) => onChange({ ...expression, scale })}
          step={0.05}
          value={expression.scale ?? 1}
        />
      </div>
    </article>
  );
}
