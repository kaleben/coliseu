import "./styles.css";
import { api, type Config, type Group, type TermStatus } from "./transport";
import { Pane, setInputFilter, setLook } from "./pane";
import { ChatView } from "./chat";
import type { ChatState } from "./transport";
import { claudeMark, icon, type IconName } from "./icons";
import { applyTheme, fontCss, TERM_THEMES } from "./themes";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import { loadSettings, openSettings, settings } from "./settings";
import { openOnboarding, setupTerms, shouldOnboard } from "./onboarding";
import { accountById, accounts, initAccounts, rerenderFooter, setUsageListener, shortName } from "./accounts";
import { bindPrsView, initPrs, prsConfigChanged, prsEnabled, render as renderPrs, totalCount, waitingCount } from "./prs";
import type { Terminal } from "./transport";
import { contextLevel, esc, fmtTokens, SHELLS, WAITING_LABEL } from "./labels";
import { addTab, currentScreen, goHome, initApp, openConvo, refresh as appRefresh, setConvoBar, type AppHost } from "./mobile/shell";
import { initPush } from "./mobile/push";
import { initInstall } from "./mobile/install";
import { homeTab } from "./mobile/home";
import { createConvoBar } from "./mobile/convo";
import { accountsTab, prsTab } from "./mobile/pages";
import { filesOpen, initFiles, renderFiles, toggleFiles } from "./files";
import { initViewer, openFile } from "./viewer";

// ---------- Estado ----------

interface Tab {
  id: string;
  groupId: string;
  panes: string[];
  dir: "row" | "col";
  sizes?: number[];
}
interface Layout {
  tabs: Tab[];
  activeGroup?: string;
  activeTab: Record<string, string>; // groupId -> tabId
  activePane: Record<string, string>; // tabId -> termId
  collapsed: Record<string, boolean>; // groupId -> sidebar recolhida
  sidebarWidth?: number;
}

let cfg: Config = { groups: [], terminals: [], layout: null, settings: null };
let layout: Layout = { tabs: [], activeTab: {}, activePane: {}, collapsed: {} };
let status: Record<string, TermStatus> = {};
const panes = new Map<string, Pane>();
const tabEls = new Map<string, HTMLDivElement>();

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const uid = () => Math.random().toString(36).slice(2, 10);

const term = (id: string) => cfg.terminals.find((t) => t.id === id);
const group = (id?: string) => cfg.groups.find((g) => g.id === id);
const tabsOf = (gid: string) => layout.tabs.filter((t) => t.groupId === gid);
const activeGroupId = () => layout.activeGroup ?? cfg.groups[0]?.id;
const activeTab = () => {
  const gid = activeGroupId();
  if (!gid) return undefined;
  return layout.tabs.find((t) => t.id === layout.activeTab[gid]) ?? tabsOf(gid)[0];
};
const activePaneId = () => {
  const t = activeTab();
  if (!t) return undefined;
  const p = layout.activePane[t.id];
  return p && t.panes.includes(p) ? p : t.panes[0];
};
const tabOfTerm = (tid: string) => layout.tabs.find((t) => t.panes.includes(tid));

function saveLayout() {
  api.layoutSave(layout);
}

/** Garante que layout e terminais existentes estão coerentes. */
function normalize() {
  const ids = new Set(cfg.terminals.map((t) => t.id));
  for (const tab of layout.tabs) {
    tab.panes = tab.panes.filter((p) => ids.has(p));
    if (tab.sizes && tab.sizes.length !== tab.panes.length) tab.sizes = undefined;
    const first = term(tab.panes[0] ?? "");
    if (first) tab.groupId = first.groupId;
  }
  layout.tabs = layout.tabs.filter((t) => t.panes.length > 0);
  for (const t of cfg.terminals) {
    if (!tabOfTerm(t.id) && !setupTerms.has(t.id)) layout.tabs.push({ id: uid(), groupId: t.groupId, panes: [t.id], dir: "row" });
  }
  if (!group(layout.activeGroup)) layout.activeGroup = cfg.groups[0]?.id;
  // Remove painéis cujo terminal sumiu.
  for (const [id, p] of panes) {
    if (!ids.has(id)) {
      p.dispose();
      panes.delete(id);
    }
  }
  for (const [id, el] of tabEls) {
    if (!layout.tabs.some((t) => t.id === id)) {
      el.remove();
      tabEls.delete(id);
    }
  }
}

// ---------- Ações ----------

/** Cria e posiciona um terminal; devolve o id (ou nada, se falhou: o aviso já foi mostrado). */
async function newTerminal(groupId = activeGroupId(), split?: "row" | "col"): Promise<string | undefined> {
  if (!groupId) return;
  try {
    const t = await api.termCreate(groupId);
    placeTerminal(t, groupId, split);
    return t.id;
  } catch (e) {
    toast(`Erro ao criar terminal: ${e}`);
  }
}

/** Coloca um terminal recém-criado no layout (nova aba ou split) e foca nele. */
function placeTerminal(t: Terminal, groupId: string, split?: "row" | "col") {
  {
    cfg.terminals.push(t);
    const cur = activeTab();
    if (split && cur && cur.groupId === groupId) {
      if (cur.panes.length === 1) cur.dir = split;
      const at = cur.panes.indexOf(activePaneId() ?? "") + 1 || cur.panes.length;
      cur.panes.splice(at, 0, t.id);
      cur.sizes = undefined;
      layout.activePane[cur.id] = t.id;
    } else {
      const tab: Tab = { id: uid(), groupId, panes: [t.id], dir: "row" };
      layout.tabs.push(tab);
      layout.activeTab[groupId] = tab.id;
      layout.activePane[tab.id] = t.id;
    }
    layout.activeGroup = groupId;
    saveLayout();
    render();
    focusActive();
  }
}


async function closeTerminal(tid: string, ask = true) {
  const st = status[tid];
  if (ask && st && !SHELLS.has(st.command)) {
    const ok = await confirmDialog(`“${term(tid)?.title}” está rodando <b>${esc(st.command)}</b>. Encerrar mesmo assim?`);
    if (!ok) return;
  }
  cfg = await api.termKill(tid);
  removePane(tid);
}

function removePane(tid: string) {
  const tab = tabOfTerm(tid);
  if (tab) {
    tab.panes = tab.panes.filter((p) => p !== tid);
    tab.sizes = undefined;
  }
  cfg.terminals = cfg.terminals.filter((t) => t.id !== tid);
  normalize();
  saveLayout();
  render();
  focusActive();
}

function activateTerminal(tid: string) {
  const tab = tabOfTerm(tid);
  if (!tab) return;
  setView("terms");
  unseen.delete(tid);
  layout.activeGroup = tab.groupId;
  layout.activeTab[tab.groupId] = tab.id;
  layout.activePane[tab.id] = tid;
  saveLayout();
  render();
  focusActive();
  maybeAutoChat(true);
}

function activateTab(tabId: string) {
  const tab = layout.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  layout.activeGroup = tab.groupId;
  layout.activeTab[tab.groupId] = tab.id;
  saveLayout();
  render();
  focusActive();
  maybeAutoChat(true);
}

function cycleTab(delta: number) {
  const gid = activeGroupId();
  if (!gid) return;
  const tabs = tabsOf(gid);
  const i = tabs.findIndex((t) => t.id === activeTab()?.id);
  if (tabs.length) activateTab(tabs[(i + delta + tabs.length) % tabs.length].id);
}

function cyclePane(delta: number) {
  const tab = activeTab();
  if (!tab || tab.panes.length < 2) return;
  const i = tab.panes.indexOf(activePaneId() ?? "");
  activateTerminal(tab.panes[(i + delta + tab.panes.length) % tab.panes.length]);
}

function focusActive() {
  if (isAppHome()) return; // terminal fora da tela: não abre o teclado do celular
  if (document.querySelector(".onboarding")) return; // primeiros passos abertos: o foco é deles
  const id = activePaneId();
  if (!id) return;
  requestAnimationFrame(() => {
    const chat = chatViews.get(id);
    // No celular não foca a caixa do chat sozinho (abriria o teclado).
    if (chat) {
      if (!MOBILE) chat.focus();
    } else panes.get(id)?.focus();
  });
}

async function renameTerminal(tid: string) {
  const t = term(tid);
  if (!t) return;
  const r = await formDialog("Renomear terminal", [{ key: "title", label: "Nome", value: t.title }]);
  if (r && r !== "extra" && r.title?.trim()) {
    cfg = await api.termUpdate(tid, { title: r.title.trim() });
    render();
  }
}

async function moveTerminal(tid: string) {
  const t = term(tid);
  if (!t) return;
  const r = await formDialog("Mover para grupo", [
    { key: "group", label: "Grupo", value: t.groupId, options: cfg.groups.map((g) => [g.id, g.name]) },
  ]);
  if (r && r !== "extra" && r.group && r.group !== t.groupId) {
    const tab = tabOfTerm(tid);
    if (tab) tab.panes = tab.panes.filter((p) => p !== tid);
    cfg = await api.termUpdate(tid, { groupId: r.group });
    normalize();
    saveLayout();
    render();
  }
}

async function editGroup(g?: Group) {
  const r = await formDialog(g ? `Editar grupo ${g.name}` : "Novo grupo", [
    { key: "name", label: "Nome", value: g?.name ?? "" },
    { key: "cwd", label: "Pasta", value: g?.cwd ?? "~/", type: "folder" },
    { key: "color", label: "Cor", value: g?.color ?? "#a855f7", type: "color" },
    {
      key: "account",
      label: "Conta padrão dos novos terminais",
      value: g?.account ?? "",
      options: [["", "Seguir a conta global"], ...accounts.map((a): [string, string] => [a.id, `${shortName(a)} (${a.label})`])],
    },
  ], g ? "Remover grupo" : undefined);
  if (r === "extra" && g) {
    try {
      cfg = await api.groupDelete(g.id);
      normalize();
      render();
    } catch (e) {
      toast(String(e));
    }
    return;
  }
  if (!r || typeof r === "string" || !r.name?.trim()) return;
  const next: Group = {
    id: g?.id ?? r.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + uid().slice(0, 4),
    name: r.name.trim(),
    cwd: r.cwd.trim() || "~/",
    color: r.color,
    account: r.account || null,
    folders: g?.folders ?? [],
  };
  cfg = await api.groupUpsert(next);
  render();
}

async function chooseTermAccount(tid: string) {
  const t = term(tid);
  if (!t) return;
  const r = await formDialog(`Conta de “${t.title}”`, [
    {
      key: "account",
      label: "Vale para o próximo claude aberto neste terminal",
      value: t.account ?? "",
      options: [["", "Seguir a conta global"], ...accounts.map((a): [string, string] => [a.id, `${shortName(a)} (${a.label})`])],
    },
  ]);
  if (!r || r === "extra") return;
  try {
    cfg = await api.termSetAccount(tid, r.account || null);
    render();
  } catch (e) {
    toast(String(e));
  }
}

async function copySelection() {
  const p = panes.get(activePaneId() ?? "");
  const sel = p?.term.getSelection();
  if (sel) await api.clipboardWrite(sel);
}

async function paste() {
  const p = panes.get(activePaneId() ?? "");
  if (!p) return;
  const text = await api.clipboardRead().catch(() => "");
  if (text) p.term.paste(text);
}

// ---------- Atalhos ----------

/** Retorna true se o atalho foi tratado (não vai para o terminal). */
function handleKey(e: KeyboardEvent): boolean {
  const cs = e.ctrlKey && e.shiftKey && !e.altKey;
  if (cs) {
    switch (e.code) {
      case "KeyT": void newTerminal(); return true;
      case "KeyD": void newTerminal(activeGroupId(), "row"); return true;
      case "KeyE": void newTerminal(activeGroupId(), "col"); return true;
      case "KeyW": { const id = activePaneId(); if (id) void closeTerminal(id); return true; }
      case "KeyC": void copySelection(); return true;
      case "KeyV": void paste(); return true;
      case "KeyR": { const id = activePaneId(); if (id) inlineRename(id); return true; }
      case "KeyF": { const id = activePaneId(); if (id) panes.get(id)?.openSearch(); return true; }
      case "KeyP": { if (prsEnabled()) setView(view === "prs" ? "terms" : "prs"); return true; }
      case "KeyB": { if (!MOBILE) toggleFiles(); return true; }
    }
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "PageUp" || e.key === "PageDown")) {
    cycleTab(e.key === "PageUp" ? -1 : 1);
    return true;
  }
  if (e.altKey && !e.ctrlKey && /^Digit[1-9]$/.test(e.code)) {
    const g = cfg.groups[Number(e.code.slice(5)) - 1];
    if (g) {
      layout.activeGroup = g.id;
      saveLayout();
      render();
      focusActive();
    }
    return true;
  }
  if (e.altKey && !e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
    cyclePane(e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1);
    return true;
  }
  return false;
}

document.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).closest?.(".modal")) return;
  if (view === "file" && (e.target as HTMLElement).closest?.("#file-view")) return;
  if (handleKey(e)) e.preventDefault();
});

// ---------- Render ----------

function agentBadge(st?: TermStatus) {
  if (!st) return "";
  const cmd = st.command;
  if (/claude/i.test(cmd) || /claude/i.test(st.title)) return "claude";
  if (/codex/i.test(cmd)) return "codex";
  if (!SHELLS.has(cmd)) return cmd;
  return "";
}

// ---------- Estado do Claude ----------

type AgentState = "busy" | "waiting" | "idle" | "done" | "none";
/** Terminais cujo Claude terminou e o usuário ainda não olhou. */
const unseen = new Set<string>();
const STATE_LABEL: Record<AgentState, string> = {
  busy: "processando",
  waiting: "aguardando você",
  idle: "parado",
  done: "concluído",
  none: "",
};

function agentState(tid: string): AgentState {
  const c = status[tid]?.claude;
  if (!c) {
    // Reserva: o backend normalmente já põe o chat no status; se não vier, o chat diz o estado.
    const cs = chatStates.get(tid);
    if (!cs) return "none";
    return cs.pending.length ? "waiting" : cs.busy ? "busy" : "idle";
  }
  if (c.status === "waiting" || c.status === "needs_user" || c.status === "blocked") return "waiting";
  // "shell": o Claude já terminou a vez dele; só sobrou um comando em 2º plano.
  if (c.status === "busy") return "busy";
  return unseen.has(tid) ? "done" : "idle";
}

const STATE_RANK: Record<AgentState, number> = { waiting: 4, busy: 3, done: 2, idle: 1, none: 0 };
const worstState = (tids: string[]) =>
  tids.map(agentState).reduce<AgentState>((a, b) => (STATE_RANK[b] > STATE_RANK[a] ? b : a), "none");

function ago(ms: number) {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** Elemento de tempo decorrido, atualizado a cada segundo sem redesenhar a sidebar. */
const elapsed = (ms: number, cls = "tage") => (ms ? `<span class="${cls}" data-since="${ms}">${ago(ms)}</span>` : "");

setInterval(() => {
  // Só a sidebar e as abas do desktop (o app no celular tem o próprio relógio).
  document.querySelectorAll<HTMLElement>("#sidebar [data-since], #tabbar [data-since]").forEach((el) => {
    const t = ago(Number(el.dataset.since));
    if (el.textContent !== t) el.textContent = t;
  });
}, 1000);

/**
 * Tempo de execução por terminal, medido pelo Coliseu (o statusUpdatedAt do
 * Claude é regravado a cada etapa). Uma execução vai do início do
 * "processando" até voltar a "parado" — esperas por aprovação no meio contam.
 * Ao terminar, a duração fica congelada até a próxima execução.
 */
const runs: Record<string, { session: string; start?: number; lastMs?: number }> = {};

function trackStates(next: Record<string, TermStatus>) {
  for (const [tid, st] of Object.entries(next)) {
    const c = st.claude;
    if (!c) {
      delete runs[tid];
      continue;
    }
    const first = !runs[tid] || runs[tid].session !== c.sessionId;
    if (first) runs[tid] = { session: c.sessionId };
    const r = runs[tid];
    const active = agentStateOf(c.status) !== "idle";
    if (active && r.start === undefined) {
      // 1ª observação já no meio da execução: melhor palpite é o horário do Claude.
      r.start = first ? c.statusSince || Date.now() : Date.now();
    } else if (!active && r.start !== undefined) {
      r.lastMs = Date.now() - r.start;
      r.start = undefined;
    }
  }
  for (const tid of Object.keys(runs)) if (!next[tid]) delete runs[tid];
}

/** Duração fixa no formato do contador. */
function dur(ms: number) {
  return ago(Date.now() - ms);
}

function agentStateOf(status: string) {
  if (status === "waiting" || status === "needs_user" || status === "blocked") return "waiting";
  if (status === "busy") return "busy";
  return "idle"; // inclui "shell" (parado, com comando em 2º plano)
}

function stateLine(tid: string) {
  const c = status[tid]?.claude;
  const st = agentState(tid);
  if (!c || st === "none") return "";
  let label = STATE_LABEL[st];
  if (st === "waiting" && c.waitingFor) label = WAITING_LABEL[c.waitingFor] ?? c.waitingFor;
  const bg = c.status === "shell" ? `<span class="tage" title="O Claude terminou, mas um comando dele segue rodando em segundo plano">· 2º plano</span>` : "";
  const r = runs[tid];
  const time = r?.start !== undefined
    ? elapsed(r.start) // executando: conta ao vivo
    : r?.lastMs !== undefined
      ? `<span class="tage" title="Duração da última execução">${dur(r.lastMs)}</span>` // terminou: congela
      : "";
  return `<span class="state s-${st}">${esc(label)}</span>${ctxChip(c.context)}${bg}${time}`;
}

/** Contexto em uso (o que o /context mostra): "82%" com cor por nível. */
function ctxChip(ctx?: import("./transport").ContextUse | null) {
  if (!ctx) return "";
  const { pct, level } = contextLevel(ctx);
  return `<span class="ctxu ctxu-${level}" title="Contexto: ${fmtTokens(ctx.used)} de ${fmtTokens(ctx.window)} tokens (${esc(ctx.model)})">${pct}%</span>`;
}

function cleanTitle(st?: TermStatus) {
  if (!st) return "";
  if (st.claude?.name) return st.claude.name;
  const t = st.title.replace(/^[\u2800-\u28ff◐◑✳✻✶✢·*\s]+/, "").trim();
  if (!t || t.includes("ubuntu")) return "";
  return t;
}

let editing = false;

function renderSidebar() {
  if (MOBILE) appRefresh();
  if (editing) return;
  const nav = $("#groups");
  const ag = activeGroupId();
  const ap = activePaneId();
  nav.innerHTML = cfg.groups
    .map((g, gi) => {
      const terms = cfg.terminals.filter((t) => t.groupId === g.id);
      const collapsed = layout.collapsed[g.id];
      const nWait = terms.filter((t) => agentState(t.id) === "waiting").length;
      const nBusy = terms.filter((t) => agentState(t.id) === "busy").length;
      const nDone = terms.filter((t) => agentState(t.id) === "done").length;
      return `
      <div class="group ${g.id === ag ? "active" : ""}" data-gid="${g.id}">
        <div class="group-head" style="--c:${g.color}">
          <button class="chev" data-act="collapse" title="${collapsed ? "Expandir" : "Recolher"}">${icon(collapsed ? "chevronRight" : "chevronDown", 14)}</button>
          <span class="dot"></span>
          <span class="gname" data-act="select" title="Alt+${gi + 1}">${esc(g.name)}</span>
          <span class="count">
            ${nWait ? `<b class="pill s-waiting" title="aguardando você">${nWait}</b>` : ""}
            ${nBusy ? `<b class="pill s-busy" title="processando">${nBusy}</b>` : ""}
            ${nDone ? `<b class="pill s-done" title="concluído (não visto)">${nDone}</b>` : ""}
            <span class="num">${terms.length}</span>
          </span>
          <span class="gactions">
            <button class="icon" data-act="edit" title="Editar grupo">${icon("settings", 14)}</button>
            <button class="icon" data-act="new" title="Novo terminal">${icon("plus", 15)}</button>
          </span>
        </div>
        ${collapsed ? "" : `<ul>${terms.map((t) => termItem(t.id, t.title, t.cwd, t.id === ap && g.id === ag)).join("")}</ul>`}
      </div>`;
    })
    .join("");
  updateWindowTitle();
}

function termItem(tid: string, title: string, cwd: string, active: boolean) {
  const st = status[tid];
  const state = agentState(tid);
  const badge = agentBadge(st);
  const sub = cleanTitle(st) || (st?.path ?? cwd).replace(/^\/home\/[^/]+/, "~");
  const subs = st?.claude?.subagents ?? [];
  const acc = accountById(term(tid)?.account);
  const accTag = acc ? `<span class="acc-tag" title="Conta fixa: ${esc(acc.label)}">@${esc(shortName(acc))}</span>` : "";
  return `<li class="term ${active ? "active" : ""} t-${state}" data-tid="${tid}">
    <div class="trow"><span class="tdot"></span><span class="ttitle" title="Duplo clique para renomear">${esc(title)}</span>${accTag}${badgeHtml(badge)}
    <span class="tactions">
      <button class="icon" data-act="rename" title="Renomear (Ctrl+Shift+R)">${icon("pencil", 13)}</button>
      <button class="icon" data-act="close" title="Encerrar">${icon("x", 14)}</button>
    </span></div>
    <div class="tsub">${esc(sub)}</div>
    ${stateLine(tid) ? `<div class="tstate">${stateLine(tid)}</div>` : ""}
    ${subs.length ? `<ul class="subs">${subs
      .map(
        (a) => `<li class="sub ${a.finished ? "fin" : "run"}" title="${esc(a.agentType)} · ${esc(a.description)}">
          <span class="sicon">${a.finished ? icon("check", 12) : icon("loader", 12, "spin")}</span>
          <span class="sdesc">${esc(a.description)}</span>
          ${elapsed(a.finished ? a.updatedAt : a.startedAt, "stime")}</li>`,
      )
      .join("")}</ul>` : ""}
  </li>`;
}

/** Claude/Codex viram símbolo; outros comandos ficam como selo de texto. */
function badgeHtml(badge: string) {
  if (!badge) return "";
  if (badge === "claude") return `<span class="agent-mark a-claude" title="Claude Code">${claudeMark(14)}</span>`;
  if (badge === "codex") return `<span class="agent-mark a-codex" title="Codex">${icon("code", 14)}</span>`;
  return `<span class="badge">${esc(badge)}</span>`;
}

function updateWindowTitle() {
  const tids = cfg.terminals.map((t) => t.id);
  const w = tids.filter((t) => agentState(t) === "waiting").length;
  const b = tids.filter((t) => agentState(t) === "busy").length;
  const parts = [w && `${w} aguardando`, b && `${b} processando`].filter(Boolean);
  document.title = parts.length ? `Coliseu — ${parts.join(", ")}` : "Coliseu";
}

/** Edição inline do nome do terminal na sidebar. */
function inlineRename(tid: string) {
  const span = document.querySelector<HTMLElement>(`li.term[data-tid="${tid}"] .ttitle`);
  const t = term(tid);
  if (!span || !t) return void renameTerminal(tid);
  editing = true;
  const input = document.createElement("input");
  input.className = "rename";
  input.value = t.title;
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save: boolean) => {
    if (done) return;
    done = true;
    editing = false;
    const v = input.value.trim();
    if (save && v && v !== t.title) cfg = await api.termUpdate(tid, { title: v });
    render();
    focusActive();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") void finish(true);
    if (e.key === "Escape") void finish(false);
  };
  input.onblur = () => void finish(true);
  input.onclick = (e) => e.stopPropagation();
}

let lastClick = { tid: "", at: 0 };

$("#groups").addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  if (el.closest("input.rename")) return;
  const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
  const gid = el.closest<HTMLElement>("[data-gid]")?.dataset.gid;
  const tid = el.closest<HTMLElement>("[data-tid]")?.dataset.tid;
  if (tid) {
    if (act === "close") return void closeTerminal(tid);
    if (act === "rename") return inlineRename(tid);
    // Duplo clique detectado manualmente: o 1º clique redesenha a sidebar,
    // então o evento nativo "dblclick" nunca chega no mesmo elemento.
    const now = Date.now();
    const dbl = lastClick.tid === tid && now - lastClick.at < 400;
    lastClick = { tid, at: now };
    activateTerminal(tid);
    if (dbl) inlineRename(tid);
    return;
  }
  if (!gid) return;
  if (act === "new") void newTerminal(gid);
  else if (act === "edit") void editGroup(group(gid));
  else if (act === "collapse") {
    layout.collapsed[gid] = !layout.collapsed[gid];
    saveLayout();
    renderSidebar();
  } else {
    setView("terms");
    layout.activeGroup = gid;
    saveLayout();
    render();
    focusActive();
  }
});
$("#groups").addEventListener("contextmenu", (e) => {
  const tid = (e.target as HTMLElement).closest<HTMLElement>("[data-tid]")?.dataset.tid;
  if (!tid) return;
  e.preventDefault();
  contextMenu(e.clientX, e.clientY, [
    ["Renomear", () => inlineRename(tid), "pencil"],
    ["Mover para grupo…", () => moveTerminal(tid), "swap"],
    ["Conta deste terminal…", () => chooseTermAccount(tid), "user"],
    [chatStates.has(tid) ? "Voltar ao terminal" : "Abrir como chat", () => toggleChat(tid), chatStates.has(tid) ? "terminal" : "message"],
    ["Encerrar", () => closeTerminal(tid), "x"],
  ]);
});
$("#add-group").addEventListener("click", () => void editGroup());

function renderTabs() {
  const gid = activeGroupId();
  const g = group(gid);
  const at = activeTab()?.id;
  $("#tabbar").innerHTML =
    (MOBILE ? `<button class="icon drawer-btn" data-act="drawer" title="Menu">${icon("menu", 18)}</button>` : "") +
    (g ? `<span class="tg" style="--c:${g.color}"><i></i>${esc(g.name)}</span>` : "") +
    (gid ? tabsOf(gid) : [])
      .map((t) => {
        const label = t.panes.map((p) => term(p)?.title ?? "?").join(" │ ");
        const st = worstState(t.panes);
        return `<div class="tab ${t.id === at ? "active" : ""} t-${st}" data-tab="${t.id}" title="${esc(STATE_LABEL[st])}">
          <span class="tdot"></span><span>${esc(label)}</span>
          <button class="icon x" data-act="close-tab" title="Fechar aba">${icon("x", 13)}</button></div>`;
      })
      .join("") +
    (gid ? `<button class="icon add" data-act="new-tab" title="Novo terminal (Ctrl+Shift+T)">${icon("plus", 15)}</button>
      <span class="spacer"></span>
      ${micButton()}
      <button class="icon ${chatStates.has(activePaneId() ?? "") ? "on" : ""}" data-act="chat" title="Chat ⇄ Terminal">${icon("message", 15)}</button>
      <button class="icon" data-act="search" title="Buscar no terminal (Ctrl+Shift+F)">${icon("search", 15)}</button>
      <button class="icon" data-act="split-row" title="Dividir lado a lado (Ctrl+Shift+D)">${icon("splitRight", 15)}</button>
      <button class="icon" data-act="split-col" title="Dividir em cima/baixo (Ctrl+Shift+E)">${icon("splitDown", 15)}</button>` : "");
}

$("#tabbar").addEventListener("click", async (e) => {
  const el = e.target as HTMLElement;
  const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
  const tabId = el.closest<HTMLElement>("[data-tab]")?.dataset.tab;
  if (act === "drawer") return toggleDrawer();
  if (act === "new-tab") return void newTerminal();
  if (act === "split-row") return void newTerminal(activeGroupId(), "row");
  if (act === "split-col") return void newTerminal(activeGroupId(), "col");
  if (act === "chat") return void toggleChat();
  if (act === "voice") return toggleVoice();
  if (act === "search") {
    const id = activePaneId();
    if (id) panes.get(id)?.openSearch();
    return;
  }
  if (act === "close-tab" && tabId) {
    const tab = layout.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const running = tab.panes.filter((p) => status[p] && !SHELLS.has(status[p].command));
    if (running.length && !(await confirmDialog(`Esta aba tem ${running.length} processo(s) rodando. Encerrar?`))) return;
    for (const p of [...tab.panes]) await closeTerminal(p, false);
    return;
  }
  if (tabId) activateTab(tabId);
});
$("#tabbar").addEventListener("dblclick", (e) => {
  const tabId = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.dataset.tab;
  const tab = layout.tabs.find((t) => t.id === tabId);
  const tid = tab && (tab.panes.includes(activePaneId() ?? "") ? activePaneId()! : tab.panes[0]);
  if (tid) void renameTerminal(tid);
});
$("#tabbar").addEventListener("auxclick", (e) => {
  // Clique do meio fecha a aba.
  if (e.button !== 1) return;
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]")?.querySelector<HTMLElement>("[data-act=close-tab]");
  btn?.click();
});

// Ditado por voz: usa o /voice do próprio Claude Code (modo "tap": um toque
// começa a gravar, outro para e envia). O botão só manda a tecla do ditado,
// Alt+K (voice:pushToTalk em ~/.claude/keybindings.json), para o terminal.
const VOICE_KEY = "\x1bk";
/** Terminais gravando (pelo que o botão sabe; o envio, ao virar "trabalhando", zera). */
const recording = new Set<string>();

function micButton() {
  const id = activePaneId();
  // Só no app do PC: o microfone é o do PC (pelo navegador seria o de outro aparelho).
  if (!api.native || !id || !status[id]?.claude || chatStates.has(id)) return "";
  const on = recording.has(id);
  return `<button class="icon mic ${on ? "on rec" : ""}" data-act="voice" title="${on ? "Parar e enviar" : "Ditar por voz (Alt+K)"}">${icon("mic", 15)}</button>`;
}

function toggleVoice() {
  const id = activePaneId();
  if (!id) return;
  api.termInput(id, VOICE_KEY);
  if (!recording.delete(id)) recording.add(id);
  renderTabs();
  panes.get(id)?.focus();
}

function ensurePane(tid: string) {
  let p = panes.get(tid);
  if (!p) {
    p = new Pane(tid, handleKey, () => {
      const tab = tabOfTerm(tid);
      if (unseen.delete(tid)) renderSidebar();
      if (tab && layout.activePane[tab.id] !== tid) {
        layout.activePane[tab.id] = tid;
        saveLayout();
        renderSidebar();
        markActivePane();
      }
    });
    panes.set(tid, p);
  }
  return p;
}

function markActivePane() {
  const ap = activePaneId();
  for (const [id, p] of panes) p.el.classList.toggle("focused", id === ap);
  document.body.classList.toggle("chat-active", !!ap && chatViews.has(ap));
}

// ---------- Modo chat ----------

/** termId → tela de chat (terminal em modo chat). */
const chatViews = new Map<string, ChatView>();
/**
 * Estado por terminal em modo chat. É o MESMO objeto que o ChatView mantém
 * (load/applyState guardam a referência e setMode/setBusy o atualizam): o app
 * no celular lê o modo atual daqui (AppHost.chatState).
 */
const chatStates = new Map<string, ChatState>();

function attachChat(tid: string) {
  const p = panes.get(tid);
  if (!p) return; // o painel ainda não foi criado: renderWorkspace anexa depois
  let v = chatViews.get(tid);
  if (!v) {
    v = new ChatView(tid, () => void toggleChat(tid), toast);
    chatViews.set(tid, v);
  }
  if (v.el.parentElement !== p.el) p.el.appendChild(v.el);
  p.el.classList.add("chat-mode");
  void v.load(chatStates.get(tid));
  markActivePane();
  renderTabs();
}

function detachChat(tid: string) {
  // No celular, voltar ao terminal (daqui ou de outro aparelho) vale como
  // escolha: esse terminal não reabre sozinho como chat.
  if (MOBILE && chatStates.has(tid)) preferTerminal(tid, true);
  const v = chatViews.get(tid);
  v?.el.remove();
  chatViews.delete(tid);
  chatStates.delete(tid);
  const p = panes.get(tid);
  if (p) {
    p.el.classList.remove("chat-mode");
    requestAnimationFrame(() => p.fitNow());
  }
  markActivePane();
  renderTabs();
}

let chatBusy = false;

/** Terminal ⇄ chat. */
async function toggleChat(tid = activePaneId()) {
  if (!tid || chatBusy) return;
  chatBusy = true;
  try {
    if (chatStates.has(tid)) {
      await api.chatClose(tid);
      detachChat(tid);
      focusActive();
    } else {
      const st = await api.chatOpen(tid);
      preferTerminal(tid, false);
      chatStates.set(tid, st);
      attachChat(tid);
      focusActive();
    }
  } catch (e) {
    toast(String(e));
  } finally {
    chatBusy = false;
  }
}

// No celular o padrão é o chat: o terminal ativo com o Claude parado abre como
// chat sozinho, a menos que o usuário tenha voltado ao terminal nele.
const PREF_KEY = "coliseu.terminalPreferred";
const terminalPreferred = new Set<string>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(PREF_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  })(),
);

function preferTerminal(tid: string, on: boolean) {
  if (on) terminalPreferred.add(tid);
  else terminalPreferred.delete(tid);
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify([...terminalPreferred]));
  } catch {
    /* ignora */
  }
}

/**
 * Só age depois de um gesto no celular (abrir a página, trocar de terminal,
 * voltar para a aba): o polling sozinho nunca converte o terminal, senão o
 * celular parado na mesa tiraria o Claude de quem está usando o desktop.
 * Se o Claude estava processando, o candidato espera ele parar.
 */
let autoCandidate: string | null = null;

function maybeAutoChat(fromUser = false) {
  if (!MOBILE) return;
  if (isAppHome()) return; // no app, só a conversa aberta vira chat
  if (fromUser) autoCandidate = activePaneId() ?? null;
  const tid = autoCandidate;
  if (!tid || tid !== activePaneId() || document.visibilityState !== "visible") return;
  if (chatBusy || view !== "terms") return;
  if (chatStates.has(tid) || terminalPreferred.has(tid)) return void (autoCandidate = null);
  const c = status[tid]?.claude;
  if (c?.kind !== "claude") return void (autoCandidate = null);
  if (c.status !== "idle") return; // processando/aguardando: tenta quando parar
  autoCandidate = null;
  void toggleChat(tid);
}

function onChatEvent(e: import("./transport").ChatEvent) {
  if (e.ev === "opened") {
    chatStates.set(e.chatId, e.state);
    attachChat(e.chatId);
  }
  const v = chatViews.get(e.chatId);
  if (v) {
    v.trackPending(e);
    v.handle(e);
  }
  // Pedidos pendentes também no estado (o app no celular mostra "aguardando você").
  const st = chatStates.get(e.chatId);
  if (st && e.ev === "permission" && !st.pending.some((p) => p.requestId === e.requestId)) st.pending.push(e);
  if (st && e.ev === "permission_resolved") st.pending = st.pending.filter((p) => p.requestId !== e.requestId);
  if (st && e.ev === "state") st.busy = !!e.busy;
  // Sem tela de chat aberta neste aparelho, ninguém mais atualiza o modo.
  if (st && e.ev === "mode" && typeof e.mode === "string") st.mode = e.mode;

  if (e.ev === "closed") {
    if (e.error) toast(`Chat encerrado: ${e.error}${e.resumedTerminal ? " — a conversa foi retomada no terminal." : ""}`);
    else if (e.resumedTerminal) toast("O chat foi encerrado; a conversa foi retomada no terminal.");
    detachChat(e.chatId);
  }
  // O backend põe o chat no status (terms_status): lê agora, sem esperar o
  // próximo ciclo de 1,5 s. Assim o "trabalhando" é visto mesmo numa resposta
  // curta, e "concluído"/notificação saem do mesmo lugar de sempre (pollStatus).
  if (["opened", "closed", "state", "permission", "permission_resolved"].includes(e.ev)) void pollStatus(true);
}

function renderWorkspace() {
  const ws = $("#workspace");
  const at = activeTab();
  for (const tab of layout.tabs) {
    let el = tabEls.get(tab.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "tabview";
      tabEls.set(tab.id, el);
      ws.appendChild(el);
    }
    const visible = tab.id === at?.id;
    el.style.display = visible ? "flex" : "none";
    el.style.flexDirection = tab.dir === "row" ? "row" : "column";
    if (!visible && !tab.panes.some((p) => panes.has(p))) continue; // lazy

    // Reconstrói a ordem: pane, divisor, pane...
    const want: HTMLElement[] = [];
    tab.panes.forEach((tid, i) => {
      if (i > 0) want.push(divider(tab, i - 1));
      const p = ensurePane(tid);
      if (chatStates.has(tid) && !chatViews.has(tid)) queueMicrotask(() => attachChat(tid));
      p.el.style.flex = `${tab.sizes?.[i] ?? 1} 1 0`;
      want.push(p.el);
    });
    const same = want.length === el.children.length && want.every((w, i) => w === el!.children[i]);
    if (!same) el.replaceChildren(...want);
    if (visible) for (const tid of tab.panes) panes.get(tid)!.open();
  }
  const empty = $("#workspace .empty");
  if (!at) {
    if (!empty) {
      const d = document.createElement("div");
      d.className = "empty";
      const g = group(activeGroupId());
      d.innerHTML = `<div class="empty-icon">${icon("terminal", 28)}</div>
        <h2>${g ? esc(g.name) : "Coliseu"}</h2>
        <p>Nenhum terminal aberto neste grupo.</p>
        <button class="primary" data-act="new">${icon("plus", 15)} Novo terminal <kbd>Ctrl Shift T</kbd></button>`;
      d.querySelector("button")!.onclick = () => void newTerminal();
      ws.appendChild(d);
    }
  } else empty?.remove();
  requestAnimationFrame(() => at?.panes.forEach((p) => panes.get(p)?.fitNow()));
  markActivePane();
}

function divider(tab: Tab, i: number) {
  const d = document.createElement("div");
  d.className = `divider ${tab.dir}`;
  d.onmousedown = (ev) => {
    ev.preventDefault();
    const parent = d.parentElement!;
    const els = tab.panes.map((p) => panes.get(p)!.el);
    const rect = (el: HTMLElement) => el.getBoundingClientRect();
    const horiz = tab.dir === "row";
    const total = els.reduce((s, el) => s + (horiz ? rect(el).width : rect(el).height), 0);
    const sizes = els.map((el) => ((horiz ? rect(el).width : rect(el).height) / total) * els.length);
    const start = horiz ? ev.clientX : ev.clientY;
    const a0 = sizes[i], b0 = sizes[i + 1];
    parent.classList.add("dragging");
    const move = (m: MouseEvent) => {
      const delta = (((horiz ? m.clientX : m.clientY) - start) / total) * els.length;
      const a = Math.max(0.15, Math.min(a0 + b0 - 0.15, a0 + delta));
      sizes[i] = a;
      sizes[i + 1] = a0 + b0 - a;
      els[i].style.flex = `${sizes[i]} 1 0`;
      els[i + 1].style.flex = `${sizes[i + 1]} 1 0`;
    };
    const up = () => {
      parent.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      tab.sizes = sizes;
      saveLayout();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return d;
}

function readableOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.35 ? "#0b0b0e" : "#ffffff";
}

function applyGroupAccent() {
  const main = $("#main");
  const color = normalizeHex(group(activeGroupId())?.color ?? "");
  if (!color) {
    for (const k of ["--accent", "--accent-hover", "--accent-fg", "--accent-soft"]) main.style.removeProperty(k);
    return;
  }
  main.style.setProperty("--accent", color);
  main.style.setProperty("--accent-hover", `color-mix(in srgb, ${color} 82%, #fff)`);
  main.style.setProperty("--accent-fg", readableOn(color));
  main.style.setProperty("--accent-soft", `color-mix(in srgb, ${color} 14%, transparent)`);
}

function render() {
  normalize();
  applyGroupAccent();
  renderSidebar();
  renderTabs();
  renderWorkspace();
  renderFiles();
}

// ---------- Diálogos ----------

type Field = { key: string; label: string; value: string; type?: string; options?: [string, string][] };

function normalizeHex(v: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

function formDialog(title: string, fields: Field[], extra?: string): Promise<Record<string, string> | "extra" | null> {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    root.innerHTML = `<div class="backdrop"><form class="modal form">
      <div class="mhead"><h3>${esc(title)}</h3></div>
      ${fields
        .map((f) =>
          f.options
            ? `<label><span class="label">${esc(f.label)}</span><select name="${f.key}">${f.options
                .map(([v, l]) => `<option value="${esc(v)}" ${v === f.value ? "selected" : ""}>${esc(l)}</option>`)
                .join("")}</select></label>`
            : f.type === "color"
              ? `<label><span class="label">${esc(f.label)}</span><span class="color-row"><input type="color" data-color-for="${f.key}" value="${esc(normalizeHex(f.value) ?? "#a855f7")}" aria-label="Seletor de cor" /><input name="${f.key}" type="text" class="hex-input" value="${esc(normalizeHex(f.value) ?? f.value)}" maxlength="7" spellcheck="false" autocomplete="off" placeholder="#a855f7" aria-label="Cor em hex" /></span></label>`
              : f.type === "folder"
              ? `<label><span class="label">${esc(f.label)}</span><span class="folder-row"><input name="${f.key}" type="text" value="${esc(f.value)}" />${api.native ? `<button type="button" data-pick="${f.key}">📁 Escolher…</button>` : ""}</span></label>`
              : `<label><span class="label">${esc(f.label)}</span><input name="${f.key}" type="${f.type ?? "text"}" value="${esc(f.value)}" /></label>`,
        )
        .join("")}
      <div class="actions">
        ${extra ? `<button type="button" class="danger" data-act="extra">${esc(extra)}</button>` : ""}
        <span class="spacer"></span>
        <button type="button" data-act="cancel">Cancelar</button>
        <button type="submit" class="primary">Salvar</button>
      </div></form></div>`;
    const form = root.querySelector("form")!;
    const done = (v: Record<string, string> | "extra" | null) => {
      root.innerHTML = "";
      resolve(v);
      focusActive();
    };
    form.querySelectorAll<HTMLInputElement>("[data-color-for]").forEach((picker) => {
      const text = form.querySelector<HTMLInputElement>(`input[name="${picker.dataset.colorFor}"]`)!;
      picker.oninput = () => {
        text.value = picker.value;
        text.classList.remove("invalid");
      };
      text.oninput = () => {
        const hex = normalizeHex(text.value);
        text.classList.toggle("invalid", !hex && text.value.trim() !== "");
        if (hex) picker.value = hex;
      };
      text.onblur = () => {
        const hex = normalizeHex(text.value);
        if (hex) text.value = hex;
      };
    });
    form.onsubmit = (e) => {
      e.preventDefault();
      const bad = [...form.querySelectorAll<HTMLInputElement>(".hex-input")].find((i) => !normalizeHex(i.value));
      if (bad) {
        bad.classList.add("invalid");
        bad.focus();
        bad.select();
        return;
      }
      form.querySelectorAll<HTMLInputElement>(".hex-input").forEach((i) => (i.value = normalizeHex(i.value)!));
      done(Object.fromEntries(new FormData(form)) as Record<string, string>);
    };
    form.querySelector<HTMLElement>("[data-act=cancel]")!.onclick = () => done(null);
    form.querySelector<HTMLElement>("[data-act=extra]")?.addEventListener("click", () => done("extra"));
    // Seletor de pastas do sistema; o nome vazio vem da pasta escolhida.
    form.querySelectorAll<HTMLElement>("[data-pick]").forEach((b) => (b.onclick = async () => {
      const input = form.querySelector<HTMLInputElement>(`input[name="${b.dataset.pick}"]`)!;
      const dir = await api.pickFolder(input.value).catch(() => null);
      if (!dir) return;
      input.value = dir;
      const name = form.querySelector<HTMLInputElement>('input[name="name"]');
      if (name && !name.value.trim()) name.value = dir.split("/").filter((p) => p && p !== "~").pop() ?? "";
    }));
    // Corpo em bloco: um handler on* que devolve false cancela a tecla (nada se digitava).
    form.onkeydown = (e) => {
      if (e.key === "Escape") done(null);
    };
    const first = form.querySelector<HTMLInputElement>("input,select");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  });
}

function confirmDialog(html: string): Promise<boolean> {
  return new Promise((resolve) => {
    const root = $("#modal-root");
    root.innerHTML = `<div class="backdrop"><div class="modal confirm" tabindex="-1"><p>${html}</p>
      <div class="actions"><span class="spacer"></span><button data-v="0">Cancelar</button><button class="danger" data-v="1">Encerrar</button></div></div></div>`;
    const m = root.querySelector<HTMLElement>(".modal")!;
    const done = (v: boolean) => {
      root.innerHTML = "";
      resolve(v);
      focusActive();
    };
    m.querySelectorAll<HTMLElement>("[data-v]").forEach((b) => (b.onclick = () => done(b.dataset.v === "1")));
    m.onkeydown = (e) => {
      if (e.key === "Escape") done(false);
      if (e.key === "Enter") done(true);
    };
    m.querySelector<HTMLElement>(".danger")!.focus();
  });
}

function contextMenu(x: number, y: number, items: [string, () => unknown, IconName?][]) {
  document.querySelector(".ctx")?.remove();
  const m = document.createElement("div");
  m.className = "ctx";
  m.style.left = `${x}px`;
  m.style.top = `${y}px`;
  for (const [label, fn, ic] of items) {
    const b = document.createElement("button");
    b.innerHTML = `${ic ? icon(ic, 14) : "<i class='i'></i>"}<span>${esc(label)}</span>`;
    if (label === "Encerrar") b.classList.add("danger-item");
    b.onclick = () => {
      m.remove();
      void fn();
    };
    m.appendChild(b);
  }
  document.body.appendChild(m);
  // Não deixa o menu sair da tela.
  const r = m.getBoundingClientRect();
  if (r.right > innerWidth - 8) m.style.left = `${innerWidth - r.width - 8}px`;
  if (r.bottom > innerHeight - 8) m.style.top = `${innerHeight - r.height - 8}px`;
  setTimeout(() => window.addEventListener("click", () => m.remove(), { once: true }));
}

function toast(msg: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------- Tela de PRs ----------

let view: "terms" | "prs" | "file" = "terms";

function setView(v: "terms" | "prs" | "file") {
  if (v === "prs" && !prsEnabled()) v = "terms";
  view = v;
  const prs = v === "prs";
  $("#tabbar").hidden = v !== "terms";
  $("#workspace").hidden = v !== "terms";
  $("#prs-view").hidden = !prs;
  $("#file-view").hidden = v !== "file";
  document.body.classList.toggle("view-prs", prs);
  if (prs) renderPrs();
  renderNav();
  if (v === "terms") {
    requestAnimationFrame(() => panes.forEach((p) => p.fitNow()));
    focusActive();
  }
}

function renderNav() {
  if (MOBILE) appRefresh();
  const b = $("#nav-prs");
  b.hidden = !prsEnabled();
  const w = waitingCount();
  b.classList.toggle("on", view === "prs");
  b.innerHTML = `${icon("pr", 15)}<span>Pull requests</span>
    ${w ? `<b class="pill s-waiting" title="aguardando você">${w}</b>` : ""}<span class="num">${totalCount() || ""}</span>`;
  const f = $("#nav-files");
  f.hidden = MOBILE;
  f.classList.toggle("on", filesOpen());
  f.innerHTML = `${icon("folder", 15)}<span>Arquivos</span>`;
}

function notifyPr(title: string, body: string) {
  const n = settings.notify;
  const desktop = !(windowFocused && n.onlyUnfocused && !settings.prs.notifyFocused);
  const push = n.push && awayFromDesktop();
  if (!desktop && !push) return;
  api.notify(title, body, undefined, n.sound, push, desktop);
}

// ---------- Aparência ----------

function applyLook() {
  const ui = settings.ui;
  applyTheme(ui.theme);
  // No celular a tela é estreita: fonte menor para caber mais colunas.
  const size = MOBILE ? Math.min(ui.termFontSize, 13) : ui.termFontSize;
  setLook({ theme: TERM_THEMES[ui.theme] ?? TERM_THEMES.preto, fontFamily: fontCss(ui.termFont), fontSize: size });
}

// ---------- Celular (acesso remoto pelo navegador) ----------

const MOBILE = !api.native && (matchMedia("(pointer: coarse)").matches || innerWidth < 820);

function toggleDrawer(open = !document.body.classList.contains("drawer-open")) {
  document.body.classList.toggle("drawer-open", open);
}

let ctrlLatch = false;

function setupMobile() {
  document.body.classList.add("mobile");
  // Teclado virtual: a página ocupa só a área visível acima dele (reforço
  // para navegadores que ignoram interactive-widget=resizes-content).
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => {
      document.body.style.height = `${vv.height}px`;
      window.scrollTo(0, 0);
    };
    vv.addEventListener("resize", fit);
    fit();
  }
  // Voltou para a aba / desbloqueou a tela: reassume o tamanho do terminal.
  document.addEventListener("visibilitychange", () => {
    const id = activePaneId();
    if (document.visibilityState === "visible" && id && view === "terms") panes.get(id)?.claim();
    if (document.visibilityState === "visible") maybeAutoChat(true);
  });

  // Barra de teclas extras acima do teclado virtual.
  const KEYS: [string, string, string?][] = [
    ["Esc", "\x1b"],
    ["Tab", "\t"],
    ["Ctrl", "ctrl"],
    ["↑", "\x1b[A"],
    ["↓", "\x1b[B"],
    ["←", "\x1b[D"],
    ["→", "\x1b[C"],
    ["⏎ linha", "\x1b\r", "Nova linha no Claude/Codex"],
    ["^C", "\x03", "Interromper"],
    ["Colar", "paste"],
  ];
  const bar = document.createElement("div");
  bar.id = "keybar";
  bar.innerHTML = KEYS.map(([l, k, t]) => `<button data-key="${encodeURIComponent(k)}" ${t ? `title="${t}"` : ""}>${l}</button>`).join("");
  $("#main").appendChild(bar);
  // pointerdown + preventDefault: não tira o foco do terminal (teclado continua aberto).
  bar.addEventListener("pointerdown", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
    if (!b) return;
    e.preventDefault();
    const k = decodeURIComponent(b.dataset.key!);
    const id = activePaneId();
    if (!id) return;
    if (k === "ctrl") {
      ctrlLatch = !ctrlLatch;
      b.classList.toggle("on", ctrlLatch);
    } else if (k === "paste") void paste();
    else api.termInput(id, k);
  });
  setInputFilter((d) => {
    if (!ctrlLatch || d.length !== 1) return d;
    ctrlLatch = false;
    bar.querySelector('[data-key="ctrl"]')?.classList.remove("on");
    const c = d.toLowerCase().charCodeAt(0);
    return c >= 97 && c <= 122 ? String.fromCharCode(c - 96) : d; // Ctrl+letra
  });
}

// ---------- App no celular (docs/MOBILE_SPEC.md) ----------

const appHost: AppHost = {
  groups: () => cfg.groups,
  terminals: () => cfg.terminals,
  status: (tid) => status[tid],
  state: (tid) => agentState(tid),
  run: (tid) => runs[tid],
  // O nome que o usuário deu ao terminal (não o da sessão do Claude).
  title: (tid) => term(tid)?.title || "Terminal",
  activeId: () => activePaneId(),
  activate: (tid) => activateTerminal(tid),
  newTerminal: (groupId) => newTerminal(groupId),
  rename: (tid) => renameTerminal(tid),
  close: async (tid) => {
    const was = activePaneId() === tid;
    await closeTerminal(tid);
    if (was && !term(tid)) goHome();
  },
  isChat: (tid) => chatStates.has(tid),
  toggleChat: (tid) => toggleChat(tid),
  chatState: (tid) => chatStates.get(tid),
  setChatMode: async (tid, mode) => {
    try {
      await api.chatSetMode(tid, mode);
    } catch (e) {
      toast(String(e));
    }
  },
  focus: () => focusActive(),
  toast: (msg) => toast(msg),
};

function setupApp() {
  initApp(appHost);
  setUsageListener(appRefresh);
  // Notificação tocada com o app já aberto: vai para a conversa daquele terminal.
  void initPush((tid) => {
    if (term(tid)) openConvo(tid);
  }).then(appRefresh);
  addTab(homeTab(appHost));
  addTab(prsTab(appHost)); // some/aparece com a configuração (AppTab.enabled)
  addTab(accountsTab(appHost));
  setConvoBar(createConvoBar(appHost));
}

// ---------- Sincronização entre aparelhos ----------

let cfgVersion = 0;

/** Outro aparelho (desktop ↔ celular) mudou terminais/grupos/configurações: recarrega. */
async function syncFromOtherDevice() {
  try {
    const v = await api.stateVersion();
    if (cfgVersion && v !== cfgVersion && !editing) {
      const next = await api.stateGet();
      cfg = { ...next, layout: cfg.layout };
      loadSettings(next.settings);
      applyLook();
      normalize();
      render();
    }
    cfgVersion = v;
  } catch {
    /* conexão oscilando */
  }
}

// ---------- Largura da sidebar ----------

const SIDEBAR_DEFAULT = 260;
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 600;

function applySidebarWidth(w: number) {
  document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
}

function initSidebarResize() {
  applySidebarWidth(layout.sidebarWidth ?? SIDEBAR_DEFAULT);
  const handle = document.createElement("div");
  handle.className = "sidebar-resize";
  handle.title = "Arraste para ajustar · duplo clique para o tamanho padrão";
  $("#sidebar").appendChild(handle);

  handle.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = $("#sidebar").getBoundingClientRect().width;
    document.body.classList.add("resizing-sidebar");
    const move = (m: MouseEvent) => {
      const w = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + m.clientX - startX)));
      layout.sidebarWidth = w;
      applySidebarWidth(w);
    };
    const up = () => {
      document.body.classList.remove("resizing-sidebar");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      saveLayout();
      panes.forEach((p) => p.fitNow());
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  handle.addEventListener("dblclick", () => {
    layout.sidebarWidth = undefined;
    applySidebarWidth(SIDEBAR_DEFAULT);
    saveLayout();
    panes.forEach((p) => p.fitNow());
  });
}

// ---------- Boot ----------

api.onChatEvent(onChatEvent);

api.onTermExit(({ id, gone }) => {
  if (gone) {
    if (settings.notify.exited) notifyTerm(id, "Terminal encerrado", term(id)?.cwd ?? "");
    removePane(id);
  } else {
    // Cliente caiu mas a sessão vive: reconecta.
    const p = panes.get(id);
    if (p) {
      p.markDetached();
      setTimeout(() => p.el.isConnected && void p.attach(), 300);
    }
  }
});

// ---------- Notificações ----------

let windowFocused = document.hasFocus();
window.addEventListener("focus", () => (windowFocused = true));
window.addEventListener("blur", () => (windowFocused = false));

/** Último uso do teclado/mouse no desktop (para saber se a pessoa saiu do computador). */
let lastInput = Date.now();
for (const ev of ["keydown", "pointerdown", "pointermove", "wheel"]) {
  window.addEventListener(ev, () => (lastInput = Date.now()), { capture: true, passive: true });
}
/** Ninguém no computador: janela sem foco ou parada há 2 min (a janela pode ter ficado na frente). */
const awayFromDesktop = () => !windowFocused || Date.now() - lastInput > 2 * 60_000;

/** Início de comandos que não são shell/agente, para "comando longo terminou". */
const cmdStart: Record<string, { cmd: string; at: number }> = {};
const AGENT_CMDS = /^(claude|codex)$/;

const agentName = (kind?: string) => (kind === "codex" ? "Codex" : "Claude");

function notifyTerm(tid: string, title: string, body: string) {
  const n = settings.notify;
  const t = term(tid);
  if (t && n.mutedGroups.includes(t.groupId)) return;
  const desktop = !(windowFocused && (n.onlyUnfocused || tid === activePaneId()));
  // Celular: só quando a pessoa não está no computador (regra própria, ver awayFromDesktop).
  const push = n.push && awayFromDesktop();
  if (!desktop && !push) return;
  const g = group(t?.groupId);
  const where = t ? `${g ? `[${g.name}] ` : ""}${t.title}` : "";
  api.notify(where ? `${title} — ${where}` : title, body, tid, n.sound, push, desktop);
}

function detectEvents(prev: Record<string, TermStatus>, next: Record<string, TermStatus>) {
  const n = settings.notify;
  const now = Date.now();
  for (const [tid, st] of Object.entries(next)) {
    const before = prev[tid];
    if (!before) continue; // 1º poll ou terminal novo: sem transição
    const a = before.claude, b = st.claude;

    if (n.waiting && b?.status === "waiting" && a?.status !== "waiting") {
      const why = b.waitingFor ? (WAITING_LABEL[b.waitingFor] ?? b.waitingFor) : "precisa de você";
      notifyTerm(tid, "Aguardando você", `${b.name ?? agentName(b.kind)}: ${why}`);
    }
    // Só a sessão principal: com subagentes ainda rodando, cada relatório que chega
    // faz o Claude trabalhar um pouco e parar de novo — avisa quando o último acabar.
    if (n.done && a?.status === "busy" && (b?.status === "idle" || b?.status === "shell") && !b.subagents.some((x) => !x.finished)) {
      notifyTerm(tid, `${agentName(b.kind)} concluiu`, b.name ?? "Pronto para a próxima instrução");
    }
    if (n.subagent && a && b && a.sessionId === b.sessionId) {
      const still = new Set(b.subagents.map((x) => x.id));
      for (const sa of a.subagents) {
        if (!still.has(sa.id)) notifyTerm(tid, "Subagent concluído", sa.description);
      }
    }
    // Comando longo (não-agente) terminou.
    const cmd = st.command;
    const running = !SHELLS.has(cmd) && !AGENT_CMDS.test(cmd);
    const started = cmdStart[tid];
    if (started && started.cmd !== cmd) {
      const secs = Math.round((now - started.at) / 1000);
      if (n.longCmd && secs >= n.longCmdSecs) notifyTerm(tid, "Comando terminou", `${started.cmd} (${ago(started.at)})`);
      delete cmdStart[tid];
    }
    if (running && !cmdStart[tid]) cmdStart[tid] = { cmd, at: now };
  }
}

let lastRender = 0;

/** Terminal à vista agora (no app, na home, nenhum: o painel ativo fica escondido). */
const viewingPane = () => (document.hasFocus() && !isAppHome() ? activePaneId() : undefined);
const isAppHome = () => MOBILE && document.body.classList.contains("app") && currentScreen() === "home";

let inflight: Promise<void> | null = null;
let pollAgain = false;

/**
 * Lê o status dos terminais. Uma leitura por vez: com outra em andamento,
 * devolve a mesma promessa; `again` (eventos do chat) pede mais uma logo depois,
 * o ciclo de 1,5 s só pula.
 */
function pollStatus(again = false): Promise<void> {
  if (inflight) {
    if (again) pollAgain = true;
    return inflight;
  }
  inflight = readStatus().finally(() => {
    inflight = null;
    if (pollAgain) {
      pollAgain = false;
      void pollStatus();
    }
  });
  return inflight;
}

async function readStatus() {
  try {
    // Conexão morrendo pode nunca responder: sem limite, travaria as próximas leituras.
    const next = await Promise.race([
      api.termsStatus(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("tempo esgotado")), 10_000)),
    ]);
    // Transições: terminou de processar fora da vista → "concluído (não visto)".
    const viewing = viewingPane();
    for (const [tid, st] of Object.entries(next)) {
      const before = status[tid]?.claude?.status;
      const after = st.claude?.status;
      const stopped = after === "idle" || after === "shell";
      if (before === "busy" && stopped && tid !== viewing) unseen.add(tid);
      if (!stopped) unseen.delete(tid);
      if (after === "busy") recording.delete(tid); // enviou: o ditado acabou
    }
    for (const tid of unseen) if (!next[tid]?.claude) unseen.delete(tid);
    detectEvents(status, next);
    trackStates(next);
    const changed = JSON.stringify(next) !== JSON.stringify(status);
    status = next;
    // Re-render só quando muda (ou a cada 15s para atualizar os tempos),
    // para não "engolir" cliques no meio de um redesenho.
    if (changed || Date.now() - lastRender > 15000) {
      lastRender = Date.now();
      renderSidebar();
      renderTabs();
    }
    maybeAutoChat();
  } catch {
    /* ignora */
  }
}

async function boot() {
  // Celular: esconde o layout do desktop desde o início (a casca entra depois).
  if (MOBILE) document.body.classList.add("app");
  // O convite de instalação do Chrome chega cedo: precisa estar ouvindo antes.
  if (MOBILE) initInstall(() => appRefresh());
  cfg = await api.stateGet();
  cfgVersion = await api.stateVersion().catch(() => 0);
  for (const st of await api.chatStates().catch(() => [] as ChatState[])) chatStates.set(st.termId, st);
  setInterval(() => void syncFromOtherDevice(), 2000);
  if (MOBILE) setupMobile();
  loadSettings(cfg.settings);
  applyLook();
  $("#open-settings").innerHTML = icon("settings", 16);
  $("#add-group").innerHTML = icon("plus", 15);
  void initAccounts(() => renderSidebar());
  $("#nav-prs").addEventListener("click", () => setView(view === "prs" ? "terms" : "prs"));
  bindPrsView((t) => api.clipboardWrite(t), () => setView("terms"), () => toggleDrawer(true));
  initPrs(renderNav, notifyPr);
  renderNav();
  api.onFocusTerm((id) => activateTerminal(id));
  $("#open-settings").addEventListener("click", () => openSettings(cfg.groups, focusActive, () => {
    applyLook();
    rerenderFooter();
    if (!prsEnabled() && view === "prs") setView("terms");
    renderNav();
    renderPrs();
    prsConfigChanged();
  }));
  const l = cfg.layout as Partial<Layout> | null;
  layout = {
    tabs: l?.tabs ?? [],
    activeGroup: l?.activeGroup,
    activeTab: l?.activeTab ?? {},
    activePane: l?.activePane ?? {},
    collapsed: l?.collapsed ?? {},
    sidebarWidth: l?.sidebarWidth,
  };
  initSidebarResize();
  if (!MOBILE) {
    initFiles({
      groups: () => cfg.groups,
      activeGroupId,
      openFile,
      setFolders: async (gid, folders) => {
        const g = group(gid);
        if (!g) return;
        cfg = { ...(await api.groupUpsert({ ...g, folders })), layout: cfg.layout };
        render();
      },
      pickFolder: (start) => api.pickFolder(start),
      insertPath: (path) => {
        const id = activePaneId();
        if (!id) return toast("Nenhum terminal ativo");
        api.termInput(id, `${path} `);
        focusActive();
      },
      newTerminalAt: (gid, cwd) =>
        void api
          .termCreate(gid, { cwd })
          .then((t) => placeTerminal(t, gid))
          .catch((e) => toast(`Erro ao criar terminal: ${e}`)),
      contextMenu,
      toast,
      onResize: () => {
        renderNav();
        requestAnimationFrame(() => panes.forEach((p) => p.fitNow()));
      },
    });
    $("#nav-files").addEventListener("click", () => toggleFiles());
    initViewer({ show: () => setView("file"), hide: () => setView("terms"), toast, confirm: confirmDialog });
  }
  await pollStatus();
  render();
  if (MOBILE) setupApp();
  focusActive();
  maybeAutoChat(true);
  setInterval(() => void pollStatus(), 1500);
  // Fontes carregadas depois do 1º fit mudam o tamanho da célula.
  void document.fonts.ready.then(() => panes.forEach((p) => p.fitNow()));
  window.addEventListener("focus", focusActive);
  const onboarding = () =>
    void openOnboarding({
      groups: () => cfg.groups,
      reload: async () => {
        cfg = { ...(await api.stateGet()), layout: cfg.layout };
        normalize();
        render();
      },
      openTerminal: (gid) => void newTerminal(gid),
      onClose: focusActive,
    });
  window.addEventListener("coliseu:onboarding", onboarding);
  if (shouldOnboard(cfg.terminals.length)) onboarding();
}

void boot();
