import { validateSpriteAuthoring } from "../visualValidation";
import type { TimelineTrack, TimelineNode } from "../types";
import type { NodeCheck } from "./nodes";
import { AMBIENCE_SLOTS, ID_PATTERN } from "./shared";
import { validateScreenEffect } from "./effects";

export function validateTimelineNode(
  node: TimelineNode,
  {
    project,
    sceneId,
    issue,
    checkAsset,
    checkDuration,
    checkTimestamp,
    checkVolume,
  }: NodeCheck,
): void {
  if (
    !Number.isInteger(node.duration_ms) ||
    node.duration_ms < 1 ||
    node.duration_ms > 1_800_000
  ) {
    issue("invalid_timeline_duration", "时间线时长必须在 1ms 到 30 分钟之间");
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
        : track.type === "emitter"
          ? `emitter:${track.emitter_id}`
          : track.type === "button"
            ? `button:${track.instance_id}`
            : track.type === "ambience"
              ? `ambience:${track.slot}`
              : track.type;
    if (trackIds.has(trackId))
      issue("duplicate_timeline_track", `重复时间线轨道：${trackId}`);
    trackIds.add(trackId);
    if (track.type === "ambience" && !AMBIENCE_SLOTS.includes(track.slot))
      issue("invalid_ambience_slot", "环境声轨道槽位必须是 slot_1 到 slot_4");
    if (track.type === "video") {
      videos += 1;
      checkAsset(track.asset, "video", true);
      if (!node.await) issue("video_requires_await", "视频时间线必须等待完成");
      checkTimestamp(track.clip_start_ms, "视频裁剪起点");
      if (track.clip_end_ms != null) {
        checkTimestamp(track.clip_end_ms, "视频裁剪终点");
        if (track.clip_end_ms <= track.clip_start_ms) {
          issue("invalid_video_clip", "视频裁剪终点必须晚于起点");
        }
      }
    } else if (track.type === "sprite") {
      validateSpriteAuthoring(project, track, issue);
      checkAsset(track.asset, "sprite", false);
    } else if (track.type === "emitter") {
      if (!ID_PATTERN.test(track.emitter_id))
        issue("invalid_emitter_id", "发射器实例 ID 非法");
      if (!(
        sceneDefinition !== undefined &&
        Object.values(sceneDefinition.nodes).some(
          (candidate) =>
            candidate.type === "particle" &&
            candidate.action === "start" &&
            candidate.emitter_id === track.emitter_id,
        )
      ))
        issue(
          "unknown_emitter_instance",
          `时间线引用了未启动的发射器实例：${track.emitter_id}`,
        );
    } else if (
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
          issue("invalid_timeline_keyframe", `${channel} 关键帧时间或数值无效`);
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
  if (videos > 1) issue("too_many_video_tracks", "单条时间线最多一个视频轨");
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
        issue("invalid_timeline_event_time", `事件 ${event.id} 超出时间线时长`);
      }
    }
    ids.add(event.id);
    priorEvent = event.at_ms;
  }
}

function timelineChannels(track: TimelineTrack): string[] {
  switch (track.type) {
    case "emitter":
      return ["x", "y", "scale", "rotation_deg", "opacity", "z"];
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
