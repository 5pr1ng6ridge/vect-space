import type { ReactNode } from "react";
import { resolveSpriteAsset, sceneSpriteIds } from "../../../story";
import { defaultCurtainFill } from "../../../presentationDefaults";
import { SpriteSourceFields } from "../../SpriteSourceFields";
import type { CurtainAction } from "../../../types";
import { Field, NumberField } from "../../Fields";
import {
  CurtainFillFields,
  CurtainTransitionFields,
  ScreenEffectFields,
  TransitionSpecFields,
} from "../../SpecFields";
import type { FieldsContext, NodeOf } from "../fieldsContext";
import {
  AnimationFields,
  AssetSelect,
  AwaitFields,
  OptionalNumber,
  TargetSelect,
  TextField,
} from "../fieldControls";
import {
  BackgroundPreview,
  CurtainPreview,
  ScreenEffectPreview,
} from "../previews";
import { SpriteStagePreview } from "../SpriteStagePreview";

export function backgroundFields(
  node: NodeOf<"background">,
  ctx: FieldsContext,
): ReactNode {
  const {
    nodeId,
    update,
    scene,
    manifest,
    assets,
    animations,
    onError,
    previewEnvironment,
    targets,
  } = ctx;
  return (
    <>
      <AssetSelect
        allowNone
        animations={animations}
        assets={assets}
        kind="background"
        label="背景素材"
        manifest={manifest}
        onChange={(background) => update({ ...node, background })}
        value={node.background}
      />
      <TransitionSpecFields
        onChange={(transition) => update({ ...node, transition })}
        value={node.transition}
      />
      <AnimationFields node={node} onChange={update} />
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
      <BackgroundPreview
        assets={assets}
        environment={previewEnvironment}
        node={node}
        nodeId={nodeId}
        onChange={update}
        onError={onError}
        scene={scene}
      />
    </>
  );
}

export function curtainFields(
  node: NodeOf<"curtain">,
  ctx: FieldsContext,
): ReactNode {
  const {
    nodeId,
    update,
    scene,
    manifest,
    assets,
    onError,
    previewEnvironment,
    targets,
  } = ctx;
  return (
    <>
      <Field label="幕布动作">
        <select
          value={node.action}
          onChange={(event) => {
            const action = event.currentTarget.value as CurtainAction;
            update({
              ...node,
              action,
              fill:
                action === "cover" ? (node.fill ?? defaultCurtainFill()) : null,
            });
          }}
        >
          <option value="cover">落下幕布</option>
          <option value="reveal">收起幕布</option>
        </select>
      </Field>
      {node.action === "cover" && (
        <CurtainFillFields
          manifest={manifest}
          onChange={(fill) => update({ ...node, fill })}
          value={node.fill ?? null}
        />
      )}
      <CurtainTransitionFields
        onChange={(transition) => update({ ...node, transition })}
        value={node.transition}
      />
      <AnimationFields node={node} onChange={update} />
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
      <CurtainPreview
        assets={assets}
        environment={previewEnvironment}
        node={node}
        nodeId={nodeId}
        onError={onError}
        scene={scene}
      />
    </>
  );
}

export function spriteFields(
  node: NodeOf<"sprite">,
  ctx: FieldsContext,
): ReactNode {
  const {
    nodeId,
    update,
    scene,
    manifest,
    assets,
    animations,
    onError,
    previewEnvironment,
    preview,
    targets,
  } = ctx;
  return (
    <>
      <TextField
        label="立绘实例 ID"
        onChange={(sprite_id) => update({ ...node, sprite_id })}
        suggestions={sceneSpriteIds(scene)}
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
      <SpriteSourceFields
        assets={assets}
        textBlocks={preview?.project.text_blocks ?? []}
        value={node}
        onChange={(patch) =>
          update({
            ...node,
            ...patch,
            ...(patch.source === undefined
              ? {}
              : { character: null, expression: null }),
          })
        }
      />
      {node.source === undefined && (
        <>
          <Field label="角色绑定（可选）">
            <select
              value={node.character ?? ""}
              onChange={(event) => {
                const character = event.currentTarget.value || null;
                const definition =
                  character === null
                    ? undefined
                    : manifest.characters[character];
                const expression =
                  character === null
                    ? null
                    : (node.expression ??
                      definition?.default_expression ??
                      null);
                update({ ...node, character, expression });
              }}
            >
              <option value="">不绑定角色（直接素材）</option>
              {Object.entries(manifest.characters).map(([id, definition]) => (
                <option key={id} value={id}>
                  {definition.display_name} · {id}
                </option>
              ))}
            </select>
          </Field>
          {node.character != null && (
            <Field label="表情">
              <select
                value={node.expression ?? ""}
                onChange={(event) =>
                  update({
                    ...node,
                    expression: event.currentTarget.value || null,
                  })
                }
              >
                <option value="">使用默认表情</option>
                {Object.keys(
                  manifest.characters[node.character]?.expressions ?? {},
                ).map((expressionId) => (
                  <option key={expressionId} value={expressionId}>
                    {expressionId}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {node.character != null &&
          node.asset == null &&
          node.action !== "hide" ? (
            <Field
              hint="已绑定角色表情，运行时会自动使用角色表中登记的素材。"
              label="立绘素材"
            >
              <output>
                {resolveSpriteAsset(node, manifest) ??
                  "未解析：请选择表情或设置默认表情"}
              </output>
            </Field>
          ) : (
            <AssetSelect
              allowNone={node.action !== "show" || node.character != null}
              animations={animations}
              assets={assets}
              kind="sprite"
              label={node.character == null ? "立绘素材" : "素材覆盖（可选）"}
              manifest={manifest}
              onChange={(asset) => update({ ...node, asset })}
              value={node.asset}
            />
          )}
        </>
      )}
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
        {node.action === "move" ? (
          <Field label="水平翻转">
            <select
              onChange={(event) =>
                update({
                  ...node,
                  flip_x:
                    event.currentTarget.value === "keep"
                      ? undefined
                      : event.currentTarget.value === "true",
                })
              }
              value={node.flip_x == null ? "keep" : String(node.flip_x)}
            >
              <option value="keep">保持当前</option>
              <option value="false">不翻转</option>
              <option value="true">翻转</option>
            </select>
          </Field>
        ) : (
          <label className="checkbox-field">
            <span>水平翻转</span>
            <input
              checked={node.flip_x ?? false}
              onChange={(event) =>
                update({ ...node, flip_x: event.currentTarget.checked })
              }
              type="checkbox"
            />
          </label>
        )}
        <OptionalNumber
          label="横向缩放"
          value={node.scale_x ?? null}
          step={0.05}
          onChange={(scale_x) => update({ ...node, scale_x })}
        />
        <OptionalNumber
          label="纵向缩放"
          value={node.scale_y ?? null}
          step={0.05}
          onChange={(scale_y) => update({ ...node, scale_y })}
        />
        <OptionalNumber
          label="旋转 °"
          value={node.rotation_deg ?? null}
          onChange={(rotation_deg) => update({ ...node, rotation_deg })}
        />
        <OptionalNumber
          label="锚点 X"
          value={node.anchor_x ?? null}
          min={0}
          max={1}
          step={0.05}
          onChange={(anchor_x) => update({ ...node, anchor_x })}
        />
        <OptionalNumber
          label="锚点 Y"
          value={node.anchor_y ?? null}
          min={0}
          max={1}
          step={0.05}
          onChange={(anchor_y) => update({ ...node, anchor_y })}
        />
        <OptionalNumber
          label="换表情淡化 ms"
          min={0}
          onChange={(crossfade_ms) => update({ ...node, crossfade_ms })}
          value={node.crossfade_ms ?? null}
        />
      </div>
      <AnimationFields node={node} onChange={update} />
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
      <SpriteStagePreview
        assets={assets}
        environment={previewEnvironment}
        manifest={manifest}
        node={node}
        nodeId={nodeId}
        onChange={update}
        onError={onError}
        preview={preview}
        sceneId={scene.id}
      />
    </>
  );
}

export function particleFields(
  node: NodeOf<"particle">,
  ctx: FieldsContext,
): ReactNode {
  const {
    nodeId,
    update,
    scene,
    manifest,
    assets,
    onError,
    previewEnvironment,
    preview,
    targets,
  } = ctx;
  return (
    <>
      <TextField
        label="发射器实例 ID"
        value={node.emitter_id}
        onChange={(emitter_id) => update({ ...node, emitter_id })}
      />
      <p className="field-note">
        同时显示多个持续特效时使用不同的实例 ID；同 ID 的 start
        会重启该发射器，stop 会清除该发射器。
      </p>
      <Field label="粒子动作">
        <select
          value={node.action}
          onChange={(event) =>
            update({
              ...node,
              action: event.currentTarget.value as typeof node.action,
            })
          }
        >
          <option value="start">持续发射 / 重启</option>
          <option value="stop">停止并清除</option>
          <option value="burst">单次爆发（不存档）</option>
        </select>
      </Field>
      {node.action !== "stop" && (
        <>
          <Field label="粒子效果">
            <select
              value={node.particle ?? ""}
              onChange={(event) =>
                update({ ...node, particle: event.currentTarget.value || null })
              }
            >
              <option value="">选择粒子定义</option>
              {(preview?.project.particles ?? []).map((file) => (
                <option key={file.definition.id} value={file.definition.id}>
                  {file.definition.id}
                </option>
              ))}
            </select>
          </Field>
          <OptionalNumber
            label="随机种子（留空沿用定义）"
            min={0}
            max={0xffffffff}
            value={node.seed ?? null}
            onChange={(seed) => update({ ...node, seed })}
          />
          <Field label="发射器坐标空间">
            <select
              value={node.space}
              onChange={(event) =>
                update({
                  ...node,
                  space: event.currentTarget.value as typeof node.space,
                })
              }
            >
              <option value="world">世界</option>
              <option value="screen">屏幕</option>
            </select>
          </Field>
          <div className="field-grid">
            <NumberField
              label="X"
              value={node.x}
              onChange={(x) => update({ ...node, x })}
            />
            <NumberField
              label="Y"
              value={node.y}
              onChange={(y) => update({ ...node, y })}
            />
            <NumberField
              label="整体缩放"
              min={0.001}
              step={0.05}
              value={node.scale}
              onChange={(scale) => update({ ...node, scale })}
            />
            <NumberField
              label="整体旋转 °"
              value={node.rotation_deg}
              onChange={(rotation_deg) => update({ ...node, rotation_deg })}
            />
            <NumberField
              label="整体透明度"
              min={0}
              max={1}
              step={0.05}
              value={node.opacity}
              onChange={(opacity) => update({ ...node, opacity })}
            />
            <NumberField
              label="层级 Z"
              value={node.z}
              onChange={(z) => update({ ...node, z })}
            />
          </div>
        </>
      )}
      <p className="field-note">
        只操作整个发射器；单次爆发和单个粒子不能添加时间线轨道。
      </p>
      <TargetSelect
        label="下一节点"
        targets={targets}
        value={node.next}
        onChange={(next) => update({ ...node, next })}
      />
      <SpriteStagePreview
        assets={assets}
        environment={previewEnvironment}
        manifest={manifest}
        node={node}
        nodeId={nodeId}
        onChange={update}
        onError={onError}
        preview={preview}
        sceneId={scene.id}
      />
    </>
  );
}

export function clearFields(
  node: NodeOf<"clear">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
  return (
    <>
      <p className="field-note">
        淡出背景、立绘、镜头与持续视觉效果；BGM、环境声和对话框 UI 会保留。
      </p>
      <AnimationFields node={node} onChange={update} />
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
    </>
  );
}

export function cameraFields(
  node: NodeOf<"camera">,
  ctx: FieldsContext,
): ReactNode {
  const { update, targets } = ctx;
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
}

export function screenEffectFields(
  node: NodeOf<"screen_effect">,
  ctx: FieldsContext,
): ReactNode {
  const {
    nodeId,
    update,
    scene,
    assets,
    onError,
    previewEnvironment,
    targets,
  } = ctx;
  return (
    <>
      <ScreenEffectFields
        onChange={(effect) => update({ ...node, effect })}
        value={node.effect}
      />
      <AwaitFields node={node} onChange={update} />
      <TargetSelect
        label="下一节点"
        onChange={(next) => update({ ...node, next })}
        targets={targets}
        value={node.next}
      />
      <ScreenEffectPreview
        assets={assets}
        environment={previewEnvironment}
        node={node}
        nodeId={nodeId}
        onError={onError}
        scene={scene}
      />
    </>
  );
}
