//! Minhas PRs abertas no GitHub (porta do pr-tracker em Python).
//!
//! Usa o `gh` CLI (mesma autenticação do usuário). Em vez de uma lista fixa de
//! repositórios, busca `is:pr is:open author:<login> [org:<org>]` — PRs em
//! repositórios novos entram sozinhas. Sem logins configurados, usa a conta
//! logada no `gh`; sem organizações, busca em todas. Para cada PR: reviews, checks/status,
//! comentários → decisão, CI, última atividade e "de quem é a vez".

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    process::Command,
    sync::{Arc, LazyLock},
    time::{SystemTime, UNIX_EPOCH},
};

const FAILED: &[&str] = &["failure", "timed_out", "cancelled", "action_required", "startup_failure"];
const WORKERS: usize = 4;

#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrConfig {
    /// Filtro opcional (vazio = todas as organizações e repositórios pessoais).
    pub orgs: Vec<String>,
    /// Vazio = a conta logada no `gh`.
    pub logins: Vec<String>,
    /// Intervalo de atualização automática, em minutos.
    pub interval_min: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LastActivity {
    pub at: String,
    pub login: String,
    pub kind: String,
    pub url: String,
    pub mine: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Pr {
    pub org: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub url: String,
    pub branch: String,
    pub base: String,
    pub draft: bool,
    pub updated_at: String,
    /// approved | changes_requested | none
    pub decision: String,
    /// success | failure | pending | none
    pub checks: String,
    pub last: Option<LastActivity>,
    /// waiting_me | waiting_reviewer | none
    pub action: String,
    pub requested: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrState {
    pub generated_at: u64,
    pub prs: Vec<Pr>,
    pub errors: Vec<String>,
    pub refreshing: bool,
}

struct Shared {
    state: PrState,
    cfg: Option<PrConfig>,
}

static SHARED: LazyLock<Arc<Mutex<Shared>>> =
    LazyLock::new(|| Arc::new(Mutex::new(Shared { state: PrState::default(), cfg: None })));

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn gh(args: &[&str]) -> anyhow::Result<Value> {
    let out = Command::new("gh").args(args).output()?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!("{}", err.trim().chars().take(300).collect::<String>());
    }
    Ok(serde_json::from_slice(&out.stdout)?)
}

fn gh_api(path: &str) -> anyhow::Result<Value> {
    gh(&["api", path])
}

/// Login da conta ativa no `gh` (None: gh ausente ou sem login). Guardado por 10 min
/// (a falta de login, só 10 s: quem acabou de rodar `gh auth login` vê na hora).
pub fn gh_user() -> Option<String> {
    static CACHE: LazyLock<Mutex<Option<(u64, Option<String>)>>> = LazyLock::new(|| Mutex::new(None));
    if let Some((at, v)) = CACHE.lock().clone() {
        let ttl = if v.is_some() { 10 * 60_000 } else { 10_000 };
        if now_ms().saturating_sub(at) < ttl {
            return v;
        }
    }
    let v = gh_api("user").ok().and_then(|u| u["login"].as_str().map(str::to_owned)).filter(|l| !l.is_empty());
    *CACHE.lock() = Some((now_ms(), v.clone()));
    v
}

/// Logins efetivos: os configurados, ou a conta do `gh`.
fn logins_of(cfg: &PrConfig) -> Vec<String> {
    let l: Vec<String> = cfg.logins.iter().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
    if !l.is_empty() {
        return l;
    }
    gh_user().into_iter().collect()
}

fn arr(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

fn login(v: &Value) -> String {
    v["user"]["login"].as_str().unwrap_or_default().to_owned()
}

/// Contas automáticas (vercel[bot], github-actions[bot], dependabot[bot], Copilot…)
/// não contam como revisão nem como "última atividade".
fn is_bot(v: &Value) -> bool {
    v["user"]["type"].as_str() == Some("Bot") || login(v).ends_with("[bot]")
}

fn decision_of(reviews: &[Value], author: &str) -> String {
    let mut sorted = reviews.to_vec();
    sorted.sort_by(|a, b| a["submitted_at"].as_str().unwrap_or("").cmp(b["submitted_at"].as_str().unwrap_or("")));
    let mut latest: std::collections::HashMap<String, String> = Default::default();
    for r in sorted.iter().filter(|r| !is_bot(r)) {
        let who = login(r);
        let st = r["state"].as_str().unwrap_or_default();
        if who == author || st == "COMMENTED" {
            continue;
        }
        latest.insert(who, st.to_owned());
    }
    let states: HashSet<&str> = latest.values().map(|s| s.as_str()).collect();
    if states.contains("CHANGES_REQUESTED") {
        "changes_requested"
    } else if states.contains("APPROVED") {
        "approved"
    } else {
        "none"
    }
    .into()
}

fn checks_of(runs: &[Value], commit_state: Option<&str>) -> String {
    if !runs.is_empty() {
        if runs.iter().any(|r| r["conclusion"].as_str().is_some_and(|c| FAILED.contains(&c))) {
            return "failure".into();
        }
        if runs.iter().any(|r| r["status"].as_str() != Some("completed")) {
            return "pending".into();
        }
        if matches!(commit_state, Some("failure" | "error")) {
            return "failure".into();
        }
        return "success".into();
    }
    match commit_state {
        Some("success") => "success",
        Some("failure" | "error") => "failure",
        Some("pending") => "pending",
        _ => "none",
    }
    .into()
}

fn last_activity(author: &str, mine: &HashSet<String>, reviews: &[Value], comments: &[Value]) -> Option<LastActivity> {
    let mut items: Vec<(String, String, String, String)> = vec![];
    for c in comments.iter().filter(|c| !is_bot(c)) {
        items.push((
            c["created_at"].as_str().unwrap_or_default().into(),
            login(c),
            "comentou".into(),
            c["html_url"].as_str().unwrap_or_default().into(),
        ));
    }
    for r in reviews.iter().filter(|r| !is_bot(r)) {
        let kind = match r["state"].as_str() {
            Some("APPROVED") => "aprovou",
            Some("CHANGES_REQUESTED") => "pediu mudanças",
            Some("COMMENTED") => "revisou",
            _ => continue,
        };
        let Some(at) = r["submitted_at"].as_str() else { continue };
        items.push((at.into(), login(r), kind.into(), r["html_url"].as_str().unwrap_or_default().into()));
    }
    let (at, who, kind, url) = items.into_iter().max_by(|a, b| a.0.cmp(&b.0))?;
    let is_mine = mine.contains(&who) || who == author;
    Some(LastActivity { at, login: who, kind, url, mine: is_mine })
}

fn build_pr(org: &str, repo: &str, number: u64, mine: &HashSet<String>) -> anyhow::Result<Pr> {
    let base = format!("repos/{org}/{repo}/");
    let pr = gh_api(&format!("{base}pulls/{number}"))?;
    let sha = pr["head"]["sha"].as_str().unwrap_or_default().to_owned();
    let reviews = arr(&gh_api(&format!("{base}pulls/{number}/reviews?per_page=100"))?);
    let mut comments = arr(&gh_api(&format!("{base}issues/{number}/comments?per_page=100"))?);
    comments.extend(arr(&gh_api(&format!("{base}pulls/{number}/comments?per_page=100"))?));
    let runs = arr(&gh_api(&format!("{base}commits/{sha}/check-runs?per_page=100"))?["check_runs"]);
    let combined = gh_api(&format!("{base}commits/{sha}/status"))?;
    let commit_state = (combined["total_count"].as_u64().unwrap_or(0) > 0).then(|| combined["state"].as_str()).flatten();

    let author = login(&pr);
    let decision = decision_of(&reviews, &author);
    let checks = checks_of(&runs, commit_state);
    let last = last_activity(&author, mine, &reviews, &comments);
    let action = match &last {
        None => "none",
        _ if decision == "approved" => "none",
        Some(l) if l.mine => "waiting_reviewer",
        Some(_) => "waiting_me",
    };
    Ok(Pr {
        org: org.into(),
        repo: repo.into(),
        number,
        title: pr["title"].as_str().unwrap_or_default().into(),
        url: pr["html_url"].as_str().unwrap_or_default().into(),
        branch: pr["head"]["ref"].as_str().unwrap_or_default().into(),
        base: pr["base"]["ref"].as_str().unwrap_or_default().into(),
        draft: pr["draft"].as_bool().unwrap_or(false),
        updated_at: pr["updated_at"].as_str().unwrap_or_default().into(),
        decision,
        checks,
        last,
        action: action.into(),
        requested: arr(&pr["requested_reviewers"]).iter().filter_map(|r| r["login"].as_str().map(str::to_owned)).collect(),
    })
}

/// Busca completa (bloqueante). Chamada numa thread própria.
fn refresh(cfg: &PrConfig) -> (Vec<Pr>, Vec<String>) {
    let logins = logins_of(cfg);
    let mine: HashSet<String> = logins.iter().cloned().collect();
    let mut errors = vec![];
    if logins.is_empty() {
        errors.push("sem conta do GitHub: rode `gh auth login` ou informe seus logins nas configurações".into());
        return (vec![], errors);
    }
    let orgs: Vec<Option<&str>> = {
        let o: Vec<Option<&str>> = cfg.orgs.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).map(Some).collect();
        if o.is_empty() { vec![None] } else { o }
    };
    let mut found: Vec<(String, String, u64)> = vec![];
    for org in &orgs {
        for l in &logins {
            let q = match org {
                Some(o) => format!("q=is:pr is:open author:{l} org:{o}"),
                None => format!("q=is:pr is:open author:{l}"),
            };
            match gh(&["api", "-X", "GET", "search/issues", "-f", &q, "-f", "per_page=100"]) {
                Ok(v) => {
                    for item in arr(&v["items"]) {
                        // .../repos/<dono>/<repo>
                        let mut parts = item["repository_url"].as_str().unwrap_or_default().rsplit('/');
                        let repo = parts.next().unwrap_or_default().to_owned();
                        let owner = parts.next().unwrap_or_default().to_owned();
                        let n = item["number"].as_u64().unwrap_or(0);
                        if !repo.is_empty() && !owner.is_empty() && n > 0 && !found.iter().any(|(o, r, x)| *o == owner && *r == repo && *x == n) {
                            found.push((owner, repo, n));
                        }
                    }
                }
                Err(e) => errors.push(format!("busca {}{l}: {e}", org.map(|o| format!("{o}/")).unwrap_or_default())),
            }
        }
    }

    // Detalhes em paralelo (WORKERS threads).
    let queue = Arc::new(Mutex::new(found));
    let results = Arc::new(Mutex::new((Vec::<Pr>::new(), Vec::<String>::new())));
    let handles: Vec<_> = (0..WORKERS)
        .map(|_| {
            let (queue, results, mine) = (queue.clone(), results.clone(), mine.clone());
            std::thread::spawn(move || loop {
                let Some((org, repo, n)) = queue.lock().pop() else { break };
                match build_pr(&org, &repo, n, &mine) {
                    Ok(pr) => results.lock().0.push(pr),
                    Err(e) => results.lock().1.push(format!("{repo}#{n}: {e}")),
                }
            })
        })
        .collect();
    for h in handles {
        let _ = h.join();
    }
    let (mut prs, errs) = std::mem::take(&mut *results.lock());
    errors.extend(errs);
    prs.sort_by(|a, b| {
        (a.action != "waiting_me", &a.repo, a.number).cmp(&(b.action != "waiting_me", &b.repo, b.number))
    });
    (prs, errors)
}

fn start_refresh(cfg: PrConfig) {
    {
        let mut s = SHARED.lock();
        if s.state.refreshing {
            return;
        }
        s.state.refreshing = true;
    }
    std::thread::spawn(move || {
        let (prs, errors) = refresh(&cfg);
        let mut s = SHARED.lock();
        s.state = PrState { generated_at: now_ms(), prs, errors, refreshing: false };
    });
}

/// Estado atual. Dispara atualização em segundo plano se estiver velho,
/// se a configuração mudou, ou se `force`.
pub fn get(cfg: PrConfig, force: bool) -> PrState {
    let (stale, changed, st) = {
        let mut s = SHARED.lock();
        let changed = s.cfg.as_ref() != Some(&cfg);
        s.cfg = Some(cfg.clone());
        let stale = now_ms().saturating_sub(s.state.generated_at) > cfg.interval_min.max(1) * 60_000;
        (stale, changed, s.state.clone())
    };
    if force || stale || changed {
        start_refresh(cfg);
        let mut st = st;
        st.refreshing = true;
        return st;
    }
    st
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore] // `cargo test --lib prs_live -- --ignored --nocapture`
    fn prs_live() {
        // Conta logada no gh, todas as organizações.
        let cfg = super::PrConfig { orgs: vec![], logins: vec![], interval_min: 5 };
        let (prs, errors) = super::refresh(&cfg);
        for p in &prs {
            println!("{}#{} {:?} decision={} checks={} action={}", p.repo, p.number, p.title.chars().take(40).collect::<String>(), p.decision, p.checks, p.action);
        }
        println!("erros: {errors:?}");
    }
}
