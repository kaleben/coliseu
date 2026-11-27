use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub color: String,
    pub cwd: String,
    /// Conta Claude padrão do grupo (fase 3).
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub folders: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    pub id: String,
    pub group_id: String,
    pub title: String,
    pub cwd: String,
    /// Conta Claude específica deste terminal (fase 3).
    #[serde(default)]
    pub account: Option<String>,
    pub created_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub groups: Vec<Group>,
    pub terminals: Vec<Terminal>,
    /// Layout de abas/splits da UI (formato definido pelo frontend).
    #[serde(default)]
    pub layout: serde_json::Value,
    /// Preferências (notificações etc.; formato definido pelo frontend).
    #[serde(default)]
    pub settings: serde_json::Value,
    /// Acesso pelo celular (servidor web na rede Tailscale).
    #[serde(default)]
    pub remote: RemoteCfg,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCfg {
    pub enabled: bool,
    pub port: u16,
    /// Segredo exigido em toda requisição (cookie após o 1º acesso com ?t=).
    pub token: String,
}

impl Default for RemoteCfg {
    fn default() -> Self {
        Self { enabled: false, port: 47300, token: String::new() }
    }
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Perfil da instância ($COLISEU_PROFILE, ex.: "dev"): isola config, socket tmux,
/// links de conta por terminal e snapshots de uma instância de testes.
pub fn profile() -> Option<String> {
    std::env::var("COLISEU_PROFILE")
        .ok()
        .filter(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

/// "coliseu" ou "coliseu-<perfil>"
pub fn instance_name() -> String {
    match profile() {
        Some(p) => format!("coliseu-{p}"),
        None => "coliseu".into(),
    }
}

pub fn config_dir() -> PathBuf {
    let d = dirs::config_dir().unwrap_or_else(|| home().join(".config")).join(instance_name());
    let _ = fs::create_dir_all(&d);
    d
}

fn config_path() -> PathBuf {
    config_dir().join("config.json")
}

/// Expande `~` e cai para o HOME se o diretório não existir.
pub fn resolve_cwd(cwd: &str) -> String {
    let p = if let Some(rest) = cwd.strip_prefix("~") {
        home().join(rest.trim_start_matches('/'))
    } else {
        PathBuf::from(cwd)
    };
    if p.is_dir() {
        p.to_string_lossy().into_owned()
    } else {
        home().to_string_lossy().into_owned()
    }
}

fn defaults() -> Config {
    let g = |id: &str, name: &str, color: &str, cwd: &str| Group {
        id: id.into(),
        name: name.into(),
        color: color.into(),
        cwd: cwd.into(),
        account: None,
        folders: vec![],
    };
    Config {
        // Primeiro uso: um grupo genérico na pasta pessoal (o usuário cria os dele).
        groups: vec![g("projetos", "Projetos", "#a855f7", "~")],
        terminals: vec![],
        layout: serde_json::Value::Null,
        settings: serde_json::Value::Null,
        remote: RemoteCfg::default(),
    }
}

pub fn load() -> Config {
    match fs::read_to_string(config_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            eprintln!("[coliseu] config.json inválido ({e}); usando defaults");
            defaults()
        }),
        Err(_) => defaults(),
    }
}

pub fn save(cfg: &Config) -> anyhow::Result<()> {
    let path = config_path();
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(cfg)?)?;
    fs::rename(tmp, path)?;
    Ok(())
}
