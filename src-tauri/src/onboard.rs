//! Primeiros passos: verificações do PC (ferramentas, gh, Tailscale), sugestões de
//! pastas de projeto e o ditado por voz do Claude Code. Ver docs/ONBOARDING_SPEC.md.
use crate::config::home;
use serde::Serialize;
use serde_json::{json, Value};
use std::{fs, path::Path, process::Command};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// Ferramentas encontradas no shell do usuário (tmux, claude, node, gh, xdotool, tailscale).
    pub tools: Vec<String>,
    pub gh_user: Option<String>,
    /// Tailscale conectado à tailnet.
    pub ts_running: bool,
    /// HTTPS Certificates ligado na tailnet.
    pub ts_https: bool,
    /// Este usuário pode pedir o certificado (tailscale set --operator).
    pub ts_operator: bool,
    /// Celulares (Android/iOS) na mesma tailnet: (nome, online, sistema).
    pub ts_phones: Vec<(String, bool, String)>,
    pub voice: bool,
}

const TOOLS: &str = "tmux claude node gh xdotool tailscale";

/// Procura no shell de login interativo do usuário (o mesmo dos terminais): é ele
/// que acha nvm, ~/.local/bin etc.
fn found_tools() -> Vec<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let script = format!("for c in {TOOLS}; do command -v $c >/dev/null 2>&1 && echo \"@@$c\"; done");
    let out = Command::new("timeout")
        .args(["8", &shell, "-lic", &script])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output();
    let mut v: Vec<String> = out
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().filter_map(|l| l.trim().strip_prefix("@@").map(str::to_owned)).collect())
        .unwrap_or_default();
    // Sem resposta do shell: cai para o PATH do próprio app.
    if v.is_empty() {
        let path = std::env::var("PATH").unwrap_or_default();
        v = TOOLS
            .split(' ')
            .filter(|c| std::env::split_paths(&path).any(|d| d.join(c).is_file()))
            .map(str::to_owned)
            .collect();
    }
    // O instalador oficial do Claude Code põe o binário aqui (o PATH vem no próximo login).
    if !v.iter().any(|t| t == "claude") && [".local/bin/claude", ".claude/local/claude"].iter().any(|p| home().join(p).is_file()) {
        v.push("claude".into());
    }
    v
}

fn ts_operator() -> bool {
    let Ok(o) = Command::new("timeout").args(["3", "tailscale", "debug", "prefs"]).output() else { return false };
    let user = std::env::var("USER").unwrap_or_default();
    serde_json::from_slice::<Value>(&o.stdout).ok().and_then(|v| v["OperatorUser"].as_str().map(|u| !u.is_empty() && u == user)).unwrap_or(false)
}

pub fn check() -> Check {
    let tools = found_tools();
    let mut c = Check { voice: voice_on(), ..Default::default() };
    if tools.iter().any(|t| t == "gh") {
        c.gh_user = crate::prs::gh_user();
    }
    if tools.iter().any(|t| t == "tailscale") {
        if let Some(s) = crate::tls::status_json() {
            c.ts_running = s["BackendState"] == "Running";
            c.ts_https = s["CertDomains"].as_array().is_some_and(|a| !a.is_empty());
            if let Some(peers) = s["Peer"].as_object() {
                c.ts_phones = peers
                    .values()
                    .filter(|p| matches!(p["OS"].as_str(), Some("android" | "iOS")))
                    .map(|p| (p["HostName"].as_str().unwrap_or("celular").to_owned(), p["Online"] == true, p["OS"].as_str().unwrap_or("").to_owned()))
                    .collect();
            }
        }
        if c.ts_running {
            c.ts_operator = ts_operator();
        }
    }
    c.tools = tools;
    c
}

/// Pastas com git em ~ (até 3 níveis), mais recentes primeiro.
pub fn projects() -> Vec<String> {
    let h = home();
    let mut found: Vec<(std::time::SystemTime, String)> = vec![];
    fn walk(dir: &Path, depth: u32, h: &Path, out: &mut Vec<(std::time::SystemTime, String)>) {
        if out.len() >= 40 {
            return;
        }
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" || name == "snap" || !e.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let p = e.path();
            if p.join(".git").exists() {
                let t = fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                let rel = p.strip_prefix(h).map(|r| format!("~/{}", r.display())).unwrap_or_else(|_| p.display().to_string());
                out.push((t, rel));
            } else if depth < 3 {
                walk(&p, depth + 1, h, out);
            }
        }
    }
    walk(&h, 1, &h, &mut found);
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().take(8).map(|(_, p)| p).collect()
}

// ---------- ditado (modo de voz do Claude Code) ----------

fn claude_file(name: &str) -> std::path::PathBuf {
    home().join(".claude").join(name)
}

fn read_obj(p: &Path) -> Value {
    fs::read_to_string(p).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

fn write_obj(p: &Path, v: &Value) -> Result<(), String> {
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    fs::write(p, serde_json::to_string_pretty(v).unwrap_or_default() + "\n").map_err(|e| e.to_string())
}

fn voice_on() -> bool {
    read_obj(&claude_file("settings.json"))["voiceEnabled"] == true
}

/// Liga/desliga o ditado (modo tap) e o atalho Alt+K, sem mexer no resto dos arquivos.
pub fn voice_set(on: bool) -> Result<(), String> {
    let sp = claude_file("settings.json");
    let mut s = read_obj(&sp);
    s["voiceEnabled"] = json!(on);
    if on {
        s["voice"] = json!({ "enabled": true, "mode": "tap" });
    } else if let Some(v) = s.get_mut("voice").and_then(Value::as_object_mut) {
        v.insert("enabled".into(), json!(false));
    }
    write_obj(&sp, &s)?;
    if !on {
        return Ok(());
    }
    let kp = claude_file("keybindings.json");
    let mut k = read_obj(&kp);
    if !k["bindings"].is_array() {
        k["bindings"] = json!([]);
    }
    let list = k["bindings"].as_array_mut().unwrap();
    let chat = match list.iter().position(|b| b["context"] == "Chat") {
        Some(i) => i,
        None => {
            list.push(json!({ "context": "Chat", "bindings": {} }));
            list.len() - 1
        }
    };
    if !list[chat]["bindings"].is_object() {
        list[chat]["bindings"] = json!({});
    }
    list[chat]["bindings"]["meta+k"] = json!("voice:pushToTalk");
    write_obj(&kp, &k)
}
