//! tmux como "motor" invisível: socket e config próprios, sem barra, sem prefixo.

use crate::config::config_dir;
use std::{collections::HashMap, path::PathBuf, process::Command};

/// Socket do servidor tmux desta instância ("coliseu" ou "coliseu-dev").
pub fn socket() -> String {
    crate::config::instance_name()
}

const CONF: &str = r##"# Gerado pelo Coliseu — não edite (é sobrescrito ao iniciar).
set -g status off
set -g prefix None
set -g prefix2 None
unbind -a
set -g mouse off
set -s escape-time 0
set -g history-limit 50000
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:Tc:smcup@:rmcup@"
set -g set-titles on
set -g set-titles-string "#T"
set -g allow-rename on
set -g focus-events on
set -g remain-on-exit off
set -g destroy-unattached off
set -g exit-empty off
set -g aggressive-resize on
"##;

pub fn conf_path() -> PathBuf {
    config_dir().join("tmux.conf")
}

/// Variáveis que não devem vazar do processo do app para os shells.
fn polluted(key: &str) -> bool {
    const EXACT: &[&str] = &["TMUX", "TMUX_PANE", "CLAUDECODE", "INIT_CWD", "NODE_ENV"];
    const PREFIX: &[&str] = &["CLAUDE_CODE_", "ORCA_", "TAURI_", "npm_", "PNPM_", "VITE_", "CARGO_", "COLISEU_"];
    EXACT.contains(&key) || PREFIX.iter().any(|p| key.starts_with(p))
}

/// Ambiente limpo para o servidor/cliente tmux (herdado pelos shells).
pub fn clean_env() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(k, _)| !polluted(k))
        .map(|(k, v)| {
            if k == "PATH" {
                let p: Vec<&str> = v.split(':').filter(|s| !s.contains("node_modules/.bin")).collect();
                (k, p.join(":"))
            } else {
                (k, v)
            }
        })
        .collect()
}

pub fn cmd() -> Command {
    let mut c = Command::new("tmux");
    c.env_clear().envs(clean_env());
    c.args(["-L", &socket(), "-f"]).arg(conf_path());
    c
}

fn run(args: &[&str]) -> anyhow::Result<String> {
    let out = cmd().args(args).output()?;
    if !out.status.success() {
        anyhow::bail!("tmux {:?}: {}", args, String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Escreve a config e, se o servidor já estiver rodando, recarrega.
pub fn init() {
    let _ = std::fs::write(conf_path(), CONF);
    let conf = conf_path().to_string_lossy().into_owned();
    let _ = run(&["source-file", &conf]);
}

pub fn session_name(term_id: &str) -> String {
    format!("cs-{term_id}")
}

pub fn new_session(name: &str, cwd: &str, env: &[(String, String)], command: Option<&str>) -> anyhow::Result<()> {
    let mut args: Vec<String> = vec![
        "new-session".into(), "-d".into(), "-s".into(), name.into(),
        "-c".into(), cwd.into(), "-x".into(), "200".into(), "-y".into(), "50".into(),
    ];
    for (k, v) in env {
        args.push("-e".into());
        args.push(format!("{k}={v}"));
    }
    if let Some(c) = command {
        args.push(c.into());
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run(&refs)?;
    Ok(())
}

/// O aparelho em uso "assume" o terminal: a janela tmux fica exatamente do
/// tamanho dele. (Se ficasse menor que a tela, o tmux redesenharia em vez de
/// rolar e nada iria para o histórico do xterm.js.)
pub fn claim_size(name: &str, cols: u16, rows: u16) {
    let (c, r) = (cols.max(2).to_string(), rows.max(1).to_string());
    let _ = run(&["resize-window", "-x", &c, "-y", &r, "-t", &format!("={name}:")]);
}

/// Digita uma linha no terminal e aperta Enter.
pub fn send_line(name: &str, line: &str) {
    let t = format!("={name}:");
    let _ = run(&["send-keys", "-t", &t, "-l", line]);
    let _ = run(&["send-keys", "-t", &t, "Enter"]);
}

/// Última atividade (epoch, segundos) de cada sessão.
pub fn session_activity() -> HashMap<String, u64> {
    run(&["list-sessions", "-F", "#{session_name}\t#{session_activity}"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let (n, a) = l.split_once('\t')?;
            Some((n.to_owned(), a.trim().parse().ok()?))
        })
        .collect()
}

/// Últimas `lines` linhas (histórico + tela) com cores, sem linhas vazias no fim.
pub fn capture_tail(name: &str, lines: u32) -> String {
    let start = format!("-{lines}");
    let out = run(&["capture-pane", "-p", "-e", "-J", "-t", &format!("={name}:"), "-S", &start])
        .unwrap_or_default();
    out.trim_end().to_owned()
}

pub fn list_sessions() -> Vec<String> {
    run(&["list-sessions", "-F", "#{session_name}"])
        .map(|s| s.lines().map(str::to_owned).collect())
        .unwrap_or_default()
}

pub fn has_session(name: &str) -> bool {
    // "=" força match exato do nome.
    run(&["has-session", "-t", &format!("={name}")]).is_ok()
}

pub fn kill_session(name: &str) {
    let _ = run(&["kill-session", "-t", &format!("={name}")]);
}

/// Histórico (sem a tela visível) com cores, para pré-carregar o xterm.js.
pub fn capture_history(name: &str) -> String {
    run(&["capture-pane", "-p", "-e", "-J", "-t", &format!("={name}:"), "-S", "-", "-E", "-1"])
        .unwrap_or_default()
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PaneInfo {
    pub command: String,
    pub path: String,
    pub pid: u32,
    pub title: String,
}

/// Status de todas as sessões: comando em foreground, cwd atual, pid do shell, título.
pub fn panes() -> HashMap<String, PaneInfo> {
    let fmt = "#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{pane_title}";
    run(&["list-panes", "-a", "-F", fmt])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.splitn(5, '\t').collect();
            if f.len() < 5 {
                return None;
            }
            Some((
                f[0].to_owned(),
                PaneInfo {
                    command: f[1].to_owned(),
                    path: f[2].to_owned(),
                    pid: f[3].parse().unwrap_or(0),
                    title: f[4].to_owned(),
                },
            ))
        })
        .collect()
}
