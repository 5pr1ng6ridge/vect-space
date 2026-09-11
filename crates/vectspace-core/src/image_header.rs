//! Dependency-free probing of raster image pixel dimensions.
//!
//! The content model has to know the real size of every animation frame: one
//! animation may only contain frames that share a pixel size, and the decode
//! memory budget is computed from those sizes.  A full decoder (`image` crate)
//! would pull a heavy codec dependency into the Tauri-independent core, so the
//! core instead reads the header of the four raster formats the project can
//! register for images: PNG, JPEG, GIF and WebP.
//!
//! The editor's import stage still performs a full decode through the `image`
//! crate before a file is accepted; this module is the cheaper authoritative
//! check that also covers hand-written or externally generated animation
//! documents, which never pass through an import.

use std::fmt;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Pixel dimensions declared by an image header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageSize {
    pub width: u32,
    pub height: u32,
}

impl ImageSize {
    /// Decoded RGBA footprint of one image, used for the animation memory
    /// budget.  The value saturates so a hostile header can never overflow.
    pub fn decoded_bytes(self) -> u64 {
        u64::from(self.width)
            .saturating_mul(u64::from(self.height))
            .saturating_mul(4)
    }
}

#[derive(Debug)]
pub enum ImageHeaderError {
    /// The file could not be opened, read or seeked.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The signature did not match a supported raster format.
    Unsupported { path: PathBuf },
    /// The signature matched but its dimensions could not be read.
    Malformed { path: PathBuf, detail: &'static str },
}

impl fmt::Display for ImageHeaderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => {
                write!(f, "无法读取图片 {}：{source}", path.display())
            }
            Self::Unsupported { path } => write!(
                f,
                "无法识别图片格式 {}：仅支持 PNG、JPEG、GIF 和 WebP",
                path.display()
            ),
            Self::Malformed { path, detail } => {
                write!(f, "图片头部损坏 {}：{detail}", path.display())
            }
        }
    }
}

impl std::error::Error for ImageHeaderError {}

const HEADER_BYTES: usize = 32;
const JPEG_SCAN_LIMIT: u64 = 4 * 1024 * 1024;

/// Reads the declared pixel size of `path` without decoding pixel data.
pub fn probe(path: &Path) -> Result<ImageSize, ImageHeaderError> {
    let mut reader = BufReader::new(File::open(path).map_err(|source| ImageHeaderError::Io {
        path: path.to_path_buf(),
        source,
    })?);
    let mut header = [0_u8; HEADER_BYTES];
    let read = read_up_to(&mut reader, &mut header).map_err(|source| ImageHeaderError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let header = &header[..read];
    if header.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return png_size(header).ok_or_else(|| ImageHeaderError::Malformed {
            path: path.to_path_buf(),
            detail: "缺少可用的 IHDR 尺寸",
        });
    }
    if header.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return jpeg_size(&mut reader, path);
    }
    if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        return gif_size(header).ok_or_else(|| ImageHeaderError::Malformed {
            path: path.to_path_buf(),
            detail: "缺少逻辑屏幕描述符",
        });
    }
    if header.len() >= 16 && &header[0..4] == b"RIFF" && &header[8..12] == b"WEBP" {
        return webp_size(&mut reader, header, path);
    }
    Err(ImageHeaderError::Unsupported {
        path: path.to_path_buf(),
    })
}

/// Fills `buffer` from `reader`, tolerating files shorter than the buffer.
fn read_up_to<R: Read>(reader: &mut R, buffer: &mut [u8]) -> std::io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(filled)
}

fn be_u32(bytes: &[u8]) -> Option<u32> {
    let slice = bytes.get(0..4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn le_u16(bytes: &[u8]) -> Option<u32> {
    let slice = bytes.get(0..2)?;
    Some(u32::from(u16::from_le_bytes([slice[0], slice[1]])))
}

fn le_u24(bytes: &[u8]) -> Option<u32> {
    let slice = bytes.get(0..3)?;
    Some(u32::from(slice[0]) | (u32::from(slice[1]) << 8) | (u32::from(slice[2]) << 16))
}

/// PNG: the IHDR chunk always starts at byte 8, so its dimensions live at
/// offsets 16 (width) and 20 (height) in big-endian order.
fn png_size(header: &[u8]) -> Option<ImageSize> {
    if header.get(12..16)? != b"IHDR" {
        return None;
    }
    let width = be_u32(header.get(16..)?)?;
    let height = be_u32(header.get(20..)?)?;
    nonzero(width, height)
}

/// GIF: the logical screen descriptor follows the 6-byte signature and stores
/// little-endian dimensions.
fn gif_size(header: &[u8]) -> Option<ImageSize> {
    let width = le_u16(header.get(6..)?)?;
    let height = le_u16(header.get(8..)?)?;
    nonzero(width, height)
}

fn nonzero(width: u32, height: u32) -> Option<ImageSize> {
    if width == 0 || height == 0 {
        return None;
    }
    Some(ImageSize { width, height })
}

/// JPEG: walk the marker segments until a start-of-frame carries the size.
/// Marker payloads are skipped by length, so only the header region is read.
fn jpeg_size<R: Read + Seek>(reader: &mut R, path: &Path) -> Result<ImageSize, ImageHeaderError> {
    let malformed = |detail: &'static str| ImageHeaderError::Malformed {
        path: path.to_path_buf(),
        detail,
    };
    reader
        .seek(SeekFrom::Start(2))
        .map_err(|source| ImageHeaderError::Io {
            path: path.to_path_buf(),
            source,
        })?;
    let mut scanned = 2_u64;
    let mut marker = [0_u8; 2];
    let mut length_bytes = [0_u8; 2];
    while scanned < JPEG_SCAN_LIMIT {
        if read_up_to(reader, &mut marker).map_err(|source| ImageHeaderError::Io {
            path: path.to_path_buf(),
            source,
        })? < 2
        {
            return Err(malformed("帧标记在尺寸出现前结束"));
        }
        scanned += 2;
        // Padding bytes between segments are legal; resynchronize on 0xFF.
        if marker[0] != 0xFF {
            reader
                .seek(SeekFrom::Current(-1))
                .map_err(|source| ImageHeaderError::Io {
                    path: path.to_path_buf(),
                    source,
                })?;
            scanned -= 1;
            continue;
        }
        let code = marker[1];
        // Standalone markers carry no payload.
        if code == 0x01 || (0xD0..=0xD9).contains(&code) {
            if code == 0xD9 {
                return Err(malformed("在文件结束时仍未找到帧尺寸"));
            }
            continue;
        }
        if read_up_to(reader, &mut length_bytes).map_err(|source| ImageHeaderError::Io {
            path: path.to_path_buf(),
            source,
        })? < 2
        {
            return Err(malformed("段长度被截断"));
        }
        scanned += 2;
        let length = u64::from(u16::from_be_bytes(length_bytes));
        if length < 2 {
            return Err(malformed("段长度非法"));
        }
        let payload = length - 2;
        // SOF0..SOF15 except DHT (0xC4), JPG (0xC8) and DAC (0xCC).
        let is_frame = matches!(code, 0xC0..=0xCF) && !matches!(code, 0xC4 | 0xC8 | 0xCC);
        if is_frame {
            let mut frame = [0_u8; 5];
            if read_up_to(reader, &mut frame).map_err(|source| ImageHeaderError::Io {
                path: path.to_path_buf(),
                source,
            })? < 5
            {
                return Err(malformed("帧头被截断"));
            }
            let height = u32::from(u16::from_be_bytes([frame[1], frame[2]]));
            let width = u32::from(u16::from_be_bytes([frame[3], frame[4]]));
            return nonzero(width, height).ok_or_else(|| malformed("帧尺寸为零"));
        }
        reader
            .seek(SeekFrom::Current(payload as i64))
            .map_err(|source| ImageHeaderError::Io {
                path: path.to_path_buf(),
                source,
            })?;
        scanned += payload;
    }
    Err(malformed("在限定范围内未找到帧尺寸"))
}

/// WebP: three container flavours declare the canvas size differently.
fn webp_size<R: Read + Seek>(
    reader: &mut R,
    header: &[u8],
    path: &Path,
) -> Result<ImageSize, ImageHeaderError> {
    let malformed = |detail: &'static str| ImageHeaderError::Malformed {
        path: path.to_path_buf(),
        detail,
    };
    let chunk = header
        .get(12..16)
        .ok_or_else(|| malformed("WebP 分块头被截断"))?;
    let io = |source: std::io::Error| ImageHeaderError::Io {
        path: path.to_path_buf(),
        source,
    };
    match chunk {
        b"VP8X" => {
            reader.seek(SeekFrom::Start(20)).map_err(io)?;
            let mut payload = [0_u8; 10];
            if read_up_to(reader, &mut payload).map_err(io)? < 10 {
                return Err(malformed("VP8X 头被截断"));
            }
            let width = le_u24(&payload[4..]).ok_or_else(|| malformed("VP8X 宽度缺失"))? + 1;
            let height = le_u24(&payload[7..]).ok_or_else(|| malformed("VP8X 高度缺失"))? + 1;
            nonzero(width, height).ok_or_else(|| malformed("VP8X 尺寸为零"))
        }
        b"VP8 " => {
            reader.seek(SeekFrom::Start(20)).map_err(io)?;
            let mut payload = [0_u8; 10];
            if read_up_to(reader, &mut payload).map_err(io)? < 10 {
                return Err(malformed("VP8 头被截断"));
            }
            if payload[3..6] != [0x9D, 0x01, 0x2A] {
                return Err(malformed("VP8 起始码缺失"));
            }
            let width = le_u16(&payload[6..]).ok_or_else(|| malformed("VP8 宽度缺失"))? & 0x3FFF;
            let height = le_u16(&payload[8..]).ok_or_else(|| malformed("VP8 高度缺失"))? & 0x3FFF;
            nonzero(width, height).ok_or_else(|| malformed("VP8 尺寸为零"))
        }
        b"VP8L" => {
            reader.seek(SeekFrom::Start(20)).map_err(io)?;
            let mut payload = [0_u8; 5];
            if read_up_to(reader, &mut payload).map_err(io)? < 5 {
                return Err(malformed("VP8L 头被截断"));
            }
            if payload[0] != 0x2F {
                return Err(malformed("VP8L 签名缺失"));
            }
            // 14 bits of (width - 1) followed by 14 bits of (height - 1),
            // least significant bit first.
            let bits = u32::from(payload[1])
                | (u32::from(payload[2]) << 8)
                | (u32::from(payload[3]) << 16)
                | (u32::from(payload[4]) << 24);
            let width = (bits & 0x3FFF) + 1;
            let height = ((bits >> 14) & 0x3FFF) + 1;
            nonzero(width, height).ok_or_else(|| malformed("VP8L 尺寸为零"))
        }
        _ => Err(malformed("未知的 WebP 分块类型")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_fixture(name: &str, bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(name);
        let mut file = File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        (directory, path)
    }

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&13_u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    fn gif_header(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = b"GIF89a".to_vec();
        bytes.extend_from_slice(&width.to_le_bytes());
        bytes.extend_from_slice(&height.to_le_bytes());
        bytes
    }

    fn webp_vp8x(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(b"VP8X");
        bytes.extend_from_slice(&10_u32.to_le_bytes());
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        let w = (width - 1).to_le_bytes();
        let h = (height - 1).to_le_bytes();
        bytes.extend_from_slice(&w[..3]);
        bytes.extend_from_slice(&h[..3]);
        bytes
    }

    /// Minimal JPEG: SOI, one APP0 segment, then an SOF0 frame header.
    fn jpeg_header(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        bytes.extend_from_slice(b"JFIF\0");
        bytes.extend(std::iter::repeat_n(0_u8, 9));
        bytes.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
        bytes
    }

    #[test]
    fn png_gif_and_webp_dimensions_are_read() {
        let (_a, png) = write_fixture("a.png", &png_header(1920, 1080));
        assert_eq!(
            probe(&png).unwrap(),
            ImageSize {
                width: 1920,
                height: 1080
            }
        );
        let (_b, gif) = write_fixture("b.gif", &gif_header(64, 32));
        assert_eq!(
            probe(&gif).unwrap(),
            ImageSize {
                width: 64,
                height: 32
            }
        );
        let (_c, webp) = write_fixture("c.webp", &webp_vp8x(300, 200));
        assert_eq!(
            probe(&webp).unwrap(),
            ImageSize {
                width: 300,
                height: 200
            }
        );
    }

    #[test]
    fn jpeg_dimensions_are_read_past_app_segments() {
        let (_directory, path) = write_fixture("frame.jpg", &jpeg_header(1280, 720));
        assert_eq!(
            probe(&path).unwrap(),
            ImageSize {
                width: 1280,
                height: 720
            }
        );
    }

    #[test]
    fn unsupported_and_malformed_headers_report_the_path() {
        let (_directory, path) = write_fixture("frame.txt", b"not an image at all");
        let error = probe(&path).unwrap_err();
        assert!(matches!(error, ImageHeaderError::Unsupported { .. }));
        assert!(error.to_string().contains("frame.txt"));

        let (_other, truncated) = write_fixture(
            "frame.png",
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13],
        );
        let error = probe(&truncated).unwrap_err();
        assert!(matches!(error, ImageHeaderError::Malformed { .. }));
        assert!(error.to_string().contains("frame.png"));
    }

    /// Real, non-synthetic sanity check.  Binary assets are Git LFS tracked,
    /// so a checkout without `git lfs pull` only has pointer text: the test
    /// then verifies the pointer is reported as unusable instead of asserting
    /// a size nobody can read.
    #[test]
    fn real_project_assets_expose_their_real_size() {
        let repository = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for (relative, expected) in [
            ("src-tauri/icons/128x128.png", Some((128, 128))),
            ("src-tauri/icons/32x32.png", Some((32, 32))),
            ("game/assets/backgrounds/Celeste_4B5yjmVqS4.png", None),
            ("game/assets/sprites/jelly.png", None),
        ] {
            let path = repository.join(relative);
            if !path.is_file() {
                continue;
            }
            match probe(&path) {
                Ok(size) => {
                    assert!(size.width > 0 && size.height > 0, "{relative}");
                    assert!(size.decoded_bytes() >= 4, "{relative}");
                    if let Some((width, height)) = expected {
                        assert_eq!((size.width, size.height), (width, height), "{relative}");
                    }
                }
                Err(error) => assert!(
                    is_lfs_pointer(&path),
                    "{relative} 不是 LFS 指针却无法解析：{error}"
                ),
            }
        }
    }

    /// `reject_git_lfs_pointer` owns the taxonomy for unresolved LFS assets;
    /// this helper only keeps the test above from inventing a second one.
    fn is_lfs_pointer(path: &Path) -> bool {
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(_) => return false,
        };
        let mut header = [0_u8; 128];
        let read = file.read(&mut header).unwrap_or(0);
        header[..read].starts_with(b"version https://git-lfs.github.com/spec/v1")
    }
}
