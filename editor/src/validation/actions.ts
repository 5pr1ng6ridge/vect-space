import type { EditorDiagnostic, EditorProject } from "../types";
import { ID_PATTERN, error } from "./shared";

export function validateActions(
  project: EditorProject,
  diagnostics: EditorDiagnostic[],
): void {
  const actionFiles = project.actions ?? [];
  const actionIds = new Set<string>();
  const declaredActionPaths = new Set(project.manifest.actions ?? []);
  for (const file of actionFiles) {
    const definition = file.definition;
    if (!declaredActionPaths.has(file.path)) {
      diagnostics.push(
        error("undeclared_action", `立绘动作文件未登记：${file.path}`),
      );
    }
    if (
      definition.schema_version !== 1 ||
      !ID_PATTERN.test(definition.id) ||
      definition.name.trim() === "" ||
      definition.name.length > 128
    ) {
      diagnostics.push(
        error("invalid_action", `立绘动作定义无效：${definition.id}`),
      );
    }
    if (actionIds.has(definition.id)) {
      diagnostics.push(
        error("duplicate_action", `立绘动作 ID 重复：${definition.id}`),
      );
    }
    actionIds.add(definition.id);
    if (project.manifest.assets[definition.id] !== undefined) {
      diagnostics.push(
        error(
          "action_asset_collision",
          `立绘动作 ID ${definition.id} 与素材 ID 冲突`,
        ),
      );
    }
    if (
      (project.animations ?? []).some(
        (file) => file.definition.id === definition.id,
      )
    ) {
      diagnostics.push(
        error(
          "action_animation_collision",
          `立绘动作 ID ${definition.id} 与图片动画 ID 冲突`,
        ),
      );
    }
    if (
      !Number.isInteger(definition.duration_ms) ||
      definition.duration_ms < 1 ||
      definition.duration_ms > 1_800_000
    ) {
      diagnostics.push(
        error("invalid_action_duration", `立绘动作 ${definition.id} 时长无效`),
      );
    }
    const parameters = definition.parameters ?? {};
    if (Object.keys(parameters).length > 32) {
      diagnostics.push(
        error(
          "too_many_action_parameters",
          `立绘动作 ${definition.id} 参数过多`,
        ),
      );
    }
    for (const [parameterId, parameter] of Object.entries(parameters)) {
      if (!ID_PATTERN.test(parameterId)) {
        diagnostics.push(
          error(
            "invalid_action_parameter",
            `立绘动作参数 ID 非法：${parameterId}`,
          ),
        );
      }
      if (
        !Number.isFinite(parameter.default) ||
        (parameter.min != null && !Number.isFinite(parameter.min)) ||
        (parameter.max != null && !Number.isFinite(parameter.max)) ||
        (parameter.min != null &&
          parameter.max != null &&
          parameter.min > parameter.max) ||
        (parameter.min != null && parameter.default < parameter.min) ||
        (parameter.max != null && parameter.default > parameter.max)
      ) {
        diagnostics.push(
          error(
            "invalid_action_parameter",
            `立绘动作参数 ${parameterId} 范围无效`,
          ),
        );
      }
    }
    const allowedChannels = new Set([
      "x",
      "y",
      "scale",
      "scale_x",
      "scale_y",
      "rotation_deg",
      "opacity",
    ]);
    if (Object.keys(definition.channels).length === 0) {
      diagnostics.push(
        error("empty_action", `立绘动作 ${definition.id} 至少需要一个变换通道`),
      );
    }
    if (Object.keys(definition.channels).length > 16) {
      diagnostics.push(
        error("too_many_action_channels", `立绘动作 ${definition.id} 通道过多`),
      );
    }
    for (const [channel, frames] of Object.entries(definition.channels)) {
      if (!allowedChannels.has(channel)) {
        diagnostics.push(
          error(
            "invalid_action_channel",
            `立绘动作 ${definition.id} 不支持 ${channel}`,
          ),
        );
      }
      let previous = -1;
      if (frames[0]?.at_ms !== 0) {
        diagnostics.push(
          error(
            "action_missing_initial_keyframe",
            `立绘动作 ${definition.id}/${channel} 必须从 0ms 关键帧开始`,
          ),
        );
      }
      for (const frame of frames) {
        const value = frame.value;
        if (
          !Number.isFinite(value) ||
          !Number.isInteger(frame.at_ms) ||
          frame.at_ms < 0 ||
          frame.at_ms <= previous ||
          frame.at_ms > definition.duration_ms ||
          (channel === "scale" && value <= 0) ||
          ((channel === "scale_x" || channel === "scale_y") && value === 0) ||
          (channel === "opacity" && (value < 0 || value > 1)) ||
          (frame.parameter != null && parameters[frame.parameter] === undefined)
        ) {
          diagnostics.push(
            error(
              "invalid_action_keyframe",
              `立绘动作 ${definition.id}/${channel} 关键帧无效`,
            ),
          );
        }
        previous = frame.at_ms;
      }
    }
  }
  for (const path of declaredActionPaths) {
    if (!actionFiles.some((file) => file.path === path)) {
      diagnostics.push(
        error(
          "missing_action",
          `manifest 声明了立绘动作，但编辑器文档不存在：${path}`,
        ),
      );
    }
  }
}
