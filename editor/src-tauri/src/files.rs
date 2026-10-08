//! File hashing, streaming copies and project-relative path rules.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

const HASH_IO_BUFFER_SIZE: usize = 1024 * 1024;

pub(crate) fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Hash a source without loading a complete video/audio file into memory.
pub(crate) fn hash_file_streaming(path: &Path) -> Result<String, std::io::Error> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    // Keep the sizeable I/O buffer off the caller's stack.  `open_project`
    // runs on Tauri's command thread, whose stack is only 1 MiB on Windows.
    let mut buffer = vec![0_u8; HASH_IO_BUFFER_SIZE];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Like [`hash_file_streaming`], with `None` for a file that does not exist.
pub(crate) fn hash_file(path: &Path) -> Result<Option<String>, std::io::Error> {
    match hash_file_streaming(path) {
        Ok(hash) => Ok(Some(hash)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Copy a file in bounded chunks and return the SHA-256 of the copied bytes.
pub(crate) fn copy_and_hash_streaming(
    source: &Path,
    destination: &Path,
) -> Result<String, std::io::Error> {
    let mut input = File::open(source)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut output = File::create(destination)?;
    let mut hasher = Sha256::new();
    // Keep the sizeable I/O buffer off the caller's stack.  This function is
    // also used by save transactions that may run on a normal command thread.
    let mut buffer = vec![0_u8; HASH_IO_BUFFER_SIZE];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        hasher.update(&buffer[..read]);
    }
    output.sync_all()?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn copy_file_streaming(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    copy_and_hash_streaming(source, destination).map(|_| ())
}

/// Reject anything that is not a plain path inside the project directory.
pub(crate) fn safe_relative_path(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("只允许项目目录内的相对路径: {value}"));
    }
    Ok(())
}

/// Windows asset paths are case-insensitive.  Keep the reservation check
/// deterministic on the development hosts too, so importing `A.PNG` after
/// `a.png` cannot create two manifest entries that resolve to one file when
/// the project is later opened on Windows.
pub(crate) fn path_reservation_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

pub(crate) fn path_exists_case_insensitive(
    root: &Path,
    relative: &str,
) -> Result<bool, std::io::Error> {
    match resolve_case_insensitive(root, relative) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

pub(crate) fn resolve_case_insensitive(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, std::io::Error> {
    let not_found = || {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("素材路径不存在: {relative}"),
        )
    };
    let mut current = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(name) = component else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("非法素材相对路径: {relative}"),
            ));
        };
        if !current.is_dir() {
            return Err(not_found());
        }
        let wanted = name.to_string_lossy().to_lowercase();
        let mut matching = None;
        for entry in fs::read_dir(&current)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().to_lowercase() == wanted {
                matching = Some(entry.path());
                break;
            }
        }
        current = matching.ok_or_else(not_found)?;
    }
    if current.exists() {
        Ok(current)
    } else {
        Err(not_found())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_reservations_are_case_insensitive() {
        let directory = tempfile::tempdir().unwrap();
        let assets = directory.path().join("assets");
        fs::create_dir_all(assets.join("backgrounds")).unwrap();
        fs::write(assets.join("backgrounds/Classroom.PNG"), b"asset").unwrap();

        assert!(path_exists_case_insensitive(&assets, "backgrounds/classroom.png").unwrap());
        assert_eq!(
            path_reservation_key("backgrounds\\Classroom.PNG"),
            "backgrounds/classroom.png"
        );
    }
}
