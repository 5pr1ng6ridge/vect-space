//! Media inspection: decode or parse an image, audio, video or font file well
//! enough to reject corrupt or renamed files and to report its metadata.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use image::{GenericImageView, ImageReader};
use symphonia::core::codecs::CODEC_TYPE_NULL;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tauri::State;
use ttf_parser::Face;
use vectspace_protocol::{
    WireAssetDiagnostic, WireAssetInspection, WireAssetMetadata, WireAssetReuseCandidate,
    WireCommandError, WireInspectAssetImportsRequest, WireU64,
};

use crate::assets::{inferred_asset_kind, lowercase_extension, wire_asset_kind, InspectedImport};
use crate::files::hash_file_streaming;
use crate::state::{require_project, EditorState, ProjectSession};

const MAX_PENDING_ASSET_INSPECTIONS: usize = 512;
const MAX_FONT_INSPECTION_BYTES: u64 = 64 * 1024 * 1024;

fn empty_asset_metadata(format: &str) -> WireAssetMetadata {
    WireAssetMetadata {
        format: format.to_owned(),
        width: None,
        height: None,
        duration_ms: None,
        channels: None,
        sample_rate: None,
        font_family: None,
        font_style: None,
    }
}

pub(crate) fn inspect_media_source(source: &Path) -> Result<WireAssetMetadata, String> {
    let extension = lowercase_extension(source);
    // ImageReader and the container parsers validate their own structure, but
    // a few formats are permissive about the caller-provided extension.  A
    // cheap signature check keeps a renamed WAV/OGG/MP3/FLAC/MP4 from being
    // registered under a misleading path and makes the import contract
    // deterministic on both Windows and the test host.
    if matches!(extension.as_str(), "ogg" | "wav" | "mp3" | "flac" | "mp4") {
        validate_media_signature(source, &extension)?;
    }
    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "webp" => {
            let reader = ImageReader::open(source)
                .map_err(|error| error.to_string())?
                .with_guessed_format()
                .map_err(|error| error.to_string())?;
            let detected = reader.format();
            let extension_matches = match (extension.as_str(), detected) {
                ("png", Some(image::ImageFormat::Png))
                | ("jpg" | "jpeg", Some(image::ImageFormat::Jpeg))
                | ("webp", Some(image::ImageFormat::WebP)) => true,
                // `with_guessed_format` is allowed to return None for a few
                // valid image readers.  The full decode below is still the
                // authoritative corruption check in that case.
                (_, None) => true,
                _ => false,
            };
            if !extension_matches {
                return Err("文件扩展名与实际图片格式不匹配".to_owned());
            }
            let format = detected
                .map(|value| format!("{value:?}"))
                .unwrap_or_else(|| extension.to_ascii_uppercase());
            // Decode rather than only reading the header. This catches
            // truncated images that happen to carry a valid signature.
            let image = reader.decode().map_err(|error| error.to_string())?;
            let (width, height) = image.dimensions();
            let mut metadata = empty_asset_metadata(&format);
            metadata.width = Some(width);
            metadata.height = Some(height);
            Ok(metadata)
        }
        "ogg" | "wav" | "mp3" | "flac" => inspect_audio_source(source),
        "mp4" => inspect_mp4_source(source),
        "ttf" | "otf" => inspect_font_source(source),
        _ => Err("不支持的素材扩展名".to_owned()),
    }
}

fn validate_media_signature(source: &Path, extension: &str) -> Result<(), String> {
    let mut file = File::open(source).map_err(|error| error.to_string())?;
    let mut prefix = [0_u8; 12];
    let length = file.read(&mut prefix).map_err(|error| error.to_string())?;
    let bytes = &prefix[..length];
    let valid = match extension {
        "ogg" => bytes.starts_with(b"OggS"),
        "wav" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WAVE",
        "flac" => bytes.starts_with(b"fLaC"),
        "mp3" => {
            bytes.starts_with(b"ID3")
                || (bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0)
        }
        "mp4" => bytes.len() >= 8 && &bytes[4..8] == b"ftyp",
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("文件头与 .{extension} 扩展名不匹配"))
    }
}

fn inspect_audio_source(source: &Path) -> Result<WireAssetMetadata, String> {
    let file = File::open(source).map_err(|error| error.to_string())?;
    let source_stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = source.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            source_stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|error| error.to_string())?;
    let track = probed
        .format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "音频容器中没有有效音轨".to_owned())?;
    let params = &track.codec_params;
    let duration_ms = params
        .time_base
        .zip(params.n_frames)
        .and_then(|(time_base, frames)| {
            let time = time_base.calc_time(frames);
            let fraction = (time.frac * 1000.0).round();
            if !fraction.is_finite() || fraction < 0.0 {
                return None;
            }
            time.seconds
                .checked_mul(1000)
                .and_then(|value| value.checked_add(fraction as u64))
        });
    Ok(WireAssetMetadata {
        format: source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("audio")
            .to_ascii_uppercase(),
        width: None,
        height: None,
        duration_ms: duration_ms.map(WireU64::from),
        channels: params.channels.map(|value| value.count() as u16),
        sample_rate: params.sample_rate,
        font_family: None,
        font_style: None,
    })
}

fn inspect_mp4_source(source: &Path) -> Result<WireAssetMetadata, String> {
    let mut file = File::open(source).map_err(|error| error.to_string())?;
    let context = mp4parse::read_mp4(&mut file).map_err(|error| error.to_string())?;
    let track = context
        .tracks
        .iter()
        .find(|track| track.track_type == mp4parse::TrackType::Video)
        .ok_or_else(|| "MP4 容器中没有视频轨道".to_owned())?;
    let header = track
        .tkhd
        .as_ref()
        .ok_or_else(|| "MP4 视频轨道缺少尺寸信息".to_owned())?;
    let width = header.width >> 16;
    let height = header.height >> 16;
    if width == 0 || height == 0 {
        return Err("MP4 视频轨道尺寸无效".to_owned());
    }
    let duration_ms = track.duration.as_ref().and_then(|duration| {
        let timescale = track.timescale.as_ref()?.0;
        if timescale == 0 {
            return None;
        }
        duration.0.checked_mul(1000).map(|value| value / timescale)
    });
    Ok(WireAssetMetadata {
        format: "MP4".to_owned(),
        width: Some(width),
        height: Some(height),
        duration_ms: duration_ms.map(WireU64::from),
        channels: None,
        sample_rate: None,
        font_family: None,
        font_style: None,
    })
}

fn inspect_font_source(source: &Path) -> Result<WireAssetMetadata, String> {
    let length = fs::metadata(source)
        .map_err(|error| error.to_string())?
        .len();
    if length > MAX_FONT_INSPECTION_BYTES {
        return Err(format!(
            "字体文件过大，检查上限为 {} MiB",
            MAX_FONT_INSPECTION_BYTES / (1024 * 1024)
        ));
    }
    let bytes = fs::read(source).map_err(|error| error.to_string())?;
    let face = Face::parse(&bytes, 0).map_err(|error| format!("字体结构无效: {error:?}"))?;
    let family = face
        .names()
        .into_iter()
        .find(|name| {
            name.name_id == ttf_parser::name_id::TYPOGRAPHIC_FAMILY
                || name.name_id == ttf_parser::name_id::FAMILY
        })
        .and_then(|name| name.to_string());
    let style = face
        .names()
        .into_iter()
        .find(|name| {
            name.name_id == ttf_parser::name_id::TYPOGRAPHIC_SUBFAMILY
                || name.name_id == ttf_parser::name_id::SUBFAMILY
        })
        .and_then(|name| name.to_string());
    Ok(WireAssetMetadata {
        format: source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("font")
            .to_ascii_uppercase(),
        width: None,
        height: None,
        duration_ms: None,
        channels: None,
        sample_rate: None,
        font_family: family,
        font_style: style,
    })
}

/// A source file that passed inspection.
struct InspectedSource {
    path: PathBuf,
    metadata: WireAssetMetadata,
    sha256: String,
    size_bytes: u64,
}

fn error_diagnostic(code: &str, message: impl Into<String>) -> WireAssetDiagnostic {
    WireAssetDiagnostic {
        severity: "error".to_owned(),
        code: code.to_owned(),
        message: message.into(),
    }
}

fn inspect_source(raw_path: &str) -> Result<InspectedSource, WireAssetDiagnostic> {
    let io = |error: std::io::Error| error_diagnostic("io", error.to_string());
    let path = fs::canonicalize(raw_path).map_err(io)?;
    if !path.is_file() {
        return Err(error_diagnostic("not_file", "选择的路径不是文件"));
    }
    let size_bytes = fs::metadata(&path).map_err(io)?.len();
    if size_bytes == 0 {
        return Err(error_diagnostic("empty_file", "素材文件为空"));
    }
    let metadata = inspect_media_source(&path)
        .map_err(|message| error_diagnostic("invalid_media", message))?;
    let sha256 = hash_file_streaming(&path).map_err(io)?;
    Ok(InspectedSource {
        path,
        metadata,
        sha256,
        size_bytes,
    })
}

/// Registered assets whose bytes equal `sha256`, offered for reuse instead of
/// importing a second copy.
fn reuse_candidates(session: &ProjectSession, sha256: &str) -> Vec<WireAssetReuseCandidate> {
    session
        .catalog
        .manifest
        .assets
        .iter()
        .filter_map(|(id, definition)| {
            // Animated assets have no single file to compare against.
            let relative = definition.path.as_ref()?;
            let absolute = session.catalog.assets_root().join(relative);
            (hash_file_streaming(&absolute).ok().as_deref() == Some(sha256)).then(|| {
                WireAssetReuseCandidate {
                    id: id.clone(),
                    kind: wire_asset_kind(definition.kind),
                    path: relative.clone(),
                }
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) fn inspect_asset_imports(
    request: WireInspectAssetImportsRequest,
    state: State<'_, EditorState>,
) -> Result<Vec<WireAssetInspection>, WireCommandError> {
    let session_guard = state.lock_session()?;
    let session = require_project(&session_guard)?;
    let mut inspections = state.lock_inspections()?;
    let batch_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut output = Vec::with_capacity(request.source_paths.len());
    for (index, raw_path) in request.source_paths.iter().enumerate() {
        let inspection_id = format!("inspection-{batch_id}-{index}");
        let inspection = match inspect_source(raw_path) {
            Ok(source) => {
                inspections.insert(
                    inspection_id.clone(),
                    InspectedImport {
                        project_root: session.root.clone(),
                        source_path: source.path.clone(),
                        sha256: source.sha256.clone(),
                    },
                );
                WireAssetInspection {
                    inspection_id,
                    source_name: source
                        .path
                        .file_name()
                        .map(|value| value.to_string_lossy().into_owned())
                        .unwrap_or_else(|| raw_path.clone()),
                    detected_format: source.metadata.format.clone(),
                    suggested_kind: inferred_asset_kind(&source.path),
                    size_bytes: WireU64::from(source.size_bytes),
                    reuse_candidates: reuse_candidates(session, &source.sha256),
                    sha256: source.sha256,
                    metadata: source.metadata,
                    diagnostics: Vec::new(),
                }
            }
            Err(diagnostic) => {
                let metadata = empty_asset_metadata("unknown");
                WireAssetInspection {
                    inspection_id,
                    source_name: raw_path.clone(),
                    detected_format: metadata.format.clone(),
                    suggested_kind: None,
                    size_bytes: WireU64::from(0),
                    sha256: String::new(),
                    metadata,
                    reuse_candidates: Vec::new(),
                    diagnostics: vec![diagnostic],
                }
            }
        };
        output.push(inspection);
    }
    // Inspection IDs are short-lived capabilities.  Bound the table so a
    // user repeatedly opening the file picker cannot grow the editor process
    // forever; the oldest IDs naturally expire and the UI can re-inspect.
    let project_root = session.root.clone();
    while inspections
        .values()
        .filter(|item| item.project_root == project_root)
        .count()
        > MAX_PENDING_ASSET_INSPECTIONS
    {
        let Some(oldest) = inspections
            .iter()
            .find(|(_, item)| item.project_root == project_root)
            .map(|(id, _)| id.clone())
        else {
            break;
        };
        inspections.remove(&oldest);
    }
    Ok(output)
}

/// Canonical format family of an inspected media record.  `Png`/`PNG` and
/// `Jpeg`/`JPG` must never disagree when a replacement compares formats.
pub(crate) fn media_format_family(format: &str) -> Option<&'static str> {
    match format.trim().to_ascii_lowercase().as_str() {
        "png" => Some("png"),
        "jpeg" | "jpg" => Some("jpeg"),
        "webp" => Some("webp"),
        "ogg" => Some("ogg"),
        "wav" => Some("wav"),
        "mp3" => Some("mp3"),
        "flac" => Some("flac"),
        "mp4" => Some("mp4"),
        "ttf" => Some("ttf"),
        "otf" => Some("otf"),
        _ => None,
    }
}

pub(crate) fn format_family_from_path(path: &Path) -> Option<&'static str> {
    path.extension()
        .and_then(|value| value.to_str())
        .and_then(media_format_family)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_signature_rejects_renamed_audio_and_accepts_canonical_headers() {
        let directory = tempfile::tempdir().unwrap();
        let wav = directory.path().join("sound.wav");
        fs::write(&wav, b"RIFF0000WAVEfmt ").unwrap();
        assert!(validate_media_signature(&wav, "wav").is_ok());
        assert!(validate_media_signature(&wav, "ogg").is_err());

        let mp4 = directory.path().join("movie.mp4");
        fs::write(&mp4, b"\0\0\0\x18ftypisom").unwrap();
        assert!(validate_media_signature(&mp4, "mp4").is_ok());
        assert!(validate_media_signature(&mp4, "mp3").is_err());
    }
}
