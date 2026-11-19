// Interface única entre UI e core. Hoje: Tauri IPC. Futuro: WebSocket (celular).
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface Group {
  id: string;
  name: string;
  color: string;
  cwd: string;
  account?: string | null;
}

export interface Terminal {
  id: string;
  groupId: string;
  title: string;
  cwd: string;
  account?: string | null;
  createdAt: number;
}

export interface Config {
  groups: Group[];
  terminals: Terminal[];
  layout: unknown;
  settings: unknown;
}

export interface SubAgent {
  id: string;
  description: string;
  agentType: string;
  finished: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface ClaudeInfo {
  /** "claude" | "codex" */
  kind: string;
  pid: number;
  sessionId: string;
  /** busy | idle | waiting | shell | ... */
  status: string;
  waitingFor?: string | null;
  name?: string | null;
  statusSince: number;
  subagents: SubAgent[];
  /** Contexto em uso (o que o /context mostra). Só Claude. */
  context?: ContextUse | null;
}

export interface ContextUse {
  used: number;
  window: number;
  model: string;
}

export interface TermStatus {
  command: string;
  path: string;
  title: string;
  claude?: ClaudeInfo | null;
}

export interface Account {
  id: string;
  label: string;
  alias?: string | null;
  plan?: string | null;
  accountUuid?: string | null;
  orgName?: string | null;
}

export interface AccountsState {
  accounts: Account[];
  active?: string | null;
}

export interface UsageWindow {
  percent: number;
  /** ISO (Claude) ou epoch ms (Codex) */
  resetsAt?: string | number | null;
}

export interface CodexAccount {
  loggedIn: boolean;
  email?: string | null;
  plan?: string | null;
  fiveHour?: UsageWindow | null;
  weekly?: UsageWindow | null;
  updatedAt: number;
}

export interface Usage {
  fiveHour?: UsageWindow | null;
  sevenDay?: UsageWindow | null;
  error?: string | null;
  fetchedAt: number;
  stale?: boolean;
}

export interface PrConfig {
  orgs: string[];
  logins: string[];
  intervalMin: number;
}

export interface PullRequest {
  org: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  base: string;
  draft: boolean;
  updatedAt: string;
  decision: "approved" | "changes_requested" | "none";
  checks: "success" | "failure" | "pending" | "none";
  last?: { at: string; login: string; kind: string; url: string; mine: boolean } | null;
  action: "waiting_me" | "waiting_reviewer" | "none";
  requested: string[];
}

export interface PrState {
  generatedAt: number;
  prs: PullRequest[];
  errors: string[];
  refreshing: boolean;
}

export interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  token: string;
  urls: string[];
  tailscaleIp?: string | null;
  error?: string | null;
}

export interface ChatState {
  termId: string;
  sessionId?: string | null;
  busy: boolean;
  pending: ChatEvent[];
  mode: string;
  allowBypass: boolean;
  cwd: string;
  args: string[];
  since: number;
}

/** Celular inscrito no Web Push (sem as chaves: só para mostrar). */
export interface PushDevice {
  endpoint: string;
  label: string;
  createdAt: number;
}

/** Eventos do modo chat (docs/CHAT_SPEC.md §4), repassados pelo core. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChatEvent = { chatId: string; ev: string; [k: string]: any };

export interface Transport {
  /** true no app desktop (Tauri); false no navegador (celular). */
  readonly native: boolean;
  stateVersion(): Promise<number>;
  chatOpen(id: string): Promise<ChatState>;
  chatClose(id: string): Promise<void>;
  chatSend(id: string, text: string): Promise<void>;
  chatRespond(id: string, requestId: string, result: unknown): Promise<void>;
  chatInterrupt(id: string): Promise<void>;
  chatSetMode(id: string, mode: string): Promise<void>;
  chatHistory(id: string): Promise<unknown[]>;
  chatStates(): Promise<ChatState[]>;
  onChatEvent(cb: (e: ChatEvent) => void): void;
  remoteStatus(): Promise<RemoteStatus>;
  remoteSet(enabled: boolean, port?: number): Promise<RemoteStatus>;
  remoteNewToken(): Promise<RemoteStatus>;
  stateGet(): Promise<Config>;
  groupUpsert(group: Group): Promise<Config>;
  groupDelete(id: string): Promise<Config>;
  termCreate(groupId: string, opts?: { cwd?: string; title?: string; account?: string }): Promise<Terminal>;
  termSetAccount(id: string, account: string | null): Promise<Config>;
  accountsList(): Promise<AccountsState>;
  accountSwitch(id: string): Promise<AccountsState>;
  accountAlias(id: string, alias: string | null): Promise<AccountsState>;
  accountUsage(id: string, force?: boolean): Promise<Usage>;
  codexAccount(force?: boolean): Promise<CodexAccount>;
  prsGet(config: PrConfig, force?: boolean): Promise<PrState>;
  /** Conta logada no `gh` (null: sem gh ou sem login). */
  prsWhoami(): Promise<string | null>;
  accountLoginBegin(): Promise<{ flowId: string; url: string }>;
  accountLoginFinish(flowId: string, code: string): Promise<Account>;
  accountRemove(id: string): Promise<AccountsState>;
  termAttach(id: string, cols: number, rows: number, onData: (d: Uint8Array) => void): Promise<void>;
  termInput(id: string, data: string): void;
  termResize(id: string, cols: number, rows: number): void;
  termDetach(id: string): Promise<void>;
  /** Este aparelho assume o terminal: a janela tmux fica exatamente cols × rows. */
  termClaim(id: string, cols: number, rows: number): void;
  termKill(id: string): Promise<Config>;
  termUpdate(id: string, patch: { title?: string; groupId?: string }): Promise<Config>;
  layoutSave(layout: unknown): void;
  settingsSave(settings: unknown): void;
  /** `push`: também manda para os celulares inscritos (Web Push). */
  notify(title: string, body: string, termId: string | undefined, sound: boolean, push?: boolean, desktop?: boolean): void;
  /** Web Push (docs/NOTIFY_SPEC.md). */
  pushKey(): Promise<string>;
  pushSubscribe(endpoint: string, p256dh: string, auth: string, label: string): Promise<void>;
  pushUnsubscribe(endpoint: string): Promise<void>;
  pushTest(endpoint: string): Promise<void>;
  pushDevices(): Promise<PushDevice[]>;
  onFocusTerm(cb: (id: string) => void): void;
  termsStatus(): Promise<Record<string, TermStatus>>;
  onTermExit(cb: (e: { id: string; gone: boolean }) => void): void;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  openUrl(url: string): void;
}

const toBytes = (d: unknown): Uint8Array =>
  d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d as number[]);

export const tauriTransport: Transport = {
  native: true,
  stateVersion: () => invoke("state_version"),
  chatOpen: (id) => invoke("chat_open", { id }),
  chatClose: (id) => invoke("chat_close", { id }),
  chatSend: (id, text) => invoke("chat_send", { id, text }),
  chatRespond: (id, requestId, result) => invoke("chat_respond", { id, requestId, result }),
  chatInterrupt: (id) => invoke("chat_interrupt", { id }),
  chatSetMode: (id, mode) => invoke("chat_set_mode", { id, mode }),
  chatHistory: (id) => invoke("chat_history", { id }),
  chatStates: () => invoke("chat_states"),
  onChatEvent: (cb) => void listen<ChatEvent>("chat-event", (e) => cb(e.payload)),
  remoteStatus: () => invoke("remote_status"),
  remoteSet: (enabled, port) => invoke("remote_set", { enabled, port }),
  remoteNewToken: () => invoke("remote_new_token"),
  stateGet: () => invoke("state_get"),
  groupUpsert: (group) => invoke("group_upsert", { group }),
  groupDelete: (id) => invoke("group_delete", { id }),
  termCreate: (groupId, opts = {}) =>
    invoke("term_create", { groupId, cwd: opts.cwd, title: opts.title, account: opts.account }),
  termSetAccount: (id, account) => invoke("term_set_account", { id, account }),
  accountsList: () => invoke("accounts_list"),
  accountSwitch: (id) => invoke("account_switch", { id }),
  accountAlias: (id, alias) => invoke("account_alias", { id, alias }),
  accountUsage: (id, force = false) => invoke("account_usage", { id, force }),
  codexAccount: (force = false) => invoke("codex_account", { force }),
  prsGet: (config, force = false) => invoke("prs_get", { config, force }),
  prsWhoami: () => invoke("prs_whoami"),
  accountLoginBegin: () => invoke("account_login_begin"),
  accountLoginFinish: (flowId, code) => invoke("account_login_finish", { flowId, code }),
  accountRemove: (id) => invoke("account_remove", { id }),
  termAttach: (id, cols, rows, onData) => {
    const ch = new Channel<unknown>();
    ch.onmessage = (d) => onData(toBytes(d));
    return invoke("term_attach", { id, cols, rows, onData: ch });
  },
  termInput: (id, data) => void invoke("term_input", { id, data }),
  termResize: (id, cols, rows) => void invoke("term_resize", { id, cols, rows }),
  termDetach: (id) => invoke("term_detach", { id }),
  termClaim: (id, cols, rows) => void invoke("term_claim", { id, cols, rows }),
  termKill: (id) => invoke("term_kill", { id }),
  termUpdate: (id, patch) => invoke("term_update", { id, title: patch.title, groupId: patch.groupId }),
  layoutSave: (layout) => void invoke("layout_save", { layout }),
  settingsSave: (settings) => void invoke("settings_save", { settings }),
  notify: (title, body, termId, sound, push, desktop = true) => void invoke("notify", { title, body, termId, sound, push: !!push, desktop }),
  pushKey: () => invoke("push_key"),
  pushSubscribe: (endpoint, p256dh, auth, label) => invoke("push_subscribe", { endpoint, p256dh, auth, label }),
  pushUnsubscribe: (endpoint) => invoke("push_unsubscribe", { endpoint }),
  pushTest: (endpoint) => invoke("push_test", { endpoint }),
  pushDevices: () => invoke("push_devices"),
  onFocusTerm: (cb) => void listen<string>("focus-term", (e) => cb(e.payload)),
  termsStatus: () => invoke("terms_status"),
  onTermExit: (cb) => void listen<{ id: string; gone: boolean }>("term-exit", (e) => cb(e.payload)),
  clipboardRead: () => readText(),
  clipboardWrite: (t) => writeText(t),
  openUrl: (u) => void openUrl(u),
};

// ---------- Navegador (celular): WebSocket com o core ----------

const LAYOUT_KEY = "coliseu-layout";
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* sem armazenamento: o layout só não é lembrado */
  }
};

function createWsTransport(): Transport {
  // Token do 1º acesso (link/QR) já virou cookie: tira da barra de endereço.
  if (new URLSearchParams(location.search).has("t")) history.replaceState(null, "", location.pathname);
  let ws: WebSocket;
  let seq = 0;
  let ready: Promise<void>;
  const pending = new Map<number, { res: (v: never) => void; rej: (e: unknown) => void }>();
  const sinks = new Map<string, (d: Uint8Array) => void>();
  const exitListeners: ((e: { id: string; gone: boolean }) => void)[] = [];
  const chatListeners: ((e: ChatEvent) => void)[] = [];
  const decoder = new TextDecoder();

  const connect = () => {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    ready = new Promise((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("sem conexão com o Coliseu"));
    });
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        // [tamanho do id][id][saída do terminal]
        const buf = new Uint8Array(ev.data);
        const n = buf[0];
        const id = decoder.decode(buf.subarray(1, 1 + n));
        sinks.get(id)?.(buf.subarray(1 + n));
        return;
      }
      const msg = JSON.parse(ev.data);
      if (msg.event === "term-exit") exitListeners.forEach((cb) => cb(msg.payload));
      else if (msg.event === "chat-event") chatListeners.forEach((cb) => cb(msg.payload));
      else if (typeof msg.id === "number") {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (p) "err" in msg ? p.rej(msg.err) : p.res(msg.ok as never);
      }
    };
    ws.onclose = () => {
      document.body.classList.add("disconnected");
      for (const p of pending.values()) p.rej("conexão perdida");
      pending.clear();
      reconnectOverlay();
    };
  };

  // Cópia da tela "sem conexão", baixada enquanto há conexão (a queda pode ser longa).
  let offlineHtml = "";
  setTimeout(() => {
    fetch("/offline.html")
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => (offlineHtml = t))
      .catch(() => {});
  }, 3000);

  /** Conexão caiu (celular bloqueou a tela, Wi-Fi trocou…): recarrega ao voltar. */
  const reconnectOverlay = () => {
    if (document.querySelector(".reconnect")) return;
    const d = document.createElement("div");
    d.className = "reconnect";
    d.textContent = "Reconectando ao Coliseu…";
    document.body.appendChild(d);
    // Queda rápida: só a pílula. Passou de 6 s: a tela "sem conexão" completa (a
    // mesma de quando o app abre com o PC fora do ar; ela recarrega o app sozinha).
    setTimeout(() => {
      if (document.querySelector(".offline-screen") || !document.body.classList.contains("disconnected")) return;
      const f = document.createElement("iframe");
      f.className = "offline-screen";
      if (offlineHtml) f.srcdoc = offlineHtml;
      else f.src = "/offline.html"; // sem cópia: o service worker entrega a guardada
      f.title = "Sem conexão com o PC";
      document.body.appendChild(f);
    }, 6000);
    const tryAgain = async () => {
      try {
        const r = await fetch("/", { cache: "no-store" });
        if (r.ok) return location.reload();
      } catch {
        /* ainda fora */
      }
      setTimeout(tryAgain, 2000);
    };
    setTimeout(tryAgain, 1000);
  };

  const call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
    await ready;
    return new Promise<T>((res, rej) => {
      const id = ++seq;
      pending.set(id, { res: res as (v: never) => void, rej });
      ws.send(JSON.stringify({ id, cmd, args }));
    });
  };
  const fire = (cmd: string, args: Record<string, unknown>) => void call(cmd, args).catch(() => {});

  connect();

  return {
    native: false,
    stateVersion: () => call("state_version"),
    chatOpen: (id) => call("chat_open", { id }),
    chatClose: (id) => call("chat_close", { id }),
    chatSend: (id, text) => call("chat_send", { id, text }),
    chatRespond: (id, requestId, result) => call("chat_respond", { id, requestId, result }),
    chatInterrupt: (id) => call("chat_interrupt", { id }),
    chatSetMode: (id, mode) => call("chat_set_mode", { id, mode }),
    chatHistory: (id) => call("chat_history", { id }),
    chatStates: () => call("chat_states"),
    onChatEvent: (cb) => void chatListeners.push(cb),
    remoteStatus: () => Promise.reject("disponível só no desktop"),
    remoteSet: () => Promise.reject("disponível só no desktop"),
    remoteNewToken: () => Promise.reject("disponível só no desktop"),
    stateGet: async () => {
      const cfg = await call<Config>("state_get");
      // Layout de abas é por aparelho.
      const local = lsGet(LAYOUT_KEY);
      return { ...cfg, layout: local ? JSON.parse(local) : null };
    },
    groupUpsert: (group) => call("group_upsert", { group }),
    groupDelete: (id) => call("group_delete", { id }),
    termCreate: (groupId, opts = {}) => call("term_create", { groupId, cwd: opts.cwd, title: opts.title, account: opts.account }),
    termSetAccount: (id, account) => call("term_set_account", { id, account }),
    accountsList: () => call("accounts_list"),
    accountSwitch: (id) => call("account_switch", { id }),
    accountAlias: (id, alias) => call("account_alias", { id, alias }),
    accountUsage: (id, force = false) => call("account_usage", { id, force }),
    codexAccount: (force = false) => call("codex_account", { force }),
    prsGet: (config, force = false) => call("prs_get", { config, force }),
    prsWhoami: () => call("prs_whoami"),
    accountLoginBegin: () => call("account_login_begin"),
    accountLoginFinish: (flowId, code) => call("account_login_finish", { flowId, code }),
    accountRemove: (id) => call("account_remove", { id }),
    termAttach: (id, cols, rows, onData) => {
      sinks.set(id, onData);
      return call("term_attach", { id, cols, rows });
    },
    termInput: (id, data) => fire("term_input", { id, data }),
    termResize: (id, cols, rows) => fire("term_resize", { id, cols, rows }),
    termDetach: async (id) => {
      sinks.delete(id);
      await call("term_detach", { id }).catch(() => {});
    },
    termKill: (id) => call("term_kill", { id }),
    termClaim: (id, cols, rows) => fire("term_claim", { id, cols, rows }),
    termUpdate: (id, patch) => call("term_update", { id, title: patch.title, groupId: patch.groupId }),
    layoutSave: (layout) => lsSet(LAYOUT_KEY, JSON.stringify(layout)),
    settingsSave: (settings) => fire("settings_save", { settings }),
    notify: () => {},
    pushKey: () => call("push_key"),
    pushSubscribe: (endpoint, p256dh, auth, label) => call("push_subscribe", { endpoint, p256dh, auth, label }),
    pushUnsubscribe: (endpoint) => call("push_unsubscribe", { endpoint }),
    pushTest: (endpoint) => call("push_test", { endpoint }),
    pushDevices: () => call("push_devices"),
    onFocusTerm: () => {},
    termsStatus: () => call("terms_status"),
    onTermExit: (cb) => void exitListeners.push(cb),
    clipboardRead: async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        // Sem HTTPS o navegador bloqueia a leitura: o usuário cola num prompt.
        return window.prompt("Cole aqui (toque longo → Colar):") ?? "";
      }
    },
    clipboardWrite: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
    },
    openUrl: (u) => void window.open(u, "_blank", "noopener"),
  };
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const api: Transport = isTauri ? tauriTransport : createWsTransport();
