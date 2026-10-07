use super::*;
use crate::visual::{EmissionArea, ParticleAction, ParticleDefinition, ParticleRange, SpriteLayout, SpriteSource, TextBlockDefinition, PARTICLE_MAX_LIVE, TEXT_BLOCK_MAX_PIXELS};

pub(super) fn documents<T: serde::de::DeserializeOwned + Clone>(
    root: &Path, paths: &[String], drafts: Option<BTreeMap<String, T>>,
    id: impl Fn(&T) -> &str,
) -> Result<BTreeMap<String, T>, ContentError> {
    let files = match drafts {
        Some(files) => files,
        None => {
            let mut files = BTreeMap::new();
            for path in paths {
                let relative = validate_relative_path(path)?;
                let full_path = canonical_file_within(root, &root.join(relative))?;
                files.insert(path.clone(), read_yaml(&full_path)?);
            }
            files
        }
    };
    if paths.iter().collect::<BTreeSet<_>>() != files.keys().collect::<BTreeSet<_>>() {
        return Err(ContentError::Validation("视觉文档文件清单与 manifest 不一致".into()));
    }
    let mut result = BTreeMap::new();
    for value in files.into_values() {
        let key = id(&value).to_owned();
        validate_identifier("visual document", &key)?;
        if result.insert(key.clone(), value).is_some() {
            return Err(ContentError::Validation(format!("视觉文档 ID 重复: {key}")));
        }
    }
    Ok(result)
}

fn color(value: &str) -> bool {
    matches!(value.len(), 7 | 9) && value.starts_with('#') && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn validate_documents(
    manifest: &ContentManifest, texts: &BTreeMap<String, TextBlockDefinition>,
    particles: &BTreeMap<String, ParticleDefinition>, assets_root: &Path,
    overrides: &BTreeMap<String, PathBuf>, animations: &BTreeMap<String, ImageAnimationDefinition>,
    actions: &BTreeMap<String, SpriteActionDefinition>,
) -> Result<(), ContentError> {
    let mut ids = manifest.assets.keys().chain(animations.keys()).chain(actions.keys()).cloned().collect::<BTreeSet<_>>();
    for id in texts.keys().chain(particles.keys()) {
        if !ids.insert(id.clone()) { return Err(ContentError::Validation(format!("视觉文档 ID 与资源冲突: {id}"))); }
    }
    for text in texts.values() {
        let width = text.width;
        let height = text.height;
        if text.schema_version != CONTENT_SCHEMA_VERSION
            || width == 0 || height == 0 || width > 4096 || height > 4096
            || u64::from(width) * u64::from(height) > TEXT_BLOCK_MAX_PIXELS
            || text.content.chars().count() > 16_384
            || !text.font_size.is_finite() || !(1.0..=512.0).contains(&text.font_size)
            || !text.line_height.is_finite() || !(0.5..=8.0).contains(&text.line_height)
            || !text.padding.is_finite() || text.padding < 0.0 || text.padding * 2.0 >= width.min(height) as f32
            || !color(&text.color) || text.background.as_deref().is_some_and(|value| !color(value)) {
            return Err(ContentError::Validation(format!("固定文本块 {} 的大小、排版或颜色无效", text.id)));
        }
        if let Some(font) = &text.font {
            if !manifest.assets.get(font).is_some_and(|asset| asset.kind == AssetKind::Font) {
                return Err(ContentError::Validation(format!("固定文本块 {} 引用了无效字体 {font}", text.id)));
            }
        }
    }
    for particle in particles.values() {
        let finite = |range: ParticleRange| range.min.is_finite() && range.max.is_finite() && range.min <= range.max;
        let ranges = [particle.lifetime_ms, particle.velocity_x, particle.velocity_y, particle.size, particle.rotation_deg, particle.angular_velocity_deg];
        if particle.schema_version != CONTENT_SCHEMA_VERSION
            || !ranges.into_iter().all(finite)
            || particle.lifetime_ms.min < 1.0 || particle.lifetime_ms.max > 30_000.0
            || particle.size.min <= 0.0 || particle.size.max > 100.0
            || !particle.rate.is_finite() || !(0.0..=10_000.0).contains(&particle.rate)
            || particle.max_particles == 0 || particle.max_particles > PARTICLE_MAX_LIVE
            || particle.burst_count > particle.max_particles
            || !particle.gravity_x.is_finite() || !particle.gravity_y.is_finite()
            || ![particle.alpha_start, particle.alpha_end].into_iter().all(|alpha| alpha.is_finite() && (0.0..=1.0).contains(&alpha)) {
            return Err(ContentError::Validation(format!("粒子定义 {} 参数或预算无效", particle.id)));
        }
        if let EmissionArea::Rectangle { width, height } = particle.area {
            if !width.is_finite() || !height.is_finite() || !(0.0..=16_384.0).contains(&width) || !(0.0..=16_384.0).contains(&height) {
                return Err(ContentError::Validation(format!("粒子 {} 发射范围无效", particle.id)));
            }
        }
        let Some(asset) = manifest.assets.get(&particle.image) else {
            return Err(ContentError::Validation(format!("粒子 {} 图片不存在", particle.id)));
        };
        if !matches!(asset.kind, AssetKind::Background | AssetKind::Sprite | AssetKind::Gui) || asset.path.is_none() || asset.animation.is_some() {
            return Err(ContentError::Validation(format!("粒子 {} 必须使用单张静态图片", particle.id)));
        }
        let path = match overrides.get(&particle.image) {
            Some(path) => path.clone(),
            None => canonical_file_within(assets_root, &assets_root.join(validate_relative_path(asset.path.as_deref().unwrap_or_default())?))?,
        };
        let size = probe(&path).map_err(|error| ContentError::Validation(format!("粒子图片无法读取: {error}")))?;
        if size.width > 512 || size.height > 512 {
            return Err(ContentError::Validation(format!("粒子 {} 图片最大为 512×512", particle.id)));
        }
    }
    Ok(())
}

pub(super) fn source(
    source: &SpriteSource, assets: &BTreeMap<String, AssetDefinition>,
    texts: &BTreeMap<String, TextBlockDefinition>,
) -> Result<(), ContentError> {
    match source {
        SpriteSource::Image { asset } if assets.get(asset).is_some_and(|definition| matches!(definition.kind, AssetKind::Background | AssetKind::Sprite | AssetKind::Gui)) => Ok(()),
        SpriteSource::Text { text_block } if texts.contains_key(text_block) => Ok(()),
        _ => Err(ContentError::Validation(format!("Sprite 图像/文本来源无效: {source:?}"))),
    }
}

pub(super) fn layout(layout: &SpriteLayout) -> bool {
    [layout.width, layout.height].into_iter().all(|value| value.is_finite() && value > 0.0 && value <= 16_384.0)
}

pub(super) fn validate_scenes(
    scenes: &BTreeMap<String, SceneDefinition>, assets: &BTreeMap<String, AssetDefinition>,
    texts: &BTreeMap<String, TextBlockDefinition>, particles: &BTreeMap<String, ParticleDefinition>,
) -> Result<(), ContentError> {
    for (scene_id, scene) in scenes {
        for (node_id, node) in &scene.nodes {
            match node {
                SceneNode::Sprite { source: requested, asset, character, layout: requested_layout, scale_x, scale_y, rotation_deg, anchor_x, anchor_y, sprite_id, .. } => {
                    validate_identifier("sprite instance", sprite_id)?;
                    if sprite_id == crate::visual::LEGACY_BACKGROUND_ID { return node_error(scene_id, node_id, "__background__ 是旧背景适配器保留的实例 ID"); }
                    if let Some(requested) = requested {
                        if asset.is_some() || character.is_some() { return node_error(scene_id, node_id, "source 不能与旧 asset/character 同时指定"); }
                        source(requested, assets, texts)?;
                    }
                    if requested_layout.as_ref().is_some_and(|value| !layout(value))
                        || [*scale_x, *scale_y].into_iter().flatten().any(|value| !value.is_finite() || value == 0.0)
                        || rotation_deg.is_some_and(|value| !value.is_finite())
                        || [*anchor_x, *anchor_y].into_iter().flatten().any(|value| !value.is_finite() || !(0.0..=1.0).contains(&value)) {
                        return node_error(scene_id, node_id, "Sprite 布局或变换无效");
                    }
                }
                SceneNode::Timeline { tracks, .. } => {
                    for track in tracks {
                        if let TimelineTrack::Sprite { sprite_id, asset, source: requested, layout: requested_layout, .. } = track {
                            if sprite_id == crate::visual::LEGACY_BACKGROUND_ID { return node_error(scene_id, node_id, "__background__ 是旧背景适配器保留的实例 ID"); }
                            if let Some(requested) = requested {
                                if asset.is_some() { return node_error(scene_id, node_id, "Sprite 轨道 source 不能与旧 asset 同时指定"); }
                                source(requested, assets, texts)?;
                            }
                            if requested_layout.as_ref().is_some_and(|value| !layout(value)) {
                                return node_error(scene_id, node_id, "Sprite 轨道布局无效");
                            }
                        }
                    }
                }
                SceneNode::Particle { emitter_id, action, particle, x, y, scale, rotation_deg, opacity, .. } => {
                    validate_identifier("emitter instance", emitter_id)?;
                    if *action != ParticleAction::Stop && !particle.as_ref().is_some_and(|id| particles.contains_key(id)) {
                        return node_error(scene_id, node_id, "start/burst 必须引用有效粒子定义");
                    }
                    if ![x, y, scale, rotation_deg, opacity].into_iter().all(|value| value.is_finite()) || *scale <= 0.0 || !(0.0..=1.0).contains(opacity) {
                        return node_error(scene_id, node_id, "发射器变换无效");
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}
