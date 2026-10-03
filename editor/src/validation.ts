import { outputPorts } from "./story";
import { validateTemplate } from "./textTemplate";
import {
  isWindowVariable,
  MAX_SCENE_TIMERS,
  MAX_TIMER_DURATION_MS,
  MIN_TIMER_INTERVAL_MS,
  readableVariables,
  sceneRole,
  timerTargetProblem,
  WINDOW_ROLE_LABELS,
  windowTitleProblem,
} from "./windowInteraction";
import { isIntegerScalar, scalarType } from "./scalars";
import {
  IMAGE_ANIMATION_MAX_DECODED_BYTES,
  IMAGE_ANIMATION_MAX_FRAME_MS,
  IMAGE_ANIMATION_MAX_FRAMES,
  IMAGE_ANIMATION_MIN_FRAME_MS,
  IMAGE_ANIMATION_SCHEMA_VERSION,
} from "./imageAnimation";
import {
  CHOICE_STAGE_HEIGHT,
  CHOICE_STAGE_WIDTH,
} from "@vectspace/presentation-core/choice-layout";
import type {
  AssetKind,
  AmbienceSlot,
  BackgroundTransitionSpec,
  ChoiceNode,
  ConditionExpression,
  EditorDiagnostic,
  EditorProject,
  ScalarValue,
  SceneNode,
  ScreenEffectSpec,
  TimelineTrack,
  UiMotionPreset,
  ValueOperand,
  VariableType,
  TimelineKeyframe,
  ButtonClickAction,
} from "./types";

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const AMBIENCE_SLOTS: readonly AmbienceSlot[] = [
  "slot_1",
  "slot_2",
  "slot_3",
  "slot_4",
];

export function validateLive(project: EditorProject): EditorDiagnostic[] {
  const diagnostics: EditorDiagnostic[] = [];
  validateManagedDocumentPaths(project, diagnostics);
  const sceneById = new Map(
    project.scenes.map(
      (file) => [file.definition.id, file.definition] as const,
    ),
  );

  if (!sceneById.has(project.manifest.entry_scene)) {
    diagnostics.push(error("missing_entry_scene", "项目入口场景不存在"));
  } else if (
    sceneRole(sceneById.get(project.manifest.entry_scene)) !== "main"
  ) {
    diagnostics.push(
      error(
        "secondary_entry_scene",
        "项目入口场景不能是副窗口专用 Scene；请换一个主窗口 Scene 作为入口",
        project.manifest.entry_scene,
      ),
    );
  }

  if (project.manifest.schema_version !== 2) {
    diagnostics.push(
      error("invalid_manifest_schema", "manifest schema_version 必须为 2"),
    );
  }
  for (const [id, definition] of Object.entries(project.manifest.variables)) {
    if (!ID_PATTERN.test(id)) {
      diagnostics.push(error("invalid_variable", `变量名非法：${id}`));
    }
    if (isWindowVariable(id)) {
      diagnostics.push(
        error(
          "reserved_window_variable",
          `变量 ${id} 是内置的只读窗口标题变量，不能声明同名变量`,
        ),
      );
    }
    if (!valueMatchesType(definition.default, definition.type)) {
      diagnostics.push(
        error(
          "invalid_variable_default",
          `变量 ${id} 的默认值不符合 ${definition.type} 类型`,
        ),
      );
    }
  }
  for (const [id, definition] of Object.entries(project.manifest.characters)) {
    if (!ID_PATTERN.test(id)) {
      diagnostics.push(error("invalid_character", `角色 ID 非法：${id}`));
    }
    validateDisplayName(definition.display_name).forEach((message) =>
      diagnostics.push(
        error("invalid_character_name", `角色 ${id}：${message}`),
      ),
    );
    for (const [field, color] of [
      ["姓名色", definition.name_color],
      ["正文色", definition.text_color],
    ] as const) {
      if (
        color != null &&
        !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/.test(color)
      ) {
        diagnostics.push(
          error("invalid_character_color", `角色 ${id} 的${field}格式非法`),
        );
      }
    }
    const expressions = definition.expressions ?? {};
    const defaultExpression = definition.default_expression ?? null;
    if (
      definition.default_scale !== undefined &&
      (!Number.isFinite(definition.default_scale) ||
        definition.default_scale <= 0)
    ) {
      diagnostics.push(
        error("invalid_character_scale", `角色 ${id} 的默认缩放必须为正数`),
      );
    }
    if (
      defaultExpression !== null &&
      expressions[defaultExpression] === undefined
    ) {
      diagnostics.push(
        error(
          "unknown_character_expression",
          `角色 ${id} 的默认表情不存在：${defaultExpression}`,
        ),
      );
    }
    for (const [expressionId, expression] of Object.entries(expressions)) {
      if (!ID_PATTERN.test(expressionId)) {
        diagnostics.push(
          error(
            "invalid_character_expression",
            `角色 ${id} 的表情 ID 非法：${expressionId}`,
          ),
        );
      }
      const asset = project.manifest.assets[expression.asset];
      if (asset === undefined || asset.kind !== "sprite") {
        diagnostics.push(
          error(
            "invalid_character_expression_asset",
            `角色 ${id}/${expressionId} 必须引用 sprite 素材：${expression.asset}`,
          ),
        );
      }
      const anchorX = expression.anchor_x ?? 0.5;
      const anchorY = expression.anchor_y ?? 1;
      const scale = expression.scale ?? 1;
      if (
        !Number.isFinite(anchorX) ||
        !Number.isFinite(anchorY) ||
        anchorX < 0 ||
        anchorX > 1 ||
        anchorY < 0 ||
        anchorY > 1
      ) {
        diagnostics.push(
          error(
            "invalid_character_anchor",
            `角色 ${id}/${expressionId} 的锚点必须在 0 到 1 之间`,
          ),
        );
      }
      if (
        !Number.isFinite(expression.offset_x ?? 0) ||
        !Number.isFinite(expression.offset_y ?? 0) ||
        !Number.isFinite(scale) ||
        scale <= 0
      ) {
        diagnostics.push(
          error(
            "invalid_character_alignment",
            `角色 ${id}/${expressionId} 的对齐参数无效`,
          ),
        );
      }
    }
  }
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

  // Image animations (schema v1) mirror the Rust rules so an authoring mistake
  // is reported in the sidebar instead of only at save time.
  const animationFiles = project.animations ?? [];
  const animationIds = new Set<string>();
  const declaredAnimationPaths = new Set(project.manifest.animations ?? []);
  for (const file of animationFiles) {
    const definition = file.definition;
    if (!declaredAnimationPaths.has(file.path)) {
      diagnostics.push(
        error("undeclared_animation", `图片动画文件未登记：${file.path}`),
      );
    }
    if (
      definition.schema_version !== IMAGE_ANIMATION_SCHEMA_VERSION ||
      !ID_PATTERN.test(definition.id)
    ) {
      diagnostics.push(
        error("invalid_animation", `图片动画定义无效：${definition.id}`),
      );
    }
    if (animationIds.has(definition.id)) {
      diagnostics.push(
        error("duplicate_animation", `图片动画 ID 重复：${definition.id}`),
      );
    }
    animationIds.add(definition.id);
    if (project.manifest.assets[definition.id] !== undefined) {
      diagnostics.push(
        error(
          "animation_asset_collision",
          `图片动画 ID ${definition.id} 与素材 ID 冲突：动画 ID 必须独立于素材命名空间`,
        ),
      );
    }
    const frames = definition.frames;
    if (frames.length === 0) {
      diagnostics.push(
        error("empty_animation", `图片动画 ${definition.id} 至少需要一帧`),
      );
    }
    if (frames.length > IMAGE_ANIMATION_MAX_FRAMES) {
      diagnostics.push(
        error(
          "too_many_animation_frames",
          `图片动画 ${definition.id} 的帧数超过 ${IMAGE_ANIMATION_MAX_FRAMES}`,
        ),
      );
    }
    let shared: { width: number; height: number } | undefined;
    let sharedFrame = 0;
    const measured = new Set<string>();
    let decodedBytes = 0;
    for (const [index, frame] of frames.entries()) {
      const position = index + 1;
      if (
        !Number.isInteger(frame.duration_ms) ||
        frame.duration_ms < IMAGE_ANIMATION_MIN_FRAME_MS ||
        frame.duration_ms > IMAGE_ANIMATION_MAX_FRAME_MS
      ) {
        diagnostics.push(
          error(
            "invalid_animation_frame_duration",
            `图片动画 ${definition.id} 第 ${position} 帧时长必须在 ${IMAGE_ANIMATION_MIN_FRAME_MS}–${IMAGE_ANIMATION_MAX_FRAME_MS}ms 之间`,
          ),
        );
      }
      const frameAsset = project.manifest.assets[frame.asset];
      if (frameAsset === undefined) {
        diagnostics.push(
          error(
            "unknown_animation_frame",
            `图片动画 ${definition.id} 第 ${position} 帧引用了未登记的素材 ${frame.asset}`,
          ),
        );
        continue;
      }
      if (!["background", "sprite", "gui"].includes(frameAsset.kind)) {
        diagnostics.push(
          error(
            "invalid_animation_frame_kind",
            `图片动画 ${definition.id} 第 ${position} 帧的素材 ${frame.asset} 不是图片素材`,
          ),
        );
      }
      if (frameAsset.animation !== undefined) {
        diagnostics.push(
          error(
            "nested_animation_frame",
            `图片动画 ${definition.id} 第 ${position} 帧引用了动画素材 ${frame.asset}`,
          ),
        );
      }
      const size = assetPixelSize(project, frame.asset);
      if (size === undefined) continue;
      if (shared === undefined) {
        shared = size;
        sharedFrame = position;
      } else if (shared.width !== size.width || shared.height !== size.height) {
        diagnostics.push(
          error(
            "animation_frame_size_mismatch",
            `图片动画 ${definition.id} 第 ${position} 帧尺寸 ${size.width}×${size.height} 与第 ${sharedFrame} 帧 ${shared.width}×${shared.height} 不一致`,
          ),
        );
      }
      if (!measured.has(frame.asset)) {
        measured.add(frame.asset);
        decodedBytes += size.width * size.height * 4;
      }
    }
    if (decodedBytes > IMAGE_ANIMATION_MAX_DECODED_BYTES) {
      diagnostics.push(
        error(
          "animation_memory_budget",
          `图片动画 ${definition.id} 解码内存超过 ${IMAGE_ANIMATION_MAX_DECODED_BYTES / (1024 * 1024)} MiB 预算`,
        ),
      );
    }
  }
  for (const path of declaredAnimationPaths) {
    if (!animationFiles.some((file) => file.path === path)) {
      diagnostics.push(
        error(
          "missing_animation",
          `manifest 声明了图片动画，但编辑器文档不存在：${path}`,
        ),
      );
    }
  }
  for (const [id, definition] of Object.entries(project.manifest.assets)) {
    if (definition.animation !== undefined) {
      if (definition.path !== undefined) {
        diagnostics.push(
          error(
            "asset_animation_conflict",
            `素材 ${id} 的 path 与 animation 互斥`,
          ),
        );
      }
      if (!["background", "sprite", "gui"].includes(definition.kind)) {
        diagnostics.push(
          error(
            "invalid_animation_owner_kind",
            `动画素材 ${id} 必须是 background、sprite 或 gui 类型`,
          ),
        );
      }
      if (!animationIds.has(definition.animation)) {
        diagnostics.push(
          error(
            "unknown_animation",
            `素材 ${id} 引用了未登记的图片动画 ${definition.animation}`,
          ),
        );
      }
    } else if (definition.path === undefined) {
      diagnostics.push(
        error(
          "asset_without_source",
          `素材 ${id} 必须登记 path 或 animation 之一`,
        ),
      );
    }
  }

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

  const seenScenes = new Set<string>();
  for (const file of project.scenes) {
    const scene = file.definition;
    if (scene.schema_version !== 2) {
      diagnostics.push(
        error(
          "invalid_scene_schema",
          "scene schema_version 必须为 2",
          scene.id,
        ),
      );
    }
    if (!ID_PATTERN.test(scene.id)) {
      diagnostics.push(
        error("invalid_scene_id", `非法场景 ID：${scene.id}`, scene.id),
      );
    }
    if (seenScenes.has(scene.id)) {
      diagnostics.push(
        error("duplicate_scene_id", `场景 ID 重复：${scene.id}`, scene.id),
      );
    }
    seenScenes.add(scene.id);
    if (
      scene.window_role !== undefined &&
      scene.window_role !== "main" &&
      scene.window_role !== "secondary"
    ) {
      diagnostics.push(
        error(
          "invalid_window_role",
          "Scene 用途必须是 main（主窗口）或 secondary（副窗口）",
          scene.id,
        ),
      );
    }
    const timerIds = new Set(
      Object.values(scene.nodes)
        .filter((node) => node.type === "timer" && node.action === "start")
        .map((node) => (node.type === "timer" ? node.id : "")),
    );
    if (timerIds.size > MAX_SCENE_TIMERS) {
      diagnostics.push({
        severity: "warning",
        code: "too_many_timers",
        message: `Scene 里有 ${timerIds.size} 个不同的计时器 ID；同时活动的计时器最多 ${MAX_SCENE_TIMERS} 个，超出会在运行时停止`,
        scene_id: scene.id,
        node_id: null,
      });
    }
    if (scene.nodes[scene.entry] === undefined) {
      diagnostics.push(
        error(
          "missing_scene_entry",
          `入口节点不存在：${scene.entry}`,
          scene.id,
        ),
      );
    }

    const longTextDocuments = new Map<
      string,
      {
        hasStart: boolean;
        nodeId: string;
        stepIds: Map<string, string>;
        startPagination?: "continuous" | "auto" | "manual";
      }
    >();
    for (const [nodeId, candidate] of Object.entries(scene.nodes)) {
      if (candidate.type !== "long_text") continue;
      const documentId = candidate.document ?? nodeId;
      const existing = longTextDocuments.get(documentId);
      if (existing === undefined) {
        const stepIds = new Map<string, string>();
        for (const step of candidate.steps) {
          if (stepIds.has(step.id)) {
            diagnostics.push(
              error(
                "duplicate_long_text_step",
                `文稿 ${documentId} 的步骤 ID ${step.id} 在同一节点中重复`,
                scene.id,
                nodeId,
              ),
            );
          }
          stepIds.set(step.id, nodeId);
        }
        longTextDocuments.set(documentId, {
          hasStart: (candidate.mode ?? "start") === "start",
          nodeId,
          startPagination:
            (candidate.mode ?? "start") === "start"
              ? (candidate.pagination ?? "auto")
              : undefined,
          stepIds,
        });
      } else {
        if ((candidate.mode ?? "start") === "start" && existing.hasStart) {
          diagnostics.push(
            error(
              "duplicate_long_text_start",
              `文稿 ${documentId} 只能有一个开始节点`,
              scene.id,
              nodeId,
            ),
          );
        }
        if ((candidate.mode ?? "start") === "start") {
          existing.hasStart = true;
          existing.nodeId = nodeId;
          existing.startPagination = candidate.pagination ?? "auto";
        }
        for (const step of candidate.steps) {
          const previousNodeId = existing.stepIds.get(step.id);
          if (previousNodeId !== undefined) {
            const location =
              previousNodeId === nodeId
                ? "同一节点中重复"
                : `与节点 ${previousNodeId} 重复`;
            diagnostics.push(
              error(
                "duplicate_long_text_step",
                `文稿 ${documentId} 的步骤 ID ${step.id}${location}`,
                scene.id,
                nodeId,
              ),
            );
          }
          existing.stepIds.set(step.id, nodeId);
        }
      }
    }
    for (const [documentId, document] of longTextDocuments) {
      if (!document.hasStart) {
        diagnostics.push(
          error(
            "missing_long_text_start",
            `文稿 ${documentId} 缺少开始节点`,
            scene.id,
            document.nodeId,
          ),
        );
      }
    }

    for (const [nodeId, node] of Object.entries(scene.nodes)) {
      if (!ID_PATTERN.test(nodeId)) {
        diagnostics.push(
          error("invalid_node_id", `非法节点 ID：${nodeId}`, scene.id, nodeId),
        );
      }
      validateNode(project, scene.id, nodeId, node, diagnostics);
      if (
        (node.type === "button_update" || node.type === "button_remove") &&
        !Object.values(scene.nodes).some(
          (candidate) =>
            candidate.type === "button_create" &&
            candidate.instance_id === node.instance_id,
        )
      ) {
        diagnostics.push(
          error(
            "unknown_button_instance",
            `按钮实例不存在：${node.instance_id}`,
            scene.id,
            nodeId,
          ),
        );
      }
      if (node.type === "long_text" && node.mode === "continue") {
        const document = node.document ?? nodeId;
        if (
          longTextDocuments.get(document)?.startPagination === "continuous" &&
          node.steps.some((step) => step.page_break_before)
        ) {
          diagnostics.push(
            error(
              "continuous_long_text_break",
              "开始节点使用连续长卷时，接续段不能使用强制分页",
              scene.id,
              nodeId,
            ),
          );
        }
      }
      for (const port of outputPorts(node)) {
        const destinationScene = port.targetScene ?? scene.id;
        const destination = sceneById.get(destinationScene);
        if (destination === undefined) {
          diagnostics.push(
            error(
              "missing_target_scene",
              `端口“${port.label}”指向不存在的场景 ${destinationScene}`,
              scene.id,
              nodeId,
            ),
          );
        } else if (destination.nodes[port.target] === undefined) {
          diagnostics.push(
            error(
              "missing_target_node",
              `端口“${port.label}”指向不存在的节点 ${destinationScene}/${port.target}`,
              scene.id,
              nodeId,
            ),
          );
        }
      }
    }

    for (const [nodeId, node] of Object.entries(scene.nodes)) {
      if (
        node.type === "long_text_control" &&
        !longTextDocuments.has(node.document)
      ) {
        diagnostics.push(
          error(
            "unknown_long_text_document",
            `文稿控制引用了未知文稿：${node.document}`,
            scene.id,
            nodeId,
          ),
        );
      }
    }
  }

  validateChapterMap(project, sceneById, diagnostics);

  diagnostics.push(...reachabilityWarnings(project, sceneById));
  return deduplicate([...diagnostics, ...project.diagnostics]);
}

function validateManagedDocumentPaths(
  project: EditorProject,
  output: EditorDiagnostic[],
): void {
  const paths: [string, string][] = [
    ...project.manifest.scenes.map((path): [string, string] => ["scene", path]),
    ...project.manifest.ui_motions.map((path): [string, string] => [
      "ui_motion",
      path,
    ]),
    ...(project.manifest.buttons ?? []).map((path): [string, string] => [
      "button",
      path,
    ]),
    ...(project.manifest.animations ?? []).map((path): [string, string] => [
      "animation",
      path,
    ]),
    ...(project.manifest.actions ?? []).map((path): [string, string] => [
      "action",
      path,
    ]),
  ];
  if (project.manifest.chapter_map != null)
    paths.push(["chapter_map", project.manifest.chapter_map]);
  const seen = new Map<string, string>();
  for (const [kind, path] of paths) {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    if (
      normalized === "manifest.yaml" ||
      normalized.startsWith("assets/") ||
      normalized.startsWith(".vectspace/")
    ) {
      output.push(
        error(
          "reserved_document_path",
          `${kind} 路径不能覆盖受管制文件：${path}`,
        ),
      );
    }
    const previous = seen.get(normalized);
    if (previous !== undefined) {
      output.push(
        error(
          "duplicate_document_path",
          `内容文件路径与 ${previous} 冲突：${path}`,
        ),
      );
    } else {
      seen.set(normalized, kind);
    }
  }
}

/** Host-inspected pixel size of one registered asset, when known. */
function assetPixelSize(
  project: EditorProject,
  assetId: string,
): { width: number; height: number } | undefined {
  const metadata = project.assets.find(
    (asset) => asset.id === assetId,
  )?.metadata;
  if (metadata === undefined || metadata === null) return undefined;
  if (metadata.width === null || metadata.height === null) return undefined;
  return { width: metadata.width, height: metadata.height };
}

function validateChapterMap(
  project: EditorProject,
  scenes: Map<string, EditorProject["scenes"][number]["definition"]>,
  output: EditorDiagnostic[],
): void {
  const file = project.chapter_map;
  if (file === null || file === undefined) {
    if (project.manifest.chapter_map != null) {
      output.push(
        mapError(
          "missing_chapter_map",
          "manifest 声明了 chapter_map，但编辑器文档不存在",
          null,
        ),
      );
    }
    return;
  }
  const map = file.definition;
  const issue = (
    code: string,
    message: string,
    id: string | null = null,
  ): void => {
    output.push({
      severity: "error",
      code: `map_${code}`,
      message,
      scene_id: null,
      node_id: null,
      workspace: "map",
      flow_element_id: id,
    });
  };
  if (project.manifest.chapter_map !== file.path)
    issue("path", "chapter_map 文件路径与 manifest 不一致");
  if (map.schema_version !== 1)
    issue("schema", "chapter map schema_version 必须为 1");
  if (
    !Number.isInteger(map.width) ||
    !Number.isInteger(map.height) ||
    map.width < 1920 ||
    map.height < 1080 ||
    map.width > 16380 ||
    map.height > 16380 ||
    map.width % 20 !== 0 ||
    map.height % 20 !== 0
  ) {
    issue(
      "size",
      "房间尺寸必须在 1920×1080 到 16380×16380 之间并吸附到 20px 网格",
    );
  }
  const validViewCenter = (
    value: number,
    roomSize: number,
    viewportSize: number,
  ): boolean => {
    if (!Number.isInteger(value) || value < 0) return false;
    if (value % 20 !== 0) return false;
    if (roomSize <= viewportSize) return value === roomSize / 2;
    const half = viewportSize / 2;
    return value >= half && value <= roomSize - half;
  };
  if (
    !validViewCenter(map.view_x, map.width, 1920) ||
    !validViewCenter(map.view_y, map.height, 1080)
  )
    issue("view", "初始视图中心超出 1920×1080 视口边界");
  if (map.background != null) {
    const background = project.manifest.assets[map.background];
    if (background === undefined || background.kind !== "background")
      issue("background", `地图背景素材无效：${map.background}`, null);
  }
  const ids = new Set<string>();
  for (const item of map.decorations) {
    if (!ID_PATTERN.test(item.id) || !ids.add(item.id))
      issue("object_id", `地图装饰 ID 非法或重复：${item.id}`, item.id);
    if (
      !Number.isInteger(item.z) ||
      item.z < -2147483648 ||
      item.z > 2147483647
    )
      issue("z", `地图对象 ${item.id} 层级必须是 32 位整数`, item.id);
    validateMapRect(
      item.x,
      item.y,
      item.width,
      item.height,
      map.width,
      map.height,
      issue,
      item.id,
    );
    const asset = project.manifest.assets[item.asset];
    if (
      asset === undefined ||
      (asset.kind !== "gui" && asset.kind !== "sprite")
    )
      issue("asset", `地图装饰素材无效：${item.asset}`, item.id);
  }
  const scenesInMap = new Set<string>();
  const profileProject: EditorProject = {
    ...project,
    manifest: {
      ...project.manifest,
      variables: Object.fromEntries(
        Object.entries(project.manifest.variables).filter(
          ([, definition]) => definition.scope === "profile",
        ),
      ),
    },
  };
  for (const item of map.hotspots) {
    if (!ID_PATTERN.test(item.id) || !ids.add(item.id))
      issue("object_id", `章节热点 ID 非法或重复：${item.id}`, item.id);
    if (!scenes.has(item.scene_id))
      issue("scene", `章节热点引用未知 Scene：${item.scene_id}`, item.id);
    else if (sceneRole(scenes.get(item.scene_id)) !== "main")
      issue(
        "scene_secondary",
        `章节热点 ${item.id} 不能进入副窗口专用 Scene：${item.scene_id}`,
        item.id,
      );
    if (!scenesInMap.add(item.scene_id))
      issue(
        "scene_duplicate",
        `Scene 在地图中有多个热点：${item.scene_id}`,
        item.id,
      );
    if (
      !Number.isInteger(item.z) ||
      item.z < -2147483648 ||
      item.z > 2147483647
    )
      issue("z", `地图对象 ${item.id} 层级必须是 32 位整数`, item.id);
    if (
      item.title.trim() === "" ||
      /[\x00-\x1f]/.test(item.title) ||
      Array.from(item.title).length > 64
    )
      issue("title", `章节热点标题无效：${item.title}`, item.id);
    if (item.asset != null) {
      const asset = project.manifest.assets[item.asset];
      if (
        asset === undefined ||
        (asset.kind !== "gui" && asset.kind !== "sprite")
      )
        issue("asset", `章节热点素材无效：${item.asset}`, item.id);
    }
    validateMapRect(
      item.x,
      item.y,
      item.width,
      item.height,
      map.width,
      map.height,
      issue,
      item.id,
    );
    if (item.reveal?.mode === "condition")
      validateCondition(
        profileProject,
        item.reveal.condition,
        (code, message) =>
          issue(code, `章节热点 ${item.id}：${message}`, item.id),
        false,
      );
    for (const [variable, value] of Object.entries(item.variable_overrides)) {
      const definition = project.manifest.variables[variable];
      if (definition === undefined)
        issue(
          "override_variable",
          `章节热点 ${item.id} 覆盖了未知变量 ${variable}`,
          item.id,
        );
      else if (!valueMatchesType(value, definition.type))
        issue(
          "override_type",
          `章节热点 ${item.id} 的变量 ${variable} 类型不匹配`,
          item.id,
        );
    }
  }
}

function validateMapRect(
  x: number,
  y: number,
  width: number,
  height: number,
  roomWidth: number,
  roomHeight: number,
  issue: (code: string, message: string, id?: string | null) => void,
  id: string,
): void {
  if (
    ![x, y, width, height].every(Number.isInteger) ||
    !Number.isFinite(roomWidth) ||
    !Number.isFinite(roomHeight) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0 ||
    x % 20 !== 0 ||
    y % 20 !== 0 ||
    width % 20 !== 0 ||
    height % 20 !== 0 ||
    x > roomWidth ||
    y > roomHeight ||
    width > roomWidth - x ||
    height > roomHeight - y
  )
    issue(
      "rect",
      `地图对象 ${id} 的位置和尺寸必须落在 20px 网格及房间边界内`,
      id,
    );
}

/** A choice option or node template must reference a declared button file. */
type IssueSink = (code: string, message: string) => void;

function checkChoiceTemplate(
  project: EditorProject,
  templateId: string,
  label: string,
  issue: IssueSink,
): void {
  const known = (project.buttons ?? []).some(
    (file) => file.definition.id === templateId,
  );
  if (!known) {
    issue(
      "unknown_choice_template",
      `${label} 引用了未知按钮模板：${templateId}`,
    );
  }
}

function checkChoiceIcon(
  project: EditorProject,
  iconId: string,
  label: string,
  issue: IssueSink,
): void {
  const asset = project.manifest.assets[iconId];
  if (asset === undefined) {
    issue("missing_choice_icon", `${label} 的图标素材未登记：${iconId}`);
    return;
  }
  if (asset.kind !== "gui") {
    issue(
      "invalid_choice_icon_kind",
      `${label} 的图标必须是 gui 素材：${iconId}`,
    );
  }
}

/**
 * Live diagnostics for an opted-in choice presentation.
 *
 * The runtime never locks on an invalid value: it falls back to a documented
 * default and reports a `ChoiceDiagnostic`.  The editor mirrors those rules so
 * the author sees the same problem while typing, before a preview is built.
 */
function validateChoicePresentation(
  project: EditorProject,
  node: ChoiceNode,
  issue: IssueSink,
): void {
  const presentation = node.presentation;
  if (presentation === null || presentation === undefined) return;
  if (presentation.template != null && presentation.template !== "") {
    checkChoiceTemplate(project, presentation.template, "选择节点", issue);
  }
  if (
    !Number.isFinite(presentation.anchor_x) ||
    presentation.anchor_x < 0 ||
    presentation.anchor_x > CHOICE_STAGE_WIDTH
  ) {
    issue(
      "invalid_choice_anchor",
      `anchor_x 必须是 0–${CHOICE_STAGE_WIDTH} 之间的设计像素`,
    );
  }
  if (
    !Number.isFinite(presentation.anchor_y) ||
    presentation.anchor_y < 0 ||
    presentation.anchor_y > CHOICE_STAGE_HEIGHT
  ) {
    issue(
      "invalid_choice_anchor",
      `anchor_y 必须是 0–${CHOICE_STAGE_HEIGHT} 之间的设计像素`,
    );
  }
  if (
    presentation.direction !== "vertical" &&
    presentation.direction !== "horizontal"
  ) {
    issue("invalid_choice_direction", "方向必须是 vertical 或 horizontal");
  }
  if (!Number.isFinite(presentation.gap) || presentation.gap < 0) {
    issue("invalid_choice_gap", "选项间距必须是非负数");
  }
  for (const [side, value] of [
    ["width", presentation.button_width],
    ["height", presentation.button_height],
  ] as const) {
    if (value != null && (!Number.isFinite(value) || value <= 0)) {
      issue("invalid_choice_size", `button_${side} 必须是正数`);
    }
  }
}

function validateNode(
  project: EditorProject,
  sceneId: string,
  nodeId: string,
  node: SceneNode,
  output: EditorDiagnostic[],
): void {
  const scene = project.scenes.find(
    (candidate) => candidate.definition.id === sceneId,
  );
  const issue = (code: string, message: string) =>
    output.push(error(code, message, sceneId, nodeId));
  const checkDuration = (duration: number) => {
    if (!Number.isInteger(duration) || duration < 0 || duration > 60_000) {
      issue("invalid_duration", "时长必须在 0–60000 ms 之间");
    }
  };
  const checkTimestamp = (timestamp: number, label: string) => {
    if (!Number.isInteger(timestamp) || timestamp < 0) {
      issue("invalid_timestamp", `${label} 必须是非负整数毫秒数`);
    }
  };
  const checkVolume = (volume: number) => {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      issue("invalid_volume", "音量必须在 0–1 之间");
    }
  };
  const checkAsset = (
    id: string | null | undefined,
    kind: AssetKind,
    required: boolean,
  ) => {
    if (id == null || id === "") {
      if (required) issue("missing_asset", `必须选择 ${kind} 素材`);
      return;
    }
    const asset = project.manifest.assets[id];
    if (asset === undefined) {
      issue("unknown_asset", `素材未登记：${id}`);
    } else if (asset.kind !== kind) {
      issue("wrong_asset_kind", `素材 ${id} 的类型应为 ${kind}`);
    }
  };

  switch (node.type) {
    case "background":
      checkAsset(node.background, "background", false);
      checkDuration(node.duration_ms);
      validateBackgroundTransition(node.transition, issue);
      break;
    case "curtain":
      if (node.action === "cover") {
        if (node.fill == null) {
          issue("missing_curtain_fill", "cover 幕布必须填写颜色或 gui 素材");
        } else if ("asset" in node.fill) {
          checkAsset(node.fill.asset, "gui", true);
        } else {
          validateColorValue(node.fill.color, "幕布颜色", issue);
        }
      } else if (node.fill != null) {
        issue("invalid_curtain_fill", "reveal 幕布不能指定 fill");
      }
      checkDuration(node.duration_ms);
      break;
    case "sprite":
      if (!ID_PATTERN.test(node.sprite_id))
        issue("invalid_sprite_id", "立绘实例 ID 非法");
      checkAsset(
        node.asset,
        "sprite",
        node.action === "show" && node.character == null,
      );
      if (node.character != null) {
        const character = project.manifest.characters[node.character];
        if (character === undefined) {
          issue("unknown_character", `角色未登记：${node.character}`);
        } else if (
          node.expression != null &&
          (character.expressions ?? {})[node.expression] === undefined
        ) {
          issue(
            "unknown_character_expression",
            `角色 ${node.character} 未定义表情：${node.expression}`,
          );
        } else if (
          node.expression == null &&
          node.asset == null &&
          character.default_expression == null &&
          node.action !== "hide"
        ) {
          issue("missing_character_expression", "角色没有可用表情或素材");
        }
      } else if (node.expression != null) {
        issue("expression_without_character", "表情必须与角色一起使用");
      }
      if (
        node.crossfade_ms != null &&
        (!Number.isInteger(node.crossfade_ms) ||
          node.crossfade_ms < 0 ||
          node.crossfade_ms > 60_000)
      ) {
        issue("invalid_crossfade", "交叉淡化时长必须在 0–60000 ms 之间");
      }
      checkDuration(node.duration_ms);
      if (
        (node.x !== null && !Number.isFinite(node.x)) ||
        (node.y !== null && !Number.isFinite(node.y))
      ) {
        issue("invalid_sprite_position", "立绘坐标必须是有限数");
      }
      if (
        node.scale !== null &&
        (!Number.isFinite(node.scale) || node.scale <= 0)
      ) {
        issue("invalid_scale", "缩放必须是正数");
      }
      if (
        node.opacity !== null &&
        (!Number.isFinite(node.opacity) || node.opacity < 0 || node.opacity > 1)
      ) {
        issue("invalid_opacity", "透明度必须在 0–1 之间");
      }
      break;
    case "clear":
      checkDuration(node.duration_ms);
      break;
    case "say":
      if (node.text.trim() === "") issue("empty_dialogue", "对话文本不能为空");
      if (node.page_id != null && !ID_PATTERN.test(node.page_id)) {
        issue("invalid_dialogue_page", "对话页 ID 非法");
      }
      if (node.mode === "append" && !node.page_id) {
        issue("missing_dialogue_page", "接续对话必须指定对话页 ID");
      }
      if (
        node.speaker !== null &&
        project.manifest.characters[node.speaker] === undefined
      ) {
        validateDisplayName(node.speaker).forEach((message) =>
          issue("invalid_temporary_speaker", message),
        );
      }
      validateTextTemplate(project, node.text, issue);
      if (
        node.speed_cps !== null &&
        (!Number.isFinite(node.speed_cps) || node.speed_cps <= 0)
      ) {
        issue("invalid_speed", "文字速度必须是正数");
      }
      break;
    case "long_text": {
      if (node.document !== undefined && node.document !== null) {
        if (!ID_PATTERN.test(node.document))
          issue("invalid_long_text_document", "文稿 ID 非法");
      }
      if (
        node.mode !== undefined &&
        node.mode !== "start" &&
        node.mode !== "continue"
      ) {
        issue("invalid_long_text_mode", "长文本模式无效");
      }
      if (node.mode === "continue" && !node.document) {
        issue("missing_long_text_document", "接续长文本必须指定文稿 ID");
      }
      if (
        node.mode === "continue" &&
        (node.paper != null ||
          node.pagination !== undefined ||
          node.font_size !== undefined ||
          node.text_color !== undefined ||
          node.layout !== undefined)
      ) {
        issue(
          "long_text_inherited_style",
          "接续长文本不能重复定义纸张、分页、字号、颜色或布局",
        );
      }
      if (
        node.on_exit !== undefined &&
        node.on_exit !== "close" &&
        node.on_exit !== "hide" &&
        node.on_exit !== "keep_visible"
      ) {
        issue("invalid_long_text_exit", "长文本离开行为无效");
      }
      checkAsset(node.paper ?? null, "gui", false);
      if (
        node.pagination !== undefined &&
        node.pagination !== "continuous" &&
        node.pagination !== "auto" &&
        node.pagination !== "manual"
      ) {
        issue("invalid_long_text_pagination", "长文本分页方式无效");
      }
      if (
        node.font_size !== undefined &&
        (!Number.isFinite(node.font_size) ||
          node.font_size < 16 ||
          node.font_size > 72)
      ) {
        issue("invalid_long_text_font_size", "长文本字号必须在 16 到 72 之间");
      }
      if (
        node.text_color !== undefined &&
        !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(node.text_color)
      ) {
        issue(
          "invalid_long_text_color",
          "长文本颜色必须是 #RRGGBB 或 #RRGGBBAA",
        );
      }
      if (node.layout !== undefined) {
        const layout = node.layout;
        const values = Object.values(layout);
        if (
          values.some((value) => !Number.isFinite(value)) ||
          layout.x < 0 ||
          layout.y < 0 ||
          layout.width < 160 ||
          layout.height < 240 ||
          layout.x + layout.width > 1920 ||
          layout.y + layout.height > 1080 ||
          layout.padding_x < 0 ||
          layout.padding_y < 0 ||
          layout.width <= layout.padding_x * 2 + 80 ||
          layout.height <= layout.padding_y * 2 + 80 ||
          layout.page_height <= layout.padding_y * 2 + 80 ||
          layout.page_gap < 0
        ) {
          issue("invalid_long_text_layout", "长文本位置、边距或页尺寸无效");
        }
      }
      if (node.steps.length === 0 || node.steps.length > 1024) {
        issue("invalid_long_text_steps", "长文本必须包含 1 到 1024 个步骤");
      }
      const ids = new Set<string>();
      for (const [index, step] of node.steps.entries()) {
        if (!ID_PATTERN.test(step.id)) {
          issue("invalid_long_text_step", `第 ${index + 1} 段的 ID 非法`);
        }
        if (ids.has(step.id)) {
          issue("duplicate_long_text_step", `步骤 ID 重复：${step.id}`);
        }
        if (step.text.trim() === "") {
          issue("empty_long_text_step", `第 ${index + 1} 段不能为空`);
        }
        if (
          (node.mode ?? "start") === "start" &&
          index === 0 &&
          step.page_break_before
        ) {
          issue("leading_long_text_break", "第一段不应在前方强制分页");
        }
        if (node.pagination === "continuous" && step.page_break_before) {
          issue("continuous_long_text_break", "连续长卷不能使用强制分页");
        }
        validateTextTemplate(project, step.text, issue);
        ids.add(step.id);
      }
      if (
        node.speed_cps !== null &&
        (!Number.isFinite(node.speed_cps) || node.speed_cps <= 0)
      ) {
        issue("invalid_long_text_speed", "文字速度必须是正数");
      }
      break;
    }
    case "long_text_control":
      if (!ID_PATTERN.test(node.document))
        issue("invalid_long_text_document", "文稿 ID 非法");
      if (
        node.action !== "show" &&
        node.action !== "hide" &&
        node.action !== "close"
      )
        issue("invalid_long_text_action", "文稿控制操作无效");
      break;
    case "choice": {
      if (node.choices.length === 0) issue("empty_choice", "至少需要一个选项");
      const ids = new Set<string>();
      for (const choice of node.choices) {
        if (!ID_PATTERN.test(choice.id))
          issue("invalid_choice_id", `非法选项 ID：${choice.id}`);
        if (ids.has(choice.id))
          issue("duplicate_choice_id", `选项 ID 重复：${choice.id}`);
        if (choice.label.trim() === "")
          issue("empty_choice_label", "选项文本不能为空");
        validateTextTemplate(project, choice.label, issue);
        if (choice.visible_if !== undefined)
          validateCondition(project, choice.visible_if, issue);
        if (choice.enabled_if !== undefined)
          validateCondition(project, choice.enabled_if, issue);
        if (choice.template != null && choice.template !== "") {
          checkChoiceTemplate(
            project,
            choice.template,
            `选项 ${choice.id}`,
            issue,
          );
        }
        if (choice.icon != null && choice.icon !== "") {
          checkChoiceIcon(project, choice.icon, `选项 ${choice.id}`, issue);
        }
        ids.add(choice.id);
      }
      validateChoicePresentation(project, node, issue);
      break;
    }
    case "set":
      if (!ID_PATTERN.test(node.variable))
        issue("invalid_variable", "变量名非法");
      if (isWindowVariable(node.variable)) {
        issue(
          "readonly_window_variable",
          `${node.variable} 是只读的窗口标题变量，不能用「设置变量」修改；请使用「设置窗口标题」节点`,
        );
      } else if (project.manifest.variables[node.variable] === undefined) {
        issue("unknown_variable", `变量未声明：${node.variable}`);
      } else validateMutation(project, node, issue);
      break;
    case "condition":
      validateCondition(project, node.condition, issue);
      break;
    case "playback":
      break;
    case "action": {
      if (!ID_PATTERN.test(node.sprite_id))
        issue("invalid_action_sprite", "动作目标立绘实例 ID 非法");
      if (
        !scene ||
        !Object.values(scene.definition.nodes).some(
          (candidate) =>
            candidate.type === "sprite" &&
            candidate.sprite_id === node.sprite_id,
        )
      ) {
        issue(
          "unknown_action_sprite",
          `动作引用了未声明的立绘实例：${node.sprite_id}`,
        );
      }
      const actionDefinition = project.actions?.find(
        (file) => file.definition.id === node.action,
      )?.definition;
      if (actionDefinition === undefined)
        issue("unknown_action", `未知立绘动作：${node.action}`);
      if (node.duration_ms != null) checkDuration(node.duration_ms);
      if (node.parameters != null) {
        for (const [parameter, value] of Object.entries(node.parameters)) {
          const definition = actionDefinition?.parameters?.[parameter];
          if (definition === undefined) {
            issue("unknown_action_parameter", `动作参数未声明：${parameter}`);
          } else if (
            !Number.isFinite(value) ||
            (definition.min != null && value < definition.min) ||
            (definition.max != null && value > definition.max)
          ) {
            issue(
              "invalid_action_parameter",
              `动作参数 ${parameter} 超出声明范围`,
            );
          }
        }
      }
      break;
    }
    case "wait":
      checkDuration(node.duration_ms);
      break;
    case "bgm":
      checkAsset(node.asset, "bgm", node.action === "start");
      checkVolume(node.volume);
      checkDuration(node.duration_ms);
      checkTimestamp(node.start_ms ?? 0, "BGM 起始点");
      if ((node.loop_start_ms == null) !== (node.loop_end_ms == null)) {
        issue("invalid_bgm_loop", "BGM 循环起止点必须同时提供");
      } else if (node.loop_start_ms != null && node.loop_end_ms != null) {
        checkTimestamp(node.loop_start_ms, "BGM 循环起点");
        checkTimestamp(node.loop_end_ms, "BGM 循环终点");
        if (
          node.loop_start_ms >= node.loop_end_ms ||
          (node.start_ms ?? 0) > node.loop_end_ms
        ) {
          issue("invalid_bgm_loop", "BGM 循环点顺序无效");
        }
      }
      break;
    case "ambience":
      if (!AMBIENCE_SLOTS.includes(node.slot))
        issue("invalid_ambience_slot", "环境声槽位必须是 slot_1 到 slot_4");
      checkAsset(node.asset, "ambience", node.action === "start");
      if (node.action === "stop" && node.asset != null) {
        issue("invalid_ambience_stop_asset", "ambience stop 不能提供 asset");
      }
      checkVolume(node.volume);
      checkDuration(node.duration_ms);
      checkTimestamp(node.start_ms ?? 0, "ambience 起始点");
      if ((node.loop_start_ms == null) !== (node.loop_end_ms == null)) {
        issue("invalid_ambience_loop", "ambience 循环起止点必须同时提供");
      } else if (node.loop_start_ms != null && node.loop_end_ms != null) {
        checkTimestamp(node.loop_start_ms, "ambience 循环起点");
        checkTimestamp(node.loop_end_ms, "ambience 循环终点");
        if (
          node.loop_start_ms >= node.loop_end_ms ||
          (node.start_ms ?? 0) > node.loop_end_ms
        ) {
          issue("invalid_ambience_loop", "ambience 循环点顺序无效");
        }
      }
      break;
    case "sfx":
      checkAsset(node.asset, "sfx", true);
      checkVolume(node.volume);
      break;
    case "camera":
      checkDuration(node.duration_ms);
      if (
        ![node.x, node.y, node.zoom].every(Number.isFinite) ||
        node.zoom <= 0
      ) {
        issue("invalid_camera", "镜头坐标必须有限，缩放必须为正数");
      }
      break;
    case "screen_effect":
      checkDuration(node.duration_ms);
      validateScreenEffect(node.effect, issue);
      break;
    case "dialogue_ui":
      if (node.duration_ms !== null) checkDuration(node.duration_ms);
      if (
        node.motion !== null &&
        !project.ui_motions.some((file) => file.definition.id === node.motion)
      )
        issue("unknown_ui_motion", `未知 UI 动效：${node.motion}`);
      break;
    case "ui_motion_set":
      if (
        node.motion !== null &&
        !project.ui_motions.some((file) => file.definition.id === node.motion)
      )
        issue("unknown_ui_motion", `未知 UI 动效：${node.motion}`);
      break;
    case "ui_motion_play":
      if (
        !project.ui_motions.some((file) => file.definition.id === node.motion)
      )
        issue("unknown_ui_motion", `未知 UI 动效：${node.motion}`);
      if (node.duration_ms !== null) checkDuration(node.duration_ms);
      break;
    case "button_create":
      if (!ID_PATTERN.test(node.instance_id))
        issue("invalid_button_instance", "按钮实例 ID 非法");
      if (
        !project.buttons?.some((file) => file.definition.id === node.template)
      )
        issue("unknown_button_template", `未知按钮模板：${node.template}`);
      validateButtonLayout(node, issue);
      validateButtonAction(project, node.action, sceneId, issue);
      break;
    case "button_update":
      if (!ID_PATTERN.test(node.instance_id))
        issue("invalid_button_instance", "按钮实例 ID 非法");
      if (
        node.template != null &&
        !project.buttons?.some((file) => file.definition.id === node.template)
      )
        issue("unknown_button_template", `未知按钮模板：${node.template}`);
      validateButtonLayout(node, issue);
      if (node.action != null)
        validateButtonAction(project, node.action, sceneId, issue);
      break;
    case "button_remove":
      if (!ID_PATTERN.test(node.instance_id))
        issue("invalid_button_instance", "按钮实例 ID 非法");
      break;
    case "timeline": {
      if (
        !Number.isInteger(node.duration_ms) ||
        node.duration_ms < 1 ||
        node.duration_ms > 1_800_000
      ) {
        issue(
          "invalid_timeline_duration",
          "时间线时长必须在 1ms 到 30 分钟之间",
        );
      }
      if (!node.await && node.skippable) {
        issue("invalid_timeline_skip", "非阻塞时间线不能设为可跳过");
      }
      if (node.tracks.length > 64)
        issue("too_many_timeline_tracks", "时间线轨道超过 64 条");
      if (node.events.length > 2048)
        issue("too_many_timeline_events", "时间线事件超过 2048 个");
      let keyframes = 0;
      let videos = 0;
      const trackIds = new Set<string>();
      const sceneDefinition = project.scenes.find(
        (file) => file.definition.id === sceneId,
      )?.definition;
      for (const track of node.tracks) {
        const trackId =
          track.type === "sprite"
            ? `sprite:${track.sprite_id}`
            : track.type === "button"
              ? `button:${track.instance_id}`
              : track.type === "ambience"
                ? `ambience:${track.slot}`
                : track.type;
        if (trackIds.has(trackId))
          issue("duplicate_timeline_track", `重复时间线轨道：${trackId}`);
        trackIds.add(trackId);
        if (track.type === "ambience" && !AMBIENCE_SLOTS.includes(track.slot))
          issue(
            "invalid_ambience_slot",
            "环境声轨道槽位必须是 slot_1 到 slot_4",
          );
        if (track.type === "video") {
          videos += 1;
          checkAsset(track.asset, "video", true);
          if (!node.await)
            issue("video_requires_await", "视频时间线必须等待完成");
          checkTimestamp(track.clip_start_ms, "视频裁剪起点");
          if (track.clip_end_ms != null) {
            checkTimestamp(track.clip_end_ms, "视频裁剪终点");
            if (track.clip_end_ms <= track.clip_start_ms) {
              issue("invalid_video_clip", "视频裁剪终点必须晚于起点");
            }
          }
        } else if (track.type === "sprite")
          checkAsset(track.asset, "sprite", false);
        else if (
          track.type === "button" &&
          !(
            sceneDefinition !== undefined &&
            Object.values(sceneDefinition.nodes).some(
              (candidate) =>
                candidate.type === "button_create" &&
                candidate.instance_id === track.instance_id,
            )
          )
        ) {
          issue(
            "unknown_button_instance",
            `时间线引用了未创建的按钮实例：${track.instance_id}`,
          );
        }
        const allowed = timelineChannels(track);
        for (const [channel, frames] of Object.entries(track.channels)) {
          if (!allowed.includes(channel))
            issue(
              "invalid_timeline_channel",
              `${track.type} 不支持 ${channel} 通道`,
            );
          if (frames.length === 0) {
            issue("empty_timeline_channel", `${channel} 通道不能为空`);
          }
          keyframes += frames.length;
          let prior = -1;
          for (const [frameIndex, frame] of frames.entries()) {
            const inherited = frame.value === "inherit";
            if (
              (!inherited && !Number.isFinite(frame.value)) ||
              !Number.isInteger(frame.at_ms) ||
              frame.at_ms < 0 ||
              frame.at_ms <= prior ||
              frame.at_ms > node.duration_ms
            ) {
              issue(
                "invalid_timeline_keyframe",
                `${channel} 关键帧时间或数值无效`,
              );
            }
            if (
              inherited &&
              (track.type === "video" ||
                frameIndex !== 0 ||
                frame.at_ms !== 0 ||
                frames.length < 2)
            ) {
              issue(
                "invalid_timeline_inherit",
                `${channel} 的继承值只能作为非视频轨的 0ms 起始帧`,
              );
            }
            if (
              !inherited &&
              ["opacity", "volume"].includes(channel) &&
              ((frame.value as number) < 0 || (frame.value as number) > 1)
            ) {
              issue(
                "invalid_timeline_range",
                `${channel} 关键帧必须在 0 到 1 之间`,
              );
            }
            if (
              !inherited &&
              ((["scale", "zoom", "width", "height"].includes(channel) &&
                (frame.value as number) <= 0) ||
                (["scale_x", "scale_y"].includes(channel) &&
                  (frame.value as number) === 0))
            ) {
              issue("invalid_timeline_range", `${channel} 关键帧缩放无效`);
            }
            if (typeof frame.easing === "object") {
              const [x1, y1, x2, y2] = frame.easing.cubic_bezier;
              if (
                ![x1, y1, x2, y2].every(Number.isFinite) ||
                x1 < 0 ||
                x1 > 1 ||
                x2 < 0 ||
                x2 > 1
              ) {
                issue(
                  "invalid_cubic_bezier",
                  "贝塞尔曲线的 x 控制点必须在 0 到 1 之间",
                );
              }
            }
            prior = frame.at_ms;
          }
        }
      }
      if (videos > 1)
        issue("too_many_video_tracks", "单条时间线最多一个视频轨");
      if (keyframes > 10_000)
        issue("too_many_keyframes", "时间线关键帧超过 10000 个");
      const ids = new Set<string>();
      let priorEvent = -1;
      for (const event of node.events) {
        if (!ID_PATTERN.test(event.id) || ids.has(event.id))
          issue("invalid_timeline_event", `事件 ID 无效或重复：${event.id}`);
        if (
          !Number.isInteger(event.at_ms) ||
          event.at_ms < 0 ||
          event.at_ms < priorEvent ||
          event.at_ms > node.duration_ms
        )
          issue("invalid_timeline_event_time", `事件 ${event.id} 未排序或越界`);
        if (event.type === "sfx") {
          checkAsset(event.asset, "sfx", true);
          checkVolume(event.volume);
        } else {
          checkDuration(event.duration_ms);
          validateScreenEffect(event.effect, issue);
          if (event.at_ms + event.duration_ms > node.duration_ms) {
            issue(
              "invalid_timeline_event_time",
              `事件 ${event.id} 超出时间线时长`,
            );
          }
        }
        ids.add(event.id);
        priorEvent = event.at_ms;
      }
      break;
    }
    case "end":
      break;
    case "jump": {
      // A Scene belongs to one window: a jump never changes which window the
      // story is written for.
      const destination =
        node.scene === null
          ? undefined
          : project.scenes.find(
              (candidate) => candidate.definition.id === node.scene,
            );
      if (
        destination !== undefined &&
        scene !== undefined &&
        sceneRole(destination.definition) !== sceneRole(scene.definition)
      ) {
        issue(
          "window_role_mismatch",
          `不能从${WINDOW_ROLE_LABELS[sceneRole(scene.definition)]}专用 Scene 跳转到${WINDOW_ROLE_LABELS[sceneRole(destination.definition)]}专用 Scene ${node.scene}；跳转只能在相同用途的 Scene 之间进行`,
        );
      }
      break;
    }
    case "open_window": {
      // Non-blocking: the story continues to `next` in this Scene. The named
      // window Scene is resolved across scenes and must exist.
      const destination = project.scenes.find(
        (candidate) => candidate.definition.id === node.scene,
      );
      if (node.scene.length === 0) {
        issue("missing_window_scene", "副窗口必须指定目标场景");
      } else if (destination === undefined) {
        issue("unknown_window_scene", `副窗口指向未声明的场景 ${node.scene}`);
      } else if (sceneRole(destination.definition) !== "secondary") {
        issue(
          "window_scene_not_secondary",
          `场景 ${node.scene} 不是副窗口专用 Scene；请在场景列表中把它的用途设置为「副窗口」`,
        );
      }
      if (scene !== undefined && sceneRole(scene.definition) !== "main") {
        issue(
          "secondary_opens_window",
          "只有主窗口 Scene 可以打开副窗口；副窗口 Scene 不能再打开窗口",
        );
      }
      if (
        scene === undefined ||
        scene.definition.nodes[node.next] === undefined
      ) {
        issue("missing_next_node", "open_window 的 next 节点不存在");
      }
      break;
    }
    case "window_title": {
      const problem = windowTitleProblem(node.title);
      if (problem !== null) issue("invalid_window_title", problem);
      validateTextTemplate(project, node.title, issue);
      break;
    }
    case "window_control": {
      if (node.target !== "main" && node.target !== "secondary") {
        issue("invalid_window_target", "目标窗口必须是主窗口或副窗口");
      }
      if (node.action !== "advance" && !ID_PATTERN.test(node.id ?? "")) {
        issue(
          "invalid_block_id",
          "阻挡 ID 不能为空，且只能使用字母、数字、点、下划线和连字符",
        );
      }
      const message = node.message ?? "";
      const problem = windowTitleProblem(message);
      if (problem !== null)
        issue("invalid_block_message", problem.replace("窗口标题", "阻挡提示"));
      validateTextTemplate(project, message, issue);
      break;
    }
    case "timer": {
      if (!ID_PATTERN.test(node.id)) {
        issue(
          "invalid_timer_id",
          "计时器 ID 非法（字母、数字、点、下划线、连字符）",
        );
      }
      if (node.action !== "start" && node.action !== "stop") {
        issue("invalid_timer_action", "计时器操作必须是启动或停止");
      }
      if (node.action === "start") {
        const delay = node.delay_ms ?? 0;
        if (
          !Number.isInteger(delay) ||
          delay < 0 ||
          delay > MAX_TIMER_DURATION_MS
        ) {
          issue(
            "invalid_timer_delay",
            `计时器延迟必须在 0–${MAX_TIMER_DURATION_MS} ms 之间`,
          );
        }
        if (node.interval_ms != null) {
          if (
            !Number.isInteger(node.interval_ms) ||
            node.interval_ms < MIN_TIMER_INTERVAL_MS ||
            node.interval_ms > MAX_TIMER_DURATION_MS
          ) {
            issue(
              "invalid_timer_interval",
              `重复间隔必须在 ${MIN_TIMER_INTERVAL_MS}–${MAX_TIMER_DURATION_MS} ms 之间`,
            );
          }
        }
        if (node.target == null || node.target === "") {
          issue("missing_timer_target", "启动计时器必须选择一个效果节点");
        } else {
          const problem = timerTargetProblem(
            scene?.definition.nodes[node.target],
          );
          if (problem !== null) {
            issue(
              "invalid_timer_target",
              `计时器目标 ${node.target} 无效：${problem}`,
            );
          }
        }
      }
      break;
    }
  }
}

const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/;

/** `#RRGGBB`/`#RRGGBBAA`, matching the Rust loader's accepted colors. */
function validateColorValue(
  color: string,
  label: string,
  issue: (code: string, message: string) => void,
): void {
  if (!COLOR_PATTERN.test(color)) {
    issue("invalid_color", `${label}必须是 #RRGGBB 或 #RRGGBBAA`);
  }
}

/** Mirrors `validate_background_transition` in the Rust content model. */
function validateBackgroundTransition(
  transition: BackgroundTransitionSpec,
  issue: (code: string, message: string) => void,
): void {
  switch (transition.type) {
    case "cut":
    case "cross_fade":
      return;
    case "fade_through_color":
      validateColorValue(transition.color, "转场颜色", issue);
      return;
    case "wipe":
    case "push":
      if (
        !Number.isFinite(transition.softness) ||
        transition.softness < 0 ||
        transition.softness > 1
      ) {
        issue("invalid_transition_softness", "转场柔边必须在 0–1 之间");
      }
      return;
  }
}

/** Mirrors `validate_screen_effect` in the Rust content model. */
function validateScreenEffect(
  effect: ScreenEffectSpec,
  issue: (code: string, message: string) => void,
): void {
  if (effect.type === "flash") {
    validateColorValue(effect.color, "闪光颜色", issue);
    if (
      !Number.isFinite(effect.peak_alpha) ||
      effect.peak_alpha < 0 ||
      effect.peak_alpha > 1
    ) {
      issue("invalid_flash_peak", "闪光峰值透明度必须在 0–1 之间");
    }
    return;
  }
  if (effect.type !== "shake") {
    validateShaderEffect(effect, issue);
    return;
  }
  for (const [label, value] of [
    ["横向振幅", effect.amplitude_x],
    ["纵向振幅", effect.amplitude_y],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 256) {
      issue("invalid_shake_amplitude", `${label}必须在 0–256 之间`);
    }
  }
  if (
    !Number.isFinite(effect.frequency_hz) ||
    effect.frequency_hz < 0.1 ||
    effect.frequency_hz > 60
  ) {
    issue("invalid_shake_frequency", "震动频率必须在 0.1–60 Hz 之间");
  }
  if (!Number.isFinite(effect.decay) || effect.decay < 0 || effect.decay > 1) {
    issue("invalid_shake_decay", "震动衰减必须在 0–1 之间");
  }
  if (
    !Number.isInteger(effect.seed) ||
    effect.seed < 0 ||
    effect.seed > 0xffff_ffff
  ) {
    issue("invalid_shake_seed", "震动 seed 必须是 0–4294967295 的整数");
  }
}

/** Shader effect ranges, mirroring `validate_screen_effect` in Rust. */
function validateShaderEffect(
  effect: Extract<
    ScreenEffectSpec,
    {
      type:
        | "chromatic_aberration"
        | "glitch"
        | "shockwave"
        | "color_grade"
        | "focus"
        | "ripple";
    }
  >,
  issue: (code: string, message: string) => void,
): void {
  const range = (
    code: string,
    label: string,
    value: number,
    min: number,
    max: number,
  ): void => {
    if (!Number.isFinite(value) || value < min || value > max) {
      issue(code, `${label}必须在 ${min}–${max} 之间`);
    }
  };
  const center = (
    prefix: string,
    value: { center_x: number; center_y: number },
  ): void => {
    range(`invalid_${prefix}_center`, "中心 X", value.center_x, 0, 1920);
    range(`invalid_${prefix}_center`, "中心 Y", value.center_y, 0, 1080);
  };
  const fades = (
    prefix: string,
    value: { fade_in: number; fade_out: number },
  ): void => {
    range(`invalid_${prefix}_fade`, "渐入比例", value.fade_in, 0, 1);
    range(`invalid_${prefix}_fade`, "渐出比例", value.fade_out, 0, 1);
    if (value.fade_in + value.fade_out > 1) {
      issue(`invalid_${prefix}_fade`, "渐入与渐出比例之和不能超过 1");
    }
  };
  const intensity = (prefix: string, value: number): void => {
    range(`invalid_${prefix}_intensity`, "效果强度", value, 0, 1);
  };
  switch (effect.type) {
    case "chromatic_aberration":
      range(
        "invalid_chromatic_intensity",
        "色差强度",
        effect.intensity,
        0,
        128,
      );
      range(
        "invalid_chromatic_angle",
        "色差方向角度",
        effect.angle_deg,
        -360,
        360,
      );
      center("chromatic", effect);
      range(
        "invalid_chromatic_edge_weight",
        "色差边缘权重",
        effect.edge_weight,
        0,
        1,
      );
      fades("chromatic", effect);
      return;
    case "glitch":
      range(
        "invalid_glitch_displacement",
        "故障位移",
        effect.displacement,
        0,
        512,
      );
      if (
        !Number.isInteger(effect.slice_count) ||
        effect.slice_count < 1 ||
        effect.slice_count > 32
      ) {
        issue("invalid_glitch_slice_count", "故障切片数必须是 1–32 的整数");
      }
      range("invalid_glitch_density", "故障切片密度", effect.density, 0, 1);
      range(
        "invalid_glitch_frequency",
        "故障变化频率",
        effect.frequency_hz,
        0.1,
        60,
      );
      if (
        !Number.isInteger(effect.seed) ||
        effect.seed < 0 ||
        effect.seed > 0xffff_ffff
      ) {
        issue("invalid_glitch_seed", "故障 seed 必须是 0–4294967295 的整数");
      }
      fades("glitch", effect);
      return;
    case "shockwave":
      center("shockwave", effect);
      range(
        "invalid_shockwave_radius",
        "冲击波最大半径",
        effect.max_radius,
        1,
        4096,
      );
      range(
        "invalid_shockwave_width",
        "冲击波波宽",
        effect.wave_width,
        1,
        1024,
      );
      range(
        "invalid_shockwave_strength",
        "冲击波扭曲强度",
        effect.strength,
        0,
        256,
      );
      return;
    case "color_grade":
      range(
        "invalid_color_grade_brightness",
        "亮度偏移",
        effect.brightness,
        -1,
        1,
      );
      range("invalid_color_grade_contrast", "对比度", effect.contrast, 0, 2);
      range(
        "invalid_color_grade_saturation",
        "饱和度",
        effect.saturation,
        0,
        2,
      );
      validateColorValue(effect.tint, "着色颜色", issue);
      range(
        "invalid_color_grade_tint_strength",
        "着色强度",
        effect.tint_strength,
        0,
        1,
      );
      intensity("color_grade", effect.intensity);
      fades("color_grade", effect);
      return;
    case "focus":
      center("focus", effect);
      range("invalid_focus_radius", "清晰半径", effect.radius, 0, 2203);
      range("invalid_focus_softness", "边缘过渡", effect.softness, 1, 2203);
      range("invalid_focus_blur", "最大模糊", effect.blur, 0, 24);
      range("invalid_focus_darkness", "边缘压暗", effect.darkness, 0, 1);
      intensity("focus", effect.intensity);
      fades("focus", effect);
      return;
    case "ripple":
      center("ripple", effect);
      range("invalid_ripple_amplitude", "波纹振幅", effect.amplitude, 0, 64);
      range(
        "invalid_ripple_wavelength",
        "波纹波长",
        effect.wavelength,
        8,
        2203,
      );
      range("invalid_ripple_speed", "波纹速度", effect.speed, 0, 2000);
      range("invalid_ripple_damping", "波纹衰减", effect.damping, 0, 8);
      intensity("ripple", effect.intensity);
      fades("ripple", effect);
      return;
  }
}

function validateButtonLayout(
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

function validateButtonAction(
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

function timelineChannels(track: TimelineTrack): string[] {
  switch (track.type) {
    case "sprite":
      return [
        "x",
        "y",
        "scale",
        "scale_x",
        "scale_y",
        "rotation_deg",
        "opacity",
        "z",
      ];
    case "camera":
      return ["x", "y", "zoom", "rotation_deg"];
    case "button":
      return [
        "x",
        "y",
        "width",
        "height",
        "scale_x",
        "scale_y",
        "rotation_deg",
        "opacity",
        "z",
      ];
    case "video":
      return ["x", "y", "width", "height", "opacity", "z", "volume"];
    case "bgm":
    case "ambience":
      return ["volume"];
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

function validateMutation(
  project: EditorProject,
  node: Extract<SceneNode, { type: "set" }>,
  issue: (code: string, message: string) => void,
): void {
  const target = project.manifest.variables[node.variable];
  if (target === undefined) return;
  const op = node.op ?? "assign";
  if (op === "toggle") {
    if (target.type !== "boolean") {
      issue("invalid_toggle", "toggle 只能用于 boolean 变量");
    }
    if (node.value !== undefined) {
      issue("invalid_toggle_value", "toggle 不接受 value");
    }
    return;
  }
  if (node.value === undefined) {
    issue("missing_mutation_value", `${op} 必须提供 value`);
    return;
  }
  const sourceType = mutationValueType(project, node.value, issue);
  if (sourceType === null) return;
  const compatible = (() => {
    switch (op) {
      case "assign":
        return (
          target.type === sourceType ||
          (target.type === "number" && sourceType === "integer")
        );
      case "add":
      case "sub":
      case "mul":
        return (
          isNumericType(target.type) &&
          isNumericType(sourceType) &&
          (target.type !== "integer" || sourceType === "integer")
        );
      case "mod":
        return target.type === "integer" && sourceType === "integer";
      case "append":
        return target.type === "string" && sourceType === "string";
    }
  })();
  if (!compatible) {
    issue("variable_operation_type", `${op} 的目标变量与操作数类型不兼容`);
  }
  if (op === "mod" && typeof node.value === "number" && node.value === 0) {
    issue("modulo_by_zero", "mod 的除数不能为零");
  }
}

function mutationValueType(
  project: EditorProject,
  value: NonNullable<Extract<SceneNode, { type: "set" }>["value"]>,
  issue: (code: string, message: string) => void,
): VariableType | null {
  if (typeof value === "object" && value !== null) {
    const definition = readableVariables(project.manifest)[value.variable];
    if (definition === undefined) {
      issue("unknown_variable", `操作数引用了未声明变量：${value.variable}`);
      return null;
    }
    return definition.type;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    issue("non_finite_literal", "运算数值必须是有限数");
  }
  if (
    typeof value === "string" &&
    new TextEncoder().encode(value).length > 16 * 1024
  ) {
    issue("string_too_long", "字符串不能超过 16 KiB UTF-8");
  }
  return scalarType(value);
}

function validateTextTemplate(
  project: EditorProject,
  source: string,
  issue: (code: string, message: string) => void,
): void {
  const types = Object.fromEntries(
    Object.entries(readableVariables(project.manifest)).map(
      ([id, definition]) => [id, definition.type],
    ),
  );
  for (const message of validateTemplate(source, types)) {
    issue("invalid_interpolation", message);
  }
}

function validateDisplayName(value: string): string[] {
  const issues: string[] = [];
  if (value.trim() === "") issues.push("显示名不能为空");
  if (Array.from(value).length > 64) issues.push("显示名不能超过 64 个字符");
  if (/\p{Cc}/u.test(value)) issues.push("显示名不能包含控制字符");
  return issues;
}

function validateCondition(
  project: EditorProject,
  condition: ConditionExpression,
  issue: (code: string, message: string) => void,
  allowWindowVariables = true,
): void {
  let nodes = 0;
  const visit = (candidate: ConditionExpression, depth: number): void => {
    nodes += 1;
    if (depth > 32) {
      issue("condition_too_deep", "条件表达式嵌套不能超过 32 层");
      return;
    }
    if (nodes > 256) {
      issue("condition_too_large", "条件表达式不能超过 256 个节点");
      return;
    }
    switch (candidate.op) {
      case "eq":
      case "ne": {
        const left = operandType(
          project,
          candidate.left,
          issue,
          allowWindowVariables,
        );
        const right = operandType(
          project,
          candidate.right,
          issue,
          allowWindowVariables,
        );
        if (
          left !== null &&
          right !== null &&
          left !== right &&
          !(isNumericType(left) && isNumericType(right))
        ) {
          issue("condition_type_mismatch", "Eq/Ne 两侧类型不兼容");
        }
        break;
      }
      case "lt":
      case "le":
      case "gt":
      case "ge": {
        const left = operandType(
          project,
          candidate.left,
          issue,
          allowWindowVariables,
        );
        const right = operandType(
          project,
          candidate.right,
          issue,
          allowWindowVariables,
        );
        if (
          (left !== null && !isNumericType(left)) ||
          (right !== null && !isNumericType(right))
        ) {
          issue("condition_ordering_type", "Lt/Le/Gt/Ge 只允许比较整数或数值");
        }
        break;
      }
      case "and":
      case "or":
        if (candidate.conditions.length === 0) {
          issue("empty_condition_group", "And/Or 至少需要一个子条件");
        }
        candidate.conditions.forEach((child) => visit(child, depth + 1));
        break;
      case "not":
        visit(candidate.condition, depth + 1);
        break;
    }
  };
  visit(condition, 1);
}

function operandType(
  project: EditorProject,
  operand: ValueOperand,
  issue: (code: string, message: string) => void,
  allowWindowVariables = true,
): VariableType | null {
  if ("variable" in operand) {
    const definition = allowWindowVariables
      ? readableVariables(project.manifest)[operand.variable]
      : project.manifest.variables[operand.variable];
    if (definition === undefined) {
      issue("unknown_variable", `条件引用了未声明变量：${operand.variable}`);
      return null;
    }
    return definition.type;
  }
  if (typeof operand.value === "number" && !Number.isFinite(operand.value)) {
    issue("non_finite_literal", "条件数值必须是有限数");
  }
  return scalarType(operand.value);
}

function valueMatchesType(value: ScalarValue, type: VariableType): boolean {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return (
        isIntegerScalar(value) &&
        (typeof value === "bigint" || Number.isSafeInteger(value))
      );
    case "number":
      return (
        typeof value === "bigint" ||
        (typeof value === "number" && Number.isFinite(value))
      );
    case "string":
      return (
        typeof value === "string" &&
        new TextEncoder().encode(value).length <= 16 * 1024
      );
  }
}

function isNumericType(type: VariableType): boolean {
  return type === "integer" || type === "number";
}

function reachabilityWarnings(
  project: EditorProject,
  sceneById: Map<string, EditorProject["scenes"][number]["definition"]>,
): EditorDiagnostic[] {
  const entry = sceneById.get(project.manifest.entry_scene);
  if (entry === undefined || entry.nodes[entry.entry] === undefined) return [];
  const reached = new Set<string>();
  // Nodes that only run as a timer's effect: reachable, but not a flow source.
  const effectReached = new Set<string>();
  const queue: [string, string][] = [[entry.id, entry.entry]];
  // The room map is a second way into the story.  A hotspot that is always
  // revealed *and* always replayable is enterable without ever reaching the
  // chapter through a jump, so its scene entry counts as reachable.  A locked
  // hotspot (`replay: completed`) or a hidden one cannot bootstrap itself, and
  // a profile condition cannot be decided statically, so those keep warning.
  for (const hotspot of project.chapter_map?.definition.hotspots ?? []) {
    const scene = sceneById.get(hotspot.scene_id);
    if (scene === undefined || scene.nodes[scene.entry] === undefined) continue;
    const revealed = (hotspot.reveal?.mode ?? "completed") === "always";
    const replayable = (hotspot.replay?.mode ?? "completed") === "always";
    if (revealed && replayable) queue.push([hotspot.scene_id, scene.entry]);
  }
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    const [sceneId, nodeId] = next;
    const key = `${sceneId}\u0000${nodeId}`;
    if (reached.has(key)) continue;
    reached.add(key);
    const scene = sceneById.get(sceneId);
    const node = scene?.nodes[nodeId];
    if (node === undefined) continue;
    for (const port of outputPorts(node)) {
      queue.push([port.targetScene ?? sceneId, port.target]);
    }
    // A timer's effect target runs without following the target's own `next`,
    // so the target itself is reachable but its successors are not implied.
    if (node.type === "timer" && node.action === "start" && node.target) {
      if (scene?.nodes[node.target] !== undefined)
        effectReached.add(`${sceneId}\u0000${node.target}`);
    }
    // The secondary runtime enters its own scene while the main flow follows next.
    if (node.type === "open_window") {
      const windowScene = sceneById.get(node.scene);
      if (windowScene !== undefined)
        queue.push([windowScene.id, windowScene.entry]);
    }
  }
  const warnings: EditorDiagnostic[] = [];
  for (const file of project.scenes) {
    for (const nodeId of Object.keys(file.definition.nodes)) {
      const key = `${file.definition.id}\u0000${nodeId}`;
      if (!reached.has(key) && !effectReached.has(key)) {
        warnings.push({
          severity: "warning",
          code: "unreachable_node",
          message: "节点无法从项目入口到达",
          scene_id: file.definition.id,
          node_id: nodeId,
        });
      }
    }
  }
  return warnings;
}

function error(
  code: string,
  message: string,
  sceneId: string | null = null,
  nodeId: string | null = null,
): EditorDiagnostic {
  return {
    severity: "error",
    code,
    message,
    scene_id: sceneId,
    node_id: nodeId,
  };
}

function mapError(
  code: string,
  message: string,
  elementId: string | null,
): EditorDiagnostic {
  return {
    severity: "error",
    code,
    message,
    scene_id: null,
    node_id: null,
    workspace: "map",
    flow_element_id: elementId,
  };
}

function deduplicate(diagnostics: EditorDiagnostic[]): EditorDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.scene_id,
      diagnostic.node_id,
      diagnostic.workspace,
      diagnostic.flow_element_id,
      diagnostic.message,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
