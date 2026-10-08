import type { ReactElement } from "react";
import { sceneRole } from "../../windowInteraction";
import type {
  ContentManifest,
  MutationValue,
  ScalarValue,
  SceneDefinition,
  SceneNode,
  VariableOperation,
  ButtonClickAction,
  ButtonPostAction,
  ButtonSetAction,
} from "../../types";
import { Field } from "../Fields";
import { Trash2 } from "lucide-react";
import { VARIABLE_TYPE_LABELS } from "../../labels";
import { IconButton } from "../../ui/Button";
import { BooleanField, OptionalNumber, TargetSelect } from "./fieldControls";
import {
  SET_OPERATIONS,
  defaultScalar,
  defaultSetValue,
  mutationTypesCompatible,
  operationSupportsTarget,
} from "./model";
import { LiteralEditor } from "./ConditionEditor";

export function ButtonLayoutFields({
  node,
  onChange,
}: {
  node: Extract<SceneNode, { type: "button_create" | "button_update" }>;
  onChange(node: SceneNode): void;
}): ReactElement {
  return (
    <div className="field-grid">
      <OptionalNumber
        label="X"
        onChange={(x) => onChange({ ...node, x })}
        value={node.x ?? null}
      />
      <OptionalNumber
        label="Y"
        onChange={(y) => onChange({ ...node, y })}
        value={node.y ?? null}
      />
      <OptionalNumber
        label="宽度"
        min={1}
        onChange={(width) => onChange({ ...node, width })}
        value={node.width ?? null}
      />
      <OptionalNumber
        label="高度"
        min={1}
        onChange={(height) => onChange({ ...node, height })}
        value={node.height ?? null}
      />
      <OptionalNumber
        label="旋转°"
        onChange={(rotation_deg) => onChange({ ...node, rotation_deg })}
        value={node.rotation_deg ?? null}
      />
      <OptionalNumber
        label="横向缩放"
        onChange={(scale_x) => onChange({ ...node, scale_x })}
        step={0.05}
        value={node.scale_x ?? null}
      />
      <OptionalNumber
        label="纵向缩放"
        onChange={(scale_y) => onChange({ ...node, scale_y })}
        step={0.05}
        value={node.scale_y ?? null}
      />
      <OptionalNumber
        label="透明度"
        max={1}
        min={0}
        onChange={(opacity) => onChange({ ...node, opacity })}
        step={0.05}
        value={node.opacity ?? null}
      />
      <OptionalNumber
        label="层级 Z"
        onChange={(z) => onChange({ ...node, z })}
        step={1}
        value={node.z ?? null}
      />
      <BooleanField
        label="显示"
        onChange={(visible) => onChange({ ...node, visible })}
        value={node.visible ?? true}
      />
      <BooleanField
        label="启用点击"
        onChange={(enabled) => onChange({ ...node, enabled })}
        value={node.enabled ?? true}
      />
    </div>
  );
}

export function ButtonActionEditor({
  action,
  manifest,
  onChange,
  optional = false,
  sceneId,
  scenes,
  targets,
}: {
  action: ButtonClickAction;
  manifest: ContentManifest;
  onChange(action: ButtonClickAction | null): void;
  optional?: boolean;
  sceneId: string;
  scenes: SceneDefinition[];
  targets: string[];
}): ReactElement {
  const replaceSet = (index: number, patch: Partial<ButtonSetAction>): void => {
    const sets = action.sets.map((set, setIndex) =>
      setIndex === index ? { ...set, ...patch } : set,
    );
    onChange({ ...action, sets });
  };
  const addSet = (): void => {
    const variable = Object.keys(manifest.variables)[0] ?? "";
    const type = manifest.variables[variable]?.type ?? "boolean";
    onChange({
      ...action,
      sets: [
        ...action.sets,
        { variable, op: "assign", value: defaultScalar(type) },
      ],
    });
  };
  const nextKind = action.next?.type ?? "none";
  const setNext = (kind: string): void => {
    let next: ButtonPostAction | null = null;
    if (kind === "advance") next = { type: "advance" };
    if (kind === "open_panel") next = { type: "open_panel", panel: "saves" };
    if (kind === "jump")
      next = { type: "jump", scene: null, target: targets[0] ?? "" };
    onChange({ ...action, next });
  };
  const jump = action.next?.type === "jump" ? action.next : undefined;
  const jumpSceneId = jump?.scene ?? sceneId;
  const jumpScene = scenes.find((candidate) => candidate.id === jumpSceneId);
  const jumpTargets =
    jumpScene === undefined ? targets : Object.keys(jumpScene.nodes);
  return (
    <section className="button-action-editor">
      <header>
        <strong>点击行为{optional ? "（可选）" : ""}</strong>
        {optional && (
          <button onClick={() => onChange(null)} type="button">
            清空
          </button>
        )}
      </header>
      {action.sets.map((set, index) => {
        const variableType =
          manifest.variables[set.variable]?.type ?? "boolean";
        const operation = set.op ?? "assign";
        return (
          <article
            className="button-action-row"
            key={`${index}-${set.variable}`}
          >
            <select
              value={set.variable}
              onChange={(event) =>
                replaceSet(index, {
                  variable: event.currentTarget.value,
                  value: defaultScalar(
                    manifest.variables[event.currentTarget.value]?.type ??
                      "boolean",
                  ),
                })
              }
            >
              {!manifest.variables[set.variable] && (
                <option value={set.variable}>
                  {set.variable || "— 未声明 —"}
                </option>
              )}
              {Object.entries(manifest.variables).map(([id, definition]) => (
                <option key={id} value={id}>
                  {id}（{VARIABLE_TYPE_LABELS[definition.type]}）
                </option>
              ))}
            </select>
            <select
              value={operation}
              onChange={(event) =>
                replaceSet(index, {
                  op: event.currentTarget.value as VariableOperation,
                  value:
                    event.currentTarget.value === "toggle"
                      ? undefined
                      : (set.value ?? defaultScalar(variableType)),
                })
              }
            >
              {SET_OPERATIONS.map(({ value, label }) => (
                <option
                  disabled={!operationSupportsTarget(value, variableType)}
                  key={value}
                  value={value}
                >
                  {label}
                </option>
              ))}
            </select>
            {operation !== "toggle" && (
              <ButtonMutationValueEditor
                manifest={manifest}
                onChange={(value) => replaceSet(index, { value })}
                operation={operation}
                targetVariable={set.variable}
                value={set.value}
              />
            )}
            <IconButton
              icon={Trash2}
              label="移除这条变量修改"
              onClick={() =>
                onChange({
                  ...action,
                  sets: action.sets.filter(
                    (_candidate, setIndex) => setIndex !== index,
                  ),
                })
              }
              size="sm"
            />
          </article>
        );
      })}
      <button onClick={addSet} type="button">
        ＋ 添加变量修改
      </button>
      <Field label="点击后操作">
        <select
          value={nextKind}
          onChange={(event) => setNext(event.currentTarget.value)}
        >
          <option value="none">无（仍拦截背景点击）</option>
          <option value="advance">推进剧情</option>
          <option value="jump">跳转剧情节点</option>
          <option value="open_panel">打开系统面板</option>
        </select>
      </Field>
      {action.next?.type === "jump" && (
        <>
          <Field label="跳转场景">
            <select
              value={action.next.scene ?? ""}
              onChange={(event) => {
                const nextScene = event.currentTarget.value || null;
                const candidate =
                  scenes.find((item) => item.id === (nextScene ?? sceneId)) ??
                  (nextScene === null ? jumpScene : undefined);
                const nextTarget =
                  candidate === undefined
                    ? ""
                    : (Object.keys(candidate.nodes)[0] ?? "");
                onChange({
                  ...action,
                  next: {
                    type: "jump",
                    scene: nextScene,
                    target: nextTarget,
                  },
                });
              }}
            >
              <option value="">本场景 · {sceneId}</option>
              {scenes
                .filter(
                  (candidate) =>
                    candidate.id !== sceneId &&
                    // A button never moves the story to the other window's Scenes.
                    sceneRole(candidate) ===
                      sceneRole(scenes.find((item) => item.id === sceneId)),
                )
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.id}
                  </option>
                ))}
            </select>
          </Field>
          <TargetSelect
            label="跳转目标"
            onChange={(target) =>
              onChange({
                ...action,
                next: {
                  ...(action.next as Extract<
                    ButtonPostAction,
                    { type: "jump" }
                  >),
                  target,
                },
              })
            }
            targets={jumpTargets}
            value={action.next.target}
          />
        </>
      )}
      {action.next?.type === "open_panel" && (
        <Field label="系统面板">
          <select
            value={action.next.panel}
            onChange={(event) =>
              onChange({
                ...action,
                next: {
                  type: "open_panel",
                  panel: event.currentTarget.value as Extract<
                    ButtonPostAction,
                    { type: "open_panel" }
                  >["panel"],
                },
              })
            }
          >
            <option value="saves">存档</option>
            <option value="settings">设置</option>
            <option value="history">历史记录</option>
          </select>
        </Field>
      )}
    </section>
  );
}

function ButtonMutationValueEditor({
  manifest,
  onChange,
  operation,
  targetVariable,
  value,
}: {
  manifest: ContentManifest;
  onChange(value: MutationValue): void;
  operation: VariableOperation;
  targetVariable: string;
  value: MutationValue | undefined;
}): ReactElement {
  const targetType = manifest.variables[targetVariable]?.type ?? "boolean";
  const current = value ?? defaultSetValue(targetVariable, operation, manifest);
  const variableValue =
    typeof current === "object" && current !== null ? current.variable : null;
  const eligibleVariables = Object.entries(manifest.variables).filter(
    ([, definition]) =>
      mutationTypesCompatible(targetType, definition.type, operation),
  );
  return (
    <div className="operand-editor">
      <select
        value={variableValue === null ? "literal" : "variable"}
        onChange={(event) => {
          if (event.currentTarget.value === "variable") {
            onChange({ variable: eligibleVariables[0]?.[0] ?? "" });
          } else {
            onChange(defaultScalar(targetType));
          }
        }}
      >
        <option value="literal">固定值</option>
        <option disabled={eligibleVariables.length === 0} value="variable">
          变量
        </option>
      </select>
      {variableValue === null ? (
        <LiteralEditor
          expectedType={targetType}
          onChange={onChange}
          value={current as ScalarValue}
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
              {id}（{VARIABLE_TYPE_LABELS[definition.type]}）
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
