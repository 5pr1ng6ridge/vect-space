import type { ReactElement } from "react";
import type { SpriteTrackSource } from "@vectspace/presentation-core/visual";
import type { EditorAsset, SpriteKind, CoordinateSpace, TextBlockFile } from "../types";
import { AssetChooser } from "./AssetChooser";
import { Field, NumberField } from "./Fields";

interface SpriteSourceFieldsProps {
  value: SpriteTrackSource;
  assets: readonly EditorAsset[];
  textBlocks: readonly TextBlockFile[];
  onChange(patch: Partial<SpriteTrackSource>): void;
}

/** Metadata changes never reapply creation presets to an existing pose. */
export function SpriteSourceFields({ value, assets, textBlocks, onChange }: SpriteSourceFieldsProps): ReactElement {
  const mode = value.source?.type ?? "legacy";
  const layout = value.layout;
  return (
    <>
      <Field label="Sprite 来源">
        <select value={mode} onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(next === "legacy"
            ? { source: undefined }
            : { asset: null, source: next === "image"
              ? { type: "image", asset: value.source?.type === "image" ? value.source.asset : value.asset ?? "" }
              : { type: "text", text_block: value.source?.type === "text" ? value.source.text_block : textBlocks[0]?.definition.id ?? "" } });
        }}>
          <option value="legacy">继承 / 角色表情 / 旧素材</option>
          <option value="image">统一图片来源</option>
          <option value="text">固定文本块</option>
        </select>
      </Field>
      {value.source?.type === "image" && (
        <Field label="Sprite 图片">
          <AssetChooser assets={assets} kind={["background", "sprite", "gui"]} label="Sprite 图片"
            value={value.source.asset} onChange={(asset) => onChange({ source: { type: "image", asset: asset ?? "" }, asset: null })} />
        </Field>
      )}
      {value.source?.type === "text" && (
        <Field label="固定文本块">
          <select value={value.source.text_block} onChange={(event) => onChange({ source: { type: "text", text_block: event.currentTarget.value }, asset: null })}>
            <option value="">选择文本块</option>
            {textBlocks.map((file) => <option key={file.definition.id} value={file.definition.id}>{file.definition.id}</option>)}
          </select>
        </Field>
      )}
      <div className="field-grid">
        <Field label="Sprite 类别" hint="只决定新实例默认值，不重置已有位置和变换。">
          <select value={value.sprite_kind ?? ""} onChange={(event) => onChange({ sprite_kind: (event.currentTarget.value || undefined) as SpriteKind | undefined })}>
            <option value="">继承 / 按来源默认</option>
            <option value="background">背景</option><option value="character">角色</option>
            <option value="item">物品</option><option value="ui">独立 UI 图像</option><option value="text">固定文本</option>
          </select>
        </Field>
        <Field label="坐标空间">
          <select value={value.space ?? ""} onChange={(event) => onChange({ space: (event.currentTarget.value || undefined) as CoordinateSpace | undefined })}>
            <option value="">继承 / 类别默认</option><option value="world">世界（受镜头影响）</option><option value="screen">屏幕（不受镜头影响）</option>
          </select>
        </Field>
      </div>
      <label className="checkbox-field">
        <span>指定布局框</span>
        <input type="checkbox" checked={value.layout != null} onChange={(event) => onChange({ layout: event.currentTarget.checked ? { width: 1920, height: 1080, fit: "contain" } : undefined })} />
      </label>
      {layout != null && (
        <div className="field-grid">
          <NumberField label="布局宽度" min={1} max={16384} value={layout.width} onChange={(width) => onChange({ layout: { ...layout, width } })} />
          <NumberField label="布局高度" min={1} max={16384} value={layout.height} onChange={(height) => onChange({ layout: { ...layout, height } })} />
          <Field label="适配方式">
            <select value={layout.fit} onChange={(event) => onChange({ layout: { ...layout, fit: event.currentTarget.value as typeof layout.fit } })}>
              <option value="contain">完整包含</option><option value="cover">覆盖</option><option value="stretch">拉伸</option>
            </select>
          </Field>
        </div>
      )}
    </>
  );
}
