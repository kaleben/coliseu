//! Web Push para o celular (docs/NOTIFY_SPEC.md).
//!
//! Layout em ~/.local/share/coliseu/push[-<perfil>]/:
//!   vapid.pem   chave do servidor (gerada uma vez; permissão 600)
//!   subs.json   aparelhos inscritos
//!
//! O conteúdo vai criptografado (aes128gcm): o serviço de push do navegador
//! (Google, no Android) só entrega, não lê.

use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use web_push::{ContentEncoding, SubscriptionInfo, Urgency, VapidSignatureBuilder, WebPushMessageBuilder};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    /// Nome para mostrar ("Chrome · Android").
    pub label: String,
    pub created_at: u64,
    /// Recusas seguidas (401/403). Uma pode ser passageira; várias = inscrição com chave antiga.
    #[serde(default)]
    pub auth_fails: u32,
}

static LOCK: Mutex<()> = Mutex::new(());
/// Chave VAPID lida/gerada uma vez (a trava evita duas chaves no 1º uso simultâneo).
static VAPID: Mutex<Option<Vec<u8>>> = Mutex::new(None);
/// Um serviço de push travado não pode segurar os outros avisos.
static HTTP: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().unwrap_or_default()
});

/// O que a lista de aparelhos mostra (sem as chaves de criptografia de cada um).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub endpoint: String,
    pub label: String,
    pub created_at: u64,
}

fn dir() -> PathBuf {
    let name = match crate::config::profile() {
        Some(p) => format!("push-{p}"),
        None => "push".into(),
    };
    crate::accounts::base().join(name)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Chave VAPID (PEM). Gerada com o openssl na primeira vez.
fn vapid_pem() -> Result<Vec<u8>, String> {
    let mut cache = VAPID.lock();
    if let Some(k) = cache.as_ref() {
        return Ok(k.clone());
    }
    let d = dir();
    let f = d.join("vapid.pem");
    if let Ok(b) = std::fs::read(&f) {
        *cache = Some(b.clone());
        return Ok(b);
    }
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let out = std::process::Command::new("openssl")
        .args(["ecparam", "-name", "prime256v1", "-genkey", "-noout"])
        .output()
        .map_err(|e| format!("openssl: {e}"))?;
    if !out.status.success() || out.stdout.is_empty() {
        return Err("não deu para gerar a chave do push (openssl)".into());
    }
    write_private(&f, &out.stdout)?;
    *cache = Some(out.stdout.clone());
    Ok(out.stdout)
}

/// Grava com permissão 600 desde a criação.
fn write_private(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    f.write_all(data).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Chave pública para o navegador (applicationServerKey), base64url sem "=".
pub fn public_key() -> Result<String, String> {
    use base64::Engine;
    let pem = vapid_pem()?;
    let b = VapidSignatureBuilder::from_pem_no_sub(pem.as_slice()).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b.get_public_key()))
}

/// Lista para mostrar (desktop e celular).
pub fn device_list() -> Vec<DeviceInfo> {
    devices()
        .into_iter()
        .map(|d| DeviceInfo { endpoint: d.endpoint, label: d.label, created_at: d.created_at })
        .collect()
}

fn devices() -> Vec<Device> {
    std::fs::read(dir().join("subs.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(list: &[Device]) -> Result<(), String> {
    std::fs::create_dir_all(dir()).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
    write_private(&dir().join("subs.json"), &data)
}

/// Inscreve (ou atualiza) um aparelho.
pub fn subscribe(endpoint: String, p256dh: String, auth: String, label: String) -> Result<(), String> {
    if !endpoint.starts_with("https://") {
        return Err("endereço de push inválido".into());
    }
    let _g = LOCK.lock();
    let mut list = devices();
    // O app reenvia a inscrição a cada abertura: mantém a data original e só grava se mudou.
    if let Some(d) = list.iter_mut().find(|d| d.endpoint == endpoint) {
        if d.p256dh == p256dh && d.auth == auth && d.label == label {
            return Ok(());
        }
        (d.p256dh, d.auth, d.label) = (p256dh, auth, label);
    } else {
        list.push(Device { endpoint, p256dh, auth, label, created_at: now_ms(), auth_fails: 0 });
    }
    save(&list)
}

pub fn unsubscribe(endpoint: &str) -> Result<(), String> {
    let _g = LOCK.lock();
    let mut list = devices();
    list.retain(|d| d.endpoint != endpoint);
    save(&list)
}

/// Envia para todos os aparelhos (em segundo plano). Inscrição vencida (404/410) é removida.
pub fn send_all(title: String, body: String, term_id: Option<String>) {
    let list = devices();
    if list.is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let payload = json!({ "title": title, "body": body, "termId": term_id }).to_string();
        let results = futures_util::future::join_all(list.iter().map(|d| send_one(d, &payload))).await;
        let (mut gone, mut denied, mut ok) = (vec![], vec![], vec![]);
        for (d, r) in list.iter().zip(results) {
            match r {
                Ok(()) => ok.push(d.endpoint.clone()),
                Err(SendErr::Gone) => gone.push(d.endpoint.clone()),
                Err(SendErr::Denied(e)) => {
                    eprintln!("[coliseu] push recusado ({}): {e}", d.label);
                    denied.push(d.endpoint.clone());
                }
                Err(SendErr::Other(e)) => eprintln!("[coliseu] push falhou ({}): {e}", d.label),
            }
        }
        // Atualiza a lista só se algo mudou: vencidas saem; recusadas 3x seguidas também.
        let changed = !gone.is_empty() || !denied.is_empty() || list.iter().any(|d| d.auth_fails > 0 && ok.contains(&d.endpoint));
        if changed {
            let _g = LOCK.lock();
            let mut cur = devices();
            for d in cur.iter_mut() {
                if denied.contains(&d.endpoint) {
                    d.auth_fails += 1;
                } else if ok.contains(&d.endpoint) {
                    d.auth_fails = 0;
                }
            }
            cur.retain(|d| !gone.contains(&d.endpoint) && d.auth_fails < 3);
            let _ = save(&cur);
        }
    });
}

/// Notificação de teste para um aparelho.
pub async fn send_test(endpoint: &str) -> Result<(), String> {
    let d = devices().into_iter().find(|d| d.endpoint == endpoint).ok_or("aparelho não inscrito")?;
    let payload = json!({ "title": "Coliseu", "body": "Notificações funcionando neste aparelho.", "termId": null }).to_string();
    match send_one(&d, &payload).await {
        Ok(()) => Ok(()),
        Err(SendErr::Gone) => {
            let _ = unsubscribe(endpoint);
            Err("a inscrição deste aparelho expirou; ative de novo".into())
        }
        Err(SendErr::Denied(e)) => Err(format!("o serviço de push recusou ({e}); desative e ative de novo no celular")),
        Err(SendErr::Other(e)) => Err(e),
    }
}

enum SendErr {
    /// Inscrição vencida (404/410): sai na hora.
    Gone,
    /// Recusa (401/403): pode ser passageira; 3 seguidas tiram o aparelho.
    Denied(String),
    Other(String),
}

async fn send_one(d: &Device, payload: &str) -> Result<(), SendErr> {
    let other = |e: &dyn std::fmt::Display| SendErr::Other(e.to_string());
    let info = SubscriptionInfo::new(d.endpoint.as_str(), d.p256dh.as_str(), d.auth.as_str());
    let pem = vapid_pem().map_err(|e| other(&e))?;
    let mut sig = VapidSignatureBuilder::from_pem(pem.as_slice(), &info).map_err(|e| other(&e))?;
    // Contato exigido pelo protocolo (a Apple recusa localhost/.invalid). Genérico de
    // propósito: nada pessoal sai daqui.
    sig.add_claim("sub", "mailto:notificacoes@coliseu.app");
    let sig = sig.build().map_err(|e| other(&e))?;

    let mut b = WebPushMessageBuilder::new(&info);
    b.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
    b.set_vapid_signature(sig);
    b.set_ttl(4 * 3600); // aviso velho não interessa
    b.set_urgency(Urgency::High);
    let msg = b.build().map_err(|e| other(&e))?;

    let mut req = HTTP.post(msg.endpoint.to_string()).header("TTL", msg.ttl.to_string());
    if let Some(u) = msg.urgency {
        req = req.header("Urgency", u.to_string());
    }
    if let Some(p) = msg.payload {
        req = req
            .header("Content-Encoding", p.content_encoding.to_str())
            .header("Content-Type", "application/octet-stream");
        for (k, v) in p.crypto_headers {
            req = req.header(k, v);
        }
        req = req.body(p.content);
    }
    let res = req.send().await.map_err(|e| other(&e))?;
    match res.status().as_u16() {
        200..=299 => Ok(()),
        // 404/410: inscrição vencida. 401/403: recusa (contada; 3 seguidas tiram o aparelho).
        404 | 410 => Err(SendErr::Gone),
        401 | 403 => Err(SendErr::Denied(format!("HTTP {}", res.status().as_u16()))),
        s => Err(SendErr::Other(format!("HTTP {s}: {}", res.text().await.unwrap_or_default().chars().take(200).collect::<String>()))),
    }
}
