//! Quanto do contexto a sessão do Claude já usou (o que o /context mostra).
//!
//! Vem da última resposta do Claude no arquivo da sessão
//! (~/.claude/projects/<slug>/<sessionId>.jsonl): entrada + cache lido + cache
//! criado + saída = o que vai na próxima chamada. A janela de cada modelo vem do
//! próprio Claude (`modelUsage.contextWindow` nos resultados do chat/SDK),
//! guardada em ~/.local/share/coliseu/models.json; sem ela, uma tabela padrão.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::LazyLock;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextUse {
    /// Tokens em uso.
    pub used: u64,
    /// Tamanho da janela do modelo.
    pub window: u64,
    pub model: String,
}

/// Arquivo da sessão → (até onde foi lido, último uso achado). Só lê o que cresceu.
static CACHE: LazyLock<Mutex<HashMap<String, (u64, Option<(u64, String)>)>>> = LazyLock::new(Default::default);
/// sessionId → arquivo; ou a hora em que não foi achado (não varre de novo por 10 s).
static PATHS: LazyLock<Mutex<HashMap<String, Result<PathBuf, std::time::Instant>>>> = LazyLock::new(Default::default);
/// Janela por modelo aprendida do próprio Claude.
static WINDOWS: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(|| {
    let m = std::fs::read(models_file())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    Mutex::new(m)
});

fn models_file() -> PathBuf {
    crate::accounts::base().join("models.json")
}

/// Janela do modelo: a informada pelo Claude; senão 1M para a família 5 em diante
/// (claude-opus-5-5 confirmado) e 200k para as anteriores (4.5, 3.5…). Se o uso já
/// passou da janela, é a variante de 1M do mesmo modelo.
fn window_for(model: &str, used: u64) -> u64 {
    let w = WINDOWS.lock().get(model).copied().unwrap_or_else(|| {
        if model.ends_with("[1m]") || major_version(model) >= 5 { 1_000_000 } else { 200_000 }
    });
    if used > w { 1_000_000.max(w) } else { w }
}

/// "claude-opus-5-5" → 5; "claude-sonnet-4-5-20250929" → 4; "claude-3-5-sonnet-…" → 3.
fn major_version(model: &str) -> u32 {
    let parts: Vec<&str> = model.split('-').collect();
    for (i, p) in parts.iter().enumerate() {
        if matches!(*p, "opus" | "sonnet" | "haiku") {
            // Novo formato: família e depois a versão; antigo: versão antes da família.
            // (datas como 20241022 não são versão)
            let ver = |k: usize| parts.get(k).and_then(|v| v.parse::<u32>().ok()).filter(|&n| n < 100);
            if let Some(v) = ver(i + 1).or_else(|| i.checked_sub(2).and_then(ver)) {
                return v;
            }
        }
    }
    0
}

/// Aprende a janela de um modelo (resultado do chat/SDK: `modelUsage`).
pub fn learn_from_model_usage(model_usage: &Value) {
    let Some(map) = model_usage.as_object() else { return };
    let mut w = WINDOWS.lock();
    let mut changed = false;
    for (model, v) in map {
        if let Some(cw) = v["contextWindow"].as_u64().filter(|&n| n > 0) {
            changed |= w.insert(model.clone(), cw) != Some(cw);
        }
    }
    if changed {
        // Gravado com a trava: duas gravações seguidas não ficam fora de ordem.
        let _ = std::fs::write(models_file(), serde_json::to_vec_pretty(&*w).unwrap_or_default());
    }
}

/// Arquivo da conversa (`~/.claude/projects/<slug>/<sessionId>.jsonl`). Uma sessão
/// sem nenhuma mensagem ainda não tem arquivo. Sempre confere no disco quando
/// não sabe (o chat decide retomar ou não por aqui).
pub fn transcript(session_id: &str) -> Option<PathBuf> {
    lookup(session_id, false)
}

/// `remember_miss`: na leitura de status (a cada 1,5 s), uma sessão ainda sem
/// arquivo não varre ~/.claude/projects de novo por 10 s.
fn lookup(session_id: &str, remember_miss: bool) -> Option<PathBuf> {
    match PATHS.lock().get(session_id) {
        Some(Ok(p)) if p.is_file() => return Some(p.clone()),
        Some(Err(at)) if remember_miss && at.elapsed() < std::time::Duration::from_secs(10) => return None,
        _ => {}
    }
    let found = std::fs::read_dir(crate::agents::claude_home().join("projects"))
        .ok()
        .and_then(|rd| rd.flatten().map(|e| e.path().join(format!("{session_id}.jsonl"))).find(|p| p.is_file()));
    let mut paths = PATHS.lock();
    if paths.len() > 500 {
        paths.clear(); // sessões antigas (/clear cria uma nova a cada vez)
    }
    paths.insert(session_id.to_owned(), found.clone().ok_or_else(std::time::Instant::now));
    found
}

/// Contexto em uso pela sessão (None: sem resposta do Claude ainda, ou logo
/// depois de compactar sem o número novo).
pub fn for_session(session_id: &str) -> Option<ContextUse> {
    if session_id.is_empty() {
        return None;
    }
    let path = lookup(session_id, true)?;
    let size = std::fs::metadata(&path).ok()?.len();
    let key = path.to_string_lossy().into_owned();
    let cached = CACHE.lock().get(&key).cloned();
    const MAX: u64 = 16 * 1024 * 1024;
    let (found, read_to) = match cached {
        Some((read, r)) if read == size => (r, size),
        // Cresceu (pouco): só os bytes novos, a partir do fim da última linha inteira
        // lida; sem resposta nova neles, vale a de antes.
        Some((read, prev)) if read < size && size - read <= MAX => {
            let model = prev.as_ref().map(|p| p.1.clone());
            let (r, upto) = scan(&path, read, size, model.as_deref());
            (match r {
                Scan::Found(u) => Some(u),
                Scan::Compacted(post) => post,
                Scan::Nothing => prev,
            }, upto)
        }
        // Primeira vez, arquivo encolheu ou cresceu demais: do fim para trás até achar.
        _ => {
            let mut span: u64 = 256 * 1024;
            loop {
                let start = size.saturating_sub(span);
                let (r, upto) = scan(&path, start, size, None);
                match r {
                    Scan::Found(u) => break (Some(u), upto),
                    Scan::Compacted(post) => break (post, upto),
                    Scan::Nothing if start == 0 || span >= MAX => break (None, upto),
                    Scan::Nothing => span *= 4,
                }
            }
        }
    };
    {
        let mut c = CACHE.lock();
        if c.len() > 500 {
            c.clear();
        }
        c.insert(key, (read_to, found.clone()));
    }
    let (used, model) = found?;
    Some(ContextUse { used, window: window_for(&model, used), model })
}

enum Scan {
    /// Última resposta do Claude: (tokens em uso, modelo).
    Found((u64, String)),
    /// Compactação depois da última resposta: o número de depois, se houver.
    Compacted(Option<(u64, String)>),
    Nothing,
}

/// Procura, de trás para frente no trecho [start, end), a última resposta do Claude
/// na conversa principal — ou uma compactação depois dela. Devolve também até onde
/// o trecho tem linhas inteiras (a próxima leitura começa ali: uma linha sendo
/// escrita agora é lida inteira na próxima vez). `model`: o da resposta anterior,
/// para a compactação (a resposta pode estar antes do trecho).
fn scan(path: &std::path::Path, start: u64, end: u64, model: Option<&str>) -> (Scan, u64) {
    let Ok(mut f) = std::fs::File::open(path) else { return (Scan::Nothing, start) };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return (Scan::Nothing, start);
    }
    let mut buf = Vec::with_capacity((end - start) as usize);
    if f.by_ref().take(end - start).read_to_end(&mut buf).is_err() {
        return (Scan::Nothing, start);
    }
    let whole = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let upto = start + whole as u64;
    let text = String::from_utf8_lossy(&buf[..whole]);
    (scan_text(&text, model), upto)
}

fn scan_text(text: &str, model: Option<&str>) -> Scan {
    for line in text.lines().rev() {
        if line.contains("compact_boundary") {
            if let Ok(e) = serde_json::from_str::<Value>(line) {
                if e["subtype"] == "compact_boundary" {
                    let meta = if e["compactMetadata"].is_object() { &e["compactMetadata"] } else { &e["compact_metadata"] };
                    let post = meta["postTokens"].as_u64().or_else(|| meta["post_tokens"].as_u64());
                    // O modelo vem da resposta anterior (aqui no trecho ou a já conhecida).
                    let m = model_before(text, line).or_else(|| model.map(str::to_owned));
                    return Scan::Compacted(post.zip(m));
                }
            }
            // Outra linha que só cita o termo (ex.: uma resposta falando disso): segue.
        }
        if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        if e["type"] != "assistant" || e["isSidechain"] == true {
            continue;
        }
        let model = e["message"]["model"].as_str().unwrap_or_default();
        if model.is_empty() || model.starts_with('<') {
            continue; // mensagens sintéticas (erros, interrupções) não têm uso real
        }
        let u = &e["message"]["usage"];
        let n = |k: &str| u[k].as_u64().unwrap_or(0);
        let used = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens") + n("output_tokens");
        if used > 0 {
            return Scan::Found((used, model.to_owned()));
        }
    }
    Scan::Nothing
}

/// Modelo da última resposta antes de `marker` no texto.
fn model_before(text: &str, marker: &str) -> Option<String> {
    let at = text.find(marker)?;
    text[..at].lines().rev().find_map(|l| {
        let e: Value = serde_json::from_str(l).ok()?;
        (e["type"] == "assistant").then(|| e["message"]["model"].as_str().map(str::to_owned)).flatten().filter(|m| !m.starts_with('<'))
    })
}

#[cfg(test)]
mod tests {
    /// Sessão real: `SID=<id> cargo test --lib context_real -- --ignored --nocapture`.
    #[test]
    fn versions() {
        use super::major_version as v;
        assert_eq!(v("claude-opus-5-5"), 5);
        assert_eq!(v("claude-sonnet-4-5-20250929"), 4);
        assert_eq!(v("claude-haiku-4-5-20251001"), 4);
        assert_eq!(v("claude-3-5-sonnet-20241022"), 3);
        assert_eq!(v("claude-opus-4-1"), 4);
        assert_eq!(v("<synthetic>"), 0);
    }

    #[test]
    fn compaction() {
        use super::{scan, Scan};
        let dir = std::env::temp_dir().join(format!("coliseu-ctx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("s.jsonl");
        let reply = r#"{"type":"assistant","isSidechain":false,"message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":900000,"cache_creation_input_tokens":0,"output_tokens":5}}}"#;
        let run = |extra: &str| {
            std::fs::write(&f, format!("{reply}\n{extra}\n")).unwrap();
            let size = std::fs::metadata(&f).unwrap().len();
            match scan(&f, 0, size, None).0 {
                Scan::Found(u) => format!("found {}", u.0),
                Scan::Compacted(p) => format!("compacted {:?}", p.map(|x| x.0)),
                Scan::Nothing => "nothing".into(),
            }
        };
        assert_eq!(run(""), "found 900015");
        assert_eq!(run(r#"{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"manual","preTokens":900015,"postTokens":42000}}"#), "compacted Some(42000)");
        assert_eq!(run(r#"{"type":"system","subtype":"compact_boundary","compactMetadata":{"trigger":"auto","preTokens":900015}}"#), "compacted None");
        // Resposta que só cita o termo não engana.
        assert_eq!(run(r#"{"type":"user","message":{"content":"o que é compact_boundary?"}}"#), "found 900015");
        // Leitura incremental: a resposta ficou num trecho anterior; o modelo vem de antes.
        let boundary = r#"{"type":"system","subtype":"compact_boundary","compactMetadata":{"postTokens":42000}}"#;
        std::fs::write(&f, format!("{reply}\n{boundary}\n")).unwrap();
        let size = std::fs::metadata(&f).unwrap().len();
        let from = reply.len() as u64 + 1;
        match scan(&f, from, size, Some("claude-opus-5-5")).0 {
            Scan::Compacted(Some((n, m))) => assert_eq!((n, m.as_str()), (42000, "claude-opus-5-5")),
            _ => panic!("esperava compactação com o modelo anterior"),
        }
        // Linha pela metade: só lê até a última linha inteira.
        std::fs::write(&f, format!("{reply}\n{{\"type\":\"assis")).unwrap();
        let size = std::fs::metadata(&f).unwrap().len();
        assert_eq!(scan(&f, 0, size, None).1, reply.len() as u64 + 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore]
    fn context_real() {
        let sid = std::env::var("SID").unwrap();
        let t = std::time::Instant::now();
        println!("{:?} em {:?}", super::for_session(&sid), t.elapsed());
        let t = std::time::Instant::now();
        println!("de novo (cache): {:?} em {:?}", super::for_session(&sid).map(|c| c.used), t.elapsed());
    }
}
