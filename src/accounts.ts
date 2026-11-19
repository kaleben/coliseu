// Contas do Claude: rodapé com uso da conta ativa + janela de contas.
import { api, type Account, type CodexAccount, type Usage, type UsageWindow } from "./transport";
import { settings } from "./settings";
import { icon } from "./icons";
import { esc } from "./labels";

export let accounts: Account[] = [];
export let activeId: string | null = null;
const usage: Record<string, Usage> = {};

export const shortName = (a?: Account) => (a ? a.alias || a.label.split("@")[0] : "—");
export const accountById = (id?: string | null) => accounts.find((a) => a.id === id);

let onChange: () => void = () => {};
/** Novos números de uso (o app no celular redesenha; o desktop já atualiza o rodapé). */
let onData: () => void = () => {};
export const setUsageListener = (fn: () => void) => (onData = fn);

// ---------- Codex (uma conta, só leitura: dados vêm do disco) ----------

let codex: CodexAccount | null = null;

async function refreshCodex(force = false) {
  try {
    codex = await api.codexAccount(force);
  } catch {
    codex = null;
  }
  renderFooter();
  renderCodexCard();
  onData();
}

function codexBlock(verbose: boolean) {
  if (!codex?.loggedIn) return verbose ? `<div class="acc-err">Codex não está logado (rode <code>codex login</code>).</div>` : "";
  if (!codex.fiveHour && !codex.weekly) return `<div class="acc-err">sem uso registrado ainda</div>`;
  const note = codex.updatedAt ? `<div class="acc-stale">atualizado ${age(codex.updatedAt)}</div>` : "";
  return bar("5h", codex.fiveHour) + bar("sem", codex.weekly) + (verbose ? note : "");
}

function renderCodexCard() {
  const el = document.querySelector<HTMLElement>("#codex-acc");
  if (!el) return;
  el.innerHTML = codex?.loggedIn
    ? `<div class="acc codex"><div class="acc-row"><div class="acc-id">
        <b>${esc(codex.email?.split("@")[0] ?? "Codex")}</b>${codex.plan ? ` <span class="acc-plan">${esc(codex.plan)}</span>` : ""}
        <small>${esc(codex.email ?? "")} · ChatGPT</small></div></div>
        <div class="acc-bars">${codexBlock(true)}</div></div>`
    : codexBlock(true);
}

export async function initAccounts(changed: () => void) {
  onChange = changed;
  void refreshCodex();
  setInterval(() => void refreshCodex(), 3 * 60_000); // backend faz cache e respeita 429
  await reloadAccounts();
  void refreshUsage(true);
  // O backend faz cache (no máx. 1 consulta a cada 3 min por conta e respeita 429).
  setInterval(() => void refreshUsage(false), 3 * 60_000);
  $footer().addEventListener("click", () => void openAccounts());
}

export async function reloadAccounts() {
  const st = await api.accountsList();
  accounts = st.accounts;
  activeId = st.active ?? null;
  renderFooter();
  onChange();
}

let lastAll = 0;
/** Ativa a cada minuto; todas a cada 5 min (ou quando forçado). */
async function refreshUsage(all: boolean, force = false) {
  const doAll = all || Date.now() - lastAll > 5 * 60_000;
  if (doAll) lastAll = Date.now();
  const ids = doAll ? accounts.map((a) => a.id) : activeId ? [activeId] : [];
  await Promise.all(
    ids.map(async (id) => {
      try {
        usage[id] = await api.accountUsage(id, force);
      } catch (e) {
        usage[id] = { ...(usage[id] ?? {}), error: String(e), stale: true, fetchedAt: usage[id]?.fetchedAt ?? 0 };
      }
    }),
  );
  renderFooter();
  renderModalBody();
  onData();
}

const $footer = () => document.querySelector<HTMLElement>("#account-bar")!;

function level(p: number) {
  return p >= 85 ? "hi" : p >= 60 ? "mid" : "lo";
}

export function resetIn(iso?: string | number | null) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!(ms > 0)) return "";
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.round(h / 24)}d`;
}

function bar(label: string, w?: UsageWindow | null) {
  if (!w) return `<div class="ubar empty"><span class="ul">${label}</span><span class="track"><i></i></span><span class="up">—</span></div>`;
  const p = Math.round(w.percent);
  const r = resetIn(w.resetsAt);
  return `<div class="ubar ${level(p)}" title="${label}: ${p}% usado${r ? ` · renova em ${r}` : ""}">
    <span class="ul">${label}</span>
    <span class="track"><i style="width:${Math.min(100, p)}%"></i></span>
    <span class="up">${p}%</span>${r ? `<span class="ur">${r}</span>` : ""}</div>`;
}

export function age(ms: number) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "agora";
  if (m < 60) return `há ${m}min`;
  return `há ${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
}

/** Barras sempre que houver números (mesmo antigos); erro só se nunca houve dado. */
function usageBlock(u?: Usage, verbose = false) {
  const hasData = !!(u?.fiveHour || u?.sevenDay);
  if (!hasData) {
    if (!u) return `<div class="acc-err">carregando uso…</div>`;
    return `<div class="acc-err" title="${esc(u.error ?? "")}">${verbose ? esc(u.error ?? "uso indisponível") : "uso indisponível"}</div>`;
  }
  const note = u!.stale
    ? `<div class="acc-stale" title="${esc(u!.error ?? "dado em cache")}">atualizado ${age(u!.fetchedAt)}${verbose && u!.error ? ` · ${esc(u!.error)}` : ""}</div>`
    : "";
  return bar("5h", u!.fiveHour) + bar("7d", u!.sevenDay) + note;
}

export function rerenderFooter() {
  renderFooter();
}

function renderFooter() {
  const a = accountById(activeId);
  const u = activeId ? usage[activeId] : undefined;
  $footer().innerHTML = `
    <div class="acc-head"><span class="acc-name">${esc(shortName(a))}</span>
      ${a?.plan ? `<span class="acc-plan">${esc(a.plan)}</span>` : ""}<span class="acc-switch">${icon("swap", 13)}</span></div>
    ${usageBlock(u)}
    ${codex?.loggedIn && settings.ui.showCodex ? `<div class="acc-head codex-head"><span class="acc-name">Codex</span>${codex.plan ? `<span class="acc-plan">${esc(codex.plan)}</span>` : ""}</div>${codexBlock(false)}` : ""}`;
  $footer().title = a ? `${a.label} — clique para gerenciar contas` : "Contas";
}

// ---------- Leitura/ações para outras telas (app no celular) ----------

/** Último uso conhecido da conta (sem consultar a rede). */
export const usageOf = (id: string): Usage | undefined => usage[id];
/** Último estado conhecido do Codex (sem consultar a rede). */
export const codexState = () => codex;

/** Recarregar manual (o mesmo do botão da janela de contas): ignora o cache e consulta agora. */
export async function refreshAccountsNow() {
  await Promise.all([refreshCodex(true), refreshUsage(true, true)]);
}

/** Troca a conta global (o mesmo do "Usar" da janela de contas). Lança em caso de falha. */
export async function switchAccount(id: string) {
  const st = await api.accountSwitch(id);
  accounts = st.accounts;
  activeId = st.active ?? null;
  renderFooter();
  renderModalBody();
  onChange();
  void refreshUsage(false);
}

// ---------- Janela de contas ----------

let modalOpen = false;

function renderModalBody() {
  if (!modalOpen) return;
  const list = document.querySelector<HTMLElement>("#acc-list");
  if (!list) return;
  list.innerHTML = accounts
    .map((a) => {
      const u = usage[a.id];
      const active = a.id === activeId;
      return `<div class="acc ${active ? "active" : ""}" data-id="${esc(a.id)}">
        <div class="acc-row">
          <div class="acc-id">
            <b>${esc(shortName(a))}</b>${a.plan ? ` <span class="acc-plan">${esc(a.plan)}</span>` : ""}
            <small>${esc(a.label)}${a.orgName ? ` · ${esc(a.orgName)}` : ""}</small>
          </div>
          <button class="icon" data-act="alias" title="Apelido">${icon("pencil", 14)}</button>
          ${active ? "" : `<button class="icon" data-act="remove" title="Remover conta do Coliseu">${icon("trash", 14)}</button>`}
          ${active ? `<span class="acc-active">${icon("check", 13)} Ativa</span>` : `<button class="btn sm" data-act="use">Usar</button>`}
        </div>
        <div class="acc-bars">${usageBlock(u, true)}</div>
      </div>`;
    })
    .join("");
}

// ---------- Adicionar conta (OAuth com código colado) ----------

let flowId: string | null = null;

function renderAddIdle() {
  flowId = null;
  const box = document.querySelector<HTMLElement>("#acc-add");
  if (box) box.innerHTML = `<button class="btn ghost" data-act="add">${icon("plus", 15)} Adicionar conta</button>`;
}

async function startLogin() {
  const box = document.querySelector<HTMLElement>("#acc-add");
  if (!box) return;
  const { flowId: id, url } = await api.accountLoginBegin();
  flowId = id;
  api.openUrl(url);
  box.innerHTML = `<div class="login-box">
    <b>Adicionar conta</b>
    <ol>
      <li>No navegador, entre na conta do Claude que quer adicionar e clique em <b>Autorizar</b>.
        <button class="link" data-act="reopen">Abrir de novo</button></li>
      <li>Copie o código que a página mostrar e cole aqui:</li>
    </ol>
    <input id="login-code" class="code" placeholder="Cole o código aqui" autocomplete="off" spellcheck="false" />
    <div class="login-err"></div>
    <div class="actions"><button data-act="cancel-add">Cancelar</button><span class="spacer"></span>
      <button class="primary" data-act="finish">Concluir</button></div>
  </div>`;
  const input = box.querySelector<HTMLInputElement>("#login-code")!;
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") void finishLogin();
    if (e.key === "Escape") renderAddIdle();
  };
  input.focus();
}

async function finishLogin() {
  const input = document.querySelector<HTMLInputElement>("#login-code");
  const errEl = document.querySelector<HTMLElement>("#acc-add .login-err");
  const btn = document.querySelector<HTMLButtonElement>("#acc-add [data-act=finish]");
  if (!input || !flowId) return;
  const code = input.value.trim();
  if (!code) return void input.focus();
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Concluindo…";
  }
  try {
    const acc = await api.accountLoginFinish(flowId, code);
    renderAddIdle();
    await reloadAccounts();
    usage[acc.id] = await api.accountUsage(acc.id).catch((e) => ({ error: String(e), fetchedAt: 0 }));
    renderModalBody();
    document.querySelector<HTMLElement>(`.acc[data-id="${acc.id}"]`)?.classList.add("just-added");
  } catch (e) {
    if (errEl) errEl.textContent = String(e);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Concluir";
    }
  }
}

export async function openAccounts() {
  const root = document.querySelector<HTMLElement>("#modal-root")!;
  modalOpen = true;
  root.innerHTML = `<div class="backdrop"><div class="modal accounts" tabindex="-1">
    <div class="shead"><h3>Contas do Claude</h3>
      <span class="mtools"><button class="icon" data-act="refresh" title="Atualizar uso agora">${icon("refresh", 15)}</button>
      <button class="icon" data-act="close" title="Fechar (Esc)">${icon("x", 16)}</button></span></div>
    <p class="hint">“Usar” troca a conta global: vale para todo <code>claude</code> novo, dentro e fora do Coliseu.
      Terminais fixados numa conta (botão direito no terminal) não mudam.</p>
    <h4 class="sec">Claude</h4>
    <div id="acc-list"></div>
    <div id="acc-add"><button class="btn ghost" data-act="add">${icon("plus", 15)} Adicionar conta</button></div>
    <h4 class="sec">Codex</h4>
    <div id="codex-acc"></div>
  </div></div>`;
  const m = root.querySelector<HTMLElement>(".modal")!;
  const close = () => {
    modalOpen = false;
    root.innerHTML = "";
    onChange();
  };
  m.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
    const id = el.closest<HTMLElement>("[data-id]")?.dataset.id;
    if (act === "close") return close();
    if (act === "refresh") {
      void refreshCodex(true);
      // Recarregar manual: ignora o cache e consulta agora.
      el.closest<HTMLElement>("[data-act]")!.classList.add("spinning");
      return void refreshUsage(true, true).finally(() =>
        document.querySelector("[data-act=refresh]")?.classList.remove("spinning"),
      );
    }
    if (act === "add" || act === "reopen") return void startLogin();
    if (act === "cancel-add") return renderAddIdle();
    if (act === "finish") return void finishLogin();
    if (act === "remove" && id) {
      const a = accountById(id);
      if (!confirm(`Remover ${a?.label} do Coliseu?\n\nAs credenciais salvas desta conta serão apagadas (a conta em si não é afetada; dá para adicionar de novo depois).`)) return;
      try {
        const st = await api.accountRemove(id);
        accounts = st.accounts;
        activeId = st.active ?? null;
        renderFooter();
        renderModalBody();
        onChange();
      } catch (err) {
        alert(String(err));
      }
      return;
    }
    if (act === "use" && id) {
      try {
        await switchAccount(id);
      } catch (err) {
        alert(`Falha ao trocar conta: ${err}`);
      }
    }
    if (act === "alias" && id) {
      const row = el.closest<HTMLElement>(".acc")!.querySelector<HTMLElement>(".acc-id b")!;
      const a = accountById(id)!;
      const input = document.createElement("input");
      input.className = "rename";
      input.value = a.alias ?? "";
      input.placeholder = a.label.split("@")[0];
      row.replaceWith(input);
      input.focus();
      const save = async () => {
        const st = await api.accountAlias(id, input.value.trim() || null);
        accounts = st.accounts;
        renderFooter();
        renderModalBody();
        onChange();
      };
      input.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") void save();
        if (ev.key === "Escape") renderModalBody();
      };
      input.onblur = () => void save();
    }
  });
  // Corpo em bloco: devolver false num on* cancelaria toda tecla dos campos da janela.
  m.onkeydown = (e) => {
    if (e.key === "Escape") close();
  };
  root.querySelector<HTMLElement>(".backdrop")!.addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) close();
  });
  renderModalBody();
  renderCodexCard();
  m.focus();
  void reloadAccounts().then(() => refreshUsage(true));
}
