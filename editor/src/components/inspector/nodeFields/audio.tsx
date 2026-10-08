import type { ReactNode } from "react";
import { Field, NumberField } from "../../Fields";
import { AudioLoopEditor } from "../../AudioLoopEditor";
import type { FieldsContext, NodeOf } from "../fieldsContext";
import { AssetSelect, AwaitFields, TargetSelect } from "../fieldControls";

export function bgmFields(node: NodeOf<"bgm">, ctx: FieldsContext): ReactNode {
  const { update, manifest, assets, onError, targets } = ctx;
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
        <AudioLoopEditor
          asset={
            assets.find((candidate) => candidate.id === node.asset) ?? null
          }
          label="BGM"
          loopEndMs={node.loop_end_ms ?? null}
          loopStartMs={node.loop_start_ms ?? null}
          onChange={(patch) => update({ ...node, ...patch })}
          onError={onError}
          startMs={node.start_ms ?? 0}
          volume={node.volume}
        />
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
}

export function ambienceFields(
  node: NodeOf<"ambience">,
  ctx: FieldsContext,
): ReactNode {
  const { update, manifest, assets, onError, targets } = ctx;
  return (
    <>
      <Field label="槽位">
        <select
          value={node.slot}
          onChange={(event) =>
            update({
              ...node,
              slot: event.currentTarget.value as typeof node.slot,
            })
          }
        >
          <option value="slot_1">槽位 1</option>
          <option value="slot_2">槽位 2</option>
          <option value="slot_3">槽位 3</option>
          <option value="slot_4">槽位 4</option>
        </select>
      </Field>
      <Field label="动作">
        <select
          value={node.action}
          onChange={(event) => {
            const action = event.currentTarget.value as typeof node.action;
            const next = { ...node, action };
            if (action === "stop") {
              // Stop nodes carry no start/loop metadata.  Besides keeping
              // the authored shape canonical, this prevents changing back
              // and forth between actions from leaving invalid hidden
              // fields behind.
              next.asset = null;
              delete next.start_ms;
              delete next.loop_start_ms;
              delete next.loop_end_ms;
            }
            update(next);
          }}
        >
          <option value="start">开始 / 替换</option>
          <option value="stop">停止</option>
        </select>
      </Field>
      <AssetSelect
        allowNone={node.action === "stop"}
        kind="ambience"
        label="环境声素材"
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
        <AudioLoopEditor
          asset={
            assets.find((candidate) => candidate.id === node.asset) ?? null
          }
          label="环境声"
          loopEndMs={node.loop_end_ms ?? null}
          loopStartMs={node.loop_start_ms ?? null}
          onChange={(patch) => update({ ...node, ...patch })}
          onError={onError}
          startMs={node.start_ms ?? 0}
          volume={node.volume}
        />
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
}

export function sfxFields(node: NodeOf<"sfx">, ctx: FieldsContext): ReactNode {
  const { update, manifest, targets } = ctx;
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
}
