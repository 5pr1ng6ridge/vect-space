import type { EditorDiagnostic, EditorProject, UiMotionPreset } from "../types";
import { ID_PATTERN, error } from "./shared";

export function validateUiMotions(
  project: EditorProject,
  diagnostics: EditorDiagnostic[],
): void {
  const motionIds = new Set(
    project.ui_motions.map((file) => file.definition.id),
  );
  const declaredMotionPaths = new Set(project.manifest.ui_motions);
  for (const file of project.ui_motions) {
    if (!declaredMotionPaths.has(file.path)) {
      diagnostics.push(
        error("undeclared_ui_motion", `UI 动效文件未登记：${file.path}`),
      );
    }
    const preset = file.definition;
    if (preset.schema_version !== 1 || !ID_PATTERN.test(preset.id)) {
      diagnostics.push(
        error("invalid_ui_motion", `UI 动效定义无效：${preset.id}`),
      );
    }
    if (
      !Number.isInteger(preset.duration_ms) ||
      preset.duration_ms < 1 ||
      preset.duration_ms > 1_800_000
    ) {
      diagnostics.push(
        error("invalid_ui_motion_duration", `UI 动效 ${preset.id} 时长无效`),
      );
    }
    validateUiMotionPreset(preset, diagnostics);
  }
  for (const [slot, motion] of [
    ["dialogue_show", project.manifest.ui_motion_defaults.dialogue_show],
    ["dialogue_hide", project.manifest.ui_motion_defaults.dialogue_hide],
  ] as const) {
    if (motion != null && !motionIds.has(motion)) {
      diagnostics.push(
        error(
          "unknown_ui_motion",
          `默认槽位 ${slot} 引用了未知 UI 动效 ${motion}`,
        ),
      );
    }
  }
}

function validateUiMotionPreset(
  preset: UiMotionPreset,
  output: EditorDiagnostic[],
): void {
  const targets = new Set<string>();
  for (const track of preset.tracks) {
    if (targets.has(track.target)) {
      output.push(
        error(
          "duplicate_ui_motion_target",
          `UI 动效 ${preset.id} 的目标 ${track.target} 重复`,
        ),
      );
    }
    targets.add(track.target);
    if (Object.keys(track.channels).length === 0) {
      output.push(
        error(
          "empty_ui_motion_track",
          `UI 动效 ${preset.id} 的 ${track.target} 轨道没有通道`,
        ),
      );
    }
    for (const [channel, frames] of Object.entries(track.channels)) {
      if (
        ![
          "offset_x",
          "offset_y",
          "scale_x",
          "scale_y",
          "rotation_deg",
          "opacity",
        ].includes(channel)
      ) {
        output.push(
          error(
            "invalid_ui_motion_channel",
            `UI 动效 ${preset.id} 不支持通道 ${channel}`,
          ),
        );
      }
      let prior = -1;
      for (const frame of frames) {
        if (
          typeof frame.value !== "number" ||
          !Number.isFinite(frame.value) ||
          !Number.isInteger(frame.at_ms) ||
          frame.at_ms < 0 ||
          frame.at_ms <= prior ||
          frame.at_ms > preset.duration_ms
        ) {
          output.push(
            error(
              "invalid_ui_motion_keyframe",
              `UI 动效 ${preset.id}/${channel} 的关键帧无效`,
            ),
          );
        }
        if (
          channel === "opacity" &&
          typeof frame.value === "number" &&
          (frame.value < 0 || frame.value > 1)
        ) {
          output.push(
            error(
              "invalid_ui_motion_range",
              `UI 动效 ${preset.id} 的透明度必须在 0–1`,
            ),
          );
        }
        if (
          ["scale_x", "scale_y"].includes(channel) &&
          typeof frame.value === "number" &&
          frame.value === 0
        ) {
          output.push(
            error(
              "invalid_ui_motion_range",
              `UI 动效 ${preset.id} 的缩放不能为 0`,
            ),
          );
        }
        prior = frame.at_ms;
      }
    }
  }
}
