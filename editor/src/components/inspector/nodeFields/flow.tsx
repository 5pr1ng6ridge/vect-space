import type { ReactNode } from "react";
import { sceneSpriteIds } from "../../../story";
import { sceneRole, WINDOW_ROLE_LABELS } from "../../../windowInteraction";
import type { SpriteActionEnd } from "../../../types";
import { Field, NumberField } from "../../Fields";
import { VARIABLE_TYPE_LABELS } from "../../../labels";
import type { FieldsContext, NodeOf } from "../fieldsContext";
import {
  SET_OPERATIONS,
  defaultScalar,
  defaultSetValue,
  operationSupportsTarget,
} from "../model";
import { MutationValueEditor } from "../MutationEditor";
import {
  BooleanField,
  OptionalNumber,
  TargetSelect,
  TextField,
} from "../fieldControls";
import { ConditionEditor } from "../ConditionEditor";
import { SceneOptions } from "../WindowEditors";

export function setFields(node: NodeOf<"set">, ctx: FieldsContext): ReactNode {
  const { update, manifest, targets } = ctx;
  return (
    <>
      <Field label="目标变量">
        <select
          value={node.variable}
          onChange={(event) => {
            const variable = event.currentTarget.value;
            const targetType = manifest.variables[variable]?.type ?? "boolean";
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
              {id}（{VARIABLE_TYPE_LABELS[definition.type]}）
            </option>
          ))}
        </select>
      </Field>
      <Field label="操作">
        <select
          value={node.op ?? "assign"}
          onChange={(event) => {
            const op = event.currentTarget.value as NonNullable<typeof node.op>;
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
}

export function conditionFields(
  node: NodeOf<"condition">,
  ctx: FieldsContext,
): ReactNode {
  const { update, manifest, targets } = ctx;
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
}

export function playbackFields(
  node: NodeOf<"playback">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
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
}

export function actionFields(
  node: NodeOf<"action">,
  ctx: FieldsContext,
): ReactNode {
  const { update, scene, actions, targets } = ctx;
  const definition = actions.find(
    (file) => file.definition.id === node.action,
  )?.definition;
  const spriteIds = sceneSpriteIds(scene);
  return (
    <>
      <Field label="目标立绘实例">
        <select
          onChange={(event) =>
            update({ ...node, sprite_id: event.currentTarget.value })
          }
          value={node.sprite_id}
        >
          {!spriteIds.includes(node.sprite_id) && (
            <option value={node.sprite_id}>{node.sprite_id}</option>
          )}
          {spriteIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </Field>
      <Field label="动作">
        <select
          onChange={(event) =>
            update({
              ...node,
              action: event.currentTarget.value,
              parameters: {},
            })
          }
          value={node.action}
        >
          {!actions.some((file) => file.definition.id === node.action) && (
            <option value={node.action}>{node.action || "— 未选择 —"}</option>
          )}
          {actions.map(({ definition: candidate }) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.id} · {candidate.name}
            </option>
          ))}
        </select>
      </Field>
      {definition !== undefined && (
        <>
          <OptionalNumber
            label="覆盖时长 ms（留空使用定义）"
            max={1_800_000}
            min={1}
            onChange={(duration_ms) => update({ ...node, duration_ms })}
            step={1}
            value={node.duration_ms ?? null}
          />
          {Object.entries(definition.parameters ?? {}).map(
            ([parameter, parameterDefinition]) => (
              <NumberField
                key={parameter}
                label={`参数 ${parameter}`}
                max={parameterDefinition.max ?? undefined}
                min={parameterDefinition.min ?? undefined}
                onChange={(value) =>
                  update({
                    ...node,
                    parameters: {
                      ...(node.parameters ?? {}),
                      [parameter]: value,
                    },
                  })
                }
                value={
                  node.parameters?.[parameter] ?? parameterDefinition.default
                }
              />
            ),
          )}
        </>
      )}
      <Field label="结束姿态">
        <select
          onChange={(event) =>
            update({
              ...node,
              end: (event.currentTarget.value ||
                null) as SpriteActionEnd | null,
            })
          }
          value={node.end ?? ""}
        >
          <option value="">使用动作定义</option>
          <option value="hold">保持最后一帧</option>
          <option value="restore">恢复动作前姿态</option>
        </select>
      </Field>
      <BooleanField
        label="等待动作完成"
        onChange={(await_completion) =>
          update({ ...node, await: await_completion })
        }
        value={node.await}
      />
      {actions.length === 0 && (
        <p className="field-note">请先在项目面板创建一个立绘动作。</p>
      )}
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
    </>
  );
}

export function jumpFields(
  node: NodeOf<"jump">,
  ctx: FieldsContext,
): ReactNode {
  const { update, scene, scenes } = ctx;
  const targetScene = node.scene === null ? scene : undefined;
  return (
    <>
      <Field
        label="目标场景"
        hint={`留空表示当前场景；只能跳到同为${WINDOW_ROLE_LABELS[sceneRole(scene)]}专用的场景`}
      >
        <select
          value={node.scene ?? ""}
          onChange={(event) =>
            update({ ...node, scene: event.currentTarget.value || null })
          }
        >
          <option value="">当前场景</option>
          <SceneOptions
            current={node.scene}
            role={sceneRole(scene)}
            scenes={scenes}
          />
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

export function waitFields(
  node: NodeOf<"wait">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
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
}

export function timelineFields(
  node: NodeOf<"timeline">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
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
        双击时间线节点进入全屏工作区，编辑轨道、事件和缓动曲线。
      </p>
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
    </>
  );
}
