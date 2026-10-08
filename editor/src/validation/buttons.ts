import { isWindowVariable, sceneRole } from "../windowInteraction";
import type {
  EditorDiagnostic,
  EditorProject,
  SceneNode,
  TimelineKeyframe,
  ButtonClickAction,
} from "../types";
import { ID_PATTERN, error } from "./shared";
import { validateMutation } from "./expressions";

export function validateButtons(
  project: EditorProject,
  diagnostics: EditorDiagnostic[],
): void {
  const buttonFiles = project.buttons ?? [];
  const buttonIds = new Set<string>();
  const declaredButtonPaths = new Set(project.manifest.buttons ?? []);
  for (const file of buttonFiles) {
    const template = file.definition;
    if (!declaredButtonPaths.has(file.path)) {
      diagnostics.push(
        error("undeclared_button", `按钮模板文件未登记：${file.path}`),
      );
    }
    if (template.schema_version !== 1 || !ID_PATTERN.test(template.id)) {
      diagnostics.push(
        error("invalid_button", `按钮模板定义无效：${template.id}`),
      );
    }
    if (buttonIds.has(template.id)) {
      diagnostics.push(
        error("duplicate_button", `按钮模板 ID 重复：${template.id}`),
      );
    }
    buttonIds.add(template.id);
    if (
      !Number.isFinite(template.width) ||
      template.width <= 0 ||
      !Number.isFinite(template.height) ||
      template.height <= 0
    ) {
      diagnostics.push(
        error("invalid_button_size", `按钮模板 ${template.id} 尺寸必须为正数`),
      );
    }
    for (const [slot, assetId] of [
      ["normal", template.normal],
      ["hover", template.hover],
      ["pressed", template.pressed],
    ] as const) {
      if (assetId == null) continue;
      const asset = project.manifest.assets[assetId];
      if (
        asset === undefined ||
        (asset.kind !== "gui" && asset.kind !== "sprite")
      ) {
        diagnostics.push(
          error(
            "invalid_button_asset",
            `按钮模板 ${template.id} 的${slot}素材无效：${assetId}`,
          ),
        );
      }
    }
    for (const state of ["normal", "hover", "pressed"] as const) {
      const animation = template.animations[state];
      if (animation == null) continue;
      if (
        !Number.isInteger(animation.duration_ms) ||
        animation.duration_ms < 1 ||
        animation.duration_ms > 1_800_000
      ) {
        diagnostics.push(
          error(
            "invalid_button_animation",
            `按钮模板 ${template.id}/${state} 动画时长无效`,
          ),
        );
      }
      for (const [channel, frames] of Object.entries(animation.channels)) {
        const keyframes: TimelineKeyframe[] = frames;
        if (
          !(
            [
              "offset_x",
              "offset_y",
              "scale_x",
              "scale_y",
              "rotation_deg",
              "opacity",
            ] as string[]
          ).includes(channel)
        ) {
          diagnostics.push(
            error(
              "invalid_button_channel",
              `按钮模板 ${template.id} 不支持 ${channel} 通道`,
            ),
          );
        }
        let previous = -1;
        for (const frame of keyframes) {
          if (
            frame.value === "inherit" ||
            typeof frame.value !== "number" ||
            !Number.isFinite(frame.value) ||
            !Number.isInteger(frame.at_ms) ||
            frame.at_ms < 0 ||
            frame.at_ms <= previous ||
            frame.at_ms > animation.duration_ms
          ) {
            diagnostics.push(
              error(
                "invalid_button_keyframe",
                `按钮模板 ${template.id}/${state}/${channel} 关键帧无效`,
              ),
            );
          }
          if (
            channel === "opacity" &&
            typeof frame.value === "number" &&
            (frame.value < 0 || frame.value > 1)
          )
            diagnostics.push(
              error(
                "invalid_button_range",
                `按钮模板 ${template.id} 透明度必须在 0–1`,
              ),
            );
          if (
            (channel === "scale_x" || channel === "scale_y") &&
            typeof frame.value === "number" &&
            frame.value === 0
          )
            diagnostics.push(
              error(
                "invalid_button_range",
                `按钮模板 ${template.id} 缩放不能为 0`,
              ),
            );
          previous = frame.at_ms;
        }
      }
    }
  }
  for (const path of declaredButtonPaths) {
    if (!buttonFiles.some((file) => file.path === path))
      diagnostics.push(
        error(
          "missing_button",
          `manifest 声明了按钮模板，但编辑器文档不存在：${path}`,
        ),
      );
  }
}

export function validateButtonLayout(
  node: Extract<SceneNode, { type: "button_create" | "button_update" }>,
  issue: (code: string, message: string) => void,
): void {
  const fields: [string, number | null | undefined][] = [
    ["x", node.x],
    ["y", node.y],
    ["width", node.width],
    ["height", node.height],
    ["rotation_deg", node.rotation_deg],
    ["scale_x", node.scale_x],
    ["scale_y", node.scale_y],
    ["opacity", node.opacity],
    ["z", node.z],
  ];
  for (const [field, value] of fields) {
    if (value != null && !Number.isFinite(value))
      issue("invalid_button_layout", `${field} 必须是有限数`);
  }
  if (node.width != null && node.width <= 0)
    issue("invalid_button_layout", "按钮宽度必须为正数");
  if (node.height != null && node.height <= 0)
    issue("invalid_button_layout", "按钮高度必须为正数");
  if (node.scale_x === 0) issue("invalid_button_layout", "横向缩放不能为 0");
  if (node.scale_y === 0) issue("invalid_button_layout", "纵向缩放不能为 0");
  if (node.opacity != null && (node.opacity < 0 || node.opacity > 1))
    issue("invalid_button_layout", "透明度必须在 0–1 之间");
}

export function validateButtonAction(
  project: EditorProject,
  action: ButtonClickAction,
  sceneId: string,
  issue: (code: string, message: string) => void,
): void {
  if (action.sets.length > 64)
    issue("too_many_button_sets", "按钮变量修改超过 64 条");
  for (const set of action.sets) {
    if (isWindowVariable(set.variable)) {
      issue(
        "readonly_window_variable",
        `按钮不能修改只读的窗口标题变量 ${set.variable}`,
      );
      continue;
    }
    if (
      !ID_PATTERN.test(set.variable) ||
      project.manifest.variables[set.variable] === undefined
    ) {
      issue("unknown_button_variable", `按钮引用了未知变量：${set.variable}`);
      continue;
    }
    const pseudo = {
      type: "set" as const,
      variable: set.variable,
      op: set.op ?? "assign",
      value: set.value,
      next: "",
    };
    validateMutation(project, pseudo, issue);
  }
  if (action.next?.type === "jump") {
    if (!ID_PATTERN.test(action.next.target))
      issue("invalid_button_target", "按钮跳转目标 ID 非法");
    if (action.next.scene != null && !ID_PATTERN.test(action.next.scene))
      issue("invalid_button_target", "按钮跳转场景 ID 非法");
    const destinationId = action.next.scene ?? sceneId;
    const destination = project.scenes.find(
      (file) => file.definition.id === destinationId,
    )?.definition;
    if (destination === undefined) {
      issue(
        "unknown_button_target_scene",
        `按钮跳转场景不存在：${destinationId}`,
      );
    } else if (
      !Object.prototype.hasOwnProperty.call(
        destination.nodes,
        action.next.target,
      )
    ) {
      issue(
        "unknown_button_target",
        `按钮跳转目标节点不存在：${destinationId}/${action.next.target}`,
      );
    } else if (
      sceneRole(destination) !==
      sceneRole(
        project.scenes.find((file) => file.definition.id === sceneId)
          ?.definition,
      )
    ) {
      issue(
        "window_role_mismatch",
        `按钮不能跨主/副窗口用途跳转到场景 ${destinationId}`,
      );
    }
  }
}
