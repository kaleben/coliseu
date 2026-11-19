// Tela "Pull requests": minhas PRs abertas no GitHub, com o que está esperando por mim.
import { api, type PrState, type PullRequest } from "./transport";
import { settings } from "./settings";
import { icon } from "./icons";
import { esc } from "./labels";

let state: PrState = { generatedAt: 0, prs: [], errors: [], refreshing: false };
let onChange: () => void = () => {};
let pollTimer = 0;
let shouldNotify: (title: string, body: string) => void = () => {};

/** Contador "aguardando você" para a sidebar. */
export const waitingCount = () => state.prs.filter((p) => p.action === "waiting_me").length;
export const totalCount = () => state.prs.length;
export const prsEnabled = () => settings.prs.enabled;
/** Estado atual (só leitura; para o app no celular). */
export const prState = (): Readonly<PrState> => state;

const config = () => ({
  orgs: settings.prs.orgs,
  logins: settings.prs.logins,
  intervalMin: settings.prs.intervalMin,
});

export function initPrs(changed: () => void, notify: (title: string, body: string) => void) {
  onChange = changed;
  shouldNotify = notify;
  void poll(false);
  setInterval(() => void poll(false), 60_000); // o backend decide quando buscar de novo
}

async function poll(force: boolean) {
  if (!settings.prs.enabled) return;
  clearTimeout(pollTimer);
  try {
    const next = await api.prsGet(config(), force);
    const finished = next.generatedAt !== state.generatedAt && !next.refreshing;
    if (finished && state.generatedAt) detectChanges(state.prs, next.prs, next.errors);
    state = next;
    render();
    onChange();
    // Enquanto busca, pergunta de novo em instantes.
    if (next.refreshing) pollTimer = window.setTimeout(() => void poll(false), 2500);
  } catch (e) {
    state = { ...state, errors: [String(e)], refreshing: false };
    render();
    onChange();
  }
}

/** Configuração mudou: pergunta ao backend (ele refaz a busca se orgs/logins mudaram). */
export function prsConfigChanged() {
  void poll(false);
}

export function refreshPrsNow() {
  void poll(true);
}

// ---------- Notificações de mudança ----------

const LABELS = {
  decision: { approved: "aprovada", changes_requested: "mudanças pedidas", none: "sem review" },
  checks: { success: "CI ok", failure: "CI falhou", pending: "CI rodando", none: "sem CI" },
  action: { waiting_me: "Aguardando você", waiting_reviewer: "Aguardando reviewer", none: "Sem pendências" },
};

const key = (p: PullRequest) => `${p.org}/${p.repo}#${p.number}`;
const lastKey = (p: PullRequest) => (p.last ? `${p.last.login}|${p.last.at}` : "");

function detectChanges(prev: PullRequest[], cur: PullRequest[], errors: string[]) {
  const ev = settings.prs.events;
  if (!settings.prs.notify) return;
  const before = new Map(prev.map((p) => [key(p), p]));
  for (const p of cur) {
    const label = `${p.repo} #${p.number}`;
    const old = before.get(key(p));
    if (!old) {
      if (ev.newPr) shouldNotify("Nova PR", `${label} · ${p.title}`);
      continue;
    }
    const msgs: string[] = [];
    if (ev.review && old.decision !== p.decision && p.decision !== "none") msgs.push(`review: ${LABELS.decision[p.decision]}`);
    if (old.checks !== p.checks) {
      if ((p.checks === "failure" && ev.ciFail) || (p.checks === "success" && ev.ciPass) || (p.checks === "pending" && ev.ciPending))
        msgs.push(LABELS.checks[p.checks]);
    }
    if (ev.comment && lastKey(old) !== lastKey(p) && p.last && !p.last.mine) msgs.push(`${p.last.login} ${p.last.kind}`);
    if (ev.waitingMe && old.action !== p.action && p.action === "waiting_me") msgs.push("aguardando você");
    if (msgs.length) shouldNotify(label, `${msgs.join(" · ")}\n${p.title}`);
  }
  if (!ev.closed) return;
  const now = new Set(cur.map(key));
  for (const p of prev) {
    const failedRepo = errors.some((e) => e.includes(p.repo));
    if (!now.has(key(p)) && !failedRepo) shouldNotify("PR saiu da lista", `${p.repo} #${p.number} (mesclada ou fechada) · ${p.title}`);
  }
}

// ---------- Render ----------

function ago(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} d`;
}

function chip(text: string, tone = "", ic?: Parameters<typeof icon>[0]) {
  return `<span class="pchip ${tone}">${ic ? icon(ic, 12) : ""}${esc(text)}</span>`;
}

function prCard(p: PullRequest) {
  const decisionChip = {
    approved: chip("Aprovada", "ok", "circleCheck"),
    changes_requested: chip("Mudanças pedidas", "bad", "circleX"),
    none: chip("Sem review", "", "circleDashed"),
  }[p.decision];
  const checksChip = {
    success: chip("CI ok", "ok", "circleCheck"),
    failure: chip("CI falhou", "bad", "circleX"),
    pending: chip("CI rodando", "warn", "clock"),
    none: chip("Sem CI", ""),
  }[p.checks];
  const who = p.last ? (p.last.mine ? "você" : p.last.login) : "";
  const last = p.last
    ? `<span class="paction a-${p.action}">${LABELS.action[p.action]}</span>
       <span class="pwho">${icon("message", 12)} ${esc(who)} ${esc(p.last.kind)} ${ago(p.last.at)}</span>
       <button class="link" data-open="${esc(p.last.url)}">abrir</button>`
    : `<span class="paction a-none">${LABELS.action.none}</span>`;
  return `<article class="pr a-${p.action} ${p.decision === "approved" ? "is-approved" : ""}">
    <div class="pr-icon">${icon(p.draft ? "prDraft" : "pr", 16)}</div>
    <div class="pr-main">
      <div class="pr-top">
        <button class="pr-title" data-open="${esc(p.url)}" title="Abrir no GitHub">${esc(p.title)}</button>
        <span class="pr-tools">
          <button class="icon" data-copy="${esc(`${p.url} · ${p.repo} · ${p.branch}`)}" title="Copiar link · repo · branch">${icon("copy", 14)}</button>
          <button class="icon" data-open="${esc(p.url)}" title="Abrir no GitHub">${icon("external", 14)}</button>
        </span>
      </div>
      <div class="pr-meta">
        <span class="pr-repo">${esc(p.repo)} <b>#${p.number}</b></span>
        <span class="pr-branch">${icon("branch", 12)}<code>${esc(p.branch)}</code> → <code>${esc(p.base)}</code></span>
      </div>
      <div class="pr-chips">
        ${p.draft ? chip("Draft") : ""}${decisionChip}${checksChip}
        ${p.requested.length ? chip(`Pedido a ${p.requested.join(", ")}`, "warn", "userCheck") : ""}
      </div>
      <div class="pr-last">${last}</div>
    </div>
  </article>`;
}

function section(title: string, prs: PullRequest[], tone: string) {
  if (!prs.length) return "";
  return `<section class="pr-sec"><h4 class="${tone}">${esc(title)} <span>${prs.length}</span></h4>${prs.map(prCard).join("")}</section>`;
}

export function render() {
  const root = document.querySelector<HTMLElement>("#prs-view");
  if (!root) return;
  const prs = state.prs;
  const when = state.generatedAt ? new Date(state.generatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—";
  const waiting = prs.filter((p) => p.action === "waiting_me");
  const reviewer = prs.filter((p) => p.action === "waiting_reviewer");
  const rest = prs.filter((p) => p.action === "none");

  let body: string;
  if (!settings.prs.enabled) body = `<div class="pr-empty">Acompanhamento de PRs desligado em Configurações → Pull requests.</div>`;
  else if (!prs.length) body = `<div class="pr-empty">${state.refreshing ? `${icon("loader", 18, "spin")} buscando suas PRs…` : "Nenhuma PR aberta sua."}</div>`;
  else
    body =
      section("Aguardando você", waiting, "t-bad") +
      section("Aguardando reviewer", reviewer, "t-warn") +
      section("Sem pendências", rest, "t-muted");

  root.innerHTML = `
    <header class="pr-header">
      <button class="icon drawer-btn" data-act="menu" title="Menu">${icon("menu", 18)}</button>
      <div class="pr-title-box">
        <h2>${icon("pr", 18)} Pull requests</h2>
        <div class="pr-sub">${prs.length} abertas · <b class="${waiting.length ? "t-bad" : ""}">${waiting.length} aguardando você</b> ·
          ${state.refreshing ? "atualizando…" : `atualizado às ${when}`} · ${esc(settings.prs.orgs.join(", ") || "todas as organizações")}</div>
      </div>
      <div class="pr-actions">
        <button class="btn back-btn" data-act="back" title="Voltar aos terminais (Ctrl+Shift+P)">${icon("terminal", 14)} Terminais</button>
        <button class="btn" data-act="copy-all" ${prs.length ? "" : "disabled"}>${icon("copy", 14)} Copiar todas</button>
        <button class="btn" data-act="refresh" ${state.refreshing ? "disabled" : ""}>${icon("refresh", 14, state.refreshing ? "spin" : "")} Atualizar</button>
      </div>
    </header>
    ${state.errors.length ? `<div class="pr-errors">${icon("circleX", 14)} ${esc(state.errors.join(" | "))}</div>` : ""}
    <div class="pr-list">${body}</div>`;
}

export function bindPrsView(clipboard: (t: string) => Promise<void>, onBack: () => void, onMenu: () => void) {
  const root = document.querySelector<HTMLElement>("#prs-view")!;
  root.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const open = t.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (open) return api.openUrl(open);
    const copy = t.closest<HTMLElement>("[data-copy]");
    if (copy) {
      await clipboard(copy.dataset.copy!);
      copy.innerHTML = icon("check", 14);
      setTimeout(() => (copy.innerHTML = icon("copy", 14)), 1200);
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "back") return onBack();
    if (act === "menu") return onMenu();
    if (act === "refresh") refreshPrsNow();
    if (act === "copy-all") {
      await clipboard(state.prs.map((p) => `${p.url} · ${p.repo} · ${p.branch}`).join("\n"));
      const b = t.closest<HTMLElement>("[data-act]")!;
      b.innerHTML = `${icon("check", 14)} Copiado`;
      setTimeout(render, 1200);
    }
  });
}
