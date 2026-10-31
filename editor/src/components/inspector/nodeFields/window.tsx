import type { ReactNode } from "react";
import {
  MAX_SCENE_TIMERS,
  MAX_TIMER_DURATION_MS,
  MIN_TIMER_INTERVAL_MS,
  nonEmpty,
  sceneRole,
  validTimerTargets,
} from "../../../windowInteraction";
import { Field, NumberField } from "../../Fields";
import type { FieldsContext, NodeOf } from "../fieldsContext";
import {
  SceneOptions,
  WindowGeometryFields,
  WindowLayerFields,
  WindowRoleSelect,
} from "../WindowEditors";
import { BooleanField, TargetSelect, TextField } from "../fieldControls";

export function openWindowFields(
  node: NodeOf<"open_window">,
  ctx: FieldsContext,
): ReactNode {
  const { update, scene, scenes, targets } = ctx;
  return (
    <>
      <Field
        hint="只列出「副窗口」用途的场景；重复打开会在同一个副窗口中替换场景"
        label="副窗口场景"
      >
        <select
          value={node.scene}
          onChange={(event) =>
            update({ ...node, scene: event.currentTarget.value })
          }
        >
          <option value="">请选择场景</option>
          <SceneOptions current={node.scene} role="secondary" scenes={scenes} />
        </select>
      </Field>
      <p className="field-note">
        仅「主窗口」用途的场景可以打开副窗口；副窗口没有存档、设置或历史界面，也不能再打开窗口。
        目标场景的用途可在左侧场景列表中设置。
      </p>
      {sceneRole(scene) !== "main" && (
        <p className="field-note field-note-warning">
          当前场景是副窗口专用，不能包含「打开副窗口」节点。
        </p>
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

export function windowTitleFields(
  node: NodeOf<"window_title">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
  return (
    <>
      <WindowRoleSelect
        label="目标窗口"
        onChange={(target) => update({ ...node, target })}
        value={node.target}
      />
      <TextField
        allowEmpty
        label="标题"
        onChange={(title) => update({ ...node, title })}
        value={node.title}
      />
      <p className="field-note">
        可写 [var=变量名] 引用变量。标题只在执行到这里时求值一次并保存，之后可用
        [var=window.main.title] / [var=window.secondary.title]
        读取（只读）。原生窗口标题按纯文本显示，不处理排版标记。副窗口标题在窗口关闭或被替换后恢复默认。
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

export function windowControlFields(
  node: NodeOf<"window_control">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
  return (
    <>
      <WindowRoleSelect
        label="目标窗口"
        onChange={(target) => update({ ...node, target })}
        value={node.target}
      />
      <Field label="操作">
        <select
          value={node.action}
          onChange={(event) => {
            const action = event.currentTarget.value as typeof node.action;
            update({
              ...node,
              action,
              id: action === "advance" ? "" : nonEmpty(node.id, "gate"),
              message: action === "block" ? (node.message ?? "") : "",
            });
          }}
        >
          <option value="block">阻挡翻页</option>
          <option value="unblock">解除阻挡</option>
          <option value="advance">推进一页（脚本）</option>
        </select>
      </Field>
      {node.action !== "advance" && (
        <TextField
          label="阻挡 ID"
          onChange={(id) => update({ ...node, id })}
          value={node.id ?? ""}
        />
      )}
      {node.action === "block" && (
        <TextField
          allowEmpty
          label="提示文本（可选）"
          onChange={(message) => update({ ...node, message })}
          value={node.message ?? ""}
        />
      )}
      <p className="field-note">
        {node.action === "advance"
          ? "推进只翻一页：不会替玩家选择选项，也不会自动解除阻挡；目标没有停在对话或长文本时什么也不会发生。需要先「解除阻挡」再推进。"
          : "阻挡只限制翻页（手动、自动、快进和按钮的「继续」）；选项、其他按钮和计时器照常工作。同一个场景用同一个 ID 再次阻挡会覆盖旧提示；解除只会解除自己用这个 ID 创建的阻挡，场景退出时自动清除。"}
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

export function windowGeometryFields(
  node: NodeOf<"window_geometry">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
  return (
    <>
      <WindowGeometryFields node={node} onChange={update} />
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
    </>
  );
}

export function windowLayerFields(
  node: NodeOf<"window_layer">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
  return (
    <>
      <WindowLayerFields node={node} onChange={update} />
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
    </>
  );
}

export function timerFields(
  node: NodeOf<"timer">,
  ctx: FieldsContext,
): ReactNode {
  const { update, scene, targets } = ctx;
  const targetsForTimer = validTimerTargets(scene);
  const repeating = node.interval_ms != null;
  return (
    <>
      <Field label="操作">
        <select
          value={node.action}
          onChange={(event) => {
            const action = event.currentTarget.value as typeof node.action;
            update(
              action === "stop"
                ? {
                    ...node,
                    action,
                    delay_ms: 0,
                    interval_ms: null,
                    target: null,
                  }
                : {
                    ...node,
                    action,
                    delay_ms: node.delay_ms ?? 1000,
                  },
            );
          }}
        >
          <option value="start">启动</option>
          <option value="stop">停止</option>
        </select>
      </Field>
      <TextField
        label="计时器 ID"
        onChange={(id) => update({ ...node, id })}
        value={node.id}
      />
      {node.action === "start" && (
        <>
          <NumberField
            label="首次延迟 ms"
            max={MAX_TIMER_DURATION_MS}
            min={0}
            onChange={(delay_ms) => update({ ...node, delay_ms })}
            step={50}
            value={node.delay_ms ?? 0}
          />
          <BooleanField
            label="重复触发"
            onChange={(repeat) =>
              update({ ...node, interval_ms: repeat ? 1000 : null })
            }
            value={repeating}
          />
          {repeating && (
            <NumberField
              label="重复间隔 ms"
              max={MAX_TIMER_DURATION_MS}
              min={MIN_TIMER_INTERVAL_MS}
              onChange={(interval_ms) => update({ ...node, interval_ms })}
              step={50}
              value={node.interval_ms ?? MIN_TIMER_INTERVAL_MS}
            />
          )}
          <TargetSelect
            label="触发时运行的效果节点"
            onChange={(target) => update({ ...node, target })}
            targets={targetsForTimer}
            value={node.target ?? ""}
          />
          <p className="field-note">
            到点只运行所选节点的效果，不会沿它的「下一节点」走，也不会改变正在等待的对话、长文本或选项。可选：设置变量、音效、窗口标题/控制/层级，以及未开启「等待完成」的窗口位置/大小、背景、立绘、立绘动作、时间线、BGM、环境声、镜头、屏幕效果、幕布、UI
            动效。组合动画请用时间线。
          </p>
          {targetsForTimer.length === 0 && (
            <p className="field-note field-note-warning">
              本场景还没有可被计时器运行的效果节点；请先添加一个，并保持它不要接入主线。
            </p>
          )}
        </>
      )}
      <p className="field-note">
        计时器不会自动结束：它会一直运行，直到被「停止」节点停止、场景退出或会话结束。请在离开等待处的后续节点里显式停止重复计时器。同
        ID 再次启动会替换旧计时器；重复间隔至少 {MIN_TIMER_INTERVAL_MS}{" "}
        ms，同时最多 {MAX_SCENE_TIMERS} 个。
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
