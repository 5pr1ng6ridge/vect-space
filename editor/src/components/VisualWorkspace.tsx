import { useMemo, useState, type ReactElement } from "react";
import { Sparkles, Type } from "lucide-react";

import { DESIGN_HEIGHT, DESIGN_WIDTH } from "@vectspace/presentation-core/scene-frame";
import { validateParticleDefinition, type EmitterSnapshot, type ParticleRange } from "@vectspace/presentation-core/particles";
import { resolveTextBlocks, validateTextBlock } from "@vectspace/presentation-core/text-block";
import { spritePreset } from "@vectspace/presentation-core/visual";
import type { AnimationMap } from "@vectspace/presentation-core/image-animation";

import { assetUrl } from "../api";
import { WorkspaceHeader } from "../shell/WorkspaceHeader";
import type { CuePreviewRequest } from "../presentationPreview";
import type { EditorAsset, EditorProject, ParticleDefinition, TextBlockDefinition } from "../types";
import type { VisualFile, VisualKind } from "../app/visualLibrary";
import type { EditorVisualResources } from "../visualResources";
import { AssetChooser } from "./AssetChooser";
import { CuePreview, type BurstCue, type CuePreviewEnvironment, type DecorationTransport } from "./CuePreview";
import { ColorField, DeferredTextArea, Field, NumberField } from "./Fields";
import { clampToStage, roundedPosition } from "./particleAreaGeometry";
import { ParticleGizmo } from "./ParticleGizmo";
import { errorMessage } from "./errorMessage";

const PREVIEW_ID = "visual.preview";
const CAMERA = { x: 0, y: 0, zoom: 1, rotation_deg: 0 };
/** Where the preview emitter starts; moving it is a preview-only gesture. */
const DEFAULT_PREVIEW_CENTER = { x: DESIGN_WIDTH / 2, y: DESIGN_HEIGHT / 2 };

/** `continuous` keeps one persistent emitter; `burst` replays a transient one. */
type ParticlePreviewMode = "continuous" | "burst";

interface PreviewModel {
  request: CuePreviewRequest;
  visuals: EditorVisualResources;
  transport?: DecorationTransport;
}

function problem(check: () => void): string | null {
  try {
    check();
    return null;
  } catch (reason) {
    return errorMessage(reason);
  }
}

/**
 * Full-screen editor for one fixed text block or one image particle effect.
 *
 * Every field writes the whole definition through `onChange` (one undoable
 * history entry each), and the preview is the shared `SceneSurface` fed with
 * exactly that definition: the text block is shown as a text Sprite, the
 * particle effect as one persistent whole emitter.
 */
export function VisualWorkspace({
  kind,
  file,
  project,
  animationMap,
  dirty,
  onBack,
  onChange,
  onSave,
  onValidate,
  onUndo,
  onRedo,
  undoAvailable,
  redoAvailable,
  previewEnvironment,
}: {
  kind: VisualKind;
  file: VisualFile;
  project: EditorProject;
  animationMap: AnimationMap;
  dirty: boolean;
  onBack(): void;
  onChange(definition: TextBlockDefinition | ParticleDefinition): void;
  onSave(): void;
  onValidate(): void;
  onUndo(): void;
  onRedo(): void;
  undoAvailable: boolean;
  redoAvailable: boolean;
  previewEnvironment?: CuePreviewEnvironment;
}): ReactElement {
  const definition = file.definition;
  const invalid = kind === "textBlock"
    ? problem(() => validateTextBlock(definition as TextBlockDefinition))
    : problem(() => validateParticleDefinition(definition as ParticleDefinition));
  const particleDefinition = kind === "particle" ? (definition as ParticleDefinition) : null;
  // The centre is a preview-only position (a definition has no stage
  // position): it is never written to the definition or the history.
  const [previewCenter, setPreviewCenter] = useState(DEFAULT_PREVIEW_CENTER);
  const [modeChoice, setModeChoice] = useState<ParticlePreviewMode | null>(null);
  // A definition that emits nothing continuously has only its burst to show.
  const mode: ParticlePreviewMode = modeChoice
    ?? (particleDefinition !== null && particleDefinition.rate === 0 ? "burst" : "continuous");
  const preview = useMemo((): PreviewModel | { error: string } => {
    if (invalid !== null) return { error: invalid };
    const urls = Object.fromEntries(project.assets.map((asset) => [asset.id, assetUrl(asset.absolute_path)]));
    const fontVersions = Object.fromEntries(project.assets.filter((asset) => asset.kind === "font")
      .map((asset) => [asset.id, `${project.fingerprint}:${asset.size_bytes ?? ""}`]));
    try {
      if (kind === "textBlock") {
        const text = definition as TextBlockDefinition;
        return {
          visuals: {
            textBlocks: resolveTextBlocks({ [text.id]: text }, urls, project.manifest.default_font, fontVersions),
            particles: {},
          },
          request: {
            world: { sprites: { [PREVIEW_ID]: spritePreset("text", { type: "text", text_block: text.id }) }, emitters: {}, camera: CAMERA },
            cue: null, duration_ms: 0,
          },
        };
      }
      const particle = definition as ParticleDefinition;
      const emitter: EmitterSnapshot = {
        particle: particle.id, seed: particle.seed, generation: 1, space: "world",
        x: previewCenter.x, y: previewCenter.y, scale: 1, rotation_deg: 0, opacity: 1, z: 0,
      };
      const visuals = { textBlocks: {}, particles: { [particle.id]: particle } };
      if (mode === "burst") {
        // A burst is transient: the world holds no emitter, and the cue creates
        // (and later releases) its own batch, so nothing persistent is faked.
        const burst: BurstCue = { cue_id: "visual.preview.burst", gate: "none", type: "particle_state", emitter_id: PREVIEW_ID, emitter, burst: true };
        return {
          visuals,
          request: { world: { sprites: {}, emitters: {}, camera: CAMERA }, cue: null, duration_ms: 0 },
          transport: { durationMs: Math.max(1, Math.ceil(particle.lifetime_ms.max)), burst },
        };
      }
      return {
        visuals,
        request: { world: { sprites: {}, camera: CAMERA, emitters: { [PREVIEW_ID]: emitter } }, cue: null, duration_ms: 0 },
        transport: { durationMs: Math.max(1000, Math.ceil(particle.lifetime_ms.max * 2)) },
      };
    } catch (reason) {
      return { error: errorMessage(reason) };
    }
  }, [definition, invalid, kind, mode, previewCenter, project.assets, project.fingerprint, project.manifest.default_font]);

  return (
    <main className="action-workspace visual-workspace">
      <WorkspaceHeader
        dirty={dirty}
        icon={kind === "textBlock" ? Type : Sparkles}
        kind={kind === "textBlock" ? "固定文本块" : "粒子效果"}
        onBack={onBack}
        onRedo={onRedo}
        onSave={onSave}
        onUndo={onUndo}
        onValidate={onValidate}
        redoAvailable={redoAvailable}
        title={<span title={file.path}>{definition.id}</span>}
        undoAvailable={undoAvailable}
      />
      <section className="action-workspace-body">
        <aside className="action-side-panel">
          {kind === "textBlock"
            ? <TextBlockFields assets={project.assets} definition={definition as TextBlockDefinition} onChange={onChange} />
            : <ParticleFields assets={project.assets} definition={definition as ParticleDefinition} onChange={onChange} />}
        </aside>
        <section className="visual-workspace-preview">
          {particleDefinition !== null && (
            <div aria-label="预览模式" className="segmented visual-preview-modes" role="group">
              {([["continuous", "持续发射"], ["burst", "单次爆发"]] as const).map(([value, text]) => (
                <button aria-pressed={mode === value} className={mode === value ? "is-active" : ""}
                  key={value} onClick={() => setModeChoice(value)} type="button">{text}</button>
              ))}
            </div>
          )}
          {"error" in preview ? (
            <p className="inspector-preview-note" role="alert">无法预览：{preview.error}</p>
          ) : (
            <CuePreview
              animations={animationMap}
              assets={project.assets}
              decorationTransport={preview.transport}
              environment={previewEnvironment}
              label={kind === "textBlock" ? "固定文本块预览" : "粒子效果预览"}
              overlay={particleDefinition === null ? undefined : (
                <ParticleGizmo
                  area={particleDefinition.area.type === "rectangle"
                    ? { width: particleDefinition.area.width, height: particleDefinition.area.height }
                    : null}
                  markerAriaLabel="拖动预览中心（仅预览，不保存）"
                  markerLabel="预览中心 · 不保存"
                  onAreaResize={(size) => onChange({ ...particleDefinition, area: { type: "rectangle", ...size } })}
                  onMarkerDrop={({ pointerDown, pointerNow }) => {
                    setPreviewCenter((current) => clampToStage(roundedPosition({
                      x: current.x + pointerNow.x - pointerDown.x,
                      y: current.y + pointerNow.y - pointerDown.y,
                    })));
                    return false;
                  }}
                  point={previewCenter}
                />
              )}
              request={preview.request}
              visuals={preview.visuals}
            />
          )}
          <p className="inspector-preview-note">
            {kind === "textBlock"
              ? "文本块整体栅格化为一张纹理，可作为 Sprite 移动、缩放、旋转和淡入淡出；不会逐字显示或分页。"
              : mode === "burst"
                ? particleDefinition !== null && particleDefinition.burst_count === 0
                  ? "单次爆发数量为 0，没有粒子可播放；请在左侧设置“单次爆发数量”。"
                  : "单次爆发只创建临时粒子，不会保存发射器；按空格或“重播爆发”从头重播。"
                : "预览为一个持续发射器（空格仅在“单次爆发”模式下重播）；剧情中只能整体移动/缩放/旋转发射器，单个粒子不可选择。"}
          </p>
          {particleDefinition !== null && (
            <p className="inspector-preview-note">
              拖动画面中的预览中心只移动预览位置，不会保存；拖动矩形手柄会修改生成区域的宽 / 高。
              {(previewCenter.x !== DEFAULT_PREVIEW_CENTER.x || previewCenter.y !== DEFAULT_PREVIEW_CENTER.y) && (
                <button onClick={() => setPreviewCenter(DEFAULT_PREVIEW_CENTER)} type="button">回到画面中心</button>
              )}
            </p>
          )}
        </section>
      </section>
    </main>
  );
}

function TextBlockFields({ assets, definition, onChange }: {
  assets: readonly EditorAsset[];
  definition: TextBlockDefinition;
  onChange(definition: TextBlockDefinition): void;
}): ReactElement {
  const set = (patch: Partial<TextBlockDefinition>): void => onChange({ ...definition, ...patch });
  return (
    <>
      <h3>内容</h3>
      <Field label="富文本内容" hint="沿用对话标记与 KaTeX 公式；不支持 HTML / CSS。">
        <DeferredTextArea rows={8} value={definition.content} onCommit={(content) => set({ content })} />
      </Field>
      <h3>尺寸与排版</h3>
      <div className="field-grid">
        <NumberField label="宽度" min={1} max={4096} value={definition.width} onChange={(width) => set({ width: Math.round(width) })} />
        <NumberField label="高度" min={1} max={4096} value={definition.height} onChange={(height) => set({ height: Math.round(height) })} />
        <NumberField label="字号" min={1} max={512} value={definition.font_size} onChange={(font_size) => set({ font_size })} />
        <NumberField label="行高" min={0.5} max={8} step={0.05} value={definition.line_height} onChange={(line_height) => set({ line_height })} />
        <NumberField label="内边距" min={0} value={definition.padding} onChange={(padding) => set({ padding })} />
      </div>
      <Field label="字体（留空使用项目默认字体）">
        <AssetChooser allowEmpty assets={assets} emptyLabel="项目默认字体" kind="font" label="字体"
          value={definition.font ?? null} onChange={(font) => set({ font })} />
      </Field>
      <div className="field-grid">
        <Field label="水平对齐">
          <select value={definition.align} onChange={(event) => set({ align: event.currentTarget.value as TextBlockDefinition["align"] })}>
            <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
          </select>
        </Field>
        <Field label="垂直对齐">
          <select value={definition.vertical_align} onChange={(event) => set({ vertical_align: event.currentTarget.value as TextBlockDefinition["vertical_align"] })}>
            <option value="top">顶部</option><option value="center">居中</option><option value="bottom">底部</option>
          </select>
        </Field>
      </div>
      <h3>颜色</h3>
      <ColorField label="文字颜色" value={definition.color} onChange={(color) => set({ color })} />
      <label className="checkbox-field">
        <span>背景填充</span>
        <input type="checkbox" checked={definition.background != null}
          onChange={(event) => set({ background: event.currentTarget.checked ? "#00000080" : null })} />
      </label>
      {definition.background != null && (
        <ColorField label="背景颜色" value={definition.background} onChange={(background) => set({ background })} />
      )}
    </>
  );
}

function RangeFields({ label, value, min, max, step = 1, onChange }: {
  label: string; value: ParticleRange; min?: number; max?: number; step?: number;
  onChange(value: ParticleRange): void;
}): ReactElement {
  return (
    <div className="field-grid">
      <NumberField label={`${label} 最小`} min={min} max={max} step={step} value={value.min} onChange={(next) => onChange({ ...value, min: next })} />
      <NumberField label={`${label} 最大`} min={min} max={max} step={step} value={value.max} onChange={(next) => onChange({ ...value, max: next })} />
    </div>
  );
}

function ParticleFields({ assets, definition, onChange }: {
  assets: readonly EditorAsset[];
  definition: ParticleDefinition;
  onChange(definition: ParticleDefinition): void;
}): ReactElement {
  const set = (patch: Partial<ParticleDefinition>): void => onChange({ ...definition, ...patch });
  const area = definition.area;
  return (
    <>
      <h3>图片</h3>
      <Field label="粒子图片" hint="单张静态图片，最大 512×512。">
        <AssetChooser assets={assets} kind={["gui", "sprite", "background"]} label="粒子图片"
          value={definition.image} onChange={(image) => set({ image: image ?? "" })} />
      </Field>
      <Field label="混合模式">
        <select value={definition.blend} onChange={(event) => set({ blend: event.currentTarget.value as ParticleDefinition["blend"] })}>
          <option value="normal">普通</option><option value="add">叠加发光</option>
        </select>
      </Field>
      <h3>发射</h3>
      <Field label="发射范围">
        <select value={area.type} onChange={(event) => set({ area: event.currentTarget.value === "point"
          ? { type: "point" } : { type: "rectangle", width: 400, height: 0 } })}>
          <option value="point">单点</option><option value="rectangle">矩形区域</option>
        </select>
      </Field>
      {area.type === "rectangle" && (
        <div className="field-grid">
          <NumberField label="区域宽" min={0} max={16384} value={area.width} onChange={(width) => set({ area: { ...area, width } })} />
          <NumberField label="区域高" min={0} max={16384} value={area.height} onChange={(height) => set({ area: { ...area, height } })} />
        </div>
      )}
      <div className="field-grid">
        <NumberField label="每秒数量" min={0} max={10000} value={definition.rate} onChange={(rate) => set({ rate })} />
        <NumberField label="单次爆发数量" min={0} value={definition.burst_count} onChange={(burst_count) => set({ burst_count: Math.round(burst_count) })} />
        <NumberField label="同时存在上限" min={1} max={5000} value={definition.max_particles} onChange={(max_particles) => set({ max_particles: Math.round(max_particles) })} />
        <NumberField label="随机种子" min={0} max={0xffffffff} value={definition.seed} onChange={(seed) => set({ seed: Math.round(seed) })} />
      </div>
      <RangeFields label="寿命 ms" min={1} max={30000} value={definition.lifetime_ms} onChange={(lifetime_ms) => set({ lifetime_ms })} />
      <h3>运动</h3>
      <RangeFields label="水平速度" value={definition.velocity_x} onChange={(velocity_x) => set({ velocity_x })} />
      <RangeFields label="垂直速度" value={definition.velocity_y} onChange={(velocity_y) => set({ velocity_y })} />
      <div className="field-grid">
        <NumberField label="水平加速度" value={definition.gravity_x} onChange={(gravity_x) => set({ gravity_x })} />
        <NumberField label="垂直加速度" value={definition.gravity_y} onChange={(gravity_y) => set({ gravity_y })} />
      </div>
      <h3>外观</h3>
      <RangeFields label="缩放" min={0.001} max={100} step={0.05} value={definition.size} onChange={(size) => set({ size })} />
      <RangeFields label="初始角度" value={definition.rotation_deg} onChange={(rotation_deg) => set({ rotation_deg })} />
      <RangeFields label="角速度" value={definition.angular_velocity_deg} onChange={(angular_velocity_deg) => set({ angular_velocity_deg })} />
      <div className="field-grid">
        <NumberField label="初始透明度" min={0} max={1} step={0.05} value={definition.alpha_start} onChange={(alpha_start) => set({ alpha_start })} />
        <NumberField label="结束透明度" min={0} max={1} step={0.05} value={definition.alpha_end} onChange={(alpha_end) => set({ alpha_end })} />
      </div>
    </>
  );
}
