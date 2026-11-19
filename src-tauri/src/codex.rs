//! Detecta o Codex CLI nos terminais, sem hooks:
//!  - processando: o Codex põe um spinner braille no título do terminal
//!    ("⠧ <conversa> | <pasta> | Working (3s • esc to interrupt)");
//!  - aguardando você: lê as últimas linhas da tela procurando os diálogos de
//!    aprovação (só quando o Codex está parado);
//!  - nome/ID da sessão: o título traz o nome da conversa, que é cruzado com
//!    ~/.codex/session_index.jsonl ({ id, thread_name, updated_at }).

use crate::{agents::ClaudeInfo, tmux, tmux::PaneInfo};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    fs,
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Diálogos que esperam o usuário → rótulo mostrado na sidebar.
const WAITING: &[(&str, &str)] = &[
    ("Would you like to run the following command?", "aprovar comando"),
    ("Would you like to make the following edits?", "aprovar edição"),
    ("Would you like to grant these permissions?", "conceder permissões"),
    ("Would you like to send input to the existing terminal?", "enviar entrada ao terminal"),
    ("Do you want to proceed?", "confirmar"),
    ("Trust this folder?", "confiar na pasta"),
    ("enter continue", "diálogo aberto"),
    ("enter to confirm", "diálogo aberto"),
];

fn is_spinner(c: char) -> bool {
    ('\u{2800}'..='\u{28ff}').contains(&c)
}

/// "⠧ Nome da conversa | pasta | Working (…)" → Some("Nome da conversa")
fn thread_name(title: &str) -> Option<String> {
    let t = title.trim_start_matches(|c: char| is_spinner(c) || c.is_whitespace());
    let (name, _) = t.split_once(" | ")?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

/// thread_name → id (o mais recente), relido só quando o arquivo muda.
static INDEX: LazyLock<Mutex<(Option<SystemTime>, HashMap<String, (String, String)>)>> =
    LazyLock::new(Default::default);

fn session_id_for(name: &str) -> Option<String> {
    let path = crate::config::home().join(".codex/session_index.jsonl");
    let mtime = fs::metadata(&path).and_then(|m| m.modified()).ok();
    let mut idx = INDEX.lock();
    if idx.0 != mtime {
        let mut map: HashMap<String, (String, String)> = HashMap::new();
        for line in fs::read_to_string(&path).unwrap_or_default().lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            let (Some(id), Some(n)) = (v["id"].as_str(), v["thread_name"].as_str()) else { continue };
            let upd = v["updated_at"].as_str().unwrap_or_default().to_owned();
            if map.get(n).is_none_or(|(_, u)| *u <= upd) {
                map.insert(n.to_owned(), (id.to_owned(), upd));
            }
        }
        *idx = (mtime, map);
    }
    idx.1.get(name).map(|(id, _)| id.clone())
}

/// PID do processo `codex` filho direto do shell do painel.
fn codex_pid(shell_pid: u32) -> Option<u32> {
    let kids = fs::read_to_string(format!("/proc/{shell_pid}/task/{shell_pid}/children")).ok()?;
    kids.split_whitespace()
        .filter_map(|p| p.parse::<u32>().ok())
        .find(|p| fs::read_to_string(format!("/proc/{p}/comm")).is_ok_and(|c| c.trim() == "codex"))
}

/// sessão tmux → (status, desde quando)
static SINCE: LazyLock<Mutex<HashMap<String, (String, u64)>>> = LazyLock::new(Default::default);
/// sessão tmux → último (nome da conversa, id) conhecido — o título vira
/// "[ . ] Action Required" enquanto espera aprovação.
static LAST_NAME: LazyLock<Mutex<HashMap<String, (String, String)>>> = LazyLock::new(Default::default);

pub fn scan(panes: &HashMap<String, PaneInfo>) -> HashMap<String, ClaudeInfo> {
    let mut out = HashMap::new();
    let mut since = SINCE.lock();
    for (session, p) in panes {
        if p.command != "codex" {
            continue;
        }
        let action_required = p.title.contains("Action Required");
        let busy = !action_required && p.title.chars().next().is_some_and(is_spinner);
        let waiting_for = if busy {
            None
        } else {
            let screen = tmux::capture_tail(session, 30);
            WAITING
                .iter()
                .find(|(pat, _)| screen.contains(pat))
                .map(|(_, label)| label.to_string())
                .or_else(|| action_required.then(|| "ação necessária".to_owned()))
        };
        let status = if busy {
            "busy"
        } else if waiting_for.is_some() {
            "waiting"
        } else {
            "idle"
        };
        let entry = since.entry(session.clone()).or_insert_with(|| (status.to_owned(), now_ms()));
        if entry.0 != status {
            *entry = (status.to_owned(), now_ms());
        }
        // Nome/ID: do título; se o título for de alerta, usa o último conhecido.
        let parsed = thread_name(&p.title).filter(|n| !n.starts_with('[') && !action_required);
        let (name, session_id) = {
            let mut last = LAST_NAME.lock();
            match parsed {
                Some(n) => {
                    let id = session_id_for(&n).unwrap_or_default();
                    last.insert(session.clone(), (n.clone(), id.clone()));
                    (Some(n), id)
                }
                None => match last.get(session) {
                    Some((n, id)) => (Some(n.clone()), id.clone()),
                    None => (None, String::new()),
                },
            }
        };
        out.insert(
            session.clone(),
            ClaudeInfo {
                kind: "codex".into(),
                pid: codex_pid(p.pid).unwrap_or(0),
                session_id,
                status: status.into(),
                waiting_for,
                name,
                status_since: entry.1,
                subagents: vec![],
                cwd: Some(p.path.clone()),
                context: None,
            },
        );
    }
    since.retain(|s, _| panes.get(s).is_some_and(|p| p.command == "codex"));
    LAST_NAME.lock().retain(|s, _| panes.get(s).is_some_and(|p| p.command == "codex"));
    out
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore] // `cargo test --lib codex_live_print -- --ignored --nocapture`
    fn codex_live_print() {
        for (s, c) in super::scan(&crate::tmux::panes()) {
            println!("{s}: status={} waiting={:?} name={:?} session={} pid={}", c.status, c.waiting_for, c.name, c.session_id, c.pid);
        }
    }
}

// ---------- Conta e uso do Codex (lidos do disco, sem chamadas de rede) ----------

#[derive(serde::Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub percent: f64,
    /// epoch em ms
    pub resets_at: u64,
    pub window_minutes: u64,
}

#[derive(serde::Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccount {
    pub logged_in: bool,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub five_hour: Option<UsageWindow>,
    pub weekly: Option<UsageWindow>,
    /// Quando o Codex registrou esses números (epoch ms).
    pub updated_at: u64,
}

fn codex_home() -> std::path::PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| crate::config::home().join(".codex"))
}

/// Payload de um JWT (sem validar assinatura — só para ler e-mail/plano locais).
fn jwt_payload(jwt: &str) -> Option<serde_json::Value> {
    use base64::Engine;
    let part = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Rollouts mais recentes primeiro (procura nos diretórios de data mais novos).
fn recent_rollouts(limit: usize) -> Vec<std::path::PathBuf> {
    let mut files: Vec<(SystemTime, std::path::PathBuf)> = vec![];
    let root = codex_home().join("sessions");
    let mut years: Vec<_> = fs::read_dir(&root).into_iter().flatten().flatten().map(|e| e.path()).collect();
    years.sort();
    'outer: for y in years.iter().rev() {
        let mut months: Vec<_> = fs::read_dir(y).into_iter().flatten().flatten().map(|e| e.path()).collect();
        months.sort();
        for m in months.iter().rev() {
            let mut days: Vec<_> = fs::read_dir(m).into_iter().flatten().flatten().map(|e| e.path()).collect();
            days.sort();
            for d in days.iter().rev() {
                for e in fs::read_dir(d).into_iter().flatten().flatten() {
                    if let Ok(t) = e.metadata().and_then(|m| m.modified()) {
                        files.push((t, e.path()));
                    }
                }
                if files.len() >= limit * 3 {
                    break 'outer;
                }
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.into_iter().take(limit).map(|(_, p)| p).collect()
}

/// Último `rate_limits` registrado num rollout (lê só o final do arquivo).
fn last_rate_limits(path: &std::path::Path) -> Option<(serde_json::Value, u64)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let start = len.saturating_sub(512 * 1024);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = String::new();
    f.read_to_string(&mut buf).ok()?;
    let mtime = f.metadata().ok()?.modified().ok()?;
    for line in buf.lines().rev() {
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let rl = &v["payload"]["rate_limits"];
        if rl.is_object() && !rl["primary"].is_null() {
            let ts = mtime.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            return Some((rl.clone(), ts));
        }
    }
    None
}

fn window(v: &serde_json::Value) -> Option<UsageWindow> {
    let resets_at = v["resets_at"].as_u64().unwrap_or(0) * 1000;
    let mut percent = v["used_percent"].as_f64()?;
    if resets_at > 0 && resets_at <= now_ms() {
        percent = 0.0; // a janela já renovou desde o último registro
    }
    Some(UsageWindow { percent, resets_at, window_minutes: v["window_minutes"].as_u64().unwrap_or(0) })
}

pub fn account() -> CodexAccount {
    let mut out = CodexAccount::default();
    let Some(auth) = fs::read_to_string(codex_home().join("auth.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    else {
        return out;
    };
    out.logged_in = auth["tokens"]["access_token"].is_string() || auth["OPENAI_API_KEY"].is_string();
    if let Some(claims) = auth["tokens"]["id_token"].as_str().and_then(jwt_payload) {
        out.email = claims["email"].as_str().map(str::to_owned);
        out.plan = claims["https://api.openai.com/auth"]["chatgpt_plan_type"].as_str().map(str::to_owned);
    }
    for path in recent_rollouts(8) {
        if let Some((rl, ts)) = last_rate_limits(&path) {
            out.five_hour = window(&rl["primary"]);
            out.weekly = window(&rl["secondary"]);
            out.updated_at = ts;
            if let Some(p) = rl["plan_type"].as_str() {
                out.plan = Some(p.to_owned());
            }
            break;
        }
    }
    if let Some(p) = out.plan.as_mut() {
        let mut c = p.chars();
        *p = c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default();
    }
    out
}

// ---------- Uso ao vivo (mesmo endpoint que o Codex consulta) ----------

const WHAM_USAGE: &str = "https://chatgpt.com/backend-api/wham/usage";
const LIVE_INTERVAL_MS: u64 = 3 * 60_000;

/// (último resultado ao vivo, não consultar antes de)
static LIVE: LazyLock<Mutex<(Option<CodexAccount>, u64)>> = LazyLock::new(Default::default);

fn live_window(v: &serde_json::Value) -> Option<UsageWindow> {
    Some(UsageWindow {
        percent: v["used_percent"].as_f64()?,
        resets_at: v["reset_at"].as_u64().unwrap_or(0) * 1000,
        window_minutes: v["limit_window_seconds"].as_u64().unwrap_or(0) / 60,
    })
}

async fn fetch_live() -> Result<CodexAccount, u16> {
    let auth: serde_json::Value = fs::read_to_string(codex_home().join("auth.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or(0u16)?;
    let token = auth["tokens"]["access_token"].as_str().ok_or(0u16)?;
    // Token vencido: não renovamos (quem renova é o Codex) — usa os dados do disco.
    let exp = jwt_payload(token).and_then(|c| c["exp"].as_u64()).unwrap_or(0) * 1000;
    if exp < now_ms() + 60_000 {
        return Err(0);
    }
    let mut req = reqwest::Client::new()
        .get(WHAM_USAGE)
        .bearer_auth(token)
        .header("User-Agent", "codex-cli")
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10));
    if let Some(acc) = auth["tokens"]["account_id"].as_str() {
        req = req.header("ChatGPT-Account-Id", acc);
    }
    let resp = req.send().await.map_err(|_| 0u16)?;
    if !resp.status().is_success() {
        return Err(resp.status().as_u16());
    }
    let v: serde_json::Value = resp.json().await.map_err(|_| 0u16)?;
    let rl = &v["rate_limit"];
    Ok(CodexAccount {
        logged_in: true,
        email: v["email"].as_str().map(str::to_owned),
        plan: v["plan_type"].as_str().map(str::to_owned),
        five_hour: live_window(&rl["primary_window"]),
        weekly: live_window(&rl["secondary_window"]),
        updated_at: now_ms(),
    })
}

/// Uso ao vivo com cache (3 min, 10 min após 429); cai para os dados do disco.
pub async fn account_live(force: bool) -> CodexAccount {
    let local = tauri::async_runtime::spawn_blocking(account).await.unwrap_or_default();
    if !local.logged_in {
        return local;
    }
    let (cached, next_at) = LIVE.lock().clone();
    let live = if force || now_ms() >= next_at {
        match fetch_live().await {
            Ok(a) => {
                *LIVE.lock() = (Some(a.clone()), now_ms() + LIVE_INTERVAL_MS);
                Some(a)
            }
            Err(code) => {
                let wait = if code == 429 { 10 * 60_000 } else { LIVE_INTERVAL_MS };
                LIVE.lock().1 = now_ms() + wait;
                cached
            }
        }
    } else {
        cached
    };
    // O mais recente vence (o Codex pode ter gravado algo depois da consulta).
    match live {
        Some(mut a) if a.updated_at >= local.updated_at => {
            if let Some(p) = a.plan.as_mut() {
                let mut c = p.chars();
                *p = c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default();
            }
            a.email = a.email.or(local.email);
            a
        }
        _ => local,
    }
}

#[cfg(test)]
mod account_tests {
    #[test]
    #[ignore]
    fn codex_live_usage_print() {
        let a = tauri::async_runtime::block_on(super::account_live(true));
        let age_s = (super::now_ms() - a.updated_at) / 1000;
        println!("plano={:?} 5h={:?} semana={:?} idade={}s", a.plan, a.five_hour.map(|w| w.percent), a.weekly.map(|w| w.percent), age_s);
    }

    #[test]
    #[ignore]
    fn codex_account_print() {
        let a = super::account();
        println!(
            "logged={} dominio={:?} plano={:?} 5h={:?} semana={:?}",
            a.logged_in,
            a.email.as_deref().and_then(|e| e.split('@').nth(1)),
            a.plan,
            a.five_hour.map(|w| w.percent),
            a.weekly.map(|w| w.percent)
        );
    }
}
