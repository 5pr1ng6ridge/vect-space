//! Export the frozen presentation parity payloads consumed by the browser
//! entry (`npm run parity:check`).
//!
//! Usage:
//!   cargo run -p vectspace-protocol --bin export_parity_fixture -- \
//!     <game-root> <targets.json> <out.json>
//!
//! The output has the exact wire shape the editor's `build_node_preview`
//! command returns, so the game's `PresentationController` and the editor's
//! `SceneSurface` can be driven from byte-identical payloads.  Regenerating
//! the payload on every parity run keeps the baseline tied to the real runtime
//! instead of a hand-written fixture that can drift.
//!
//! See `docs/scene-surface-migration-baseline.md` for the fixture contract.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use vectspace_core::content::ContentCatalog;
use vectspace_core::model::{AssetKind, StoryLocation, VariableMap};
use vectspace_core::runtime::{PreviewRunResult, RuntimeEngine};
use vectspace_protocol::{WireRuntimeSnapshot, WireRuntimeUpdate, WireSessionMode, WireU64};

const FIXTURE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetFile {
    schema_version: u32,
    targets: Vec<TargetSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetSpec {
    id: String,
    scene_id: String,
    node_id: String,
}

#[derive(Debug, Serialize)]
struct FixtureDocument {
    schema_version: u32,
    game_root: String,
    targets: Vec<FixtureTarget>,
    assets: Vec<FixtureAsset>,
}

#[derive(Debug, Serialize)]
struct FixtureTarget {
    id: String,
    scene_id: String,
    node_id: String,
    start_snapshot: WireRuntimeSnapshot,
    update: WireRuntimeUpdate,
    trace: Vec<StoryLocation>,
}

#[derive(Debug, Serialize)]
struct FixtureAsset {
    id: String,
    kind: AssetKind,
    /// Path relative to `<game-root>/assets`, using forward slashes.
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    animation: Option<FixtureAnimation>,
}

#[derive(Debug, Serialize)]
struct FixtureAnimation {
    id: String,
    width: u32,
    height: u32,
    total_duration_ms: u64,
    frames: Vec<FixtureAnimationFrame>,
}

#[derive(Debug, Serialize)]
struct FixtureAnimationFrame {
    asset: String,
    duration_ms: u64,
    path: String,
}

fn main() -> std::process::ExitCode {
    match run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("export_parity_fixture: {message}");
            std::process::ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let [game_root, targets_path, out_path] = args.as_slice() else {
        return Err("用法: export_parity_fixture <game-root> <targets.json> <out.json>".to_owned());
    };
    let game_root = PathBuf::from(game_root);
    let targets_text = fs::read_to_string(targets_path)
        .map_err(|error| format!("无法读取目标清单 {targets_path}: {error}"))?;
    let targets: TargetFile = serde_json::from_str(&targets_text)
        .map_err(|error| format!("目标清单不是合法 JSON: {error}"))?;
    if targets.schema_version != FIXTURE_SCHEMA_VERSION {
        return Err(format!(
            "目标清单 schema_version {} 不受支持（需要 {FIXTURE_SCHEMA_VERSION}）",
            targets.schema_version
        ));
    }

    let catalog =
        ContentCatalog::from_root(game_root.clone()).map_err(|error| error.to_string())?;
    let mut fixtures = Vec::with_capacity(targets.targets.len());
    for spec in &targets.targets {
        fixtures.push(export_target(&catalog, spec)?);
    }
    let assets = export_assets(&catalog)?;

    let document = FixtureDocument {
        schema_version: FIXTURE_SCHEMA_VERSION,
        game_root: game_root.display().to_string().replace('\\', "/"),
        targets: fixtures,
        assets,
    };
    let mut json = serde_json::to_string_pretty(&document)
        .map_err(|error| format!("无法序列化夹具: {error}"))?;
    json.push('\n');
    if let Some(parent) = Path::new(out_path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建输出目录 {}: {error}", parent.display()))?;
        }
    }
    fs::write(out_path, json).map_err(|error| format!("无法写入 {out_path}: {error}"))?;
    println!(
        "export_parity_fixture: {} 个目标、{} 个素材 -> {out_path}",
        document.targets.len(),
        document.assets.len()
    );
    Ok(())
}

fn export_target(catalog: &ContentCatalog, spec: &TargetSpec) -> Result<FixtureTarget, String> {
    let location = StoryLocation {
        scene_id: spec.scene_id.clone(),
        node_id: spec.node_id.clone(),
    };
    let mut runtime = RuntimeEngine::with_preview_overrides(catalog, &VariableMap::new())
        .map_err(|error| error.to_string())?;
    let preview = runtime
        .preview_to_from_scene_entry(catalog, &spec.scene_id, &location, &[])
        .map_err(|error| error.to_string())?;
    let (snapshot, trace) = match preview {
        PreviewRunResult::Ready { snapshot, trace } => (snapshot, trace),
        PreviewRunResult::NeedsChoice { location, .. } => {
            return Err(format!(
                "目标 {} 需要选择：{}/{}",
                spec.id, location.scene_id, location.node_id
            ));
        }
        PreviewRunResult::Unreachable { message, .. } => {
            return Err(format!("目标 {} 不可达：{message}", spec.id));
        }
    };
    let update = runtime
        .preview_execute_current_node(catalog)
        .map_err(|error| format!("目标 {} 无法执行：{error}", spec.id))?;
    Ok(FixtureTarget {
        id: spec.id.clone(),
        scene_id: spec.scene_id.clone(),
        node_id: spec.node_id.clone(),
        start_snapshot: WireRuntimeSnapshot::with_session(
            snapshot,
            WireU64::from(0),
            WireSessionMode::Story,
        ),
        update: WireRuntimeUpdate::with_session(update, WireU64::from(0), WireSessionMode::Story),
        trace,
    })
}

fn export_assets(catalog: &ContentCatalog) -> Result<Vec<FixtureAsset>, String> {
    let assets_root = catalog.assets_root().to_path_buf();
    let resolved = catalog
        .resolve_assets(&catalog.asset_ids())
        .map_err(|error| error.to_string())?;
    Ok(resolved
        .into_iter()
        .map(|asset| FixtureAsset {
            id: asset.id,
            kind: asset.kind,
            path: relative_asset_path(&assets_root, &asset.absolute_path),
            animation: asset.animation.map(|animation| FixtureAnimation {
                id: animation.id,
                width: animation.width,
                height: animation.height,
                total_duration_ms: animation.total_duration_ms,
                frames: animation
                    .frames
                    .into_iter()
                    .map(|frame| FixtureAnimationFrame {
                        asset: frame.asset,
                        duration_ms: frame.duration_ms,
                        path: relative_asset_path(&assets_root, &frame.absolute_path),
                    })
                    .collect(),
            }),
        })
        .collect())
}

fn relative_asset_path(assets_root: &Path, absolute_path: &str) -> String {
    let path = Path::new(absolute_path);
    let relative = path.strip_prefix(assets_root).unwrap_or(path);
    relative.to_string_lossy().replace('\\', "/")
}
