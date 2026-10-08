//! Journaled multi-file saves.
//!
//! A save stages every new file under `.vectspace/tmp/<id>`, backs up every
//! file it will replace under `.vectspace/backups/<id>`, then installs the
//! files one by one while recording progress in `journal.json`.  An
//! interrupted save is finished or rolled back by [`recover_pending_transactions`]
//! the next time the project is opened.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::files::{
    copy_and_hash_streaming, copy_file_streaming, hash_bytes, hash_file, hash_file_streaming,
    safe_relative_path,
};
use crate::model::{DiagnosticSeverity, EditorDiagnostic};

const TRANSACTION_VERSION: u32 = 1;
const RETAINED_BACKUP_GENERATIONS: usize = 10;

fn tmp_dir(root: &Path) -> PathBuf {
    root.join(".vectspace").join("tmp")
}

fn backups_dir(root: &Path) -> PathBuf {
    root.join(".vectspace").join("backups")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TransactionState {
    Prepared,
    Applying,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionFile {
    relative_path: String,
    new_sha256: Option<String>,
    old_sha256: Option<String>,
    existed: bool,
    #[serde(default)]
    delete: bool,
}

impl TransactionFile {
    /// The target still holds what it held before the transaction.
    fn is_original(&self, current_hash: Option<&str>) -> bool {
        match (current_hash, self.existed, &self.old_sha256) {
            (None, false, _) => true,
            (Some(current), true, Some(old)) => current == old,
            _ => false,
        }
    }

    /// The target already holds what the transaction publishes (an absent
    /// target, for a deletion).
    fn is_published(&self, current_hash: Option<&str>) -> bool {
        if self.delete {
            current_hash.is_none()
        } else {
            current_hash == self.new_sha256.as_deref()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TransactionJournal {
    version: u32,
    transaction_id: String,
    state: TransactionState,
    files: Vec<TransactionFile>,
    applied: usize,
}

#[derive(Debug, Default)]
pub(crate) struct AtomicBatchOutcome {
    pub(crate) transaction_id: String,
    pub(crate) warnings: Vec<EditorDiagnostic>,
}

/// Copy `target` into the backup tree and return its digest; `None` when the
/// target does not exist.
fn back_up(target: &Path, backup: &Path) -> Result<Option<String>, std::io::Error> {
    if !target.is_file() {
        return Ok(None);
    }
    if let Some(parent) = backup.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(target, backup)?;
    Ok(Some(hash_file_streaming(target)?))
}

/// Write small serialized documents and large staged binaries through one
/// journal.  Binary sources stay on disk until the transaction stages them, so
/// importing a large video never requires holding the whole batch in memory.
///
/// `expected_source_hashes` closes the gap between validating a staged import
/// and copying it: a user (or antivirus/indexer) can replace a temporary file in
/// between, and comparing the streaming-copy hash with the inspected one fails
/// the transaction before publication.
pub(crate) fn atomic_write_batch(
    root: &Path,
    writes: &[(PathBuf, Vec<u8>)],
    source_writes: &[(PathBuf, PathBuf)],
    expected_source_hashes: &BTreeMap<PathBuf, String>,
    deletes: &[PathBuf],
) -> Result<AtomicBatchOutcome, std::io::Error> {
    if writes.is_empty() && source_writes.is_empty() && deletes.is_empty() {
        return Ok(AtomicBatchOutcome::default());
    }
    let save_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();
    let temporary_root = tmp_dir(root).join(&save_id);
    let backup_root = backups_dir(root).join(&save_id);
    let journal_path = temporary_root.join("journal.json");
    let mut journal = TransactionJournal {
        version: TRANSACTION_VERSION,
        transaction_id: save_id.clone(),
        state: TransactionState::Prepared,
        files: Vec::with_capacity(writes.len() + source_writes.len()),
        applied: 0,
    };
    let operation = (|| -> Result<(), std::io::Error> {
        enum WriteSource<'a> {
            Bytes(&'a [u8]),
            File(&'a Path),
        }
        let mut pending = Vec::with_capacity(writes.len() + source_writes.len());
        pending.extend(
            writes
                .iter()
                .map(|(target, bytes)| (target.as_path(), WriteSource::Bytes(bytes))),
        );
        pending.extend(
            source_writes
                .iter()
                .map(|(target, source)| (target.as_path(), WriteSource::File(source))),
        );
        for (target, source) in pending {
            let relative = checked_project_relative(root, target)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let temporary = temporary_root.join(relative);
            let new_sha256 = match source {
                WriteSource::Bytes(bytes) => {
                    if let Some(parent) = temporary.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    let mut file = File::create(&temporary)?;
                    file.write_all(bytes)?;
                    file.sync_all()?;
                    hash_bytes(bytes)
                }
                WriteSource::File(source) => {
                    let hash = copy_and_hash_streaming(source, &temporary)?;
                    if let Some(expected) = expected_source_hashes.get(source) {
                        if expected != &hash {
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                format!("暂存素材在保存期间发生变化: {}", source.display()),
                            ));
                        }
                    }
                    hash
                }
            };
            let old_sha256 = back_up(target, &backup_root.join(relative))?;
            journal.files.push(TransactionFile {
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                new_sha256: Some(new_sha256),
                existed: old_sha256.is_some(),
                old_sha256,
                delete: false,
            });
        }
        for target in deletes {
            let relative = checked_project_relative(root, target)?;
            let old_sha256 = back_up(target, &backup_root.join(relative))?;
            journal.files.push(TransactionFile {
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                new_sha256: None,
                existed: old_sha256.is_some(),
                old_sha256,
                delete: true,
            });
        }
        let mut paths = BTreeSet::new();
        for file in &journal.files {
            if !paths.insert(file.relative_path.clone()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("保存事务包含重复路径: {}", file.relative_path),
                ));
            }
        }
        // The manifest is the commit marker for a content project.  Replace
        // it last so an interrupted save never advertises a document set that
        // has not been fully installed yet.
        journal
            .files
            .sort_by_key(|file| file.relative_path == "manifest.yaml");
        write_transaction_journal(&journal_path, &journal)?;
        journal.state = TransactionState::Applying;
        write_transaction_journal(&journal_path, &journal)?;

        for index in journal.applied..journal.files.len() {
            let item = &journal.files[index];
            let target = project_child(root, &item.relative_path)?;
            let temporary = project_child(&temporary_root, &item.relative_path)?;
            if item.delete {
                if target.exists() {
                    fs::remove_file(&target)?;
                }
            } else {
                replace_file(&temporary, &target)?;
            }
            journal.applied = index + 1;
            write_transaction_journal(&journal_path, &journal)?;
        }
        journal.state = TransactionState::Committed;
        write_transaction_journal(&journal_path, &journal)?;
        Ok(())
    })();

    match operation {
        Ok(()) => {
            // The project is already committed at this point.  Cleanup is
            // best-effort; a later open can remove a committed journal.
            let mut warnings = Vec::new();
            if let Err(error) = fs::remove_dir_all(&temporary_root) {
                warnings.push(cleanup_warning(format!(
                    "保存事务临时目录清理失败（事务 {save_id}）：{error}"
                )));
            }
            if let Err(error) =
                prune_backup_generations(&backups_dir(root), RETAINED_BACKUP_GENERATIONS)
            {
                warnings.push(cleanup_warning(format!(
                    "保存备份清理失败（事务 {save_id}）：{error}"
                )));
            }
            Ok(AtomicBatchOutcome {
                transaction_id: save_id,
                warnings,
            })
        }
        Err(error) => {
            // Before the Applying marker no project target has been touched.
            // Once applying starts, restore every target from its validated
            // backup immediately so a synchronous error is transactional too.
            if matches!(journal.state, TransactionState::Applying) {
                if let Err(rollback) = restore_transaction(root, &backup_root, &journal) {
                    return Err(std::io::Error::new(
                        error.kind(),
                        format!("保存事务 {save_id} 失败: {error}；立即回滚失败: {rollback}"),
                    ));
                }
            }
            if let Err(cleanup) = fs::remove_dir_all(&temporary_root) {
                eprintln!("失败保存的临时目录清理失败: {cleanup}");
            }
            if let Err(cleanup) = fs::remove_dir_all(&backup_root) {
                eprintln!("失败保存的备份清理失败: {cleanup}");
            }
            Err(error)
        }
    }
}

pub(crate) fn cleanup_warning(message: impl Into<String>) -> EditorDiagnostic {
    EditorDiagnostic {
        severity: DiagnosticSeverity::Warning,
        code: "cleanup_warning".to_owned(),
        message: message.into(),
        scene_id: None,
        node_id: None,
    }
}

fn checked_project_relative<'a>(root: &Path, target: &'a Path) -> Result<&'a Path, std::io::Error> {
    let relative = target.strip_prefix(root).map_err(|_| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("保存目标不在项目目录内: {}", target.display()),
        )
    })?;
    let text = relative.to_string_lossy().replace('\\', "/");
    safe_relative_path(&text)
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    Ok(relative)
}

fn project_child(root: &Path, relative: &str) -> Result<PathBuf, std::io::Error> {
    safe_relative_path(relative)
        .map_err(|message| std::io::Error::new(std::io::ErrorKind::InvalidInput, message))?;
    let child = root.join(relative);
    if !child.starts_with(root) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("路径逃逸项目目录: {relative}"),
        ));
    }
    Ok(child)
}

/// Replace a project document without exposing a delete-then-rename gap on
/// Windows.  The non-Windows implementation is kept for cross-platform unit
/// tests; Windows is the supported shipping target and uses the kernel's
/// replace-existing operation with write-through semantics.
#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| std::io::Error::other(error.to_string()))
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), std::io::Error> {
    if target.exists() {
        fs::remove_file(target)?;
    }
    fs::rename(source, target)
}

fn write_transaction_journal(
    path: &Path,
    journal: &TransactionJournal,
) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))?;
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    // Keep the recovery marker itself atomic.  If the process is interrupted
    // while recording progress, the previous complete journal remains
    // readable and recovery can safely resume from it.
    replace_file(&temporary, path)
}

/// Resume or roll back an interrupted editor save before the catalog is
/// opened.  Every journal path is validated before touching the filesystem;
/// no path supplied by a journal can escape its project root.
pub(crate) fn recover_pending_transactions(root: &Path) -> Result<(), std::io::Error> {
    let tmp_root = tmp_dir(root);
    if !tmp_root.is_dir() {
        return Ok(());
    }
    let mut transactions = fs::read_dir(&tmp_root)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .collect::<Vec<_>>();
    transactions.sort_by_key(std::fs::DirEntry::file_name);
    for transaction in transactions {
        let transaction_root = transaction.path();
        let journal_path = transaction_root.join("journal.json");
        if !journal_path.is_file() {
            // An empty temporary directory is never a committed project file;
            // it is safe to remove only this transaction directory.
            fs::remove_dir_all(&transaction_root)?;
            continue;
        }
        let bytes = fs::read(&journal_path)?;
        let journal: TransactionJournal = serde_json::from_slice(&bytes).map_err(|error| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "无法读取保存事务 journal {}: {error}",
                    journal_path.display()
                ),
            )
        })?;
        let directory_name = transaction_root
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if journal.version != TRANSACTION_VERSION
            || journal.transaction_id.is_empty()
            || journal.transaction_id != directory_name
            || !journal
                .transaction_id
                .bytes()
                .all(|character| character.is_ascii_digit())
            || journal.applied > journal.files.len()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("保存事务 journal 无效: {}", journal_path.display()),
            ));
        }
        let backup_root = backups_dir(root).join(&journal.transaction_id);
        // Validate the complete manifest before applying any entry.  This is
        // important when a malformed or hand-edited journal is encountered.
        let mut paths = BTreeSet::new();
        for file in &journal.files {
            if !paths.insert(file.relative_path.clone()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("保存事务包含重复路径: {}", file.relative_path),
                ));
            }
            project_child(root, &file.relative_path)?;
            if !file.delete {
                project_child(&transaction_root, &file.relative_path)?;
            }
            project_child(&backup_root, &file.relative_path)?;
        }
        if matches!(journal.state, TransactionState::Committed) {
            fs::remove_dir_all(&transaction_root)?;
            continue;
        }
        // A transaction may be resumed only while every target is still in
        // one of the states that this journal could have produced: the old
        // bytes or the new bytes (and, for a deletion, an absent target).
        // Treating an unrelated hash as recoverable would overwrite a user's
        // edit made while the application was not running.
        let mut can_finish = true;
        for file in &journal.files {
            let target = project_child(root, &file.relative_path)?;
            let staged = project_child(&transaction_root, &file.relative_path)?;
            let current_hash = hash_file(&target)?;
            let published = file.is_published(current_hash.as_deref());
            if !published && !file.is_original(current_hash.as_deref()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::AlreadyExists,
                    format!(
                        "保存事务检测到外部修改，无法安全恢复: {} (事务 {})",
                        file.relative_path, journal.transaction_id
                    ),
                ));
            }
            if !published && !staged.is_file() {
                can_finish = false;
            }
        }
        if can_finish {
            for file in &journal.files {
                let target = project_child(root, &file.relative_path)?;
                let staged = project_child(&transaction_root, &file.relative_path)?;
                let current_hash = hash_file(&target)?;
                if file.delete {
                    if current_hash.is_some() {
                        fs::remove_file(target)?;
                    }
                    continue;
                }
                if current_hash.as_deref() == file.new_sha256.as_deref() {
                    continue;
                }
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                replace_file(&staged, &target)?;
            }
        } else {
            // A missing staged file means we cannot safely finish the new
            // version.  Roll back only after the state check above proved no
            // target contains an unrelated external version.
            restore_transaction(root, &backup_root, &journal)?;
        }
        fs::remove_dir_all(&transaction_root)?;
    }
    Ok(())
}

fn restore_transaction(
    root: &Path,
    backup_root: &Path,
    journal: &TransactionJournal,
) -> Result<(), std::io::Error> {
    // A synchronous write error is not proof that the target still contains
    // the bytes this transaction expected.  Check every target before
    // deleting/replacing anything so an external edit made concurrently with
    // the save is never mistaken for a partially applied transaction.
    for file in &journal.files {
        let target = project_child(root, &file.relative_path)?;
        let current_hash = hash_file(&target)?;
        if !file.is_original(current_hash.as_deref()) && !file.is_published(current_hash.as_deref())
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("保存事务检测到外部修改，拒绝回滚 {}", file.relative_path),
            ));
        }
    }
    for file in &journal.files {
        let target = project_child(root, &file.relative_path)?;
        let backup = project_child(backup_root, &file.relative_path)?;
        if file.existed {
            let backup_hash = hash_file_streaming(&backup).map_err(|error| {
                std::io::Error::new(
                    error.kind(),
                    format!("保存事务无法从备份恢复 {}: {error}", file.relative_path),
                )
            })?;
            if file.old_sha256.as_deref() != Some(backup_hash.as_str()) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("保存事务备份校验失败: {}", file.relative_path),
                ));
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            // Copy the validated backup to a sibling temporary first, then
            // replace the target atomically.  A crash during rollback leaves
            // the journal and original backup intact for the next recovery
            // attempt instead of exposing a partially copied YAML file.
            let temporary = backup.with_extension("restore.tmp");
            copy_file_streaming(&backup, &temporary)?;
            replace_file(&temporary, &target)?;
        } else if target.exists() {
            fs::remove_file(target)?;
        }
    }
    Ok(())
}

fn prune_backup_generations(root: &Path, retain: usize) -> Result<(), std::io::Error> {
    if !root.exists() {
        return Ok(());
    }
    let mut generations = fs::read_dir(root)?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .collect::<Vec<_>>();
    generations.sort_by_key(std::fs::DirEntry::file_name);
    let remove_count = generations.len().saturating_sub(retain);
    for generation in generations.into_iter().take(remove_count) {
        fs::remove_dir_all(generation.path())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::write_batch;

    #[test]
    fn batch_writer_keeps_backups_and_replaces_all_files() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.yaml");
        let second = directory.path().join("nested/second.yaml");
        fs::write(&first, b"old").unwrap();
        write_batch(
            directory.path(),
            &[
                (first.clone(), b"new first".to_vec()),
                (second.clone(), b"new second".to_vec()),
            ],
            &[],
        );
        assert_eq!(fs::read(&first).unwrap(), b"new first");
        assert_eq!(fs::read(&second).unwrap(), b"new second");
        let backups = directory.path().join(".vectspace/backups");
        let generation = fs::read_dir(backups).unwrap().next().unwrap().unwrap();
        assert_eq!(
            fs::read(generation.path().join("first.yaml")).unwrap(),
            b"old"
        );
    }

    #[test]
    fn batch_writer_streams_sources_and_rejects_one_changed_after_inspection() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let source = root.join("staged/video.mp4");
        let target = root.join("assets/video.mp4");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"staged media bytes").unwrap();

        let rejected = atomic_write_batch(
            root,
            &[],
            &[(target.clone(), source.clone())],
            &BTreeMap::from([(source.clone(), hash_bytes(b"inspected bytes"))]),
            &[],
        )
        .unwrap_err();
        assert_eq!(rejected.kind(), std::io::ErrorKind::InvalidData);
        assert!(rejected.to_string().contains("暂存素材在保存期间发生变化"));
        assert!(!target.exists(), "a mismatched source must never publish");

        atomic_write_batch(
            root,
            &[(root.join("manifest.yaml"), b"assets: video\n".to_vec())],
            &[(target.clone(), source.clone())],
            &BTreeMap::from([(source.clone(), hash_bytes(b"staged media bytes"))]),
            &[],
        )
        .unwrap();
        assert_eq!(fs::read(target).unwrap(), b"staged media bytes");
        assert!(
            source.is_file(),
            "the import staging file is cleaned by the caller"
        );
    }

    /// Lay out an interrupted `scene.yaml` transaction (old -> new) and return
    /// its temporary directory.  The target currently holds `current`; the
    /// staged `new` bytes exist only when `staged` is set.
    fn interrupted_transaction(root: &Path, id: &str, current: &[u8], staged: bool) -> PathBuf {
        let transaction_root = root.join(".vectspace/tmp").join(id);
        let backup_root = root.join(".vectspace/backups").join(id);
        fs::create_dir_all(&transaction_root).unwrap();
        fs::create_dir_all(&backup_root).unwrap();
        fs::write(root.join("scene.yaml"), current).unwrap();
        fs::write(backup_root.join("scene.yaml"), b"old").unwrap();
        if staged {
            fs::write(transaction_root.join("scene.yaml"), b"new").unwrap();
        }
        let journal = TransactionJournal {
            version: TRANSACTION_VERSION,
            transaction_id: id.to_owned(),
            state: TransactionState::Applying,
            files: vec![TransactionFile {
                relative_path: "scene.yaml".to_owned(),
                new_sha256: Some(hash_bytes(b"new")),
                old_sha256: Some(hash_bytes(b"old")),
                existed: true,
                delete: false,
            }],
            applied: 0,
        };
        write_transaction_journal(&transaction_root.join("journal.json"), &journal).unwrap();
        transaction_root
    }

    #[test]
    fn recovery_finishes_a_transaction_when_staged_files_are_available() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let transaction_root = interrupted_transaction(root, "123", b"old", true);

        recover_pending_transactions(root).unwrap();

        assert_eq!(fs::read(root.join("scene.yaml")).unwrap(), b"new");
        assert!(!transaction_root.exists());
    }

    #[test]
    fn recovery_restores_the_old_version_when_staged_file_is_missing() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let transaction_root = interrupted_transaction(root, "456", b"old", false);

        recover_pending_transactions(root).unwrap();

        assert_eq!(fs::read(root.join("scene.yaml")).unwrap(), b"old");
        assert!(!transaction_root.exists());
    }

    #[test]
    fn recovery_stops_on_an_external_target_conflict() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let transaction_root = interrupted_transaction(root, "457", b"external", false);

        let error = recover_pending_transactions(root).unwrap_err();

        assert!(error.to_string().contains("外部修改"));
        assert_eq!(fs::read(root.join("scene.yaml")).unwrap(), b"external");
        assert!(transaction_root.exists());
    }

    #[test]
    fn recovery_rejects_path_traversal_before_mutating_files() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let transaction_root = root.join(".vectspace/tmp/789");
        fs::create_dir_all(&transaction_root).unwrap();
        let journal = TransactionJournal {
            version: TRANSACTION_VERSION,
            transaction_id: "789".to_owned(),
            state: TransactionState::Applying,
            files: vec![TransactionFile {
                relative_path: "../outside.yaml".to_owned(),
                new_sha256: Some(hash_bytes(b"bad")),
                old_sha256: None,
                existed: false,
                delete: false,
            }],
            applied: 0,
        };
        write_transaction_journal(&transaction_root.join("journal.json"), &journal).unwrap();

        assert!(recover_pending_transactions(root).is_err());
        assert!(transaction_root.exists());
    }
}
