import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import { NODE_TYPES, defaultCondition, defaultNode, nodeLabel } from "../story";
import { interpolateTemplate } from "../textTemplate";
import type {
  AssetKind,
  ConditionExpression,
  ContentManifest,
  MutationValue,
  ScalarValue,
  SceneDefinition,
  SceneNode,
  ValueOperand,
  VariableOperation,
  VariableType,
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
    case "say": {
      const speakerMode =
        node.speaker === null
          ? "narrator"
          : manifest.characters[node.speaker] !== undefined
            ? "character"
            : "temporary";
      const character =
        speakerMode === "character" && node.speaker !== null
          ? manifest.characters[node.speaker]
          : undefined;
      return (
        <>
          <Field label="说话人模式">
            <select
              value={speakerMode}
              onChange={(event) => {
                const mode = event.currentTarget.value;
                update({
                  ...node,
                  speaker:
                    mode === "narrator"
                      ? null
                      : mode === "character"
                        ? (Object.keys(manifest.characters)[0] ?? "")
                        : "临时角色",
                });
              }}
            >
              <option value="narrator">旁白</option>
              <option
                disabled={Object.keys(manifest.characters).length === 0}
                value="character"
              >
                已定义角色
              </option>
              <option value="temporary">临时名字</option>
            </select>
          </Field>
          {speakerMode === "character" && (
            <Field label="角色">
              <select
                value={node.speaker ?? ""}
                onChange={(event) =>
                  update({ ...node, speaker: event.currentTarget.value })
                }
              >
                {Object.entries(manifest.characters).map(([id, definition]) => (
                  <option key={id} value={id}>
                    {definition.display_name} · {id}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {speakerMode === "temporary" && (
            <TextField
              label="临时显示名"
              onChange={(speaker) => update({ ...node, speaker })}
              value={node.speaker ?? ""}
            />
          )}
          {character !== undefined && (
            <div className="character-style-preview">
              <span style={{ color: character.name_color ?? undefined }}>
                {character.display_name}
              </span>
              <span style={{ color: character.text_color ?? undefined }}>
                正文颜色预览
              </span>
            </div>
          )}
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
            <MarkupPreview source={interpolatePreview(node.text, manifest)} />
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
    }
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
                <OptionalConditionEditor
                  label="显示条件"
                  manifest={manifest}
                  onChange={(visible_if) =>
                    update({
                      ...node,
                      choices: node.choices.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, visible_if }
                          : candidate,
                      ),
                    })
                  }
                  value={choice.visible_if}
                />
                <OptionalConditionEditor
                  label="可用条件"
                  manifest={manifest}
                  onChange={(enabled_if) =>
                    update({
                      ...node,
                      choices: node.choices.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, enabled_if }
                          : candidate,
                      ),
                    })
                  }
                  value={choice.enabled_if}
                />
                <MarkupPreview
                  source={interpolatePreview(choice.label, manifest)}
                />
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
          <Field label="目标变量">
            <select
              value={node.variable}
              onChange={(event) => {
                const variable = event.currentTarget.value;
                const targetType =
                  manifest.variables[variable]?.type ?? "boolean";
                update({
                  ...node,
                  variable,
                  op: "assign",
                  value: defaultScalar(targetType),
                });
              }}
            >
              {!manifest.variables[node.variable] && (
                <option value={node.variable}>
                  {node.variable || "— 未声明 —"}
                </option>
              )}
              {Object.entries(manifest.variables).map(([id, definition]) => (
                <option key={id} value={id}>
                  {id} · {definition.type}
                </option>
              ))}
            </select>
          </Field>
          <Field label="操作">
            <select
              value={node.op ?? "assign"}
              onChange={(event) => {
                const op = event.currentTarget.value as NonNullable<
                  typeof node.op
                >;
                update({
                  ...node,
                  op,
                  value:
                    op === "toggle"
                      ? undefined
                      : defaultSetValue(node.variable, op, manifest),
                });
              }}
            >
              {SET_OPERATIONS.map(({ value, label }) => (
                <option
                  disabled={
                    !operationSupportsTarget(
                      value,
                      manifest.variables[node.variable]?.type,
                    )
                  }
                  key={value}
                  value={value}
                >
                  {label}
                </option>
              ))}
            </select>
          </Field>
          {(node.op ?? "assign") !== "toggle" && (
            <MutationValueEditor
              manifest={manifest}
              node={node}
              onChange={(value) => update({ ...node, value })}
            />
          )}
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
          />
        </>
      );
    case "condition":
      return (
        <>
          <ConditionEditor
            manifest={manifest}
            onChange={(condition) => update({ ...node, condition })}
            value={node.condition}
          />
          <TargetSelect
            label="条件成立"
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
    case "playback":
      return (
        <>
          <Field label="自动播放策略">
            <select
              value={node.auto}
              onChange={(event) =>
                update({
                  ...node,
                  auto: event.currentTarget.value as typeof node.auto,
                })
              }
            >
              <option value="normal">普通（由玩家切换自动）</option>
              <option value="forced">强制自动，禁止手动推进</option>
            </select>
          </Field>
          <Field label="Ctrl 快进策略">
            <select
              value={node.ctrl_fast_forward}
              onChange={(event) =>
                update({
                  ...node,
                  ctrl_fast_forward: event.currentTarget
                    .value as typeof node.ctrl_fast_forward,
                })
              }
            >
              <option value="allow">允许</option>
              <option value="block">禁止</option>
            </select>
          </Field>
          <TargetSelect
            label="下一节点"
            onChange={(next) => update({ ...node, next })}
            targets={targets}
            value={node.next}
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
          {node.action === "start" && (
            <>
              <NumberField
                label="起播 ms"
                min={0}
                onChange={(start_ms) => update({ ...node, start_ms })}
                step={100}
                value={node.start_ms ?? 0}
              />
              <BooleanField
                label="自定义循环段"
                onChange={(enabled) =>
                  update({
                    ...node,
                    loop_start_ms: enabled ? 0 : null,
                    loop_end_ms: enabled ? 1000 : null,
                  })
                }
                value={node.loop_start_ms != null && node.loop_end_ms != null}
              />
              {node.loop_start_ms != null && node.loop_end_ms != null && (
                <div className="field-grid">
                  <NumberField
                    label="循环起点 ms"
                    min={0}
                    onChange={(loop_start_ms) =>
                      update({ ...node, loop_start_ms })
                    }
                    step={100}
                    value={node.loop_start_ms}
                  />
                  <NumberField
                    label="循环终点 ms"
                    min={0}
                    onChange={(loop_end_ms) => update({ ...node, loop_end_ms })}
                    step={100}
                    value={node.loop_end_ms}
                  />
                </div>
              )}
            </>
          )}
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
    case "timeline":
      return (
        <>
          <NumberField
            label="时间线时长 ms"
            max={1_800_000}
            min={1}
            onChange={(duration_ms) => update({ ...node, duration_ms })}
            step={100}
            value={node.duration_ms}
          />
          <BooleanField
            label="等待时间线完成"
            onChange={(awaitCompletion) =>
              update({
                ...node,
                await: awaitCompletion,
                skippable: awaitCompletion ? node.skippable : false,
              })
            }
            value={node.await}
          />
          <BooleanField
            label="允许手动跳过"
            onChange={(skippable) => update({ ...node, skippable })}
            value={node.skippable}
          />
          <p className="field-note">
            在底部“关键帧”工作区编辑轨道、事件和缓动曲线。
          </p>
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

const SET_OPERATIONS: { value: VariableOperation; label: string }[] = [
  { value: "assign", label: "assign · 赋值" },
  { value: "add", label: "add · 加" },
  { value: "sub", label: "sub · 减" },
  { value: "mul", label: "mul · 乘" },
  { value: "mod", label: "mod · 取模" },
  { value: "append", label: "append · 追加文本" },
  { value: "toggle", label: "toggle · 布尔翻转" },
];

function operationSupportsTarget(
  operation: VariableOperation,
  target: VariableType | undefined,
): boolean {
  if (target === undefined || operation === "assign") return true;
  if (target === "boolean") return operation === "toggle";
  if (target === "string") return operation === "append";
  if (target === "integer")
    return ["add", "sub", "mul", "mod"].includes(operation);
  return ["add", "sub", "mul"].includes(operation);
}

function MutationValueEditor({
  manifest,
  node,
  onChange,
}: {
  manifest: ContentManifest;
  node: Extract<SceneNode, { type: "set" }>;
  onChange(value: MutationValue): void;
}): ReactElement {
  const op = node.op ?? "assign";
  const targetType = manifest.variables[node.variable]?.type ?? "boolean";
  const value = node.value ?? defaultSetValue(node.variable, op, manifest);
  const variableValue =
    typeof value === "object" && value !== null ? value.variable : null;
  const eligibleVariables = Object.entries(manifest.variables).filter(
    ([, definition]) =>
      mutationTypesCompatible(targetType, definition.type, op),
  );
  return (
    <Field label="操作数">
      <div className="operand-editor">
        <select
          value={variableValue === null ? "literal" : "variable"}
          onChange={(event) =>
            onChange(
              event.currentTarget.value === "variable"
                ? { variable: eligibleVariables[0]?.[0] ?? "" }
                : defaultScalar(targetType),
            )
          }
        >
          <option value="literal">字面量</option>
          <option value="variable">变量</option>
        </select>
        {variableValue === null ? (
          <LiteralEditor
            expectedType={targetType}
            onChange={onChange}
            value={value as ScalarValue}
          />
        ) : (
          <select
            value={variableValue}
            onChange={(event) =>
              onChange({ variable: event.currentTarget.value })
            }
          >
            {!eligibleVariables.some(([id]) => id === variableValue) && (
              <option value={variableValue}>
                {variableValue || "— 无兼容变量 —"}
              </option>
            )}
            {eligibleVariables.map(([id, definition]) => (
              <option key={id} value={id}>
                {id} · {definition.type}
              </option>
            ))}
          </select>
        )}
      </div>
    </Field>
  );
}

function defaultSetValue(
  variable: string,
  op: NonNullable<Extract<SceneNode, { type: "set" }>["op"]>,
  manifest: ContentManifest,
): MutationValue {
  const type = manifest.variables[variable]?.type ?? "boolean";
  if (op === "append") return "";
  return defaultScalar(type);
}

function mutationTypesCompatible(
  target: VariableType,
  source: VariableType,
  op: NonNullable<Extract<SceneNode, { type: "set" }>["op"]>,
): boolean {
  switch (op) {
    case "assign":
      return target === source || (target === "number" && source === "integer");
    case "add":
    case "sub":
    case "mul":
      return (
        (target === "integer" || target === "number") &&
        (source === "integer" || source === "number") &&
        (target !== "integer" || source === "integer")
      );
    case "mod":
      return target === "integer" && source === "integer";
    case "append":
      return target === "string" && source === "string";
    case "toggle":
      return false;
  }
}

function interpolatePreview(source: string, manifest: ContentManifest): string {
  try {
    return interpolateTemplate(source, (id) => {
      const definition = manifest.variables[id];
      if (definition === undefined) throw new Error(`未知变量 ${id}`);
      return definition.default;
    });
  } catch {
    return source;
  }
}

const COMPARISON_OPERATORS = ["eq", "ne", "lt", "le", "gt", "ge"] as const;
type ComparisonOperator = (typeof COMPARISON_OPERATORS)[number];

function OptionalConditionEditor({
  label,
  manifest,
  onChange,
  value,
}: {
  label: string;
  manifest: ContentManifest;
  onChange(value: ConditionExpression | undefined): void;
  value: ConditionExpression | undefined;
}): ReactElement {
  const fallbackVariable = Object.keys(manifest.variables)[0] ?? "flag";
  return (
    <div className="optional-condition">
      <BooleanField
        label={label}
        onChange={(enabled) =>
          onChange(
            enabled ? (value ?? defaultCondition(fallbackVariable)) : undefined,
          )
        }
        value={value !== undefined}
      />
      {value !== undefined && (
        <ConditionEditor
          manifest={manifest}
          onChange={onChange}
          value={value}
        />
      )}
    </div>
  );
}

function ConditionEditor({
  manifest,
  onChange,
  value,
}: {
  manifest: ContentManifest;
  onChange(value: ConditionExpression): void;
  value: ConditionExpression;
}): ReactElement {
  const fallbackVariable = Object.keys(manifest.variables)[0] ?? "flag";
  return (
    <div className="condition-editor">
      <Field label="运算符">
        <select
          value={value.op}
          onChange={(event) =>
            onChange(
              conditionForOperator(
                event.currentTarget.value as ConditionExpression["op"],
                value,
                fallbackVariable,
              ),
            )
          }
        >
          <option value="eq">Eq · 等于</option>
          <option value="ne">Ne · 不等于</option>
          <option value="lt">Lt · 小于</option>
          <option value="le">Le · 小于等于</option>
          <option value="gt">Gt · 大于</option>
          <option value="ge">Ge · 大于等于</option>
          <option value="and">And · 全部成立</option>
          <option value="or">Or · 任一成立</option>
          <option value="not">Not · 取反</option>
        </select>
      </Field>
      {isComparison(value) && (
        <div className="condition-operands">
          <OperandEditor
            label="左值"
            manifest={manifest}
            onChange={(left) => onChange({ ...value, left })}
            other={value.right}
            value={value.left}
          />
          <OperandEditor
            label="右值"
            manifest={manifest}
            onChange={(right) => onChange({ ...value, right })}
            other={value.left}
            value={value.right}
          />
        </div>
      )}
      {(value.op === "and" || value.op === "or") && (
        <div className="condition-children">
          {value.conditions.map((child, index) => (
            <div className="condition-child" key={index}>
              <div className="condition-child-actions">
                <button
                  disabled={index === 0}
                  onClick={() => {
                    const conditions = [...value.conditions];
                    [conditions[index - 1], conditions[index]] = [
                      conditions[index],
                      conditions[index - 1],
                    ];
                    onChange({ ...value, conditions });
                  }}
                  type="button"
                >
                  ↑
                </button>
                <button
                  disabled={index === value.conditions.length - 1}
                  onClick={() => {
                    const conditions = [...value.conditions];
                    [conditions[index], conditions[index + 1]] = [
                      conditions[index + 1],
                      conditions[index],
                    ];
                    onChange({ ...value, conditions });
                  }}
                  type="button"
                >
                  ↓
                </button>
                <button
                  className="danger-text"
                  onClick={() =>
                    onChange({
                      ...value,
                      conditions: value.conditions.filter(
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
              <ConditionEditor
                manifest={manifest}
                onChange={(condition) =>
                  onChange({
                    ...value,
                    conditions: value.conditions.map(
                      (candidate, candidateIndex) =>
                        candidateIndex === index ? condition : candidate,
                    ),
                  })
                }
                value={child}
              />
            </div>
          ))}
          <button
            className="wide-button"
            onClick={() =>
              onChange({
                ...value,
                conditions: [
                  ...value.conditions,
                  defaultCondition(fallbackVariable),
                ],
              })
            }
            type="button"
          >
            ＋ 添加子条件
          </button>
        </div>
      )}
      {value.op === "not" && (
        <div className="condition-child">
          <ConditionEditor
            manifest={manifest}
            onChange={(condition) => onChange({ ...value, condition })}
            value={value.condition}
          />
        </div>
      )}
    </div>
  );
}

function OperandEditor({
  label,
  manifest,
  onChange,
  other,
  value,
}: {
  label: string;
  manifest: ContentManifest;
  onChange(value: ValueOperand): void;
  other: ValueOperand;
  value: ValueOperand;
}): ReactElement {
  const variableIds = Object.keys(manifest.variables);
  const expectedType = operandVariableType(other, manifest);
  return (
    <Field label={label}>
      <div className="operand-editor">
        <select
          value={"variable" in value ? "variable" : "value"}
          onChange={(event) => {
            if (event.currentTarget.value === "variable") {
              onChange({ variable: variableIds[0] ?? "" });
            } else {
              onChange({ value: defaultScalar(expectedType ?? "boolean") });
            }
          }}
        >
          <option value="variable">变量</option>
          <option value="value">字面量</option>
        </select>
        {"variable" in value ? (
          <select
            value={value.variable}
            onChange={(event) =>
              onChange({ variable: event.currentTarget.value })
            }
          >
            {!variableIds.includes(value.variable) && (
              <option value={value.variable}>
                {value.variable || "— 未声明 —"}
              </option>
            )}
            {variableIds.map((id) => (
              <option key={id} value={id}>
                {id} · {manifest.variables[id].scope}/
                {manifest.variables[id].type}
              </option>
            ))}
          </select>
        ) : (
          <LiteralEditor
            expectedType={expectedType}
            onChange={(literal) => onChange({ value: literal })}
            value={value.value}
          />
        )}
      </div>
    </Field>
  );
}

function LiteralEditor({
  expectedType,
  onChange,
  value,
}: {
  expectedType: VariableType | null;
  onChange(value: ScalarValue): void;
  value: ScalarValue;
}): ReactElement {
  const valueType = expectedType ?? scalarVariableType(value);
  if (valueType === "boolean") {
    return (
      <select
        value={String(value)}
        onChange={(event) => onChange(event.currentTarget.value === "true")}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  return (
    <input
      step={valueType === "integer" ? 1 : "any"}
      type={
        valueType === "integer" || valueType === "number" ? "number" : "text"
      }
      value={String(value)}
      onChange={(event) =>
        onChange(
          valueType === "integer"
            ? Math.trunc(Number(event.currentTarget.value))
            : valueType === "number"
              ? Number(event.currentTarget.value)
              : event.currentTarget.value,
        )
      }
    />
  );
}

function isComparison(
  value: ConditionExpression,
): value is Extract<ConditionExpression, { left: ValueOperand }> {
  return COMPARISON_OPERATORS.includes(
    value.op as (typeof COMPARISON_OPERATORS)[number],
  );
}

function conditionForOperator(
  op: ConditionExpression["op"],
  previous: ConditionExpression,
  fallbackVariable: string,
): ConditionExpression {
  if (COMPARISON_OPERATORS.includes(op as ComparisonOperator)) {
    return {
      op: op as ComparisonOperator,
      left: isComparison(previous)
        ? previous.left
        : { variable: fallbackVariable },
      right: isComparison(previous) ? previous.right : { value: true },
    };
  }
  if (op === "and" || op === "or") {
    return {
      op,
      conditions:
        previous.op === "and" || previous.op === "or"
          ? previous.conditions
          : [previous],
    };
  }
  return {
    op: "not",
    condition: previous.op === "not" ? previous.condition : previous,
  };
}

function operandVariableType(
  operand: ValueOperand,
  manifest: ContentManifest,
): VariableType | null {
  return "variable" in operand
    ? (manifest.variables[operand.variable]?.type ?? null)
    : scalarVariableType(operand.value);
}

function scalarVariableType(value: ScalarValue): VariableType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return Number.isInteger(value) ? "integer" : "number";
}

function defaultScalar(type: VariableType): ScalarValue {
  switch (type) {
    case "boolean":
      return false;
    case "integer":
    case "number":
      return 0;
    case "string":
      return "";
  }
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
