// Casca do app no celular (docs/MOBILE_SPEC.md): navegação em pilha
// (home ⇄ conversa), barra de abas flutuante e folha de ações do iOS.
// As telas em si ficam em home.ts, convo.ts e pages.ts; o main.ts entra só
// pela interface AppHost.
import "./shell.css";
import type { ChatState, Group, Terminal, TermStatus } from "../transport";
import { icon, type IconName } from "../icons";
import { esc as escHtml } from "../labels";

export type AgentState = "busy" | "waiting" | "idle" | "done" | "none";

/** O que o app precisa do main.ts (dados ao vivo + ações já existentes). */
export interface AppHost {
  groups(): Group[];
  terminals(): Terminal[];
  status(tid: string): TermStatus | undefined;
  /** Estado do agente no terminal (o mesmo da sidebar do desktop). */
  state(tid: string): AgentState;
  /** Execução atual/última: `start` = rodando desde; `lastMs` = duração da última. */
  run(tid: string): { start?: number; lastMs?: number } | undefined;
  /** Nome do terminal (o que o usuário deu). */
  title(tid: string): string;
  /** Terminal ativo (o que a conversa mostra). */
  activeId(): string | undefined;
  /** Ativa o terminal no workspace (a conversa mostra o painel dele). */
  activate(tid: string): void;
  /** Cria um terminal no grupo; devolve o id (nada se falhou — o aviso já apareceu). */
  newTerminal(groupId: string): Promise<string | undefined>;
  rename(tid: string): Promise<void>;
  close(tid: string): Promise<void>;
  isChat(tid: string): boolean;
  /** Terminal ⇄ chat (mesmo fluxo do botão do desktop). */
  toggleChat(tid: string): Promise<void>;
  /** Estado do chat (modo de permissão atual, se pode "sem aprovações"…). */
  chatState(tid: string): ChatState | undefined;
  /** Troca o modo de permissão do chat (o evento "mode" atualiza a tela). */
  setChatMode(tid: string, mode: string): Promise<void>;
  /** Teclado do terminal (barra de teclas) e foco. */
  focus(): void;
  toast(msg: string): void;
}

/** Uma aba da barra inferior (Terminais, PRs, Contas). */
export interface AppTab {
  id: string;
  label: string;
  icon: IconName;
  /** Conteúdo da aba (fica dentro da área rolável da home). */
  el: HTMLElement;
  /** Redesenha com os dados atuais (chamado a cada mudança de status e ao entrar na aba). */
  refresh(): void;
  /** Ponto vermelho na aba (ex.: PRs esperando você). */
  badge?(): boolean;
  /** A aba aparece? (ex.: PRs desligadas nas configurações). Sem isso, sempre. */
  enabled?(): boolean;
}

/** Barra de topo da conversa (convo.ts). */
export interface ConvoBar {
  el: HTMLElement;
  /** Terminal mostrado / estado mudou. */
  update(tid: string): void;
}

export interface SheetOption {
  label: string;
  danger?: boolean;
  /** Ponto colorido antes do texto (ex.: cor do grupo). */
  dot?: string;
  run: () => unknown;
}

let host: AppHost;
let homeEl: HTMLElement;
let scrollEl: HTMLElement;
let tabbarEl: HTMLElement;
const tabs: AppTab[] = [];
let currentTab = "terms";
let convoBar: ConvoBar | null = null;
let screen: "home" | "convo" = "home";

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

/** Monta a casca. As abas e a barra da conversa entram depois (addTab / setConvoBar). */
export function initApp(h: AppHost) {
  host = h;
  document.body.classList.add("app");

  homeEl = document.createElement("section");
  homeEl.id = "app-home";
  homeEl.innerHTML = `<div class="app-scroll"></div><nav class="app-tabbar" aria-label="Seções"></nav>`;
  document.body.appendChild(homeEl);
  scrollEl = $(".app-scroll", homeEl);
  tabbarEl = $(".app-tabbar", homeEl);
  tabbarEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (b) selectTab(b.dataset.tab!);
  });

  // Depois de recarregar, a entrada anterior do histórico é de outro documento:
  // "voltar" nela recarregaria o app inteiro. Trata como link direto.
  if ((history.state as { convo?: boolean } | null)?.convo) history.replaceState(null, "", location.href);
  // Voltar do Android / do navegador: conversa → home.
  addEventListener("popstate", () => route());
  route();
}

export function addTab(tab: AppTab) {
  tabs.push(tab);
  tab.el.hidden = tab.id !== currentTab;
  scrollEl.appendChild(tab.el);
  refresh(); // barra (pode trocar a aba atual) + a aba visível, só se a home está na tela
}

export function setConvoBar(bar: ConvoBar) {
  convoBar = bar;
  document.getElementById("main")!.prepend(bar.el);
  const id = host.activeId();
  if (id) bar.update(id);
}

const visibleTabs = () => tabs.filter((t) => t.enabled?.() ?? true);

function renderTabbar() {
  // Aba atual desligada (ex.: PRs desativadas em outro aparelho): passa para a
  // primeira; quem chamou (refresh/addTab) redesenha a aba atual depois.
  const first = visibleTabs()[0];
  if (first && !visibleTabs().some((t) => t.id === currentTab)) {
    currentTab = first.id;
    for (const t of tabs) t.el.hidden = t.id !== currentTab;
    scrollEl.scrollTop = 0;
  }
  tabbarEl.innerHTML = visibleTabs()
    .map(
      (t) => `<button data-tab="${t.id}" ${t.id === currentTab ? 'aria-current="page"' : ""} aria-label="${t.label}">
        ${icon(t.icon, 20)}<span>${t.label}</span>${t.badge?.() ? '<i class="app-dot"></i>' : ""}</button>`,
    )
    .join("");
}

export function selectTab(id: string) {
  if (!visibleTabs().some((t) => t.id === id)) return;
  currentTab = id;
  for (const t of tabs) t.el.hidden = t.id !== id;
  scrollEl.scrollTop = 0;
  renderTabbar();
  tabs.find((t) => t.id === id)!.refresh();
}

/** Dados mudaram (status, config, PRs, contas): redesenha o que está visível. */
export function refresh() {
  if (!host) return;
  renderTabbar();
  if (screen === "home") tabs.find((t) => t.id === currentTab)?.refresh();
  const id = host.activeId();
  if (screen === "convo" && id) convoBar?.update(id);
}

// ---------- Navegação ----------

const convoHash = (tid: string) => `#t=${encodeURIComponent(tid)}`;
const hashTid = () => {
  if (!location.hash.startsWith("#t=")) return null;
  try {
    return decodeURIComponent(location.hash.slice(3));
  } catch {
    return null; // link estragado: cai na home
  }
};
const clearHash = () => history.replaceState(null, "", location.pathname + location.search);

/** Abre a conversa de um terminal (empilha no histórico: o voltar volta para a home). */
export function openConvo(tid: string) {
  // A marca no history.state diz que a home está logo atrás (voltar = history.back()).
  if (hashTid() !== tid) history.pushState({ convo: true }, "", convoHash(tid));
  show("convo", tid);
}

/** Volta para a home. Aberto direto por link (#t=…), não há para onde "voltar": limpa o link. */
export function goHome() {
  if (hashTid() && (history.state as { convo?: boolean } | null)?.convo) history.back();
  else {
    if (hashTid()) clearHash();
    show("home");
  }
}

function route() {
  const tid = hashTid();
  if (tid && host.terminals().some((t) => t.id === tid)) show("convo", tid);
  else {
    if (location.hash.startsWith("#t=")) clearHash();
    show("home");
  }
}

function show(s: "home" | "convo", tid?: string) {
  screen = s;
  document.body.classList.toggle("app-convo", s === "convo");
  if (s === "convo" && tid) {
    host.activate(tid);
    convoBar?.update(tid);
  } else {
    (document.activeElement as HTMLElement | null)?.blur(); // fecha o teclado
    tabs.find((t) => t.id === currentTab)?.refresh();
  }
}

export const currentScreen = () => screen;

// ---------- Folha de ações (iOS) ----------

let sheetRoot: HTMLElement | null = null;

/** Folha de ações com "Cancelar" separado. Resolve quando fecha. */
export function sheet(head: string, options: SheetOption[]): Promise<void> {
  sheetRoot?.remove();
  const root = document.createElement("div");
  root.className = "app-sheet-root";
  root.innerHTML = `<div class="app-scrim"></div>
    <div class="app-sheet" role="dialog" aria-modal="true">
      <div class="blk">${head ? `<div class="head"></div>` : ""}${options
        .map(
          (o, i) =>
            `<button class="opt${o.danger ? " red" : ""}" data-i="${i}">${o.dot ? `<i class="gd" style="background:${o.dot}"></i>` : ""}<span></span></button>`,
        )
        .join("")}</div>
      <button class="cancel">Cancelar</button>
    </div>`;
  if (head) $(".head", root).textContent = head;
  root.querySelectorAll<HTMLElement>(".opt").forEach((b) => (b.querySelector("span")!.textContent = options[Number(b.dataset.i)].label));
  document.body.appendChild(root);
  sheetRoot = root;
  requestAnimationFrame(() => root.classList.add("on"));
  return new Promise((resolve) => {
    const close = () => {
      root.classList.remove("on");
      setTimeout(() => root.remove(), 280);
      if (sheetRoot === root) sheetRoot = null;
      resolve();
    };
    root.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const opt = t.closest<HTMLElement>(".opt");
      if (opt) {
        close();
        void options[Number(opt.dataset.i)].run();
      } else if (t.closest(".cancel") || t.classList.contains("app-scrim")) close();
    });
  });
}

// ---------- Utilidades compartilhadas pelas telas ----------

export { escHtml };

/** "1:20" (rodando/duração curta), "12 min", "2 h". */
export function shortDur(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

/** Cabeçalho comum das abas: pílula de conexão + botão à direita + título grande. */
export function pageHeader(title: string, action?: { icon: IconName; label: string; id: string }) {
  return `<div class="app-nav">
      <span class="app-conn"><i></i><span class="on">Conectado ao desktop</span><span class="off">Sem conexão</span></span>
      ${action ? `<button class="app-round" data-act="${action.id}" aria-label="${escHtml(action.label)}">${icon(action.icon, 20)}</button>` : ""}
    </div>
    <h1 class="app-title">${escHtml(title)}</h1>`;
}
