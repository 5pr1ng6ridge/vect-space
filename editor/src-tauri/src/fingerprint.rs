//! Project fingerprint: a digest of every managed document and asset on disk,
//! used to refuse a save when the project changed outside the editor.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use vectspace_core::model::ContentManifest;

use crate::documents::manifest_document_paths;
use crate::files::hash_file_streaming;
use crate::layout::LAYOUT_RELATIVE_PATH;

pub(crate) fn project_fingerprint(
    root: &Path,
    manifest: &ContentManifest,
) -> Result<String, std::io::Error> {
    project_fingerprint_cached(root, manifest, &mut BTreeMap::new())
}

/// Fingerprint the current on-disk project, memoizing every resolved-path hash
/// in `cache`.  A save computes the staleness fingerprint first and the
/// post-serialization fingerprint second over the same tree; sharing the cache
/// lets the second pass reuse the first pass's file reads.
///
/// The first pass's hashes are the save's snapshot: once a present path is
/// memoized, the second pass reports those pre-save bytes even if the file is
/// externally edited or deleted in between.  That is deliberate.  An external
/// edit/delete that lands after the staleness check is therefore not absorbed
/// into the fingerprint published by this save; it leaves the on-disk tree
/// diverged from `session.fingerprint`, so the *next* save's fresh staleness
/// pass detects it and fails closed with `StaleProject` rather than overwriting
/// the external change.  Only missing paths are left uncached (see
/// `append_expected_or_disk_hash`).
pub(crate) fn project_fingerprint_cached(
    root: &Path,
    manifest: &ContentManifest,
    cache: &mut BTreeMap<PathBuf, String>,
) -> Result<String, std::io::Error> {
    project_fingerprint_with_hashes(root, manifest, &BTreeMap::new(), cache)
}

/// Compute the fingerprint while optionally substituting hashes for files that
/// are about to be published.  Save requests use this before the journal is
/// applied, so no fallible read is needed after the transaction commits.
///
/// `expected_hashes` always wins over `cache`: those bytes are about to be
/// written, so a hash memoized from the pre-save tree would be stale.
pub(crate) fn project_fingerprint_with_hashes(
    root: &Path,
    manifest: &ContentManifest,
    expected_hashes: &BTreeMap<PathBuf, String>,
    cache: &mut BTreeMap<PathBuf, String>,
) -> Result<String, std::io::Error> {
    let mut hasher = Sha256::new();
    let documents = std::iter::once(root.join("manifest.yaml"))
        .chain(manifest_document_paths(manifest).map(|path| root.join(path)))
        .chain(std::iter::once(root.join(LAYOUT_RELATIVE_PATH)));
    // Asset bytes are part of the project fingerprint too.  A changed image,
    // font or audio file must make a stale editor session fail closed instead
    // of silently overwriting the user's external change.  Sort by logical
    // asset ID for deterministic fingerprints and hash in bounded chunks.
    let mut assets = manifest
        .assets
        .iter()
        .filter_map(|(id, asset)| {
            // Animated assets carry no static file of their own; their frame
            // list lives in an animation document that is hashed above.
            asset
                .path
                .as_ref()
                .map(|relative| (id, root.join("assets").join(relative)))
        })
        .collect::<Vec<_>>();
    assets.sort_by(|left, right| left.0.cmp(right.0));
    for (id, path) in assets {
        hasher.update(b"asset:");
        hasher.update(id.as_bytes());
        hasher.update(b"\0");
        hasher.update(path.to_string_lossy().as_bytes());
        append_expected_or_disk_hash(&mut hasher, &path, expected_hashes, cache)?;
    }
    for path in documents {
        hasher.update(path.to_string_lossy().as_bytes());
        append_expected_or_disk_hash(&mut hasher, &path, expected_hashes, cache)?;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn append_expected_or_disk_hash(
    hasher: &mut Sha256,
    path: &Path,
    expected_hashes: &BTreeMap<PathBuf, String>,
    cache: &mut BTreeMap<PathBuf, String>,
) -> Result<(), std::io::Error> {
    // Bytes that are about to be published take precedence over a hash that was
    // memoized during the pre-save staleness pass.
    if let Some(hash) = expected_hashes.get(path) {
        hasher.update(hash.as_bytes());
        return Ok(());
    }
    if let Some(hash) = cache.get(path) {
        hasher.update(hash.as_bytes());
        return Ok(());
    }
    match hash_file_streaming(path) {
        Ok(hash) => {
            hasher.update(hash.as_bytes());
            // Successful first-pass hashes are the save's snapshot: memoizing
            // them reuses the pre-save bytes on the second pass even if the
            // file is edited or deleted in between.  Only missing paths stay
            // uncached, so a path that appears between passes is still observed
            // instead of being pinned to the first pass's `<missing>` value.
            cache.insert(path.to_path_buf(), hash);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => hasher.update(b"<missing>"),
        Err(error) => return Err(error),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::files::hash_bytes;
    use crate::test_support::minimal_manifest;

    /// The minimal manifest's tree with placeholder bytes: one scene, one
    /// asset, no layout file.
    fn seed_project(root: &Path) -> ContentManifest {
        fs::create_dir_all(root.join("assets/backgrounds")).unwrap();
        fs::create_dir_all(root.join("scenes")).unwrap();
        fs::write(root.join("manifest.yaml"), b"manifest").unwrap();
        fs::write(root.join("scenes/main.yaml"), b"scene").unwrap();
        fs::write(root.join("assets/backgrounds/room.png"), b"png bytes one").unwrap();
        minimal_manifest()
    }

    #[test]
    fn cache_keeps_present_paths_as_the_save_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let manifest = seed_project(root);
        let scene = root.join("scenes/main.yaml");
        let asset = root.join("assets/backgrounds/room.png");

        let mut cache = BTreeMap::new();
        let first = project_fingerprint_cached(root, &manifest, &mut cache).unwrap();
        assert!(cache.contains_key(&scene) && cache.contains_key(&asset));

        // The second pass reuses the memoized hashes: neither an edit nor a
        // delete after the staleness pass is absorbed into this save's
        // fingerprint.
        fs::write(&scene, b"scene edited").unwrap();
        fs::write(&asset, b"png bytes two").unwrap();
        let edited =
            project_fingerprint_with_hashes(root, &manifest, &BTreeMap::new(), &mut cache).unwrap();
        assert_eq!(first, edited);
        fs::remove_file(&scene).unwrap();
        let deleted =
            project_fingerprint_with_hashes(root, &manifest, &BTreeMap::new(), &mut cache).unwrap();
        assert_eq!(first, deleted);

        // The change is deferred, not lost: a fresh pass sees it and the next
        // save fails closed on the mismatch.
        assert_ne!(first, project_fingerprint(root, &manifest).unwrap());
    }

    #[test]
    fn expected_hashes_override_cached_disk_hashes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let manifest = seed_project(root);

        let mut cache = BTreeMap::new();
        let first = project_fingerprint_cached(root, &manifest, &mut cache).unwrap();
        fs::write(root.join("scenes/main.yaml"), b"externally edited").unwrap();

        // Bytes that are about to be published win over the stale cached hash,
        // matching a fingerprint computed with no cache at all.
        let expected = BTreeMap::from([(
            root.join("scenes/main.yaml"),
            hash_bytes(b"staged scene bytes"),
        )]);
        let with_expected =
            project_fingerprint_with_hashes(root, &manifest, &expected, &mut cache).unwrap();
        let reference =
            project_fingerprint_with_hashes(root, &manifest, &expected, &mut BTreeMap::new())
                .unwrap();
        assert_ne!(first, with_expected);
        assert_eq!(with_expected, reference);
    }

    #[test]
    fn cache_does_not_memoize_missing_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let manifest = seed_project(root);
        let scene = root.join("scenes/main.yaml");
        fs::remove_file(&scene).unwrap();

        let mut cache = BTreeMap::new();
        let first = project_fingerprint_cached(root, &manifest, &mut cache).unwrap();
        assert!(
            !cache.contains_key(&scene),
            "a missing path must not be memoized"
        );

        // A path that appears before the second pass is observed instead of
        // being pinned to the first pass's `<missing>` value.
        fs::write(&scene, b"scene appeared").unwrap();
        let second =
            project_fingerprint_with_hashes(root, &manifest, &BTreeMap::new(), &mut cache).unwrap();
        assert_ne!(first, second);
        assert_eq!(second, project_fingerprint(root, &manifest).unwrap());
    }
}
