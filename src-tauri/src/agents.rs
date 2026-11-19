//! Detecta sessões do Claude Code dentro dos terminais e seus subagents,
//! lendo os arquivos que o próprio Claude escreve (sem hooks):
//!   ~/.claude/sessions/<pid>.json                      → status da sessão
//!   ~/.claude/projects/<slug>/<sessionId>/subagents/   → subagents (*.meta.json + *.jsonl)

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubAgent {
    pub id: String,
    pub description: String,
    pub agent_type: String,
    pub finished: bool,
    pub started_at: u64,
    pub updated_at: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInfo {
    /// "claude" | "codex"
    pub kind: String,
    pub pid: u32,
    pub session_id: String,
    /// busy | idle | waiting | shell | ...
    pub status: String,
    pub waiting_for: Option<String>,
    pub name: Option<String>,
    pub status_since: u64,
    pub subagents: Vec<SubAgent>,
    /// Pasta onde o claude foi aberto (necessária para `--resume`).
    pub cwd: Option<String>,
    /// Contexto em uso (o que o /context mostra); só Claude.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<crate::context::ContextUse>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionFile {
    pid: u32,
    session_id: Option<String>,
    status: Option<String>,
    waiting_for: Option<String>,
    name: Option<String>,
    kind: Option<String>,
    status_updated_at: Option<u64>,
    cwd: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct MetaFile {
    description: Option<String>,
    agent_type: Option<String>,
    finished: Option<bool>,
}

/// Subagent "não concluído" sem atividade há mais que isso é considerado morto.
const STALE: Duration = Duration::from_secs(15 * 60);

pub(crate) fn claude_home() -> PathBuf {
    crate::config::home().join(".claude")
}

fn ms(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// pid → ppid de todos os processos.
fn parent_map() -> HashMap<u32, u32> {
    let mut m = HashMap::new();
    let Ok(rd) = fs::read_dir("/proc") else { return m };
    for e in rd.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(stat) = fs::read_to_string(e.path().join("stat")) else { continue };
        // formato: pid (comm) state ppid ...  — comm pode ter espaços/parênteses
        if let Some(rest) = stat.rfind(')').map(|i| &stat[i + 2..]) {
            if let Some(ppid) = rest.split(' ').nth(1).and_then(|s| s.parse().ok()) {
                m.insert(pid, ppid);
            }
        }
    }
    m
}

static SUBAGENT_DIRS: LazyLock<Mutex<HashMap<String, PathBuf>>> = LazyLock::new(Default::default);

fn subagent_dir(session_id: &str) -> Option<PathBuf> {
    if let Some(p) = SUBAGENT_DIRS.lock().get(session_id) {
        return Some(p.clone());
    }
    for e in fs::read_dir(claude_home().join("projects")).ok()?.flatten() {
        let p = e.path().join(session_id).join("subagents");
        if p.is_dir() {
            SUBAGENT_DIRS.lock().insert(session_id.to_owned(), p.clone());
            return Some(p);
        }
    }
    None
}

/// Subagentes em andamento de uma sessão (o modo chat usa: lá não há processo para escanear).
pub fn subagents_of(session_id: &str) -> Vec<SubAgent> {
    if session_id.is_empty() {
        return vec![];
    }
    subagent_dir(session_id).map(|d| subagents(&d)).unwrap_or_default()
}

fn subagents(dir: &Path) -> Vec<SubAgent> {
    let now = SystemTime::now();
    let mut out = vec![];
    let Ok(rd) = fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".jsonl") else { continue };
        let Ok(md) = e.metadata() else { continue };
        let updated = md.modified().unwrap_or(UNIX_EPOCH);
        let age = now.duration_since(updated).unwrap_or_default();
        // Atalho: arquivos sem atividade recente não interessam (evita parsear centenas de metas).
        if age > STALE {
            continue;
        }
        let meta: MetaFile = fs::read_to_string(dir.join(format!("{id}.meta.json")))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // Concluído = some da sidebar na hora.
        let finished = meta.finished.unwrap_or(false);
        if finished {
            continue;
        }
        out.push(SubAgent {
            id: id.trim_start_matches("agent-").to_owned(),
            description: meta.description.unwrap_or_else(|| "subagent".into()),
            agent_type: meta.agent_type.unwrap_or_default(),
            finished,
            started_at: ms(md.created().unwrap_or(updated)),
            updated_at: ms(updated),
        });
    }
    out.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    out
}

/// Agente (Claude ou Codex) rodando em cada sessão tmux. Claude tem prioridade.
pub fn scan_panes(panes: &HashMap<String, crate::tmux::PaneInfo>) -> HashMap<String, ClaudeInfo> {
    let pids: HashMap<u32, String> = panes.iter().map(|(s, p)| (p.pid, s.clone())).collect();
    let mut out = scan(&pids);
    for (s, c) in crate::codex::scan(panes) {
        out.entry(s).or_insert(c);
    }
    out
}

/// Para cada sessão tmux (pela pid do shell do painel), a sessão Claude que roda dentro dela.
pub fn scan(pane_pids: &HashMap<u32, String>) -> HashMap<String, ClaudeInfo> {
    let mut out: HashMap<String, ClaudeInfo> = HashMap::new();
    let Ok(rd) = fs::read_dir(claude_home().join("sessions")) else { return out };
    let parents = parent_map();

    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let Some(sf) = fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<SessionFile>(&s).ok()) else {
            continue;
        };
        if sf.kind.as_deref() == Some("bg") || !parents.contains_key(&sf.pid) {
            continue; // processo morto ou sessão em background
        }
        // Sobe a árvore de processos até achar o shell de algum painel.
        let (mut cur, mut hops, mut owner) = (sf.pid, 0, None);
        while hops < 32 {
            if let Some(s) = pane_pids.get(&cur) {
                owner = Some(s.clone());
                break;
            }
            match parents.get(&cur) {
                Some(&pp) if pp > 1 => cur = pp,
                _ => break,
            }
            hops += 1;
        }
        let Some(session) = owner else { continue };

        let status = sf.status.unwrap_or_else(|| "idle".into());
        let sid = sf.session_id.unwrap_or_default();
        let subs = subagent_dir(&sid).map(|d| subagents(&d)).unwrap_or_default();
        let info = ClaudeInfo {
            kind: "claude".into(),
            pid: sf.pid,
            session_id: sid,
            status,
            waiting_for: sf.waiting_for,
            name: sf.name,
            status_since: sf.status_updated_at.unwrap_or(0),
            subagents: subs,
            cwd: sf.cwd,
            context: None, // preenchido em terms_status (só quem mostra precisa)
        };
        // Se houver mais de um claude no mesmo terminal, fica o mais recente.
        match out.get(&session) {
            Some(prev) if prev.status_since >= info.status_since => {}
            _ => {
                out.insert(session, info);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore] // depende do ambiente: `cargo test -- --ignored --nocapture`
    fn scan_live() {
        let pids = crate::tmux::panes().into_iter().map(|(s, p)| (p.pid, s)).collect();
        for (s, c) in super::scan(&pids) {
            println!("{s}: {} {:?} {:?} subagents={}", c.status, c.waiting_for, c.name, c.subagents.len());
            for a in &c.subagents {
                println!("   - {} [{}] finished={}", a.description, a.agent_type, a.finished);
            }
        }
    }
}
