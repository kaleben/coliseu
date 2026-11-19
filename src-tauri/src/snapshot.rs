//! Restauração após reboot.
//!
//! O tmux guarda tudo em memória: reiniciar a máquina mata as sessões.
//! A cada 60s salvamos, só dos terminais que tiveram atividade:
//!   ~/.local/share/coliseu/snapshots/<termId>/history.gz  (últimas N linhas, com cores, gzip)
//!   ~/.local/share/coliseu/snapshots/<termId>/meta.json   (pasta + sessão do Claude)
//! Na volta, o terminal é recriado, o histórico reimpresso e o Claude retomado
//! com `claude --resume <sessão>`.

use crate::{accounts, agents, tmux};
use flate2::{write::GzEncoder, Compression};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    hash::{Hash, Hasher},
    io::Write,
    path::PathBuf,
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};

/// Linhas de histórico guardadas por terminal (gzip → tipicamente 30–80 KB).
const HISTORY_LINES: u32 = 3000;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeResume {
    /// "claude" | "codex"
    #[serde(default = "default_kind")]
    pub kind: String,
    pub session_id: String,
    pub cwd: String,
    /// Opções seguras de repetir (ex.: --dangerously-skip-permissions, --model X).
    pub args: Vec<String>,
}

fn default_kind() -> String {
    "claude".into()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub cwd: String,
    pub saved_at: u64,
    pub claude: Option<ClaudeResume>,
}

/// termId → (atividade do tmux na última gravação, hash do conteúdo gravado)
static STATE: LazyLock<Mutex<HashMap<String, (u64, u64)>>> = LazyLock::new(Default::default);

fn dir() -> PathBuf {
    match crate::config::profile() {
        Some(p) => accounts::base().join(format!("snapshots-{p}")),
        None => accounts::base().join("snapshots"),
    }
}
fn term_dir(id: &str) -> PathBuf {
    dir().join(id)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Opções do agente original que valem repetir no resume (sem prompt nem resume).
pub(crate) fn agent_args(kind: &str, pid: u32) -> Vec<String> {
    let (flags, with_value): (&[&str], &[&str]) = if kind == "codex" {
        (
            &["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto", "--search", "--oss"],
            &["-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-p", "--profile", "-c", "--config", "--add-dir"],
        )
    } else {
        (
            &["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--verbose", "--ide"],
            &["--permission-mode", "--model", "--add-dir", "--agent", "--settings", "--mcp-config", "--fallback-model", "--effort"],
        )
    };
    if pid == 0 {
        return vec![];
    }
    let Ok(raw) = fs::read(format!("/proc/{pid}/cmdline")) else { return vec![] };
    let argv: Vec<String> = raw.split(|b| *b == 0).filter(|a| !a.is_empty()).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
    let mut out = vec![];
    let mut i = 1;
    while i < argv.len() {
        let a = &argv[i];
        if flags.contains(&a.as_str()) {
            out.push(a.clone());
        } else if a.split_once('=').is_some_and(|(k, _)| with_value.contains(&k)) {
            out.push(a.clone());
        } else if with_value.contains(&a.as_str()) && i + 1 < argv.len() {
            out.push(a.clone());
            out.push(argv[i + 1].clone());
            i += 1;
        }
        i += 1;
    }
    out
}

fn write_atomic(path: &PathBuf, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

/// Salva os terminais que tiveram atividade desde a última vez (`force` = todos).
pub fn snapshot_all(term_ids: &[String], force: bool) {
    let activity = tmux::session_activity();
    if activity.is_empty() {
        return; // servidor tmux fora do ar: não sobrescreve snapshots bons
    }
    let panes = tmux::panes();
    let mut claude: Option<HashMap<String, agents::ClaudeInfo>> = None; // lazy: só se algo mudou

    for id in term_ids {
        let name = tmux::session_name(id);
        let Some(&act) = activity.get(&name) else { continue };
        let prev = STATE.lock().get(id).copied();
        if !force && prev.map(|p| p.0) == Some(act) {
            continue;
        }
        let claude = claude.get_or_insert_with(|| agents::scan_panes(&panes));
        // Sem espaços sobrando no fim de cada linha (o tmux preenche até a largura).
        let history: String = tmux::capture_tail(&name, HISTORY_LINES)
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n");
        let cwd = panes.get(&name).map(|p| p.path.clone()).unwrap_or_default();
        let resume = crate::chat::resume_info(id).or_else(|| claude.get(&name).filter(|c| !c.session_id.is_empty()).map(|c| ClaudeResume {
            kind: c.kind.clone(),
            session_id: c.session_id.clone(),
            cwd: c.cwd.clone().unwrap_or_else(|| cwd.clone()),
            args: agent_args(&c.kind, c.pid),
        }));

        let mut h = std::collections::hash_map::DefaultHasher::new();
        (&history, &cwd, resume.as_ref().map(|r| (&r.session_id, &r.args))).hash(&mut h);
        let hash = h.finish();
        if prev.map(|p| p.1) == Some(hash) {
            STATE.lock().insert(id.clone(), (act, hash));
            continue;
        }

        let d = term_dir(id);
        if fs::create_dir_all(&d).is_err() {
            continue;
        }
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        let ok = gz.write_all(history.as_bytes()).is_ok()
            && gz.finish().map(|bytes| write_atomic(&d.join("history.gz"), &bytes).is_ok()).unwrap_or(false);
        let meta = Meta { cwd, saved_at: now_ms(), claude: resume };
        let ok = ok && write_atomic(&d.join("meta.json"), &serde_json::to_vec(&meta).unwrap_or_default()).is_ok();
        if ok {
            STATE.lock().insert(id.clone(), (act, hash));
        }
    }
}

pub fn has_snapshot(id: &str) -> bool {
    term_dir(id).join("meta.json").exists()
}

pub fn remove(id: &str) {
    let _ = fs::remove_dir_all(term_dir(id));
    STATE.lock().remove(id);
}

/// Apaga snapshots de terminais que não existem mais.
pub fn prune(live: &[String]) {
    for e in fs::read_dir(dir()).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if !live.contains(&n) {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

/// Recria a sessão tmux a partir do snapshot. Retorna false se não havia snapshot.
pub fn restore(id: &str, fallback_cwd: &str, env: &[(String, String)]) -> bool {
    let d = term_dir(id);
    let Some(meta) = fs::read_to_string(d.join("meta.json")).ok().and_then(|s| serde_json::from_str::<Meta>(&s).ok()) else {
        return false;
    };
    let cwd = crate::config::resolve_cwd(if meta.cwd.is_empty() { fallback_cwd } else { &meta.cwd });
    let hist = d.join("history.gz");
    let mut cmd = String::new();
    if hist.exists() {
        cmd.push_str(&format!("gzip -dc {} 2>/dev/null; ", sh_quote(&hist.to_string_lossy())));
    }
    cmd.push_str(&format!("printf '\\n\\033[2m── restaurado após reinício ──\\033[0m\\n\\n'; exec \"${{SHELL:-/bin/bash}}\" -l"));
    if tmux::new_session(&tmux::session_name(id), &cwd, env, Some(&cmd)).is_err() {
        return false;
    }
    STATE.lock().remove(id);

    if let Some(c) = meta.claude {
        let session = tmux::session_name(id);
        let line = resume_line(&c, &cwd);
        // Espera o shell de login subir antes de digitar.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            tmux::send_line(&session, &line);
        });
    }
    true
}

/// Linha de shell que retoma a sessão do agente (`claude --resume` / `codex resume`)
/// com as mesmas opções; entra na pasta original se for diferente de `cur_cwd`.
pub(crate) fn resume_line(c: &ClaudeResume, cur_cwd: &str) -> String {
    let mut line = String::new();
    if !c.cwd.is_empty() && c.cwd != cur_cwd && std::path::Path::new(&c.cwd).is_dir() {
        line.push_str(&format!("cd {} && ", sh_quote(&c.cwd)));
    }
    line.push_str(if c.kind == "codex" { "codex resume " } else { "claude --resume " });
    line.push_str(&sh_quote(&c.session_id));
    for a in &c.args {
        line.push(' ');
        line.push_str(&if a.starts_with("--") && !a.contains(' ') { a.clone() } else { sh_quote(a) });
    }
    line
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn args_of_running_claude() {
        let me = std::process::id();
        // sobe a árvore até achar um processo "claude"
        let mut pid = me;
        for _ in 0..10 {
            let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
            if comm.trim() == "claude" {
                println!("pid {pid}: args preservados = {:?}", super::agent_args("claude", pid));
                return;
            }
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
            pid = stat.rsplit(')').next().and_then(|r| r.split(' ').nth(2)).and_then(|p| p.parse().ok()).unwrap_or(1);
        }
        println!("nenhum claude ancestral");
    }

    #[test]
    #[ignore] // usa o servidor tmux real: `cargo test --lib snapshot_roundtrip -- --ignored --nocapture`
    fn snapshot_roundtrip() {
        use crate::tmux;
        let id = "zztestsnap".to_string();
        let name = tmux::session_name(&id);
        tmux::kill_session(&name);
        tmux::new_session(&name, "/tmp", &[], None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1200));
        tmux::send_line(&name, "seq 1 4000 | sed 's/^/linha /'; echo MARCA_FINAL");
        std::thread::sleep(std::time::Duration::from_millis(1500));
        super::snapshot_all(&[id.clone()], true);
        let gz = std::fs::metadata(super::term_dir(&id).join("history.gz")).unwrap().len();
        println!("history.gz = {gz} bytes; meta = {}", std::fs::read_to_string(super::term_dir(&id).join("meta.json")).unwrap());
        tmux::kill_session(&name); // simula o reboot
        assert!(super::restore(&id, "/tmp", &[]));
        std::thread::sleep(std::time::Duration::from_millis(2000));
        let after = tmux::capture_tail(&name, 3000);
        let lines: Vec<&str> = after.lines().collect();
        println!("restaurado: {} linhas; primeira com conteúdo = {:?}", lines.len(), lines.iter().find(|l| !l.trim().is_empty()));
        assert!(after.contains("MARCA_FINAL"));
        assert!(after.contains("restaurado após reinício"));
        tmux::kill_session(&name);
        super::remove(&id);
        assert!(!super::term_dir(&id).exists());
    }
}
