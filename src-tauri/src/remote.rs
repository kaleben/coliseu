//! Acesso pelo celular: servidor web (HTTP + WebSocket) na rede Tailscale.
//!
//! - Escuta só em 127.0.0.1 e no IP do Tailscale (nunca em 0.0.0.0).
//! - Toda requisição exige o token: na 1ª vez via `?t=<token>` (vira cookie
//!   HttpOnly e o token sai da URL); depois pelo cookie.
//! - Serve a mesma interface do desktop; a UI detecta que não está no Tauri
//!   e fala com o core por um WebSocket (JSON-RPC + frames binários dos
//!   terminais).

use crate::{config, pty, AppState};
use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State as AxState,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, net::SocketAddr, sync::LazyLock};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, watch};

const COOKIE: &str = "coliseu_t";

/// Token atual (lido a cada requisição: trocar o token derruba os acessos antigos).
static TOKEN: LazyLock<RwLock<String>> = LazyLock::new(Default::default);
/// Servidor rodando: canal para desligar + endereços.
static RUNNING: LazyLock<Mutex<Option<(watch::Sender<bool>, Vec<String>)>>> = LazyLock::new(Default::default);
static LAST_ERROR: LazyLock<Mutex<Option<String>>> = LazyLock::new(Default::default);
/// Nome servido em HTTPS (certificado do Tailscale). Fica definido assim que o
/// servidor é (re)ligado, para o link/QR já sair certo; some se o HTTPS falhar.
static HTTPS_NAME: LazyLock<Mutex<Option<String>>> = LazyLock::new(Default::default);
/// Cada apply() é uma "geração": tarefas de uma geração antiga não mexem mais em nada.
static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn current(epoch: u64) -> bool {
    GEN.load(std::sync::atomic::Ordering::SeqCst) == epoch
}
/// Conexões WebSocket abertas (para eventos enviados a todos os celulares).
static CONNS: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>> = LazyLock::new(Default::default);

/// Envia um evento `{event, payload}` a todos os aparelhos remotos conectados.
pub fn broadcast(event: &str, payload: &Value) {
    let text = json!({ "event": event, "payload": payload }).to_string();
    CONNS.lock().retain(|_, tx| tx.send(Message::Text(text.clone().into())).is_ok());
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    pub token: String,
    /// URLs prontas para abrir no celular (com o token).
    pub urls: Vec<String>,
    pub tailscale_ip: Option<String>,
    pub error: Option<String>,
}

pub fn new_token() -> String {
    use base64::Engine;
    let bytes: Vec<u8> = (0..2).flat_map(|_| *uuid::Uuid::new_v4().as_bytes()).collect();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn tailscale_ip() -> Option<String> {
    crate::tls::ipv4()
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn authed(headers: &HeaderMap) -> bool {
    let token = TOKEN.read().clone();
    if token.is_empty() {
        return false;
    }
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .any(|(k, v)| k == COOKIE && ct_eq(v, &token))
}

pub fn status(cfg: &config::RemoteCfg) -> RemoteStatus {
    let ts = tailscale_ip();
    let running = RUNNING.lock().as_ref().map(|(_, a)| a.clone());
    let mut urls = vec![];
    if let Some(name) = HTTPS_NAME.lock().clone() {
        urls.push(format!("https://{name}:{}/?t={}", cfg.port, cfg.token));
    } else if let Some(ip) = &ts {
        urls.push(format!("http://{ip}:{}/?t={}", cfg.port, cfg.token));
    }
    urls.push(format!("http://127.0.0.1:{}/?t={}", cfg.port, cfg.token));
    RemoteStatus {
        enabled: cfg.enabled,
        running: running.is_some(),
        port: cfg.port,
        token: cfg.token.clone(),
        urls,
        tailscale_ip: ts,
        error: LAST_ERROR.lock().clone(),
    }
}

pub fn stop() {
    if let Some((tx, _)) = RUNNING.lock().take() {
        let _ = tx.send(true);
    }
}

/// (Re)inicia o servidor conforme a configuração.
pub fn apply(app: &AppHandle, cfg: &config::RemoteCfg) {
    let epoch = GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    stop();
    *TOKEN.write() = cfg.token.clone();
    *LAST_ERROR.lock() = None;
    *HTTPS_NAME.lock() = None;
    if !cfg.enabled || cfg.token.is_empty() {
        return;
    }
    let local = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let ts_addr = tailscale_ip().and_then(|ip| ip.parse::<std::net::Ipv4Addr>().ok()).map(|ip| SocketAddr::from((ip, cfg.port)));
    if ts_addr.is_none() {
        *LAST_ERROR.lock() = Some("Tailscale não encontrado: só acessível nesta máquina (127.0.0.1).".into());
    }
    let (tx, rx) = watch::channel(false);
    *RUNNING.lock() = Some((tx, [Some(local), ts_addr].iter().flatten().map(|a| a.to_string()).collect()));

    let router = Router::new()
        .route("/ws", get(ws_handler))
        .fallback(get(asset_handler))
        .with_state(app.clone());

    // Nesta máquina: HTTP.
    tauri::async_runtime::spawn(serve_http(local, router.clone(), rx.clone()));
    // No Tailscale: HTTPS com o certificado da tailnet (sem ele, HTTP com aviso).
    if let Some(addr) = ts_addr {
        let name = crate::tls::dns_name();
        *HTTPS_NAME.lock() = name.clone();
        tauri::async_runtime::spawn(serve_tailscale(addr, name, router, rx, epoch));
    }
}

async fn serve_http(addr: SocketAddr, router: Router, mut rx: watch::Receiver<bool>) {
    match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = rx.wait_for(|stop| *stop).await;
                })
                .await;
        }
        Err(e) => *LAST_ERROR.lock() = Some(format!("não deu para escutar em {addr}: {e}")),
    }
}

async fn serve_tailscale(addr: SocketAddr, name: Option<String>, router: Router, mut rx: watch::Receiver<bool>, epoch: u64) {
    use axum_server::tls_rustls::RustlsConfig;
    let cert = match &name {
        Some(n) => {
            let n = n.clone();
            tokio::task::spawn_blocking(move || crate::tls::ensure(&n)).await.unwrap_or_else(|e| Err(e.to_string()))
        }
        None => Err("HTTPS do Tailscale não está ativo (painel do Tailscale → DNS → HTTPS Certificates)".into()),
    };
    // Ligado/desligado de novo enquanto o certificado vinha: esta geração acabou.
    if !current(epoch) {
        return;
    }
    let fallback = |msg: String| {
        *HTTPS_NAME.lock() = None;
        *LAST_ERROR.lock() = Some(msg);
    };
    let (name, files) = match (name, cert) {
        (Some(n), Ok(f)) => (n, f),
        (_, Err(e)) => {
            fallback(format!("Sem HTTPS ({e}): notificações no celular não funcionam."));
            return serve_http(addr, router, rx).await;
        }
        (None, Ok(_)) => unreachable!(),
    };
    let config = match RustlsConfig::from_pem_file(&files.cert, &files.key).await {
        Ok(c) => c,
        Err(e) => {
            if current(epoch) {
                fallback(format!("Certificado inválido ({e}): usando HTTP."));
                return serve_http(addr, router, rx).await;
            }
            return;
        }
    };
    if !current(epoch) {
        return;
    }

    // Renovação diária (o tailscale só troca quando está perto de vencer).
    let (renew_cfg, mut renew_rx) = (config.clone(), rx.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)) => {}
                _ = renew_rx.wait_for(|stop| *stop) => return,
            }
            let n = name.clone();
            if let Ok(Ok(f)) = tokio::task::spawn_blocking(move || crate::tls::ensure(&n)).await {
                if let Err(e) = renew_cfg.reload_from_pem_file(&f.cert, &f.key).await {
                    eprintln!("[coliseu] recarregar certificado: {e}");
                }
            }
        }
    });

    let handle = axum_server::Handle::new();
    let h = handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = rx.wait_for(|stop| *stop).await;
        h.graceful_shutdown(Some(std::time::Duration::from_secs(1)));
    });
    if let Err(e) = axum_server::bind_rustls(addr, config).handle(handle).serve(router.into_make_service()).await {
        if current(epoch) {
            *LAST_ERROR.lock() = Some(format!("não deu para escutar em {addr}: {e}"));
        }
    }
}

/// Página de acesso negado com campo para colar o link/token: o app instalado no
/// iPhone pode não herdar o cookie do Safari e não tem barra de endereço.
fn denied_page(error: Option<&str>) -> String {
    let err = error.map(|e| format!("<p style='color:#ff9f0a'>{e}</p>")).unwrap_or_default();
    format!(
        "<meta name='viewport' content='width=device-width,initial-scale=1'><style>html{{background:#000}}</style>\
         <div style='font-family:sans-serif;max-width:420px;margin:12vh auto;padding:0 20px;color:#eee'>\
         <h3>Coliseu: acesso negado.</h3>{err}<p>Abra o link (ou QR code) de Configurações → Acesso pelo celular, ou cole o link aqui:</p>\
         <form onsubmit=\"var v=this.t.value.trim(),m=v.match(/[?&]t=([^&#]+)/),t=v;try{{if(m)t=decodeURIComponent(m[1])}}catch(e){{t=m[1]}}location.href='/?t='+encodeURIComponent(t);return false\">\
         <input name='t' autocomplete='off' placeholder='link ou token' style='width:100%;font-size:16px;padding:10px;box-sizing:border-box'>\
         <button style='margin-top:10px;font-size:16px;padding:10px 16px'>Entrar</button></form></div>"
    )
}

// ---------- Arquivos da interface ----------

async fn asset_handler(
    AxState(app): AxState<AppHandle>,
    uri: Uri,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    // 1º acesso: ?t=<token> → grava o cookie e já entrega a página (a própria
    // página tira o token da barra de endereço). Sem redirecionar: links abertos
    // por outro app (câmera/QR) não levariam o cookie no redirecionamento.
    let mut set_cookie = None;
    if let Some(t) = q.get("t") {
        let token = TOKEN.read().clone();
        if token.is_empty() || !ct_eq(t, &token) {
            return (
                StatusCode::UNAUTHORIZED,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                denied_page(Some("Esse link não vale mais (o token mudou). Gere o QR de novo no desktop ou cole o link novo.")),
            )
                .into_response();
        }
        let https = headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| HTTPS_NAME.lock().as_deref().is_some_and(|n| h.starts_with(n)));
        let secure = if https { "; Secure" } else { "" };
        set_cookie = Some(format!("{COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000{secure}"));
    }
    // Ícones e manifesto não têm nada privado e alguns navegadores os buscam sem
    // cookie (ícone da tela inicial do iPhone, splash do Android).
    const PUBLIC: &[&str] = &[
        "/manifest.webmanifest",
        "/favicon.png",
        "/icon-192.png",
        "/icon-512.png",
        "/icon-maskable-192.png",
        "/icon-maskable-512.png",
        "/apple-touch-icon.png",
        "/badge-96.png",
        "/notify-icon.png",
        // Tela "sem conexão" que o service worker guarda no celular.
        "/offline.html",
    ];
    let public = PUBLIC.contains(&uri.path());
    if set_cookie.is_none() && !public && !authed(&headers) {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            denied_page(None),
        )
            .into_response();
    }
    let path = match uri.path() {
        "/" | "" => "index.html".to_owned(),
        p => p.trim_start_matches('/').to_owned(),
    };
    if path.contains("..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // Release: arquivos embutidos no binário. Dev: pasta dist/ do projeto.
    let mut resp = if let Some(asset) = app.asset_resolver().get(path.clone()) {
        ([(header::CONTENT_TYPE, asset.mime_type.clone()), (header::CACHE_CONTROL, "no-cache".into())], asset.bytes)
            .into_response()
    } else {
        let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist").join(&path);
        match std::fs::read(&dist) {
            Ok(bytes) => ([(header::CONTENT_TYPE, mime_of(&path).to_owned())], Body::from(bytes)).into_response(),
            Err(_) => StatusCode::NOT_FOUND.into_response(),
        }
    };
    if let Some(c) = set_cookie {
        if let Ok(v) = c.parse() {
            resp.headers_mut().insert(header::SET_COOKIE, v);
        }
    }
    resp
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

// ---------- WebSocket ----------

#[derive(Deserialize)]
struct Req {
    id: u64,
    cmd: String,
    #[serde(default)]
    args: Value,
}

async fn ws_handler(AxState(app): AxState<AppHandle>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    if !authed(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| conn(app, socket))
}

async fn conn(app: AppHandle, socket: WebSocket) {
    let conn_id = uuid::Uuid::new_v4().simple().to_string()[..8].to_owned();
    let (mut sender, mut receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    CONNS.lock().insert(conn_id.clone(), tx.clone());
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sender.send(m).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = receiver.next().await {
        let Message::Text(text) = msg else { continue };
        let Ok(req) = serde_json::from_str::<Req>(&text) else { continue };
        let (app, tx, conn_id) = (app.clone(), tx.clone(), conn_id.clone());
        tauri::async_runtime::spawn(async move {
            let reply = match handle(&app, &conn_id, &tx, &req.cmd, req.args).await {
                Ok(v) => json!({ "id": req.id, "ok": v }),
                Err(e) => json!({ "id": req.id, "err": e }),
            };
            let _ = tx.send(Message::Text(reply.to_string().into()));
        });
        // Mantém o token válido durante a conexão: token trocado derruba.
        if TOKEN.read().is_empty() {
            break;
        }
    }
    CONNS.lock().remove(&conn_id);
    app.state::<AppState>().clients.detach_conn(&conn_id);
    writer.abort();
}

fn arg<T: serde::de::DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null)).map_err(|e| format!("argumento {name}: {e}"))
}

fn to<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

async fn handle(app: &AppHandle, conn_id: &str, tx: &mpsc::UnboundedSender<Message>, cmd: &str, a: Value) -> Result<Value, String> {
    let st = app.state::<AppState>();
    match cmd {
        // ---- terminais: cada conexão é um cliente tmux próprio ----
        "term_attach" => {
            let id: String = arg(&a, "id")?;
            if !crate::tmux::has_session(&crate::tmux::session_name(&id)) {
                return Err("sessão não existe mais".into());
            }
            let key = format!("{id}@{conn_id}");
            let (tx_data, tx_exit, tid) = (tx.clone(), tx.clone(), id.clone());
            let prefix = id.clone();
            let sink: pty::Sink = Box::new(move |bytes| {
                let mut frame = Vec::with_capacity(bytes.len() + prefix.len() + 1);
                frame.push(prefix.len() as u8);
                frame.extend_from_slice(prefix.as_bytes());
                frame.extend_from_slice(&bytes);
                tx_data.send(Message::Binary(frame.into())).is_ok()
            });
            st.clients
                .attach(&key, &id, arg(&a, "cols")?, arg(&a, "rows")?, sink, move |gone| {
                    let ev = json!({ "event": "term-exit", "payload": { "id": tid, "gone": gone } });
                    let _ = tx_exit.send(Message::Text(ev.to_string().into()));
                })
                .map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "term_input" => {
            let id: String = arg(&a, "id")?;
            let data: String = arg(&a, "data")?;
            st.clients.write(&format!("{id}@{conn_id}"), data.as_bytes());
            Ok(Value::Null)
        }
        "term_resize" => {
            let id: String = arg(&a, "id")?;
            let (c, r): (u16, u16) = (arg(&a, "cols")?, arg(&a, "rows")?);
            st.clients.resize(&format!("{id}@{conn_id}"), c.max(2), r.max(1));
            Ok(Value::Null)
        }
        "term_claim" => {
            crate::term_claim(arg(&a, "id")?, arg(&a, "cols")?, arg(&a, "rows")?);
            Ok(Value::Null)
        }
        "term_detach" => {
            let id: String = arg(&a, "id")?;
            st.clients.detach(&format!("{id}@{conn_id}"));
            Ok(Value::Null)
        }

        // ---- mesmos comandos do desktop ----
        "state_get" => to(crate::state_get(st)),
        "state_version" => to(crate::state_version()),
        "terms_status" => to(crate::terms_status().await),
        "group_upsert" => to(crate::group_upsert(st, arg(&a, "group")?)),
        "group_delete" => to(crate::group_delete(st, arg(&a, "id")?)?),
        "term_create" => to(crate::term_create(st, arg(&a, "groupId")?, arg(&a, "cwd")?, arg(&a, "title")?, arg(&a, "account")?)?),
        "term_kill" => to(crate::term_kill(st, arg(&a, "id")?)),
        "term_update" => to(crate::term_update(st, arg(&a, "id")?, arg(&a, "title")?, arg(&a, "groupId")?)),
        "term_set_account" => to(crate::term_set_account(st, arg(&a, "id")?, arg(&a, "account")?)?),
        "settings_save" => to(crate::settings_save(st, arg(&a, "settings")?)),
        "accounts_list" => to(crate::accounts_list()),
        "account_switch" => to(crate::account_switch(arg(&a, "id")?)?),
        "account_alias" => to(crate::account_alias(arg(&a, "id")?, arg(&a, "alias")?)?),
        "account_usage" => to(crate::account_usage(st, arg(&a, "id")?, arg(&a, "force")?).await?),
        "account_login_begin" => to(crate::account_login_begin()),
        "account_login_finish" => to(crate::account_login_finish(arg(&a, "flowId")?, arg(&a, "code")?).await?),
        "account_remove" => to(crate::account_remove(st, arg(&a, "id")?)?),
        "codex_account" => to(crate::codex_account(arg(&a, "force")?).await),
        "prs_get" => to(crate::prs_get(arg(&a, "config")?, arg(&a, "force")?)),
        "prs_whoami" => to(crate::prs_whoami().await),
        "chat_open" => to(crate::chat_open(arg(&a, "id")?).await?),
        "chat_close" => to(crate::chat_close(arg(&a, "id")?).await?),
        "chat_send" => to(crate::chat_send(arg(&a, "id")?, arg(&a, "text")?)?),
        "chat_respond" => to(crate::chat_respond(arg(&a, "id")?, arg(&a, "requestId")?, arg(&a, "result")?)?),
        "chat_interrupt" => to(crate::chat_interrupt(arg(&a, "id")?)?),
        "chat_set_mode" => to(crate::chat_set_mode(arg(&a, "id")?, arg(&a, "mode")?)?),
        "chat_history" => to(crate::chat_history(arg(&a, "id")?).await?),
        "chat_states" => to(crate::chat_states()),
        "push_key" => to(crate::push::public_key()?),
        "push_subscribe" => to(crate::push::subscribe(arg(&a, "endpoint")?, arg(&a, "p256dh")?, arg(&a, "auth")?, arg(&a, "label")?)?),
        "push_unsubscribe" => to(crate::push::unsubscribe(&arg::<String>(&a, "endpoint")?)?),
        "push_test" => to(crate::push::send_test(&arg::<String>(&a, "endpoint")?).await?),
        "push_devices" => to(crate::push::device_list()),
        // O layout de abas é por aparelho (o celular guarda o seu localmente);
        // notificações nativas e acesso remoto só fazem sentido no desktop.
        "layout_save" | "notify" => Ok(Value::Null),
        _ => Err(format!("comando não disponível remotamente: {cmd}")),
    }
}
