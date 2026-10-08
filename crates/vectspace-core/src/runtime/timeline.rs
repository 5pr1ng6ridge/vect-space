use crate::model::{
    RuntimeSnapshot, SpriteActionDefinition, SpriteActionEnd, SpriteSnapshot, TimelineChannels,
    TimelineEasing, TimelineKeyframe, TimelineKeyframeValue, TimelineTrack,
};
use crate::visual::{SpriteKind, SpriteSource};

/// Expand a reusable relative action into the absolute Timeline representation
/// understood by both game and editor presentation layers.  Keeping this
/// conversion in Rust means an action always uses the exact same starting pose
/// and parameter validation as the authoritative runtime.
pub(super) fn expand_sprite_action(
    sprite_id: &str,
    action: &SpriteActionDefinition,
    base: &SpriteSnapshot,
    duration_ms: u64,
    end: SpriteActionEnd,
    overrides: &std::collections::BTreeMap<String, f32>,
) -> Result<Vec<TimelineTrack>, String> {
    if duration_ms == 0 {
        return Err("动作时长必须大于 0".to_owned());
    }
    if overrides
        .keys()
        .any(|parameter| !action.parameters.contains_key(parameter))
    {
        let unknown = overrides
            .keys()
            .find(|parameter| !action.parameters.contains_key(*parameter))
            .expect("checked above");
        return Err(format!("动作参数未声明: {unknown}"));
    }
    for (parameter_id, parameter) in &action.parameters {
        let value = overrides
            .get(parameter_id)
            .copied()
            .unwrap_or(parameter.default);
        if !value.is_finite()
            || parameter.min.is_some_and(|min| value < min)
            || parameter.max.is_some_and(|max| value > max)
        {
            return Err(format!("动作参数 {parameter_id} 超出声明范围"));
        }
    }

    let mut channels = TimelineChannels::new();
    for (channel, keyframes) in &action.channels {
        let mut expanded =
            Vec::with_capacity(keyframes.len() + usize::from(end == SpriteActionEnd::Restore));
        let mut previous_at = None;
        for keyframe in keyframes {
            let at_ms = scale_action_time(keyframe.at_ms, action.duration_ms, duration_ms)?;
            if previous_at.is_some_and(|previous| at_ms <= previous) {
                return Err(format!("动作通道 {channel} 的关键帧在目标时长下发生重叠"));
            }
            let relative = keyframe
                .parameter
                .as_ref()
                .and_then(|parameter| overrides.get(parameter).copied())
                .or_else(|| {
                    keyframe.parameter.as_ref().and_then(|parameter| {
                        action.parameters.get(parameter).map(|value| value.default)
                    })
                })
                .unwrap_or(keyframe.value);
            if !relative.is_finite() {
                return Err(format!("动作通道 {channel} 的值必须是有限数"));
            }
            let absolute = action_channel_value(channel, relative, base)?;
            expanded.push(TimelineKeyframe {
                at_ms,
                value: TimelineKeyframeValue::Number(absolute),
                easing: keyframe.easing.clone(),
            });
            previous_at = Some(at_ms);
        }
        if end == SpriteActionEnd::Restore {
            let restore = action_base_channel_value(channel, base)?;
            let restore_frame = TimelineKeyframe {
                at_ms: duration_ms,
                value: TimelineKeyframeValue::Number(restore),
                easing: TimelineEasing::default(),
            };
            if expanded
                .last()
                .is_some_and(|frame| frame.at_ms == duration_ms)
            {
                *expanded.last_mut().expect("last exists") = restore_frame;
            } else {
                expanded.push(restore_frame);
            }
        }
        channels.insert(channel.clone(), expanded);
    }
    if channels.is_empty() {
        return Err("动作至少需要一个变换通道".to_owned());
    }
    Ok(vec![TimelineTrack::Sprite {
        sprite_id: sprite_id.to_owned(),
        asset: None,
        source: None,
        sprite_kind: None,
        space: None,
        layout: None,
        remove_at_end: false,
        channels,
    }])
}

fn scale_action_time(
    at_ms: u64,
    source_duration: u64,
    target_duration: u64,
) -> Result<u64, String> {
    if source_duration == 0 {
        return Err("动作定义时长必须大于 0".to_owned());
    }
    let scaled = (u128::from(at_ms) * u128::from(target_duration)
        + u128::from(source_duration / 2))
        / u128::from(source_duration);
    u64::try_from(scaled).map_err(|_| "动作关键帧时间溢出".to_owned())
}

fn action_channel_value(
    channel: &str,
    relative: f32,
    base: &SpriteSnapshot,
) -> Result<f32, String> {
    let base_value = action_base_channel_value(channel, base)?;
    let value = match channel {
        "x" | "y" | "rotation_deg" => base_value + relative,
        "scale" | "scale_x" | "scale_y" | "opacity" => base_value * relative,
        _ => return Err(format!("动作不支持通道 {channel}")),
    };
    if !value.is_finite() {
        return Err(format!("动作通道 {channel} 的结果必须是有限数"));
    }
    if (channel == "scale" && value <= 0.0)
        || (matches!(channel, "scale_x" | "scale_y") && value == 0.0)
    {
        return Err(format!("动作通道 {channel} 的结果缩放无效"));
    }
    if channel == "opacity" && !(0.0..=1.0).contains(&value) {
        return Err("动作 opacity 结果必须在 0 到 1 之间".to_owned());
    }
    Ok(value)
}

fn action_base_channel_value(channel: &str, base: &SpriteSnapshot) -> Result<f32, String> {
    match channel {
        "x" => Ok(base.x),
        "y" => Ok(base.y),
        "scale" => Ok(base.scale),
        "scale_x" => Ok(base.scale_x),
        "scale_y" => Ok(base.scale_y),
        "rotation_deg" => Ok(base.rotation_deg),
        "opacity" => Ok(base.opacity),
        _ => Err(format!("动作不支持通道 {channel}")),
    }
}

fn final_channel(channels: &TimelineChannels, id: &str) -> Option<f32> {
    channels
        .get(id)
        .and_then(|keyframes| keyframes.last())
        .and_then(|keyframe| keyframe.value.number())
}

fn has_inherited_channel(channels: &TimelineChannels) -> bool {
    channels
        .values()
        .any(|frames| frames.first().is_some_and(|frame| frame.value.is_inherit()))
}

pub(super) fn apply_timeline_final_state(
    snapshot: &mut RuntimeSnapshot,
    tracks: &[TimelineTrack],
) -> Result<(), String> {
    for track in tracks {
        match track {
            TimelineTrack::Emitter { emitter_id, remove_at_end, channels } => {
                let emitter = snapshot.world.emitters.get_mut(emitter_id)
                    .ok_or_else(|| format!("发射器 {emitter_id} 未启动，无法应用时间线"))?;
                if *remove_at_end {
                    snapshot.world.emitters.remove(emitter_id);
                    continue;
                }
                if let Some(value) = final_channel(channels, "x") { emitter.x = value; }
                if let Some(value) = final_channel(channels, "y") { emitter.y = value; }
                if let Some(value) = final_channel(channels, "scale") { emitter.scale = value; }
                if let Some(value) = final_channel(channels, "rotation_deg") { emitter.rotation_deg = value; }
                if let Some(value) = final_channel(channels, "opacity") { emitter.opacity = value; }
                if let Some(value) = final_channel(channels, "z") { emitter.z = value.round() as i32; }
                if emitter.scale <= 0.0 { return Err(format!("发射器 {emitter_id} 的最终缩放必须大于 0")); }
            }
            TimelineTrack::Sprite {
                sprite_id,
                asset,
                source,
                sprite_kind,
                space,
                layout,
                remove_at_end,
                channels,
            } => {
                if has_inherited_channel(channels)
                    && !snapshot.world.sprites.contains_key(sprite_id)
                {
                    return Err(format!(
                        "立绘 {sprite_id} 使用 inherit，但进入时间线时该实例不存在"
                    ));
                }
                if *remove_at_end {
                    snapshot.world.sprites.remove(sprite_id);
                    continue;
                }
                let mut target = snapshot
                    .world
                    .sprites
                    .get(sprite_id)
                    .cloned()
                    .or_else(|| {
                        let requested = source.clone().or_else(|| asset.as_ref().map(|asset|
                            SpriteSource::Image { asset: asset.clone() }))?;
                        let kind = sprite_kind.unwrap_or(if matches!(requested, SpriteSource::Text { .. }) {
                            SpriteKind::Text
                        } else {
                            SpriteKind::Character
                        });
                        Some(kind.preset(requested))
                    })
                    .ok_or_else(|| {
                        format!("Sprite {sprite_id} 未指定来源，且进入时间线时实例不存在")
                    })?;
                if let Some(source) = source {
                    target.source = source.clone();
                } else if let Some(asset) = asset {
                    target.source = SpriteSource::Image { asset: asset.clone() };
                }
                if let Some(kind) = sprite_kind { target.sprite_kind = *kind; }
                if let Some(space) = space { target.space = *space; }
                if let Some(layout) = layout { target.layout = Some(layout.clone()); }
                if let Some(value) = final_channel(channels, "x") {
                    target.x = value;
                }
                if let Some(value) = final_channel(channels, "y") {
                    target.y = value;
                }
                if let Some(value) = final_channel(channels, "scale") {
                    target.scale = value;
                }
                if let Some(value) = final_channel(channels, "scale_x") {
                    target.scale_x = value;
                }
                if let Some(value) = final_channel(channels, "scale_y") {
                    target.scale_y = value;
                }
                if let Some(value) = final_channel(channels, "rotation_deg") {
                    target.rotation_deg = value;
                }
                if let Some(value) = final_channel(channels, "opacity") {
                    target.opacity = value;
                }
                if let Some(value) = final_channel(channels, "z") {
                    target.z = value.round() as i32;
                }
                if target.scale <= 0.0 || target.scale_x == 0.0 || target.scale_y == 0.0 {
                    return Err(format!("立绘 {sprite_id} 的最终缩放必须大于 0"));
                }
                snapshot.world.sprites.insert(sprite_id.clone(), target);
            }
            TimelineTrack::Camera { channels } => {
                if let Some(value) = final_channel(channels, "x") {
                    snapshot.world.camera.x = value;
                }
                if let Some(value) = final_channel(channels, "y") {
                    snapshot.world.camera.y = value;
                }
                if let Some(value) = final_channel(channels, "zoom") {
                    if value <= 0.0 {
                        return Err("相机最终 zoom 必须大于 0".to_owned());
                    }
                    snapshot.world.camera.zoom = value;
                }
                if let Some(value) = final_channel(channels, "rotation_deg") {
                    snapshot.world.camera.rotation_deg = value;
                }
            }
            TimelineTrack::Button {
                instance_id,
                channels,
            } => {
                if has_inherited_channel(channels)
                    && !snapshot.world.buttons.contains_key(instance_id)
                {
                    return Err(format!(
                        "按钮 {instance_id} 使用 inherit，但进入时间线时该实例不存在"
                    ));
                }
                let button = snapshot
                    .world
                    .buttons
                    .get_mut(instance_id)
                    .ok_or_else(|| format!("按钮 {instance_id} 未创建，无法应用时间线"))?;
                if let Some(value) = final_channel(channels, "x") {
                    button.x = value;
                }
                if let Some(value) = final_channel(channels, "y") {
                    button.y = value;
                }
                if let Some(value) = final_channel(channels, "width") {
                    button.width = value;
                }
                if let Some(value) = final_channel(channels, "height") {
                    button.height = value;
                }
                if let Some(value) = final_channel(channels, "scale_x") {
                    button.scale_x = value;
                }
                if let Some(value) = final_channel(channels, "scale_y") {
                    button.scale_y = value;
                }
                if let Some(value) = final_channel(channels, "rotation_deg") {
                    button.rotation_deg = value;
                }
                if let Some(value) = final_channel(channels, "opacity") {
                    button.opacity = value;
                }
                if let Some(value) = final_channel(channels, "z") {
                    button.z = value.round() as i32;
                }
                if !button.width.is_finite()
                    || !button.height.is_finite()
                    || button.width <= 0.0
                    || button.height <= 0.0
                    || !button.scale_x.is_finite()
                    || !button.scale_y.is_finite()
                    || button.scale_x == 0.0
                    || button.scale_y == 0.0
                {
                    return Err(format!("按钮 {instance_id} 的最终尺寸或缩放无效"));
                }
            }
            TimelineTrack::Bgm { channels } => {
                if let Some(value) = final_channel(channels, "volume") {
                    let bgm = snapshot
                        .audio
                        .bgm
                        .as_mut()
                        .ok_or_else(|| "BGM 音量轨要求当前存在 BGM".to_owned())?;
                    bgm.volume = value;
                }
            }
            // Ambience volume automation is presentation-only. The
            // authoritative loop state, including its volume, remains in the
            // snapshot so skip/final evaluation cannot persist a transient
            // timeline value. Like the existing BGM track, an absent slot is
            // simply left unchanged.
            TimelineTrack::Ambience { .. } => {}
            TimelineTrack::Video { .. } => {}
        }
    }
    Ok(())
}
