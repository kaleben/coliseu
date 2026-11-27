use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use crate::config::{home, Group};

const LIMIT: usize = 2000;
const SKIP: &[&str] = &[".git", ".DS_Store"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub dir: bool,
}

fn expand(p: &str) -> PathBuf {
    match p.strip_prefix('~') {
        Some(rest) => home().join(rest.trim_start_matches('/')),
        None => PathBuf::from(p),
    }
}

pub fn inside_groups(groups: &[Group], path: &str) -> Result<PathBuf, String> {
    let target = expand(path).canonicalize().map_err(|e| format!("{path}: {e}"))?;
    let inside = groups
        .iter()
        .flat_map(|g| &g.folders)
        .filter_map(|f| expand(f).canonicalize().ok())
        .any(|root| target.starts_with(&root));
    if inside { Ok(target) } else { Err("fora das pastas adicionadas aos grupos".into()) }
}

pub fn list(groups: &[Group], path: &str) -> Result<Vec<Entry>, String> {
    let dir = inside_groups(groups, path)?;
    let mut out: Vec<Entry> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if SKIP.contains(&name.as_str()) {
                return None;
            }
            let p = e.path();
            Some(Entry { dir: p.is_dir(), path: p.to_string_lossy().into_owned(), name })
        })
        .take(LIMIT)
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

const READ_LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub text: String,
    pub size: u64,
    pub binary: bool,
    pub truncated: bool,
    pub mtime: u64,
}

fn mtime(p: &Path) -> u64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn read(groups: &[Group], path: &str) -> Result<FileContent, String> {
    use std::io::Read;
    let p = inside_groups(groups, path)?;
    let size = fs::metadata(&p).map_err(|e| e.to_string())?.len();
    let mut buf = Vec::new();
    fs::File::open(&p)
        .map_err(|e| e.to_string())?
        .take(READ_LIMIT)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    let binary = buf.iter().take(8192).any(|b| *b == 0);
    Ok(FileContent {
        path: p.to_string_lossy().into_owned(),
        text: if binary { String::new() } else { String::from_utf8_lossy(&buf).into_owned() },
        size,
        binary,
        truncated: size > READ_LIMIT,
        mtime: mtime(&p),
    })
}

pub const CHANGED_ON_DISK: &str = "changed-on-disk";

pub fn write(groups: &[Group], path: &str, text: &str, expected_mtime: Option<u64>) -> Result<u64, String> {
    let p = inside_groups(groups, path)?;
    if expected_mtime.is_some_and(|m| m != mtime(&p)) {
        return Err(CHANGED_ON_DISK.into());
    }
    fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(mtime(&p))
}
