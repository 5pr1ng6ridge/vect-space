import type { ReactNode } from "react";
import { Field } from "../../Fields";
import type { FieldsContext, NodeOf } from "../fieldsContext";
import {
  BooleanField,
  OptionalDurationField,
  TargetSelect,
  TextField,
  UiMotionSelect,
} from "../fieldControls";
import { ButtonActionEditor, ButtonLayoutFields } from "../ButtonEditors";

export function dialogueUiFields(
  node: NodeOf<"dialogue_ui">,
  ctx: FieldsContext,
): ReactNode {
  const { update, uiMotions, targets } = ctx;
  return (
    <>
      <BooleanField
        label="显示对话框"
        onChange={(visible) => update({ ...node, visible })}
        value={node.visible}
      />
      <UiMotionSelect
        allowDefault
        label="本次动效"
        motions={uiMotions}
        onChange={(motion) => update({ ...node, motion })}
        value={node.motion}
      />
      <OptionalDurationField
        onChange={(duration_ms) => update({ ...node, duration_ms })}
        value={node.duration_ms}
      />
      <BooleanField
        label="等待动效完成"
        onChange={(awaitCompletion) =>
          update({ ...node, await: awaitCompletion })
        }
        value={node.await}
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

export function uiMotionSetFields(
  node: NodeOf<"ui_motion_set">,
  ctx: FieldsContext,
): ReactNode {
  const { update, uiMotions, targets } = ctx;
  return (
    <>
      <Field label="默认槽位">
        <select
          onChange={(event) =>
            update({
              ...node,
              slot: event.currentTarget.value as typeof node.slot,
            })
          }
          value={node.slot}
        >
          <option value="dialogue_show">对话框出现</option>
          <option value="dialogue_hide">对话框收起</option>
        </select>
      </Field>
      <UiMotionSelect
        label="后续默认动效"
        motions={uiMotions}
        onChange={(motion) => update({ ...node, motion })}
        value={node.motion}
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

export function uiMotionPlayFields(
  node: NodeOf<"ui_motion_play">,
  ctx: FieldsContext,
): ReactNode {
  const { update, uiMotions, targets } = ctx;
  return (
    <>
      <UiMotionSelect
        label="播放动效"
        motions={uiMotions}
        onChange={(motion) => update({ ...node, motion: motion ?? "" })}
        value={node.motion || null}
      />
      <OptionalDurationField
        onChange={(duration_ms) => update({ ...node, duration_ms })}
        value={node.duration_ms}
      />
      <BooleanField
        label="等待动效完成"
        onChange={(awaitCompletion) =>
          update({ ...node, await: awaitCompletion })
        }
        value={node.await}
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

export function buttonCreateFields(
  node: NodeOf<"button_create">,
  ctx: FieldsContext,
): ReactNode {
  const { update, scene, manifest, buttons, scenes, targets } = ctx;
  return (
    <>
      <TextField
        label="实例 ID"
        onChange={(instance_id) => update({ ...node, instance_id })}
        value={node.instance_id}
      />
      <Field label="按钮模板">
        <select
          value={node.template}
          onChange={(event) =>
            update({ ...node, template: event.currentTarget.value })
          }
        >
          {!buttons.some(
            ({ definition }) => definition.id === node.template,
          ) && (
            <option value={node.template}>— 未找到：{node.template} —</option>
          )}
          {buttons.map(({ definition }) => (
            <option key={definition.id} value={definition.id}>
              {definition.id} · {definition.width}×{definition.height}
            </option>
          ))}
        </select>
      </Field>
      <ButtonLayoutFields node={node} onChange={update} />
      <ButtonActionEditor
        action={node.action}
        manifest={manifest}
        onChange={(action) => {
          if (action !== null) update({ ...node, action });
        }}
        sceneId={scene.id}
        scenes={scenes}
        targets={targets}
      />
      <TargetSelect
        label="节点完成后"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
    </>
  );
}

export function buttonUpdateFields(
  node: NodeOf<"button_update">,
  ctx: FieldsContext,
): ReactNode {
  const { update, scene, manifest, buttons, scenes, targets } = ctx;
  return (
    <>
      <TextField
        label="实例 ID"
        onChange={(instance_id) => update({ ...node, instance_id })}
        value={node.instance_id}
      />
      <Field label="替换模板（可选）">
        <select
          value={node.template ?? ""}
          onChange={(event) =>
            update({ ...node, template: event.currentTarget.value || null })
          }
        >
          <option value="">保持当前模板</option>
          {buttons.map(({ definition }) => (
            <option key={definition.id} value={definition.id}>
              {definition.id}
            </option>
          ))}
        </select>
      </Field>
      <ButtonLayoutFields node={node} onChange={update} />
      <ButtonActionEditor
        action={node.action ?? { sets: [], next: null }}
        manifest={manifest}
        onChange={(action) => update({ ...node, action })}
        optional
        sceneId={scene.id}
        scenes={scenes}
        targets={targets}
      />
      <TargetSelect
        label="节点完成后"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
    </>
  );
}

export function buttonRemoveFields(
  node: NodeOf<"button_remove">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
  return (
    <>
      <TextField
        label="实例 ID"
        onChange={(instance_id) => update({ ...node, instance_id })}
        value={node.instance_id}
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
