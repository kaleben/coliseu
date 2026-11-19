//! Contas do Claude.
//!
//! Layout em ~/.local/share/coliseu:
//!   profiles/<id>/.credentials.json   ← ÚNICO arquivo vivo de cada conta
//!   profiles/<id>/profile.json        ← label, plano, oauthAccount
//!   current  → profiles/<ativo>        (symlink de diretório)
//!   term/<termId> → current | profiles/<id>
//!
//! O Claude lê as credenciais de $CLAUDE_SECURESTORAGE_CONFIG_DIR (se definido).
//! Ele recusa um *arquivo* symlink, mas aceita um *diretório* symlink —
//! por isso trocar de conta é só reapontar o link.
//!
//! ~/.claude/.credentials.json vira um espelho da conta ativa (para processos que
//! não têm a variável), sincronizado "o mais novo vence" pelo expiresAt.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    os::unix::fs::{symlink, PermissionsExt},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::config::home;

pub const ENV_VAR: &str = "CLAUDE_SECURESTORAGE_CONFIG_DIR";
const CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CREDS: &str = ".credentials.json";

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub account_uuid: Option<String>,
    #[serde(default)]
    pub org_name: Option<String>,
    /// Bloco `oauthAccount` gravado em ~/.claude.json na troca (para /status mostrar o e-mail certo).
    #[serde(default)]
    pub oauth_account: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub percent: f64,
    pub resets_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub five_hour: Option<Window>,
    pub seven_day: Option<Window>,
    pub error: Option<String>,
    /// Quando os números (five_hour/seven_day) foram obtidos.
    pub fetched_at: u64,
    /// true = números vindos do cache (a consulta nova falhou ou ainda não é hora).
    #[serde(default)]
    pub stale: bool,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn base() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| home().join(".local/share")).join("coliseu")
}
fn profiles_dir() -> PathBuf {
    base().join("profiles")
}
pub fn current_link() -> PathBuf {
    base().join("current")
}
fn term_dir() -> PathBuf {
    match crate::config::profile() {
        Some(p) => base().join(format!("term-{p}")),
        None => base().join("term"),
    }
}
fn profile_dir(id: &str) -> PathBuf {
    profiles_dir().join(id)
}
fn claude_creds() -> PathBuf {
    home().join(".claude").join(CREDS)
}
fn claude_json() -> PathBuf {
    home().join(".claude.json")
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

/// Escrita atômica com permissão 600.
fn write_secret(p: &Path, v: &Value) -> anyhow::Result<()> {
    let tmp = p.with_extension(format!("tmp{}", std::process::id()));
    fs::write(&tmp, serde_json::to_vec(v)?)?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    fs::rename(&tmp, p)?;
    Ok(())
}

/// Troca um symlink de forma atômica.
fn relink(target: &Path, link: &Path) -> anyhow::Result<()> {
    let tmp = link.with_extension(format!("tmp{}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    symlink(target, &tmp)?;
    fs::rename(&tmp, link)?;
    Ok(())
}

fn expires_at(creds: &Value) -> u64 {
    creds["claudeAiOauth"]["expiresAt"].as_u64().unwrap_or(0)
}

// ---------- Perfis ----------

pub fn list() -> Vec<Profile> {
    let mut v: Vec<Profile> = fs::read_dir(profiles_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| serde_json::from_value(read_json(&e.path().join("profile.json"))?).ok())
        .collect();
    v.sort_by(|a, b| a.label.cmp(&b.label));
    v
}

pub fn active_id() -> Option<String> {
    fs::read_link(current_link()).ok()?.file_name()?.to_str().map(str::to_owned)
}

fn profile_from_oauth(id: &str, oauth: &Value, creds: &Value) -> Profile {
    let plan = creds["claudeAiOauth"]["subscriptionType"].as_str().map(|s| {
        let mut c = s.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    });
    Profile {
        id: id.into(),
        label: oauth["emailAddress"].as_str().unwrap_or(id).into(),
        alias: None,
        plan,
        account_uuid: oauth["accountUuid"].as_str().map(str::to_owned),
        org_name: oauth["organizationName"].as_str().map(str::to_owned),
        oauth_account: oauth.clone(),
    }
}

fn save_profile(p: &Profile, creds: &Value) -> anyhow::Result<()> {
    let d = profile_dir(&p.id);
    fs::create_dir_all(&d)?;
    fs::set_permissions(&d, fs::Permissions::from_mode(0o700))?;
    write_secret(&d.join(CREDS), creds)?;
    fs::write(d.join("profile.json"), serde_json::to_vec_pretty(p)?)?;
    Ok(())
}

pub fn update_alias(id: &str, alias: Option<String>) -> anyhow::Result<()> {
    let path = profile_dir(id).join("profile.json");
    let mut p: Profile = serde_json::from_value(read_json(&path).ok_or_else(|| anyhow::anyhow!("perfil não encontrado"))?)?;
    p.alias = alias.filter(|a| !a.trim().is_empty());
    fs::write(path, serde_json::to_vec_pretty(&p)?)?;
    Ok(())
}

/// Primeiro uso: importa a conta logada no ~/.claude e, se existirem, os perfis
/// do Tokaware (outro gerenciador de contas do Claude), uma única vez.
fn import() -> anyhow::Result<()> {
    let global_oauth = read_json(&claude_json()).map(|v| v["oauthAccount"].clone()).unwrap_or(Value::Null);
    let global_uuid = global_oauth["accountUuid"].as_str().map(str::to_owned);
    let global_creds = read_json(&claude_creds());

    let tokaware = home().join(".local/share/tokaware/data/cli-profiles/claude");
    let mut imported_global = false;
    for e in fs::read_dir(&tokaware).into_iter().flatten().flatten() {
        let d = e.path();
        let (Some(creds), Some(cj)) = (read_json(&d.join(CREDS)), read_json(&d.join(".claude.json"))) else { continue };
        let oauth = cj["oauthAccount"].clone();
        let id = e.file_name().to_string_lossy().into_owned();
        let is_global = global_uuid.is_some() && oauth["accountUuid"].as_str() == global_uuid.as_deref();
        // A conta ativa: o ~/.claude tem o token mais recente.
        let creds = match (&global_creds, is_global) {
            (Some(g), true) if expires_at(g) >= expires_at(&creds) => g.clone(),
            _ => creds,
        };
        imported_global |= is_global;
        save_profile(&profile_from_oauth(&id, &oauth, &creds), &creds)?;
    }
    if !imported_global {
        if let (Some(creds), Some(uuid)) = (&global_creds, &global_uuid) {
            let id = uuid.chars().take(12).collect::<String>();
            save_profile(&profile_from_oauth(&id, &global_oauth, creds), creds)?;
        }
    }
    Ok(())
}

pub fn init() {
    let _ = fs::create_dir_all(term_dir());
    // Logins pendentes abandonados.
    for e in fs::read_dir(profiles_dir()).into_iter().flatten().flatten() {
        if e.file_name().to_string_lossy().starts_with("new-") && !e.path().join(CREDS).exists() {
            let _ = fs::remove_dir_all(e.path());
        }
    }
    if list().is_empty() {
        if let Err(e) = import() {
            eprintln!("[coliseu] import de contas falhou: {e}");
        }
    }
    if active_id().filter(|id| profile_dir(id).is_dir()).is_none() {
        // Aponta `current` para a conta logada no ~/.claude (ou a primeira).
        let uuid = read_json(&claude_json()).and_then(|v| v["oauthAccount"]["accountUuid"].as_str().map(str::to_owned));
        let all = list();
        let pick = all.iter().find(|p| p.account_uuid.is_some() && p.account_uuid == uuid).or(all.first());
        if let Some(p) = pick {
            let _ = relink(&profile_dir(&p.id), &current_link());
        }
    }
    sync_mirror();
}

// ---------- Adicionar / remover ----------

// Login OAuth "manual" (o mesmo do `claude auth login`): abre a URL no navegador,
// o usuário autoriza, a página mostra um código `code#state` que é colado no app.
const AUTHORIZE_URL: &str = "https://claude.com/cai/oauth/authorize";
const MANUAL_REDIRECT_URL: &str = "https://platform.claude.com/oauth/code/callback";
const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
const SCOPES: &[&str] = &[
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
    "user:plugins",
    "user:privacy_consents:write",
];

struct Flow {
    verifier: String,
    state: String,
    created: u64,
}

static FLOWS: std::sync::LazyLock<parking_lot::Mutex<std::collections::HashMap<String, Flow>>> =
    std::sync::LazyLock::new(Default::default);

fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn random_b64(n_uuids: usize) -> String {
    let bytes: Vec<u8> = (0..n_uuids).flat_map(|_| *uuid::Uuid::new_v4().as_bytes()).collect();
    b64url(&bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStart {
    pub flow_id: String,
    pub url: String,
}

/// Gera PKCE + state e devolve a URL de autorização.
pub fn login_begin() -> LoginStart {
    use sha2::{Digest, Sha256};
    let verifier = random_b64(2); // 32 bytes aleatórios
    let challenge = b64url(&Sha256::digest(verifier.as_bytes()));
    let state = random_b64(2);
    let flow_id = random_b64(1);
    let mut u = reqwest::Url::parse(AUTHORIZE_URL).expect("url válida");
    u.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", MANUAL_REDIRECT_URL)
        .append_pair("scope", &SCOPES.join(" "))
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state);
    let mut flows = FLOWS.lock();
    flows.retain(|_, f| now_ms() - f.created < 30 * 60_000);
    flows.insert(flow_id.clone(), Flow { verifier, state, created: now_ms() });
    LoginStart { flow_id, url: u.to_string() }
}

fn plan_from_profile(p: &Value) -> Option<String> {
    let org_type = p["organization"]["organization_type"].as_str().unwrap_or_default();
    let plan = if org_type.contains("enterprise") {
        "enterprise"
    } else if org_type.contains("team") {
        "team"
    } else if p["account"]["has_claude_max"].as_bool() == Some(true) {
        "max"
    } else if p["account"]["has_claude_pro"].as_bool() == Some(true) {
        "pro"
    } else {
        return None;
    };
    Some(plan.into())
}

/// Troca o código colado pelos tokens, busca o perfil da conta e salva.
pub async fn login_finish(flow_id: &str, pasted: &str) -> anyhow::Result<Profile> {
    let pasted = pasted.trim();
    let (code, pasted_state) = match pasted.split_once('#') {
        Some((c, s)) => (c.trim(), Some(s.trim())),
        None => (pasted, None),
    };
    if code.is_empty() {
        anyhow::bail!("cole o código mostrado na página após autorizar");
    }
    let (verifier, state) = {
        let flows = FLOWS.lock();
        let f = flows.get(flow_id).ok_or_else(|| anyhow::anyhow!("login expirado — clique em “Abrir login” de novo"))?;
        (f.verifier.clone(), f.state.clone())
    };
    if pasted_state.is_some_and(|s| s != state) {
        anyhow::bail!("esse código é de outro login — abra o login de novo e cole o código novo");
    }

    let http = reqwest::Client::new();
    let resp = http
        .post(TOKEN_URL)
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": MANUAL_REDIRECT_URL,
            "client_id": CLIENT_ID,
            "code_verifier": verifier,
            "state": state,
        }))
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await?;
    if !resp.status().is_success() {
        let st = resp.status();
        anyhow::bail!(if st.as_u16() == 400 || st.as_u16() == 401 {
            "código inválido ou já usado — abra o login de novo".to_string()
        } else {
            format!("falha ao trocar o código (HTTP {st})")
        });
    }
    let tok: Value = resp.json().await?;
    FLOWS.lock().remove(flow_id);
    let access = tok["access_token"].as_str().ok_or_else(|| anyhow::anyhow!("resposta sem access_token"))?.to_owned();

    let profile: Value = http
        .get(PROFILE_URL)
        .bearer_auth(&access)
        .header("User-Agent", "coliseu/0.1")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let scopes: Vec<String> = tok["scope"]
        .as_str()
        .map(|s| s.split(' ').map(str::to_owned).collect())
        .unwrap_or_else(|| SCOPES.iter().map(|s| s.to_string()).collect());
    let plan = plan_from_profile(&profile);
    let creds = serde_json::json!({
        "claudeAiOauth": {
            "accessToken": access,
            "refreshToken": tok["refresh_token"],
            "expiresAt": now_ms() + tok["expires_in"].as_u64().unwrap_or(3600) * 1000,
            "scopes": scopes,
            "subscriptionType": plan,
            "rateLimitTier": profile["organization"]["rate_limit_tier"],
        }
    });
    let acc = &profile["account"];
    let org = &profile["organization"];
    let oauth = serde_json::json!({
        "accountUuid": acc["uuid"],
        "emailAddress": acc["email"],
        "organizationUuid": org["uuid"],
        "organizationName": org["name"],
        "displayName": acc["display_name"],
        "fullName": acc["full_name"],
        "billingType": org["billing_type"],
        "organizationRateLimitTier": org["rate_limit_tier"],
        "seatTier": org["seat_tier"],
        "hasExtraUsageEnabled": org["has_extra_usage_enabled"],
        "subscriptionCreatedAt": org["subscription_created_at"],
        "accountCreatedAt": acc["created_at"],
    });

    // Conta já existente? Atualiza as credenciais dela em vez de duplicar.
    let uuid = oauth["accountUuid"].as_str().map(str::to_owned);
    let existing = list().into_iter().find(|p| p.account_uuid.is_some() && p.account_uuid == uuid);
    let mut prof = match existing {
        Some(p) => p,
        None => profile_from_oauth(&uuid::Uuid::new_v4().simple().to_string()[..12], &oauth, &creds),
    };
    prof.plan = plan.map(|s| {
        let mut c = s.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    });
    prof.label = oauth["emailAddress"].as_str().unwrap_or(&prof.label).to_owned();
    prof.org_name = oauth["organizationName"].as_str().map(str::to_owned);
    prof.account_uuid = uuid;
    prof.oauth_account = oauth;
    save_profile(&prof, &creds)?;

    // Se for a conta ativa, o espelho ~/.claude também recebe as credenciais novas.
    if active_id().as_deref() == Some(prof.id.as_str()) {
        write_secret(&claude_creds(), &creds)?;
        write_global_oauth(&prof.oauth_account)?;
    }
    Ok(prof)
}

fn write_global_oauth(oauth: &Value) -> anyhow::Result<()> {
    if oauth.is_null() {
        return Ok(());
    }
    if let Some(mut cj) = read_json(&claude_json()) {
        cj["oauthAccount"] = oauth.clone();
        let tmp = claude_json().with_extension(format!("tmp{}", std::process::id()));
        fs::write(&tmp, serde_json::to_vec_pretty(&cj)?)?;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
        fs::rename(tmp, claude_json())?;
    }
    Ok(())
}

pub fn remove(id: &str) -> anyhow::Result<()> {
    if active_id().as_deref() == Some(id) {
        anyhow::bail!("não dá para remover a conta ativa — troque de conta antes");
    }
    if id.is_empty() || id.contains('/') || id.contains("..") {
        anyhow::bail!("id inválido");
    }
    fs::remove_dir_all(profile_dir(id))?;
    Ok(())
}

// ---------- Espelho ~/.claude ----------

/// Mantém ~/.claude/.credentials.json e o perfil ativo iguais: o mais novo vence.
pub fn sync_mirror() {
    let Some(id) = active_id() else { return };
    let Some(prof) = list().into_iter().find(|p| p.id == id) else { return };
    // Só sincroniza se o ~/.claude ainda for da mesma conta.
    let global_uuid = read_json(&claude_json()).and_then(|v| v["oauthAccount"]["accountUuid"].as_str().map(str::to_owned));
    if prof.account_uuid.is_some() && global_uuid != prof.account_uuid {
        return;
    }
    let pfile = profile_dir(&id).join(CREDS);
    let (Some(g), Some(p)) = (read_json(&claude_creds()), read_json(&pfile)) else { return };
    if g == p {
        return;
    }
    let r = if expires_at(&g) > expires_at(&p) {
        write_secret(&pfile, &g)
    } else if expires_at(&p) > expires_at(&g) {
        write_secret(&claude_creds(), &p)
    } else {
        Ok(())
    };
    if let Err(e) = r {
        eprintln!("[coliseu] sync de credenciais falhou: {e}");
    }
}

/// Troca a conta global.
pub fn switch(id: &str) -> anyhow::Result<()> {
    let dir = profile_dir(id);
    let creds = read_json(&dir.join(CREDS)).ok_or_else(|| anyhow::anyhow!("credenciais do perfil não encontradas"))?;
    let prof: Profile = serde_json::from_value(read_json(&dir.join("profile.json")).unwrap_or_default())?;
    sync_mirror(); // salva o token mais novo da conta que está saindo
    relink(&dir, &current_link())?;
    // Espelho para processos sem a variável + e-mail certo no /status.
    write_secret(&claude_creds(), &creds)?;
    write_global_oauth(&prof.oauth_account)?;
    Ok(())
}

// ---------- Conta por terminal ----------

/// Diretório que o terminal recebe em $CLAUDE_SECURESTORAGE_CONFIG_DIR.
pub fn term_link_path(term_id: &str) -> PathBuf {
    term_dir().join(term_id)
}

/// `None` = segue a conta global.
pub fn set_term_account(term_id: &str, account: Option<&str>) -> anyhow::Result<()> {
    let target = match account {
        Some(id) if profile_dir(id).is_dir() => profile_dir(id),
        Some(_) => anyhow::bail!("conta não encontrada"),
        None => current_link(),
    };
    fs::create_dir_all(term_dir())?;
    relink(&target, &term_link_path(term_id))
}

pub fn remove_term(term_id: &str) {
    let _ = fs::remove_file(term_link_path(term_id));
}

/// Remove links de terminais que não existem mais.
pub fn prune_terms(live: &[String]) {
    for e in fs::read_dir(term_dir()).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if !live.contains(&n) {
            let _ = fs::remove_file(e.path());
        }
    }
}

// ---------- Uso (5h / 7d) ----------

async fn refresh(id: &str, creds: &mut Value) -> anyhow::Result<()> {
    let rt = creds["claudeAiOauth"]["refreshToken"].as_str().ok_or_else(|| anyhow::anyhow!("sem refresh token"))?;
    let resp = reqwest::Client::new()
        .post(TOKEN_URL)
        .json(&serde_json::json!({ "grant_type": "refresh_token", "refresh_token": rt, "client_id": CLIENT_ID }))
        .send()
        .await?;
    if !resp.status().is_success() {
        anyhow::bail!("renovação recusada ({})", resp.status());
    }
    let r: Value = resp.json().await?;
    let at = r["access_token"].as_str().ok_or_else(|| anyhow::anyhow!("resposta sem access_token"))?;
    let o = &mut creds["claudeAiOauth"];
    o["accessToken"] = at.into();
    if let Some(nrt) = r["refresh_token"].as_str() {
        o["refreshToken"] = nrt.into();
    }
    if let Some(exp) = r["expires_in"].as_u64() {
        o["expiresAt"] = (now_ms() + exp * 1000).into();
    }
    // Grava IMEDIATAMENTE: o refresh token antigo deixou de valer.
    write_secret(&profile_dir(id).join(CREDS), creds)
}

fn window(v: &Value) -> Option<Window> {
    Some(Window {
        percent: v.get("utilization")?.as_f64()?,
        resets_at: v.get("resets_at").and_then(|x| x.as_str()).map(str::to_owned),
    })
}

/// `may_refresh`: pode renovar o token se expirado (só para contas que
/// nenhum processo está usando — senão quem renova é o próprio Claude).
async fn fetch_usage(id: &str, may_refresh: bool) -> (Usage, Option<u64>) {
    let mut out = Usage { fetched_at: now_ms(), ..Default::default() };
    let Some(mut creds) = read_json(&profile_dir(id).join(CREDS)) else {
        out.error = Some("credenciais não encontradas".into());
        return (out, None);
    };
    if expires_at(&creds) < now_ms() + 60_000 {
        if !may_refresh {
            out.error = Some("token expirado — abra o claude nesta conta para renovar".into());
            return (out, None);
        }
        if let Err(e) = refresh(id, &mut creds).await {
            out.error = Some(format!("{e}"));
            return (out, None);
        }
    }
    let token = creds["claudeAiOauth"]["accessToken"].as_str().unwrap_or_default().to_owned();
    let resp = reqwest::Client::new()
        .get(USAGE_URL)
        .bearer_auth(token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "coliseu/0.1")
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
    match resp {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) => {
                out.five_hour = window(&v["five_hour"]);
                out.seven_day = window(&v["seven_day"]);
            }
            Err(e) => out.error = Some(format!("resposta inválida: {e}")),
        },
        Ok(r) if r.status().as_u16() == 429 => {
            let retry = r
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.trim().parse::<u64>().ok());
            out.error = Some("limite de consultas atingido".into());
            return (out, Some(retry.unwrap_or(0)));
        }
        Ok(r) => out.error = Some(format!("HTTP {}", r.status())),
        Err(e) => out.error = Some(format!("{e}")),
    }
    (out, None)
}

// ---------- Cache de uso (evita 429) ----------

/// Intervalo mínimo entre consultas da mesma conta.
const MIN_INTERVAL_MS: u64 = 3 * 60_000;
/// Espera inicial após um 429 sem Retry-After (dobra a cada 429 seguido, até 1h).
const BACKOFF_MS: u64 = 5 * 60_000;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    /// Última resposta com números.
    good: Option<Usage>,
    /// Não consultar antes disso.
    next_at: u64,
    backoff_ms: u64,
}

static USAGE_CACHE: std::sync::LazyLock<parking_lot::Mutex<std::collections::HashMap<String, CacheEntry>>> =
    std::sync::LazyLock::new(|| {
        let m = read_json(&base().join("usage-cache.json"))
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        parking_lot::Mutex::new(m)
    });

fn save_cache(m: &std::collections::HashMap<String, CacheEntry>) {
    if let Ok(v) = serde_json::to_vec(m) {
        let p = base().join("usage-cache.json");
        let tmp = p.with_extension("tmp");
        if fs::write(&tmp, v).is_ok() {
            let _ = fs::rename(tmp, p);
        }
    }
}

/// Uso com cache: no máximo 1 consulta a cada 3 min por conta; respeita 429;
/// em caso de falha devolve o último valor bom marcado como `stale`.
pub async fn usage(id: &str, may_refresh: bool, force: bool) -> Usage {
    let now = now_ms();
    let cached = USAGE_CACHE.lock().get(id).cloned().unwrap_or_default();
    if !force && now < cached.next_at {
        if let Some(mut g) = cached.good {
            g.stale = now - g.fetched_at > MIN_INTERVAL_MS;
            return g;
        }
        return Usage { error: Some("aguardando para consultar de novo".into()), fetched_at: now, ..Default::default() };
    }

    let (fresh, rate_limited) = fetch_usage(id, may_refresh).await;
    let mut cache = USAGE_CACHE.lock();
    let entry = cache.entry(id.to_owned()).or_default();
    let result = if fresh.five_hour.is_some() || fresh.seven_day.is_some() {
        entry.good = Some(fresh.clone());
        entry.next_at = now + MIN_INTERVAL_MS;
        entry.backoff_ms = 0;
        fresh
    } else {
        let mut fresh = fresh;
        if let Some(retry) = rate_limited {
            entry.backoff_ms = if retry > 0 { retry * 1000 } else { (entry.backoff_ms * 2).clamp(BACKOFF_MS, 60 * 60_000) };
            entry.next_at = now + entry.backoff_ms;
            let mins = entry.backoff_ms.div_ceil(60_000);
            fresh.error = Some(format!("limite de consultas atingido — nova tentativa automática em {mins} min"));
        } else {
            entry.next_at = now + MIN_INTERVAL_MS;
        }
        match &entry.good {
            Some(g) => Usage { stale: true, error: fresh.error.clone(), ..g.clone() },
            None => fresh,
        }
    };
    save_cache(&cache);
    result
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore] // usa contas reais: `cargo test --lib accounts_live -- --ignored --nocapture`
    fn accounts_live() {
        super::init();
        let active = super::active_id();
        println!("ativa: {active:?}");
        let rt = tauri::async_runtime::block_on(async {
            for p in super::list() {
                let me = active.as_deref() == Some(p.id.as_str());
                let u = super::usage(&p.id, !me, true).await;
                let dom = p.label.split('@').nth(1).unwrap_or("");
                println!(
                    "{} @{dom} {:?} ativa={me} 5h={:?} 7d={:?} err={:?}",
                    p.id, p.plan, u.five_hour.map(|w| w.percent), u.seven_day.map(|w| w.percent), u.error
                );
            }
        });
        rt
    }
}

#[cfg(test)]
mod login_tests {
    #[test]
    fn login_url() {
        let s = super::login_begin();
        println!("{}", s.url);
        assert!(s.url.contains("code_challenge_method=S256"));
    }
}
