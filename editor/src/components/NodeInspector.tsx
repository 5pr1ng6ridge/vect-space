import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  NODE_TYPES,
  defaultNode,
  nodeLabel,
  parseScalar,
  scalarKind,
} from "../story";
import type {
  AssetKind,
  ContentManifest,
  ScalarValue,
  SceneDefinition,
  SceneNode,
} from "../types";
import { MarkupPreview } from "./MarkupPreview";

interface NodeInspectorProps {
  scene: SceneDefinition;
  manifest: ContentManifest;
  nodeId: string | null;
  onChange(nodeId: string, node: SceneNode): void;
  onRename(previousId: string, nextId: string): void;
  onDelete(nodeId: string): void;
  onDuplicate(nodeId: string): void;
  onSetEntry(nodeId: string): void;
}

export function NodeInspector({
  scene,
  manifest,
  nodeId,
  onChange,
  onRename,
  onDelete,
  onDuplicate,
  onSetEntry,
}: NodeInspectorProps): ReactElement {
  const node = nodeId === null ? undefined : scene.nodes[nodeId];
  const [idDraft, setIdDraft] = useState(nodeId ?? "");

  if (nodeId === null || node === undefined) {
    return (
      <aside className="inspector empty-inspector">
        <div className="empty-state compact">
          <span className="empty-glyph">⌁</span>
          <p>选择一个节点以编辑属性</p>
        </div>
      </aside>
    );
  }

  const update = (next: SceneNode): void => onChange(nodeId, next);
  const fallback =
    Object.keys(scene.nodes).find((id) => id !== nodeId) ?? nodeId;

  return (
    <aside className="inspector">
      <header className="inspector-header">
        <div>
          <span className="eyebrow">NODE INSPECTOR</span>
          <h2>{nodeLabel(node.type)}</h2>
        </div>
        {scene.entry === nodeId && <span className="entry-chip">ENTRY</span>}
      </header>

      <section className="inspector-section">
        <Field label="节点 ID" hint="存档会引用此 ID">
          <div className="inline-field">
            <input
              value={idDraft}
              onChange={(event) => setIdDraft(event.currentTarget.value)}
            />
            <button
              disabled={idDraft === nodeId || idDraft.trim() === ""}
              onClick={() => {
                if (
                  window.confirm(
                    "重命名节点会破坏使用旧 ID 的既有存档。确定要更新全部剧情引用吗？",
                  )
                ) {
                  onRename(nodeId, idDraft.trim());
                }
              }}
              type="button"
            >
              重命名
            </button>
          </div>
        </Field>
        <Field label="节点类型">
          <select
            value={node.type}
            onChange={(event) => {
              const nextType = event.currentTarget.value as SceneNode["type"];
              if (window.confirm("切换节点类型会重置该节点的专有字段。")) {
                update(defaultNode(nextType, fallback));
              }
            }}
          >
            {NODE_TYPES.map((candidate) => (
              <option key={candidate.type} value={candidate.type}>
                {candidate.group} · {candidate.label}
              </option>
            ))}
          </select>
        </Field>
      </section>

      <section className="inspector-section node-fields">
        {renderFields(node, update, scene, manifest)}
      </section>

      <section className="inspector-section inspector-actions">
        <button
          disabled={scene.entry === nodeId}
          onClick={() => onSetEntry(nodeId)}
          type="button"
        >
          设为场景入口
        </button>
        <button onClick={() => onDuplicate(nodeId)} type="button">
          复制节点
        </button>
        <button
          className="danger-button"
          onClick={() => onDelete(nodeId)}
          type="button"
        >
          删除节点
        </button>
      </section>
    </aside>
  );
}

function renderFields(
  node: SceneNode,
  update: (node: SceneNode) => void,
  scene: SceneDefinition,
  manifest: ContentManifest,
): ReactNode {
  const targets = Object.keys(scene.nodes);
  switch (node.type) {
    case "background":
      return (
        <>
          <AssetSelect
            allowNone
            kind="background"
            label="背景素材"
            manifest={manifest}
            onChange={(background) => update({ ...node, background })}
            value={node.background}
          />
          <Field label="转场">
            <select
              value={node.transition}
              onChange={(event) =>
                update({
                  ...node,
                  transition: event.currentTarget
                    .value as typeof node.transition,
                })
              }
            >
              <option value="cut">直接切换</option>
              <option value="cross_fade">交叉淡化</option>
            </select>
          </Field>
          <AnimationFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "sprite":
      return (
        <>
          <TextField
            label="立绘实例 ID"
            onChange={(sprite_id) => update({ ...node, sprite_id })}
            value={node.sprite_id}
          />
          <Field label="动作">
            <select
              value={node.action}
              onChange={(event) =>
                update({
                  ...node,
                  action: event.currentTarget.value as typeof node.action,
                })
              }
            >
              <option value="show">显示</option>
              <option value="move">移动 / 修改</option>
              <option value="hide">隐藏</option>
            </select>
          </Field>
          <AssetSelect
            allowNone={node.action !== "show"}
            kind="sprite"
            label="立绘素材"
            manifest={manifest}
            onChange={(asset) => update({ ...node, asset })}
            value={node.asset}
          />
          <div className="field-grid">
            <OptionalNumber
              label="X"
              onChange={(x) => update({ ...node, x })}
              value={node.x}
            />
            <OptionalNumber
              label="Y"
              onChange={(y) => update({ ...node, y })}
              value={node.y}
            />
            <OptionalNumber
              label="缩放"
              min={0.001}
              onChange={(scale) => update({ ...node, scale })}
              step={0.05}
              value={node.scale}
            />
            <OptionalNumber
              label="透明度"
              max={1}
              min={0}
              onChange={(opacity) => update({ ...node, opacity })}
              step={0.05}
              value={node.opacity}
            />
            <OptionalNumber
              label="层级 Z"
              onChange={(z) => update({ ...node, z })}
              step={1}
              value={node.z}
            />
          </div>
          <AnimationFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "say":
      return (
        <>
          <TextField
            allowEmpty
            label="说话人"
            onChange={(speaker) =>
              update({ ...node, speaker: speaker === "" ? null : speaker })
            }
            value={node.speaker ?? ""}
          />
          <Field label="对话文本" hint="支持 KaTeX、pause、speed 和 fx 标记">
            <textarea
              rows={8}
              value={node.text}
              onChange={(event) =>
                update({ ...node, text: event.currentTarget.value })
              }
            />
          </Field>
          <Field label="实际渲染预览">
            <MarkupPreview source={node.text} />
          </Field>
          <OptionalNumber
            label="文字速度 CPS"
            min={0.1}
            onChange={(speed_cps) => update({ ...node, speed_cps })}
            value={node.speed_cps}
          />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "choice":
      return (
        <>
          <div className="choice-editor-list">
            {node.choices.map((choice, index) => (
              <article className="choice-editor" key={`${choice.id}-${index}`}>
                <header>
                  <strong>选项 {index + 1}</strong>
                  <div>
                    <button
                      disabled={index === 0}
                      onClick={() => {
                        const choices = [...node.choices];
                        [choices[index - 1], choices[index]] = [
                          choices[index],
                          choices[index - 1],
                        ];
                        update({ ...node, choices });
                      }}
                      type="button"
                    >
                      ↑
                    </button>
                    <button
                      disabled={index === node.choices.length - 1}
                      onClick={() => {
                        const choices = [...node.choices];
                        [choices[index], choices[index + 1]] = [
                          choices[index + 1],
                          choices[index],
                        ];
                        update({ ...node, choices });
                      }}
                      type="button"
                    >
                      ↓
                    </button>
                    <button
                      className="danger-text"
                      onClick={() =>
                        update({
                          ...node,
                          choices: node.choices.filter(
                            (_candidate, candidateIndex) =>
                              candidateIndex !== index,
                          ),
                        })
                      }
                      type="button"
                    >
                      删除
                    </button>
                  </div>
                </header>
                <TextField
                  label="ID"
                  onChange={(id) =>
                    update({
                      ...node,
                      choices: node.choices.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, id }
                          : candidate,
                      ),
                    })
                  }
                  value={choice.id}
                />
                <TextField
                  label="文本"
                  onChange={(label) =>
                    update({
                      ...node,
                      choices: node.choices.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, label }
                          : candidate,
                      ),
                    })
                  }
                  value={choice.label}
                />
                <TargetSelect
                  label="目标"
                  onChange={(next) =>
                    update({
                      ...node,
                      choices: node.choices.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, next }
                          : candidate,
                      ),
                    })
                  }
                  targets={targets}
                  value={choice.next}
                />
                <MarkupPreview source={choice.label} />
              </article>
            ))}
          </div>
          <button
            className="wide-button"
            onClick={() => {
              let index = node.choices.length + 1;
              while (
                node.choices.some((choice) => choice.id === `option_${index}`)
              )
                index += 1;
              update({
                ...node,
                choices: [
                  ...node.choices,
                  {
                    id: `option_${index}`,
                    label: `选项 ${index}`,
                    next: targets[0] ?? "",
                  },
                ],
              });
            }}
            type="button"
          >
            ＋ 添加选项
          </button>
        </>
      );
    case "set":
      return (
        <>
          <TextField
            label="变量名"
            onChange={(variable) => update({ ...node, variable })}
            value={node.variable}
          />
          <ScalarEditor
            label="值"
            onChange={(value) => update({ ...node, value })}
            value={node.value}
          />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "branch":
      return (
        <>
          <TextField
            label="变量名"
            onChange={(variable) => update({ ...node, variable })}
            value={node.variable}
          />
          <ScalarEditor
            label="等于"
            onChange={(equals) => update({ ...node, equals })}
            value={node.equals}
          />
          <TargetSelect
            label="相等时"
            onChange={(then) => update({ ...node, then })}
            targets={targets}
            value={node.then}
          />
          <TargetSelect
            label="否则"
            onChange={(otherwise) => update({ ...node, otherwise })}
            targets={targets}
            value={node.otherwise}
          />
        </>
      );
    case "jump": {
      const targetScene = node.scene === null ? scene : undefined;
      return (
        <>
          <Field label="目标场景" hint="留空表示当前场景">
            <select
              value={node.scene ?? ""}
              onChange={(event) =>
                update({ ...node, scene: event.currentTarget.value || null })
              }
            >
              <option value="">当前场景</option>
              {manifest.scenes.map((path) => {
                const id =
                  path
                    .split("/")
                    .at(-1)
                    ?.replace(/\.ya?ml$/, "") ?? path;
                return (
                  <option key={path} value={id}>
                    {id}
                  </option>
                );
              })}
            </select>
          </Field>
          {targetScene !== undefined ? (
            <TargetSelect
              label="目标节点"
              onChange={(target) => update({ ...node, target })}
              targets={Object.keys(targetScene.nodes)}
              value={node.target}
            />
          ) : (
            <TextField
              label="目标节点 ID"
              onChange={(target) => update({ ...node, target })}
              value={node.target}
            />
          )}
        </>
      );
    }
    case "wait":
      return (
        <>
          <NumberField
            label="等待毫秒"
            max={60000}
            min={0}
            onChange={(duration_ms) => update({ ...node, duration_ms })}
            step={50}
            value={node.duration_ms}
          />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "bgm":
      return (
        <>
          <Field label="动作">
            <select
              value={node.action}
              onChange={(event) =>
                update({
                  ...node,
                  action: event.currentTarget.value as typeof node.action,
                })
              }
            >
              <option value="start">开始</option>
              <option value="stop">停止</option>
            </select>
          </Field>
          <AssetSelect
            allowNone={node.action === "stop"}
            kind="bgm"
            label="BGM 素材"
            manifest={manifest}
            onChange={(asset) => update({ ...node, asset })}
            value={node.asset}
          />
          <NumberField
            label="音量"
            max={1}
            min={0}
            onChange={(volume) => update({ ...node, volume })}
            step={0.05}
            value={node.volume}
          />
          <AwaitFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "sfx":
      return (
        <>
          <AssetSelect
            kind="sfx"
            label="音效素材"
            manifest={manifest}
            onChange={(asset) => update({ ...node, asset: asset ?? "" })}
            value={node.asset}
          />
          <NumberField
            label="音量"
            max={1}
            min={0}
            onChange={(volume) => update({ ...node, volume })}
            step={0.05}
            value={node.volume}
          />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "camera":
      return (
        <>
          <div className="field-grid">
            <NumberField
              label="X"
              onChange={(x) => update({ ...node, x })}
              value={node.x}
            />
            <NumberField
              label="Y"
              onChange={(y) => update({ ...node, y })}
              value={node.y}
            />
            <NumberField
              label="缩放"
              min={0.001}
              onChange={(zoom) => update({ ...node, zoom })}
              step={0.05}
              value={node.zoom}
            />
          </div>
          <AnimationFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "screen_effect":
      return (
        <>
          <Field label="效果">
            <select
              value={node.effect}
              onChange={(event) =>
                update({
                  ...node,
                  effect: event.currentTarget.value as typeof node.effect,
                })
              }
            >
              <option value="flash">闪光</option>
              <option value="shake">震动</option>
            </select>
          </Field>
          <AwaitFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "dialogue_ui":
      return (
        <>
          <BooleanField
            label="显示对话框"
            onChange={(visible) => update({ ...node, visible })}
            value={node.visible}
          />
          <AwaitFields node={node} onChange={update} />
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "end":
      return (
        <p className="field-note">
          终点节点没有出口。运行时将在这里显示结束状态。
        </p>
      );
  }
}

function AnimationFields({
  node,
  onChange,
}: {
  node: Extract<SceneNode, { type: "background" | "sprite" | "camera" }>;
  onChange(node: SceneNode): void;
}): ReactElement {
  return (
    <>
      <AwaitFields node={node} onChange={onChange} />
      <Field label="缓动">
        <select
          value={node.easing}
          onChange={(event) =>
            onChange({
              ...node,
              easing: event.currentTarget.value as typeof node.easing,
            })
          }
        >
          <option value="linear">linear</option>
          <option value="ease_in">ease in</option>
          <option value="ease_out">ease out</option>
          <option value="ease_in_out">ease in/out</option>
        </select>
      </Field>
    </>
  );
}

function AwaitFields({
  node,
  onChange,
}: {
  node: Extract<SceneNode, { duration_ms: number; await: boolean }>;
  onChange(node: SceneNode): void;
}): ReactElement {
  return (
    <div className="field-grid">
      <NumberField
        label="时长 ms"
        max={60000}
        min={0}
        onChange={(duration_ms) => onChange({ ...node, duration_ms })}
        step={50}
        value={node.duration_ms}
      />
      <BooleanField
        label="等待完成"
        onChange={(awaitCompletion) =>
          onChange({ ...node, await: awaitCompletion })
        }
        value={node.await}
      />
    </div>
  );
}

function AssetSelect({
  allowNone = false,
  kind,
  label,
  manifest,
  onChange,
  value,
}: {
  allowNone?: boolean;
  kind: AssetKind;
  label: string;
  manifest: ContentManifest;
  onChange(value: string | null): void;
  value: string | null;
}): ReactElement {
  const assets = useMemo(
    () =>
      Object.entries(manifest.assets).filter(
        ([, asset]) => asset.kind === kind,
      ),
    [kind, manifest.assets],
  );
  return (
    <Field label={label}>
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.currentTarget.value || null)}
      >
        {allowNone && <option value="">— 无 —</option>}
        {!allowNone && <option value="">— 请选择 —</option>}
        {assets.map(([id]) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </Field>
  );
}

function ScalarEditor({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange(value: ScalarValue): void;
  value: ScalarValue;
}): ReactElement {
  const kind = scalarKind(value);
  return (
    <Field label={label}>
      <div className="scalar-editor">
        <select
          value={kind}
          onChange={(event) => {
            const nextKind = event.currentTarget.value as typeof kind;
            onChange(
              nextKind === "boolean" ? false : nextKind === "number" ? 0 : "",
            );
          }}
        >
          <option value="text">文本</option>
          <option value="number">数字</option>
          <option value="boolean">布尔</option>
        </select>
        {kind === "boolean" ? (
          <select
            value={String(value)}
            onChange={(event) =>
              onChange(parseScalar(event.currentTarget.value, kind))
            }
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            type={kind === "number" ? "number" : "text"}
            value={String(value)}
            onChange={(event) =>
              onChange(parseScalar(event.currentTarget.value, kind))
            }
          />
        )}
      </div>
    </Field>
  );
}

function Field({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: string;
  label: string;
}): ReactElement {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined && <small>{hint}</small>}
    </label>
  );
}

function TextField({
  allowEmpty = false,
  label,
  onChange,
  value,
}: {
  allowEmpty?: boolean;
  label: string;
  onChange(value: string): void;
  value: string;
}): ReactElement {
  return (
    <Field label={label}>
      <input
        required={!allowEmpty}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </Field>
  );
}

function NumberField({
  label,
  max,
  min,
  onChange,
  step = 1,
  value,
}: {
  label: string;
  max?: number;
  min?: number;
  onChange(value: number): void;
  step?: number;
  value: number;
}): ReactElement {
  return (
    <Field label={label}>
      <input
        max={max}
        min={min}
        step={step}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </Field>
  );
}

function OptionalNumber({
  label,
  max,
  min,
  onChange,
  step = 1,
  value,
}: {
  label: string;
  max?: number;
  min?: number;
  onChange(value: number | null): void;
  step?: number;
  value: number | null;
}): ReactElement {
  return (
    <Field label={label}>
      <input
        max={max}
        min={min}
        placeholder="保持不变"
        step={step}
        type="number"
        value={value ?? ""}
        onChange={(event) =>
          onChange(
            event.currentTarget.value === ""
              ? null
              : Number(event.currentTarget.value),
          )
        }
      />
    </Field>
  );
}

function BooleanField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange(value: boolean): void;
  value: boolean;
}): ReactElement {
  return (
    <label className="boolean-field">
      <input
        checked={value}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

function TargetSelect({
  label,
  onChange,
  targets,
  value,
}: {
  label: string;
  onChange(value: string): void;
  targets: string[];
  value: string;
}): ReactElement {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {!targets.includes(value) && (
          <option value={value}>{value || "— 缺少目标 —"}</option>
        )}
        {targets.map((target) => (
          <option key={target} value={target}>
            {target}
          </option>
        ))}
      </select>
    </Field>
  );
}
