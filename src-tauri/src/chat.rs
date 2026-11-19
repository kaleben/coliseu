//! Modo chat: o Claude Code de um terminal passa a rodar pelo Agent SDK, num
//! processo auxiliar Node (`sidecar/agent.mjs`). Spec: docs/CHAT_SPEC.md.
//!
//! - `chatId == termId` (um chat por terminal).
//! - Terminal e chat nunca rodam a mesma sessão ao mesmo tempo: abrir o chat
//!   encerra o Claude do terminal (SIGTERM); voltar ao terminal fecha o chat e
//!   digita `claude --resume <sessão>` no terminal. Se o chat cair por erro, a
//!   sessão é retomada no terminal automaticamente.

use crate::{accounts, agents::ClaudeInfo, snapshot, tmux};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        LazyLock, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatState {
    pub term_id: String,
    pub session_id: Option<String>,
    pub busy: bool,
    /// Pedidos de permissão/pergunta aguardando resposta (eventos `permission`).
    pub pending: Vec<Value>,
    /// Modo de permissão atual (o SDK informa o real no `init`).
    pub mode: String,
    pub allow_bypass: bool,
    pub cwd: String,
    /// Opções do `claude` original (para voltar ao terminal igual).
    pub args: Vec<String>,
    /// Desde quando está no estado atual (ms).
    pub since: u64,
    /// `true` enquanto "voltar ao terminal" está em andamento.
    #[serde(skip)]
    closing: bool,
    /// `false` enquanto a abertura (reserva → encerrar terminal → start) não terminou.
    #[serde(skip)]
    ready: bool,
    /// Geração do processo auxiliar que roda este chat.
    #[serde(skip)]
    epoch: u64,
}

struct Sidecar {
    stdin: ChildStdin,
    child: Child,
    epoch: u64,
}

static APP: OnceLock<AppHandle> = OnceLock::new();
static SIDECAR: LazyLock<Mutex<Option<Sidecar>>> = LazyLock::new(Default::default);
static CHATS: LazyLock<Mutex<HashMap<String, ChatState>>> = LazyLock::new(Default::default);
static WAITERS: LazyLock<Mutex<HashMap<u64, std::sync::mpsc::Sender<Value>>>> = LazyLock::new(Default::default);
static REQ: AtomicU64 = AtomicU64::new(1);
static EPOCH: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// Pasta do processo auxiliar: $COLISEU_SIDECAR_DIR, ao lado do projeto do
/// executável (target/<perfil>/coliseu → ../../../sidecar), ou a do build.
fn sidecar_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("COLISEU_SIDECAR_DIR") {
        return PathBuf::from(d);
    }
    if let Some(d) = std::env::current_exe().ok().and_then(|e| Some(e.parent()?.join("../../../sidecar"))) {
        if d.join("agent.mjs").exists() {
            return d;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../sidecar")
}

/// Executa no shell de login (o app aberto pelo menu não tem o PATH do nvm etc.).
/// A saída vem entre marcadores: mensagens que o ~/.profile imprima não contaminam o valor.
fn login_shell(cmd: &str) -> Option<String> {
    let script = format!("__v=$({cmd}); printf '\\n@@COLISEU@@%s@@COLISEU@@\\n' \"$__v\"");
    let out = Command::new("bash").args(["-lc", &script]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let v = text.split("@@COLISEU@@").nth(1)?.trim().to_owned();
    (!v.is_empty()).then_some(v)
}

/// Cache só de sucesso: se falhar (Node ainda não instalado), tenta de novo depois.
fn cached(slot: &'static Mutex<Option<String>>, f: impl FnOnce() -> Option<String>) -> Option<String> {
    if let Some(v) = slot.lock().clone() {
        return Some(v);
    }
    let v = f()?;
    *slot.lock() = Some(v.clone());
    Some(v)
}

fn node_path() -> Option<String> {
    static C: LazyLock<Mutex<Option<String>>> = LazyLock::new(Default::default);
    cached(&C, || login_shell("command -v node"))
}

fn login_path() -> Option<String> {
    static C: LazyLock<Mutex<Option<String>>> = LazyLock::new(Default::default);
    cached(&C, || login_shell("printf %s \"$PATH\""))
}

/// `claude` do usuário (mesma versão/login do terminal).
fn claude_path() -> String {
    let p = crate::config::home().join(".local/bin/claude");
    if p.exists() {
        return p.to_string_lossy().into_owned();
    }
    static C: LazyLock<Mutex<Option<String>>> = LazyLock::new(Default::default);
    cached(&C, || login_shell("command -v claude")).unwrap_or_else(|| "claude".into())
}

fn emit(v: &Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit("chat-event", v.clone());
    }
    crate::remote::broadcast("chat-event", v);
}

/// Garante o processo auxiliar rodando; devolve a geração dele.
fn ensure_sidecar() -> Result<u64, String> {
    let mut guard = SIDECAR.lock();
    if let Some(s) = guard.as_mut() {
        if s.child.try_wait().map(|st| st.is_none()).unwrap_or(false) {
            return Ok(s.epoch);
        }
    }
    let node = node_path().ok_or("Node.js não encontrado (necessário para o modo chat)")?;
    let dir = sidecar_dir();
    let script = dir.join("agent.mjs");
    if !script.exists() {
        return Err(format!("processo do chat não encontrado em {}", script.display()));
    }
    let mut env = tmux::clean_env();
    if let Some(p) = login_path() {
        // O `claude` (e o node do shebang dele) precisam do PATH do login.
        env.retain(|(k, _)| k != "PATH");
        env.push(("PATH".into(), p));
    }
    let mut child = Command::new(node)
        .arg(&script)
        .current_dir(&dir)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("não deu para iniciar o processo do chat: {e}"))?;
    let stdout = child.stdout.take().ok_or("sem stdout do processo do chat")?;
    let stdin = child.stdin.take().ok_or("sem stdin do processo do chat")?;
    let epoch = EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                handle_event(v);
            }
        }
        // Este processo caiu: só os chats DELE acabaram (um novo pode já estar rodando).
        let dead: Vec<ChatState> = {
            let mut chats = CHATS.lock();
            let ids: Vec<String> = chats.iter().filter(|(_, c)| c.epoch == epoch).map(|(k, _)| k.clone()).collect();
            ids.iter().filter_map(|k| chats.remove(k)).collect()
        };
        for c in dead {
            let resumed = !c.closing && resume_in_terminal(&c);
            emit(&json!({ "chatId": c.term_id, "ev": "closed", "error": "o processo do chat terminou", "resumedTerminal": resumed }));
        }
    });
    *guard = Some(Sidecar { stdin, child, epoch });
    Ok(epoch)
}

fn send_op(op: Value) -> Result<u64, String> {
    let epoch = ensure_sidecar()?;
    let mut guard = SIDECAR.lock();
    let s = guard.as_mut().ok_or("processo do chat indisponível")?;
    let mut line = op.to_string();
    line.push('\n');
    s.stdin.write_all(line.as_bytes()).and_then(|_| s.stdin.flush()).map_err(|e| e.to_string())?;
    Ok(epoch)
}

/// Retoma a sessão do chat no terminal (`claude --resume …`). `false` se não há sessão.
fn resume_in_terminal(c: &ChatState) -> bool {
    let Some(sid) = c.session_id.clone() else { return false };
    let session = tmux::session_name(&c.term_id);
    let pane_path = tmux::panes().get(&session).map(|p| p.path.clone()).unwrap_or_default();
    let resume = snapshot::ClaudeResume { kind: "claude".into(), session_id: sid, cwd: c.cwd.clone(), args: terminal_args(c) };
    tmux::send_line(&session, &snapshot::resume_line(&resume, &pane_path));
    true
}

fn handle_event(mut v: Value) {
    let ev = v["ev"].as_str().unwrap_or_default().to_owned();
    if ev == "history" {
        if let Some(tx) = v["reqId"].as_u64().and_then(|id| WAITERS.lock().remove(&id)) {
            let _ = tx.send(v);
        }
        return;
    }
    let Some(chat_id) = v["chatId"].as_str().map(str::to_owned) else { return };
    // Fim de turno: o Claude informa a janela de contexto de cada modelo (fora da trava dos chats).
    if ev == "message" && v["msg"]["type"] == "result" {
        crate::context::learn_from_model_usage(&v["msg"]["modelUsage"]);
    }
    if ev == "closed" {
        let removed = CHATS.lock().remove(&chat_id);
        // Fechou sem ser pelo "voltar ao terminal" (erro, sessão inválida…):
        // o Claude do terminal já tinha sido encerrado — retoma lá.
        if let Some(c) = removed.filter(|c| !c.closing && c.ready) {
            v["resumedTerminal"] = json!(resume_in_terminal(&c));
        }
        emit(&v);
        return;
    }
    {
        let mut chats = CHATS.lock();
        if let Some(c) = chats.get_mut(&chat_id) {
            match ev.as_str() {
                "started" | "session" => {
                    if let Some(s) = v["sessionId"].as_str() {
                        c.session_id = Some(s.to_owned());
                    }
                }
                "state" => {
                    c.busy = v["busy"].as_bool().unwrap_or(false);
                    c.since = now_ms();
                }
                "permission" => {
                    c.pending.push(v.clone());
                    c.since = now_ms();
                }
                "permission_resolved" => {
                    let rid = v["requestId"].as_str();
                    c.pending.retain(|p| p["requestId"].as_str() != rid);
                    c.since = now_ms();
                }
                "mode" => {
                    if let Some(m) = v["mode"].as_str() {
                        c.mode = m.to_owned();
                    }
                }
                _ => {}
            }
        }
    }
    emit(&v);
}

// ---------- API usada pelos comandos ----------

pub fn states() -> Vec<ChatState> {
    CHATS.lock().values().cloned().collect()
}

/// Existe (inclusive reservado/abrindo).
fn exists(term_id: &str) -> bool {
    CHATS.lock().contains_key(term_id)
}

fn require_open(term_id: &str) -> Result<(), String> {
    match CHATS.lock().get(term_id) {
        Some(c) if c.ready => Ok(()),
        Some(_) => Err("o chat ainda está abrindo — tente em instantes".into()),
        None => Err("o chat não está aberto".into()),
    }
}

/// Modo de permissão explícito nas opções do terminal (None = vale o das configurações).
fn derive_mode(args: &[String]) -> (Option<String>, bool) {
    let mut mode = None;
    let mut bypass = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--dangerously-skip-permissions" {
            mode = Some("bypassPermissions".into());
            bypass = true;
        } else if a == "--allow-dangerously-skip-permissions" {
            bypass = true;
        } else if a == "--permission-mode" {
            mode = it.next().cloned();
        } else if let Some(m) = a.strip_prefix("--permission-mode=") {
            mode = Some(m.to_owned());
        }
    }
    if mode.as_deref() == Some("bypassPermissions") {
        bypass = true;
    }
    (mode, bypass)
}

/// Último modo de permissão gravado no transcript da sessão
/// (`{"type":"permission-mode","permissionMode":"…"}`). Lê só o fim do arquivo.
fn session_mode(file: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(file).ok()?;
    let len = f.metadata().ok()?.len();
    let mut start = len.saturating_sub(4 << 20);
    loop {
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).ok()?;
        let text = String::from_utf8_lossy(&buf);
        let found = text.lines().rev().filter(|l| l.contains("\"permission-mode\"")).find_map(|l| {
            let v: Value = serde_json::from_str(l).ok()?;
            (v["type"] == "permission-mode").then(|| v["permissionMode"].as_str().map(str::to_owned))?
        });
        if found.is_some() || start == 0 {
            return found;
        }
        start = 0; // não achou no fim: procura no arquivo todo
    }
}

/// Opções do `claude` do terminal → opções do SDK (o que não tem campo próprio vai em extraArgs).
fn sdk_options(args: &[String]) -> Value {
    let mut model = None;
    let mut fallback = None;
    let mut effort = None;
    let mut dirs: Vec<String> = vec![];
    let mut extra = serde_json::Map::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let (k, inline) = match a.split_once('=') {
            Some((k, v)) if k.starts_with("--") => (k, Some(v.to_owned())),
            _ => (a.as_str(), None),
        };
        let mut val = || inline.clone().or_else(|| it.next().cloned());
        match k {
            "--model" => model = val(),
            "--fallback-model" => fallback = val(),
            "--effort" => effort = val(),
            "--add-dir" => dirs.extend(val()),
            "--settings" | "--mcp-config" | "--agent" => {
                if let Some(v) = val() {
                    extra.insert(k.trim_start_matches("--").into(), json!(v));
                }
            }
            "--verbose" | "--ide" => {
                extra.insert(k.trim_start_matches("--").into(), Value::Null);
            }
            _ => {}
        }
    }
    let mut o = serde_json::Map::new();
    if let Some(m) = model {
        o.insert("model".into(), json!(m));
    }
    if let Some(m) = fallback {
        o.insert("fallbackModel".into(), json!(m));
    }
    if let Some(e) = effort {
        o.insert("effort".into(), json!(e));
    }
    if !dirs.is_empty() {
        o.insert("additionalDirectories".into(), json!(dirs));
    }
    if !extra.is_empty() {
        o.insert("extraArgs".into(), Value::Object(extra));
    }
    Value::Object(o)
}

fn process_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

/// Terminal → chat. Encerra o Claude do terminal (se houver) e abre o chat na mesma sessão.
pub fn open(term_id: &str) -> Result<ChatState, String> {
    // Reserva o chat antes de qualquer coisa: duas aberturas simultâneas
    // (desktop + celular) não podem encerrar/abrir em dobro.
    {
        let mut chats = CHATS.lock();
        if chats.contains_key(term_id) {
            drop(chats);
            // Outro aparelho está abrindo este chat: espera ficar pronto.
            let t0 = Instant::now();
            while t0.elapsed() < Duration::from_secs(12) {
                match CHATS.lock().get(term_id) {
                    Some(c) if c.ready => return Ok(c.clone()),
                    Some(_) => {}
                    None => return Err("a abertura do chat falhou no outro aparelho".into()),
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            return Err("o chat está demorando para abrir — tente de novo".into());
        }
        chats.insert(
            term_id.to_owned(),
            ChatState {
                term_id: term_id.to_owned(),
                session_id: None,
                busy: false,
                pending: vec![],
                mode: "default".into(),
                allow_bypass: false,
                cwd: String::new(),
                args: vec![],
                since: now_ms(),
                closing: false,
                ready: false,
                epoch: 0,
            },
        );
    }
    let r = open_reserved(term_id);
    if r.is_err() {
        CHATS.lock().remove(term_id);
    }
    r
}

fn open_reserved(term_id: &str) -> Result<ChatState, String> {
    let session = tmux::session_name(term_id);
    let panes = tmux::panes();
    let pane = panes.get(&session).ok_or("terminal não encontrado")?;
    let agent = crate::agents::scan_panes(&panes).remove(&session);

    let (resume, cwd, args, transcript) = match agent {
        Some(a) if a.kind == "codex" => return Err("o modo chat ainda não funciona com o Codex".into()),
        Some(a) if a.status == "busy" => {
            return Err("o Claude está trabalhando neste terminal — espere terminar (ou interrompa) e tente de novo".into())
        }
        // Parado, mas com comando em 2º plano: abrir o chat encerra o Claude e o comando junto.
        Some(a) if a.status == "shell" => {
            return Err("há um comando do Claude rodando em segundo plano neste terminal — termine-o (ou espere) e tente de novo".into())
        }
        Some(a) => {
            let args = snapshot::agent_args("claude", a.pid);
            // Encerra o Claude do terminal e espera sair (≤ 5 s).
            if a.pid > 0 {
                let _ = Command::new("kill").args(["-TERM", &a.pid.to_string()]).status();
                let t0 = Instant::now();
                while process_alive(a.pid) && t0.elapsed() < Duration::from_secs(5) {
                    std::thread::sleep(Duration::from_millis(100));
                }
                if process_alive(a.pid) {
                    return Err("o Claude do terminal não encerrou a tempo".into());
                }
            }
            // Sessão sem nenhuma mensagem: não há o que retomar, o chat começa uma nova.
            let file = (!a.session_id.is_empty()).then(|| crate::context::transcript(&a.session_id)).flatten();
            let sid = file.is_some().then(|| a.session_id.clone());
            (sid, a.cwd.clone().unwrap_or_else(|| pane.path.clone()), args, file)
        }
        None => (None, pane.path.clone(), vec![], None),
    };

    let (mut mode, mut allow_bypass) = derive_mode(&args);
    // O modo pode ter mudado no terminal (Shift+Tab) depois de abrir: vale o
    // último registrado na sessão.
    if let Some(m) = transcript.as_deref().and_then(session_mode) {
        allow_bypass |= m == "bypassPermissions";
        mode = Some(m);
    }
    {
        let mut chats = CHATS.lock();
        let c = chats.get_mut(term_id).ok_or("chat cancelado")?;
        c.session_id = resume.clone();
        c.mode = mode.clone().unwrap_or_else(|| "default".into());
        c.allow_bypass = allow_bypass;
        c.cwd = cwd.clone();
        c.args = args.clone();
    }
    let env = json!({ accounts::ENV_VAR: accounts::term_link_path(term_id).to_string_lossy() });
    let epoch = send_op(json!({
        "op": "start", "chatId": term_id, "cwd": cwd, "resume": resume, "env": env,
        "claudePath": claude_path(), "permissionMode": mode, "allowBypass": allow_bypass,
        "claudeOptions": sdk_options(&args),
    }))
    .map_err(|e| {
        // O Claude do terminal já foi encerrado: devolve a sessão a ele.
        if let Some(c) = CHATS.lock().get(term_id).cloned() {
            resume_in_terminal(&c);
        }
        e
    })?;
    let state = {
        let mut chats = CHATS.lock();
        let c = chats.get_mut(term_id).ok_or("chat cancelado")?;
        c.epoch = epoch;
        c.ready = true;
        c.clone()
    };
    emit(&json!({ "chatId": term_id, "ev": "opened", "state": state }));
    Ok(state)
}

/// Opções equivalentes para o `claude` do terminal, a partir do modo atual do chat.
fn terminal_args(c: &ChatState) -> Vec<String> {
    let mut out = vec![];
    let mut it = c.args.iter();
    while let Some(a) = it.next() {
        if a == "--permission-mode" {
            it.next();
            continue;
        }
        if a.starts_with("--permission-mode=") || a == "--dangerously-skip-permissions" {
            continue;
        }
        out.push(a.clone());
    }
    match c.mode.as_str() {
        "bypassPermissions" => out.push("--dangerously-skip-permissions".into()),
        "default" => {}
        m => {
            out.push("--permission-mode".into());
            out.push(m.into());
        }
    }
    // Mantém a possibilidade de pular aprovações que o terminal tinha.
    if c.allow_bypass && c.mode != "bypassPermissions" && !out.iter().any(|a| a == "--allow-dangerously-skip-permissions") {
        out.push("--allow-dangerously-skip-permissions".into());
    }
    out
}

/// Chat → terminal: fecha o chat e retoma a sessão no terminal.
pub fn close_to_terminal(term_id: &str) -> Result<(), String> {
    require_open(term_id)?;
    let c = {
        let mut chats = CHATS.lock();
        let Some(c) = chats.get_mut(term_id) else { return Ok(()) };
        c.closing = true;
        c.clone()
    };
    if let Err(e) = send_op(json!({ "op": "close", "chatId": term_id })) {
        // Volta ao normal: se o chat cair depois, a recuperação automática ainda vale.
        if let Some(c) = CHATS.lock().get_mut(term_id) {
            c.closing = false;
        }
        return Err(e);
    }
    // O sidecar aborta sozinho em ≤ 5 s; damos 8 s.
    let t0 = Instant::now();
    while exists(term_id) && t0.elapsed() < Duration::from_secs(8) {
        std::thread::sleep(Duration::from_millis(100));
    }
    if exists(term_id) {
        // NÃO retoma no terminal: dois Claudes na mesma sessão corromperiam o histórico.
        if let Some(c) = CHATS.lock().get_mut(term_id) {
            c.closing = false;
        }
        return Err("o chat não fechou a tempo — tente de novo".into());
    }
    resume_in_terminal(&c);
    emit(&json!({ "chatId": term_id, "ev": "closed", "error": null, "toTerminal": true }));
    Ok(())
}

pub fn send(term_id: &str, text: &str) -> Result<(), String> {
    require_open(term_id)?;
    send_op(json!({ "op": "send", "chatId": term_id, "text": text }))?;
    // Eco para todos os aparelhos (desktop e celular veem a mesma conversa).
    emit(&json!({ "chatId": term_id, "ev": "user", "text": text, "at": now_ms() }));
    Ok(())
}

pub fn respond(term_id: &str, request_id: &str, result: Value) -> Result<(), String> {
    require_open(term_id)?;
    send_op(json!({ "op": "respond", "chatId": term_id, "requestId": request_id, "result": result })).map(|_| ())
}

pub fn interrupt(term_id: &str) -> Result<(), String> {
    require_open(term_id)?;
    send_op(json!({ "op": "interrupt", "chatId": term_id })).map(|_| ())
}

pub fn set_mode(term_id: &str, mode: &str) -> Result<(), String> {
    const MODES: &[&str] = &["default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"];
    if !MODES.contains(&mode) {
        return Err("modo inválido".into());
    }
    require_open(term_id)?;
    if mode == "bypassPermissions" && !CHATS.lock().get(term_id).is_some_and(|c| c.allow_bypass) {
        return Err("este chat não foi aberto com permissão para pular aprovações".into());
    }
    send_op(json!({ "op": "mode", "chatId": term_id, "mode": mode })).map(|_| ())
}

/// Histórico da sessão do chat (mensagens do arquivo da sessão).
pub fn history(term_id: &str) -> Result<Value, String> {
    let (sid, cwd) = match CHATS.lock().get(term_id) {
        Some(c) => (c.session_id.clone(), c.cwd.clone()),
        None => (None, String::new()),
    };
    let Some(sid) = sid else { return Ok(json!([])) };
    let req = REQ.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = std::sync::mpsc::channel();
    WAITERS.lock().insert(req, tx);
    if let Err(e) = send_op(json!({ "op": "history", "reqId": req, "sessionId": sid, "cwd": cwd, "limit": 300 })) {
        WAITERS.lock().remove(&req);
        return Err(e);
    }
    let v = rx.recv_timeout(Duration::from_secs(15)).map_err(|_| {
        WAITERS.lock().remove(&req);
        "histórico demorou demais".to_owned()
    })?;
    Ok(v["messages"].clone())
}

/// Estado do agente para a sidebar quando o terminal está em modo chat.
pub fn claude_info(term_id: &str) -> Option<ClaudeInfo> {
    let c = CHATS.lock().get(term_id).cloned()?;
    let (status, waiting_for) = if !c.pending.is_empty() {
        let first = &c.pending[0];
        let why = if first["toolName"] == "AskUserQuestion" { "pergunta do Claude" } else { "pedido de permissão" };
        ("waiting", Some(why.to_owned()))
    } else if c.busy {
        ("busy", None)
    } else {
        ("idle", None)
    };
    Some(ClaudeInfo {
        kind: "claude".into(),
        pid: 0,
        context: None, // preenchido em terms_status, como para o terminal
        session_id: c.session_id.unwrap_or_default(),
        status: status.into(),
        waiting_for,
        name: Some("chat".into()),
        status_since: c.since,
        subagents: vec![],
        cwd: Some(c.cwd),
    })
}

/// App fechando: devolve cada chat aberto ao seu terminal (`claude --resume`).
/// Espera os chats fecharem (≤ 4 s) para nunca haver dois Claudes na mesma sessão.
pub fn return_all_to_terminals() {
    let open: Vec<ChatState> = {
        let mut chats = CHATS.lock();
        chats.values_mut().filter(|c| c.ready).for_each(|c| c.closing = true);
        chats.values().filter(|c| c.ready).cloned().collect()
    };
    if open.is_empty() {
        return;
    }
    for c in &open {
        let _ = send_op(json!({ "op": "close", "chatId": c.term_id }));
    }
    let t0 = Instant::now();
    while open.iter().any(|c| exists(&c.term_id)) && t0.elapsed() < Duration::from_secs(4) {
        std::thread::sleep(Duration::from_millis(100));
    }
    for c in open.iter().filter(|c| !exists(&c.term_id)) {
        resume_in_terminal(c);
    }
}

/// Para a restauração pós-reboot: terminal em modo chat volta com `claude --resume`.
pub fn resume_info(term_id: &str) -> Option<snapshot::ClaudeResume> {
    let c = CHATS.lock().get(term_id).cloned()?;
    Some(snapshot::ClaudeResume {
        kind: "claude".into(),
        session_id: c.session_id.clone()?,
        cwd: c.cwd.clone(),
        args: terminal_args(&c),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn options_from_terminal_args() {
        let args: Vec<String> = ["--model", "opus", "--add-dir", "../lib", "--mcp-config=x.json", "--dangerously-skip-permissions"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let o = super::sdk_options(&args);
        assert_eq!(o["model"], "opus");
        assert_eq!(o["additionalDirectories"][0], "../lib");
        assert_eq!(o["extraArgs"]["mcp-config"], "x.json");
        let (mode, bypass) = super::derive_mode(&args);
        assert_eq!(mode.as_deref(), Some("bypassPermissions"));
        assert!(bypass);
        assert_eq!(super::derive_mode(&[]).0, None);
        let both: Vec<String> = ["--dangerously-skip-permissions", "--permission-mode", "acceptEdits"].iter().map(|s| s.to_string()).collect();
        let (mode, bypass) = super::derive_mode(&both);
        assert_eq!(mode.as_deref(), Some("acceptEdits"));
        assert!(bypass, "--dangerously-skip-permissions continua permitindo pular aprovações");
    }
}

#[cfg(test)]
mod session_mode_tests {
    /// Lê sessões reais do usuário: rodar com `cargo test -- --ignored session_mode_real`.
    #[test]
    #[ignore]
    fn session_mode_real() {
        let sid = std::env::var("SID").unwrap();
        println!("modo = {:?}", crate::context::transcript(&sid).as_deref().and_then(super::session_mode));
    }
}
