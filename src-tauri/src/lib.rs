mod accounts;
mod agents;
mod chat;
mod codex;
mod config;
mod context;
mod files;
mod notify;
mod onboard;
mod prs;
mod pty;
mod push;
mod remote;
mod snapshot;
mod tmux;
mod tls;

use config::{Config, Group, Terminal};
use parking_lot::Mutex;
use serde::Serialize;
use std::{collections::HashMap, sync::Arc};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Emitter, Manager, State,
};

#[derive(Default)]
struct AppState {
    cfg: Arc<Mutex<Config>>,
    clients: pty::Clients,
}

type Res<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Muda a cada alteração de grupos/terminais/configurações (não de layout):
/// desktop e celular comparam para saber quando recarregar.
static CFG_VERSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn persist(cfg: &Config) {
    if let Err(e) = config::save(cfg) {
        eprintln!("[coliseu] falha ao salvar config: {e}");
    }
    CFG_VERSION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn state_version() -> u64 {
    CFG_VERSION.load(std::sync::atomic::Ordering::Relaxed)
}

/// Alinha a config com as sessões que realmente existem no tmux.
fn reconcile(cfg: &mut Config) {
    // Sessões que sumiram (reboot): restaura a partir do snapshot, se houver.
    let before = tmux::list_sessions();
    for t in cfg.terminals.iter().filter(|t| !before.contains(&tmux::session_name(&t.id))) {
        if !snapshot::has_snapshot(&t.id) || accounts::set_term_account(&t.id, t.account.as_deref()).is_err() {
            continue;
        }
        let env = [(accounts::ENV_VAR.to_owned(), accounts::term_link_path(&t.id).to_string_lossy().into_owned())];
        snapshot::restore(&t.id, &t.cwd, &env);
    }
    let live = tmux::list_sessions();
    cfg.terminals.retain(|t| live.contains(&tmux::session_name(&t.id)));
    // Sessões órfãs (ex.: criadas por outro cliente) entram no primeiro grupo.
    if let Some(first) = cfg.groups.first().map(|g| g.id.clone()) {
        let panes = tmux::panes();
        for s in live {
            let Some(id) = s.strip_prefix("cs-") else { continue };
            if cfg.terminals.iter().any(|t| t.id == id) {
                continue;
            }
            let cwd = panes.get(&s).map(|p| p.path.clone()).unwrap_or_default();
            cfg.terminals.push(Terminal {
                id: id.into(),
                group_id: first.clone(),
                title: "recuperado".into(),
                cwd,
                account: None,
                created_at: now_ms(),
            });
        }
    }
}

#[tauri::command]
fn state_get(st: State<AppState>) -> Config {
    let mut cfg = st.cfg.lock();
    let before = serde_json::to_string(&cfg.terminals).unwrap_or_default();
    reconcile(&mut cfg);
    let ids = cfg.terminals.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
    accounts::prune_terms(&ids);
    snapshot::prune(&ids);
    // Só grava (e muda a versão) se algo mudou de fato.
    if serde_json::to_string(&cfg.terminals).unwrap_or_default() != before {
        persist(&cfg);
    }
    cfg.clone()
}

#[tauri::command]
fn group_upsert(st: State<AppState>, group: Group) -> Config {
    let mut cfg = st.cfg.lock();
    match cfg.groups.iter_mut().find(|g| g.id == group.id) {
        Some(g) => *g = group,
        None => cfg.groups.push(group),
    }
    persist(&cfg);
    cfg.clone()
}

#[tauri::command]
fn group_delete(st: State<AppState>, id: String) -> Res<Config> {
    let mut cfg = st.cfg.lock();
    if cfg.terminals.iter().any(|t| t.group_id == id) {
        return Err("Feche os terminais do grupo antes de removê-lo.".into());
    }
    cfg.groups.retain(|g| g.id != id);
    persist(&cfg);
    Ok(cfg.clone())
}

#[tauri::command]
fn term_create(
    st: State<AppState>,
    group_id: String,
    cwd: Option<String>,
    title: Option<String>,
    account: Option<String>,
) -> Res<Terminal> {
    let mut cfg = st.cfg.lock();
    let group = cfg.groups.iter().find(|g| g.id == group_id).ok_or("grupo não encontrado")?.clone();
    let cwd = config::resolve_cwd(cwd.as_deref().unwrap_or(&group.cwd));
    let id = uuid::Uuid::new_v4().simple().to_string()[..10].to_owned();
    // Conta: explícita > padrão do grupo > global.
    let account = account.or(group.account.clone()).filter(|a| !a.is_empty());
    accounts::set_term_account(&id, account.as_deref()).map_err(err)?;
    let env = [(
        accounts::ENV_VAR.to_owned(),
        accounts::term_link_path(&id).to_string_lossy().into_owned(),
    )];
    tmux::new_session(&tmux::session_name(&id), &cwd, &env, None).map_err(err)?;
    let n = cfg.terminals.iter().filter(|t| t.group_id == group_id).count() + 1;
    let term = Terminal {
        id,
        group_id: group.id.clone(),
        title: title.unwrap_or_else(|| format!("{} {}", group.name, n)),
        cwd,
        account,
        created_at: now_ms(),
    };
    cfg.terminals.push(term.clone());
    persist(&cfg);
    Ok(term)
}

#[tauri::command]
fn term_attach(
    app: AppHandle,
    st: State<AppState>,
    id: String,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
) -> Res<()> {
    if !tmux::has_session(&tmux::session_name(&id)) {
        return Err("sessão não existe mais".into());
    }
    let cfg = st.cfg.clone();
    let tid = id.clone();
    let sink: pty::Sink = Box::new(move |bytes| on_data.send(InvokeResponseBody::Raw(bytes)).is_ok());
    st.clients
        .attach(&id, &id, cols, rows, sink, move |session_gone| {
            if session_gone {
                accounts::remove_term(&tid);
                snapshot::remove(&tid);
                let mut c = cfg.lock();
                c.terminals.retain(|t| t.id != tid);
                persist(&c);
            }
            let _ = app.emit("term-exit", serde_json::json!({ "id": tid, "gone": session_gone }));
        })
        .map_err(err)
}

#[tauri::command]
fn term_input(st: State<AppState>, id: String, data: String) {
    st.clients.write(&id, data.as_bytes());
}

#[tauri::command]
fn term_resize(st: State<AppState>, id: String, cols: u16, rows: u16) {
    st.clients.resize(&id, cols.max(2), rows.max(1));
}

/// O aparelho que focou o terminal assume o tamanho dele.
#[tauri::command]
fn term_claim(id: String, cols: u16, rows: u16) {
    tmux::claim_size(&tmux::session_name(&id), cols, rows);
}

#[tauri::command]
fn term_detach(st: State<AppState>, id: String) {
    st.clients.detach(&id);
}

#[tauri::command]
fn term_kill(st: State<AppState>, id: String) -> Config {
    st.clients.detach_all_of(&id);
    tmux::kill_session(&tmux::session_name(&id));
    accounts::remove_term(&id);
    snapshot::remove(&id);
    let mut cfg = st.cfg.lock();
    cfg.terminals.retain(|t| t.id != id);
    persist(&cfg);
    cfg.clone()
}

#[tauri::command]
fn term_update(st: State<AppState>, id: String, title: Option<String>, group_id: Option<String>) -> Config {
    let mut cfg = st.cfg.lock();
    if let Some(t) = cfg.terminals.iter_mut().find(|t| t.id == id) {
        if let Some(title) = title {
            t.title = title;
        }
        if let Some(g) = group_id {
            t.group_id = g;
        }
    }
    persist(&cfg);
    cfg.clone()
}

#[tauri::command]
fn layout_save(st: State<AppState>, layout: serde_json::Value) {
    let mut cfg = st.cfg.lock();
    cfg.layout = layout;
    // Layout é do desktop: grava sem mudar a versão (não força recarga no celular).
    if let Err(e) = config::save(&cfg) {
        eprintln!("[coliseu] falha ao salvar layout: {e}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountsState {
    accounts: Vec<accounts::Profile>,
    active: Option<String>,
}

#[tauri::command]
fn accounts_list() -> AccountsState {
    accounts::sync_mirror();
    AccountsState { accounts: accounts::list(), active: accounts::active_id() }
}

#[tauri::command]
fn account_switch(id: String) -> Res<AccountsState> {
    accounts::switch(&id).map_err(err)?;
    Ok(accounts_list())
}

#[tauri::command]
fn account_alias(id: String, alias: Option<String>) -> Res<AccountsState> {
    accounts::update_alias(&id, alias).map_err(err)?;
    Ok(accounts_list())
}

#[tauri::command]
async fn account_usage(st: State<'_, AppState>, id: String, force: Option<bool>) -> Result<accounts::Usage, String> {
    // Só renova token de conta que nenhum processo usa: não ativa e não fixada em terminal.
    let pinned = st.cfg.lock().terminals.iter().any(|t| t.account.as_deref() == Some(&id));
    let may_refresh = accounts::active_id().as_deref() != Some(&id) && !pinned;
    Ok(accounts::usage(&id, may_refresh, force.unwrap_or(false)).await)
}

#[tauri::command]
fn account_login_begin() -> accounts::LoginStart {
    accounts::login_begin()
}

#[tauri::command]
async fn account_login_finish(flow_id: String, code: String) -> Result<accounts::Profile, String> {
    accounts::login_finish(&flow_id, &code).await.map_err(err)
}

#[tauri::command]
fn account_remove(st: State<AppState>, id: String) -> Res<AccountsState> {
    accounts::remove(&id).map_err(err)?;
    // Terminais/grupos fixados nessa conta voltam a seguir a global.
    let mut cfg = st.cfg.lock();
    for t in cfg.terminals.iter_mut().filter(|t| t.account.as_deref() == Some(&id)) {
        t.account = None;
        let _ = accounts::set_term_account(&t.id, None);
    }
    for g in cfg.groups.iter_mut().filter(|g| g.account.as_deref() == Some(&id)) {
        g.account = None;
    }
    persist(&cfg);
    drop(cfg);
    Ok(accounts_list())
}

#[tauri::command]
fn term_set_account(st: State<AppState>, id: String, account: Option<String>) -> Res<Config> {
    let account = account.filter(|a| !a.is_empty());
    accounts::set_term_account(&id, account.as_deref()).map_err(err)?;
    let mut cfg = st.cfg.lock();
    if let Some(t) = cfg.terminals.iter_mut().find(|t| t.id == id) {
        t.account = account;
    }
    persist(&cfg);
    Ok(cfg.clone())
}

#[tauri::command]
async fn codex_account(force: Option<bool>) -> codex::CodexAccount {
    codex::account_live(force.unwrap_or(false)).await
}

#[tauri::command]
fn prs_get(config: prs::PrConfig, force: Option<bool>) -> prs::PrState {
    prs::get(config, force.unwrap_or(false))
}

/// Conta logada no `gh` (para as configurações de PRs). None: sem gh ou sem login.
#[tauri::command]
async fn prs_whoami() -> Option<String> {
    tauri::async_runtime::spawn_blocking(prs::gh_user).await.ok().flatten()
}

#[tauri::command]
async fn setup_check() -> onboard::Check {
    tauri::async_runtime::spawn_blocking(onboard::check).await.unwrap_or_default()
}

#[tauri::command]
fn fs_list(st: State<AppState>, path: String) -> Res<Vec<files::Entry>> {
    let groups = st.cfg.lock().groups.clone();
    files::list(&groups, &path)
}

#[tauri::command]
async fn fs_read(st: State<'_, AppState>, path: String) -> Res<files::FileContent> {
    let groups = st.cfg.lock().groups.clone();
    tauri::async_runtime::spawn_blocking(move || files::read(&groups, &path)).await.map_err(err)?
}

#[tauri::command]
async fn fs_write(st: State<'_, AppState>, path: String, text: String, mtime: Option<u64>) -> Res<u64> {
    let groups = st.cfg.lock().groups.clone();
    tauri::async_runtime::spawn_blocking(move || files::write(&groups, &path, &text, mtime)).await.map_err(err)?
}

#[tauri::command]
fn fs_open(st: State<AppState>, path: String) -> Res<()> {
    let groups = st.cfg.lock().groups.clone();
    let p = files::inside_groups(&groups, &path)?;
    tauri_plugin_opener::open_path(p, None::<&str>).map_err(err)
}

#[tauri::command]
fn fs_reveal(st: State<AppState>, path: String) -> Res<()> {
    let groups = st.cfg.lock().groups.clone();
    let p = files::inside_groups(&groups, &path)?;
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(err)
}

#[tauri::command]
async fn setup_projects() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(onboard::projects).await.unwrap_or_default()
}

#[tauri::command]
fn voice_set(on: bool) -> Res<()> {
    onboard::voice_set(on).map_err(err)
}

#[tauri::command]
fn remote_status(st: State<AppState>) -> remote::RemoteStatus {
    remote::status(&st.cfg.lock().remote)
}

#[tauri::command]
fn remote_set(app: AppHandle, st: State<AppState>, enabled: bool, port: Option<u16>) -> remote::RemoteStatus {
    let mut cfg = st.cfg.lock();
    cfg.remote.enabled = enabled;
    if let Some(p) = port.filter(|p| *p >= 1024) {
        cfg.remote.port = p;
    }
    if cfg.remote.token.is_empty() {
        cfg.remote.token = remote::new_token();
    }
    persist(&cfg);
    let rc = cfg.remote.clone();
    drop(cfg);
    remote::apply(&app, &rc);
    std::thread::sleep(std::time::Duration::from_millis(300)); // deixa o bind acontecer
    remote::status(&rc)
}

/// Gera um token novo: links/QR antigos (e celulares já conectados) deixam de funcionar.
#[tauri::command]
fn remote_new_token(app: AppHandle, st: State<AppState>) -> remote::RemoteStatus {
    let mut cfg = st.cfg.lock();
    cfg.remote.token = remote::new_token();
    persist(&cfg);
    let rc = cfg.remote.clone();
    drop(cfg);
    remote::apply(&app, &rc);
    std::thread::sleep(std::time::Duration::from_millis(300));
    remote::status(&rc)
}

// ---------- Modo chat ----------

#[tauri::command]
async fn chat_open(id: String) -> Result<chat::ChatState, String> {
    tauri::async_runtime::spawn_blocking(move || chat::open(&id)).await.map_err(err)?
}

#[tauri::command]
async fn chat_close(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || chat::close_to_terminal(&id)).await.map_err(err)?
}

#[tauri::command]
fn chat_send(id: String, text: String) -> Res<()> {
    chat::send(&id, &text)
}

#[tauri::command]
fn chat_respond(id: String, request_id: String, result: serde_json::Value) -> Res<()> {
    chat::respond(&id, &request_id, result)
}

#[tauri::command]
fn chat_interrupt(id: String) -> Res<()> {
    chat::interrupt(&id)
}

#[tauri::command]
fn chat_set_mode(id: String, mode: String) -> Res<()> {
    chat::set_mode(&id, &mode)
}

#[tauri::command]
async fn chat_history(id: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || chat::history(&id)).await.map_err(err)?
}

#[tauri::command]
fn chat_states() -> Vec<chat::ChatState> {
    chat::states()
}

#[tauri::command]
fn settings_save(st: State<AppState>, settings: serde_json::Value) {
    let mut cfg = st.cfg.lock();
    cfg.settings = settings;
    persist(&cfg);
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String, term_id: Option<String>, sound: bool, push: Option<bool>, desktop: Option<bool>) {
    if push.unwrap_or(false) {
        push::send_all(title.clone(), body.clone(), term_id.clone());
    }
    if desktop.unwrap_or(true) {
        notify::send(app, title, body, term_id, sound);
    }
}

// ---------- Push (notificações no celular) ----------

#[tauri::command]
fn push_key() -> Result<String, String> {
    push::public_key()
}

#[tauri::command]
fn push_subscribe(endpoint: String, p256dh: String, auth: String, label: String) -> Result<(), String> {
    push::subscribe(endpoint, p256dh, auth, label)
}

#[tauri::command]
fn push_unsubscribe(endpoint: String) -> Result<(), String> {
    push::unsubscribe(&endpoint)
}

#[tauri::command]
async fn push_test(endpoint: String) -> Result<(), String> {
    push::send_test(&endpoint).await
}

#[tauri::command]
fn push_devices() -> Vec<push::DeviceInfo> {
    push::device_list()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TermStatus {
    command: String,
    path: String,
    title: String,
    claude: Option<agents::ClaudeInfo>,
}

/// Status leve de cada terminal (comando em foreground, cwd, título OSC).
#[tauri::command]
async fn terms_status() -> HashMap<String, TermStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        let panes = tmux::panes();
        let mut claude = agents::scan_panes(&panes);
        panes
            .into_iter()
            .filter_map(|(s, p)| {
                let id = s.strip_prefix("cs-")?.to_owned();
                // Terminal em modo chat: o estado vem do chat.
                let mut c = match chat::claude_info(&id) {
                    Some(mut ci) => {
                        ci.subagents = agents::subagents_of(&ci.session_id);
                        Some(ci)
                    }
                    None => claude.remove(&s),
                };
                // Contexto em uso (o chat já traz o dele).
                if let Some(ci) = c.as_mut().filter(|ci| ci.kind == "claude" && ci.context.is_none()) {
                    ci.context = crate::context::for_session(&ci.session_id);
                }
                Some((id, TermStatus { command: p.command, path: p.path, title: p.title, claude: c }))
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tmux::init();
    accounts::init();
    // Mantém ~/.claude/.credentials.json e o perfil ativo sincronizados.
    std::thread::spawn(|| loop {
        std::thread::sleep(std::time::Duration::from_secs(20));
        accounts::sync_mirror();
    });
    let state = AppState { cfg: Arc::new(Mutex::new(config::load())), ..Default::default() };
    // Snapshots para restaurar após reboot (só grava terminais com atividade).
    let snap_cfg = state.cfg.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let ids: Vec<String> = snap_cfg.lock().terminals.iter().map(|t| t.id.clone()).collect();
        snapshot::snapshot_all(&ids, false);
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(|app| {
            if let (Some(p), Some(w)) = (config::profile(), app.get_webview_window("main")) {
                let _ = w.set_title(&format!("Coliseu ({p})"));
            }
            chat::init(app.handle());
            // Acesso pelo celular, se estava ligado.
            let rc = app.state::<AppState>().cfg.lock().remote.clone();
            remote::apply(app.handle(), &rc);
            Ok(())
        })
        .on_window_event(|w, e| {
            if let tauri::WindowEvent::CloseRequested { .. } = e {
                chat::return_all_to_terminals();
                let ids: Vec<String> = w.state::<AppState>().cfg.lock().terminals.iter().map(|t| t.id.clone()).collect();
                snapshot::snapshot_all(&ids, true);
            }
        })
        .invoke_handler(tauri::generate_handler![
            state_get,
            group_upsert,
            group_delete,
            term_create,
            term_attach,
            term_input,
            term_resize,
            term_detach,
            term_claim,
            term_kill,
            term_update,
            layout_save,
            settings_save,
            accounts_list,
            account_switch,
            account_alias,
            account_usage,
            term_set_account,
            account_login_begin,
            account_login_finish,
            account_remove,
            codex_account,
            prs_get,
            prs_whoami,
            state_version,
            remote_status,
            remote_set,
            remote_new_token,
            chat_open,
            chat_close,
            chat_send,
            chat_respond,
            chat_interrupt,
            chat_set_mode,
            chat_history,
            chat_states,
            push_key,
            push_subscribe,
            push_unsubscribe,
            push_test,
            push_devices,
            notify,
            terms_status,
            setup_check,
            setup_projects,
            voice_set,
            fs_list,
            fs_read,
            fs_write,
            fs_open,
            fs_reveal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
