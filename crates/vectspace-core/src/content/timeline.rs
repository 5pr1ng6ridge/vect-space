use std::collections::{BTreeMap, BTreeSet};

use crate::model::{
    AssetDefinition, AssetKind, TimelineChannels, TimelineEasing, TimelineEvent, TimelineTrack,
};
use super::ContentError;
use super::common::{node_error, validate_identifier};
use super::effects::validate_screen_effect;
use super::scenes::{require_asset, validate_duration, validate_volume};

pub(super) const MAX_TIMELINE_DURATION_MS: u64 = 30 * 60 * 1_000;
const MAX_TIMELINE_TRACKS: usize = 64;
pub(super) const MAX_TIMELINE_KEYFRAMES: usize = 10_000;
const MAX_TIMELINE_EVENTS: usize = 2_048;

#[allow(clippy::too_many_arguments)]
pub(super) fn validate_timeline(
    duration_ms: u64,
    await_completion: bool,
    skippable: bool,
    tracks: &[TimelineTrack],
    events: &[TimelineEvent],
    assets: &BTreeMap<String, AssetDefinition>,
    scene_id: &str,
    node_id: &str,
) -> Result<(), ContentError> {
    if duration_ms == 0 || duration_ms > MAX_TIMELINE_DURATION_MS {
        return node_error(scene_id, node_id, "时间线时长必须在 1ms 到 30 分钟之间");
    }
    if tracks.len() > MAX_TIMELINE_TRACKS {
        return node_error(scene_id, node_id, "时间线轨道超过 64 条");
    }
    if events.len() > MAX_TIMELINE_EVENTS {
        return node_error(scene_id, node_id, "时间线事件超过 2048 个");
    }
    if !await_completion && skippable {
        return node_error(scene_id, node_id, "非阻塞时间线不能设为可跳过");
    }
    let mut keyframe_count = 0usize;
    let mut video_count = 0usize;
    let mut track_ids = BTreeSet::new();
    for track in tracks {
        let (channels, allowed, allow_inherit): (&TimelineChannels, &[&str], bool) = match track {
            TimelineTrack::Sprite {
                sprite_id,
                asset,
                channels,
                ..
            } => {
                validate_identifier("timeline sprite id", sprite_id)?;
                if !track_ids.insert(format!("sprite:{sprite_id}")) {
                    return node_error(scene_id, node_id, "同一立绘不能出现多条时间线轨道");
                }
                if let Some(asset) = asset {
                    if !assets.get(asset).is_some_and(|definition| matches!(definition.kind,
                        AssetKind::Background | AssetKind::Sprite | AssetKind::Gui)) {
                        return node_error(scene_id, node_id, "Sprite 时间线必须引用图片来源");
                    }
                }
                (
                    channels,
                    &[
                        "x",
                        "y",
                        "scale",
                        "scale_x",
                        "scale_y",
                        "rotation_deg",
                        "opacity",
                        "z",
                    ],
                    true,
                )
            }
            TimelineTrack::Emitter { emitter_id, channels, .. } => {
                validate_identifier("timeline emitter id", emitter_id)?;
                if !track_ids.insert(format!("emitter:{emitter_id}")) {
                    return node_error(scene_id, node_id, "同一发射器不能出现多条时间线轨道");
                }
                (channels, &["x", "y", "scale", "rotation_deg", "opacity", "z"], true)
            }
            TimelineTrack::Camera { channels } => {
                if !track_ids.insert("camera".to_owned()) {
                    return node_error(scene_id, node_id, "时间线只能包含一条镜头轨");
                }
                (channels, &["x", "y", "zoom", "rotation_deg"], true)
            }
            TimelineTrack::Button {
                instance_id,
                channels,
            } => {
                validate_identifier("timeline button id", instance_id)?;
                if !track_ids.insert(format!("button:{instance_id}")) {
                    return node_error(scene_id, node_id, "同一按钮不能出现多条时间线轨道");
                }
                (
                    channels,
                    &[
                        "x",
                        "y",
                        "width",
                        "height",
                        "scale_x",
                        "scale_y",
                        "rotation_deg",
                        "opacity",
                        "z",
                    ],
                    true,
                )
            }
            TimelineTrack::Video {
                asset,
                clip_start_ms,
                clip_end_ms,
                channels,
                ..
            } => {
                video_count += 1;
                track_ids.insert("video".to_owned());
                if !await_completion {
                    return node_error(scene_id, node_id, "包含视频的时间线必须 await: true");
                }
                require_asset(assets, asset, AssetKind::Video, scene_id, node_id)?;
                if clip_end_ms.is_some_and(|end| end <= *clip_start_ms) {
                    return node_error(scene_id, node_id, "视频裁剪终点必须晚于起点");
                }
                (
                    channels,
                    &["x", "y", "width", "height", "opacity", "z", "volume"],
                    false,
                )
            }
            TimelineTrack::Bgm { channels } => {
                if !track_ids.insert("bgm".to_owned()) {
                    return node_error(scene_id, node_id, "时间线只能包含一条 BGM 音量轨");
                }
                (channels, &["volume"], true)
            }
            TimelineTrack::Ambience { slot, channels } => {
                if !track_ids.insert(format!("ambience:{}", slot.as_str())) {
                    return node_error(scene_id, node_id, "同一 ambience 槽位不能出现多条时间线轨");
                }
                (channels, &["volume"], true)
            }
        };
        validate_timeline_channels(
            channels,
            allowed,
            duration_ms,
            scene_id,
            node_id,
            &mut keyframe_count,
            allow_inherit,
        )?;
    }
    if video_count > 1 {
        return node_error(scene_id, node_id, "单条时间线最多包含一个视频轨");
    }
    if keyframe_count > MAX_TIMELINE_KEYFRAMES {
        return node_error(scene_id, node_id, "时间线关键帧超过 10000 个");
    }
    let mut event_ids = BTreeSet::new();
    let mut previous = 0;
    for (index, event) in events.iter().enumerate() {
        let (id, at_ms) = match event {
            TimelineEvent::Sfx {
                id,
                at_ms,
                asset,
                volume,
            } => {
                require_asset(assets, asset, AssetKind::Sfx, scene_id, node_id)?;
                validate_volume(*volume, scene_id, node_id)?;
                (id, *at_ms)
            }
            TimelineEvent::ScreenEffect {
                id,
                at_ms,
                effect,
                duration_ms: effect_duration,
            } => {
                validate_screen_effect(effect, scene_id, node_id)?;
                validate_duration(*effect_duration, scene_id, node_id)?;
                if at_ms.saturating_add(*effect_duration) > duration_ms {
                    return node_error(scene_id, node_id, "屏幕效果事件超出时间线时长");
                }
                (id, *at_ms)
            }
        };
        validate_identifier("timeline event id", id)?;
        if !event_ids.insert(id) {
            return node_error(scene_id, node_id, "时间线事件 ID 重复");
        }
        if at_ms > duration_ms || (index > 0 && at_ms < previous) {
            return node_error(scene_id, node_id, "时间线事件必须按时间排序且位于时长内");
        }
        previous = at_ms;
    }
    Ok(())
}

pub(super) fn validate_timeline_channels(
    channels: &TimelineChannels,
    allowed: &[&str],
    duration_ms: u64,
    scene_id: &str,
    node_id: &str,
    keyframe_count: &mut usize,
    allow_inherit: bool,
) -> Result<(), ContentError> {
    for (name, keyframes) in channels {
        if !allowed.contains(&name.as_str()) {
            return node_error(
                scene_id,
                node_id,
                &format!("时间线通道 {name} 不适用于该轨道"),
            );
        }
        if keyframes.is_empty() {
            return node_error(scene_id, node_id, &format!("时间线通道 {name} 不能为空"));
        }
        *keyframe_count = keyframe_count.saturating_add(keyframes.len());
        let mut previous = None;
        for (index, keyframe) in keyframes.iter().enumerate() {
            if keyframe.at_ms > duration_ms || previous.is_some_and(|value| keyframe.at_ms <= value)
            {
                return node_error(
                    scene_id,
                    node_id,
                    &format!("时间线通道 {name} 的关键帧无效"),
                );
            }
            if keyframe.value.is_inherit() {
                if !allow_inherit || index != 0 || keyframe.at_ms != 0 || keyframes.len() < 2 {
                    return node_error(
                        scene_id,
                        node_id,
                        &format!("时间线通道 {name} 的 inherit 只能作为 0ms 起始帧"),
                    );
                }
            } else if let Some(value) = keyframe.value.number() {
                if !value.is_finite() {
                    return node_error(
                        scene_id,
                        node_id,
                        &format!("时间线通道 {name} 的关键帧数值无效"),
                    );
                }
                if matches!(name.as_str(), "opacity" | "volume") && !(0.0..=1.0).contains(&value) {
                    return node_error(
                        scene_id,
                        node_id,
                        &format!("时间线通道 {name} 必须在 0 到 1 之间"),
                    );
                }
                if (matches!(name.as_str(), "scale" | "zoom" | "width" | "height")
                    && value <= 0.0)
                    || (matches!(name.as_str(), "scale_x" | "scale_y") && value == 0.0)
                {
                    return node_error(scene_id, node_id, &format!("时间线通道 {name} 缩放无效"));
                }
            }
            if let TimelineEasing::CubicBezier { cubic_bezier } = &keyframe.easing {
                if cubic_bezier.iter().any(|value| !value.is_finite())
                    || !(0.0..=1.0).contains(&cubic_bezier[0])
                    || !(0.0..=1.0).contains(&cubic_bezier[2])
                {
                    return node_error(
                        scene_id,
                        node_id,
                        "cubic_bezier 的 x 控制点必须在 0 到 1 之间",
                    );
                }
            }
            previous = Some(keyframe.at_ms);
        }
    }
    Ok(())
}
