// Preferências do usuário + tela de Configurações.
import { api, type Group } from "./transport";
import { icon } from "./icons";
import { THEMES, TERM_FONTS, type ThemeId } from "./themes";
import qrcode from "qrcode-generator";
import type { RemoteStatus } from "./transport";
import { esc } from "./labels";

export interface NotifySettings {
  waiting: boolean;
  done: boolean;
  subagent: boolean;
  longCmd: boolean;
  longCmdSecs: number;
  exited: boolean;
  onlyUnfocused: boolean;
  sound: boolean;
  /** Também envia para os celulares inscritos (Web Push). */
  push: boolean;
  mutedGroups: string[];
}

export interface UiSettings {
  /** Bloco de uso do Codex no rodapé da sidebar. */
  showCodex: boolean;
  theme: ThemeId;
  termFont: string;
  termFontSize: number;
}

export interface PrEvents {
  newPr: boolean;
  review: boolean;
  ciFail: boolean;
  ciPass: boolean;
  ciPending: boolean;
  comment: boolean;
  waitingMe: boolean;
  closed: boolean;
}

export interface PrSettings {
  enabled: boolean;
  orgs: string[];
  logins: string[];
  intervalMin: number;
  /** Interruptor geral das notificações de PR. */
  notify: boolean;
  /** Avisar mesmo com o Coliseu em foco. */
  notifyFocused: boolean;
  events: PrEvents;
}

export interface Settings {
  notify: NotifySettings;
  ui: UiSettings;
  prs: PrSettings;
}

export const DEFAULTS: Settings = {
  notify: {
    waiting: true,
    done: true,
    subagent: false,
    longCmd: false,
    longCmdSecs: 30,
    exited: false,
    onlyUnfocused: true,
    push: true,
    sound: true,
    mutedGroups: [],
  },
  ui: { showCodex: true, theme: "preto", termFont: "ubuntu", termFontSize: 15 },
  prs: {
    enabled: true,
    // Vazios: a conta logada no `gh`, em todas as organizações.
    orgs: [],
    logins: [],
    intervalMin: 5,
    notify: true,
    notifyFocused: false,
    events: {
      newPr: true,
      review: true,
      ciFail: true,
      ciPass: true,
      ciPending: false,
      comment: true,
      waitingMe: true,
      closed: true,
    },
  },
};

export let settings: Settings = structuredClone(DEFAULTS);

export function loadSettings(raw: unknown) {
  const r = (raw ?? {}) as Partial<Settings>;
  settings = {
    notify: { ...DEFAULTS.notify, ...(r.notify ?? {}) },
    ui: { ...DEFAULTS.ui, ...(r.ui ?? {}) },
    prs: { ...DEFAULTS.prs, ...(r.prs ?? {}), events: { ...DEFAULTS.prs.events, ...(r.prs?.events ?? {}) } },
  };
}

function save() {
  api.settingsSave(settings);
}

type BoolKey = { [K in keyof NotifySettings]: NotifySettings[K] extends boolean ? K : never }[keyof NotifySettings];

const EVENTS: [BoolKey, string, string][] = [
  ["waiting", "Aguardando você", "O Claude ou o Codex pediu permissão ou fez uma pergunta."],
  ["done", "Agente concluiu", "O Claude ou o Codex terminou de processar."],
  ["subagent", "Subagent concluído", "Um subagent terminou o trabalho."],
  ["longCmd", "Comando longo terminou", "Build, testes, deploy… que rodaram por muito tempo."],
  ["exited", "Terminal encerrado", "O shell de um terminal fechou."],
];

const PR_EVENTS: [keyof PrEvents, string, string][] = [
  ["newPr", "PR nova", "Uma PR sua foi aberta."],
  ["review", "Review mudou", "Aprovada ou mudanças pedidas."],
  ["ciFail", "CI falhou", "Algum check falhou."],
  ["ciPass", "CI passou", "Todos os checks passaram."],
  ["ciPending", "CI começou a rodar", "Checks em execução (avisa bastante)."],
  ["comment", "Comentário ou review novo", "De outra pessoa (os seus e os de bots não contam)."],
  ["waitingMe", "Passou a aguardar você", "A vez de agir na PR é sua."],
  ["closed", "Mesclada ou fechada", "A PR saiu da lista."],
];

const toggle = (key: string, label: string, desc: string, on: boolean) => `
  <label class="row toggle">
    <span class="tl"><b>${esc(label)}</b><small>${esc(desc)}</small></span>
    <input type="checkbox" data-key="${key}" ${on ? "checked" : ""} />
    <span class="sw"></span>
  </label>`;

type Tab = "look" | "notify" | "sidebar" | "prs" | "remote";
let lastTab: Tab = "look";

export function openSettings(groups: Group[], onClose: () => void, onChange: () => void = () => {}) {
  const root = document.querySelector<HTMLElement>("#modal-root")!;
  const n = settings.notify;
  const ui = settings.ui;

  const pages = (): Record<Tab, string> => ({
    look: `
      <h3>Aparência</h3>
      <div class="field">
        <div class="label">Tema</div>
        <div class="themes">
          ${THEMES.map(
            (t) => `<button class="theme-card ${ui.theme === t.id ? "on" : ""}" data-theme-pick="${t.id}">
              <span class="swatch sw-${t.id}"><i></i><i></i><i></i></span>
              <b>${esc(t.label)}</b><small>${esc(t.desc)}</small></button>`,
          ).join("")}
        </div>
      </div>
      <div class="field two">
        <label><span class="label">Fonte do terminal</span>
          <select data-key="ui:termFont">${TERM_FONTS.map(
            (f) => `<option value="${f.id}" ${ui.termFont === f.id ? "selected" : ""}>${esc(f.label)}</option>`,
          ).join("")}</select></label>
        <label><span class="label">Tamanho</span>
          <input type="number" min="9" max="28" step="1" data-key="ui:termFontSize" value="${ui.termFontSize}" /></label>
      </div>`,
    notify: `
      <h3>Notificações</h3>
      <div class="group-box">
        ${EVENTS.map(([k, l, d]) => toggle(k, l, d, n[k])).join("")}
        <label class="row inline ${n.longCmd ? "" : "off"}" id="long-secs">
          <span class="tl"><small>Considerar “longo” a partir de</small></span>
          <input type="number" min="5" max="3600" step="5" data-key="longCmdSecs" value="${n.longCmdSecs}" /><small>s</small>
        </label>
      </div>
      <div class="group-box">
        ${toggle("onlyUnfocused", "Só com o Coliseu em segundo plano", "Com a janela em foco, nenhuma notificação aparece.", n.onlyUnfocused)}
        ${toggle("sound", "Som", "Toca o som de mensagem do sistema.", n.sound)}
      </div>
      <div class="field">
        <div class="label">Grupos notificados</div>
        <div class="groups-mute">
          ${groups
            .map(
              (g) => `<label class="chip" style="--c:${g.color}">
                <input type="checkbox" data-group="${esc(g.id)}" ${n.mutedGroups.includes(g.id) ? "" : "checked"} />
                <span>${esc(g.name)}</span></label>`,
            )
            .join("")}
        </div>
      </div>
      <div class="group-box">
        ${toggle("push", "Enviar também para o celular", "Os mesmos avisos chegam no celular, mesmo com o app fechado. Ative no próprio celular: home do app → Receber notificações.", n.push)}
        <div id="push-devices" class="push-devices"><small>Carregando aparelhos…</small></div>
      </div>
      <button class="btn" data-act="test">${icon("bell", 14)} Testar notificação</button>`,
    sidebar: `
      <h3>Sidebar</h3>
      <div class="group-box">
        ${toggle("ui:showCodex", "Mostrar o Codex no rodapé", "Plano e uso (5h / semanal) do Codex abaixo da conta do Claude.", ui.showCodex)}
      </div>
      <p class="hint">Dica: arraste a borda direita da sidebar para mudar a largura; duplo clique volta ao padrão.</p>`,
    prs: `
      <h3>Pull requests</h3>
      <div class="group-box">
        ${toggle("prs:enabled", "Acompanhar minhas PRs", "Mostra a tela de PRs (Ctrl+Shift+P) e o contador na sidebar.", settings.prs.enabled)}
      </div>
      <div class="field">
        <div class="label">Notificações</div>
        <div class="group-box">
          ${toggle("prs:notify", "Notificar mudanças nas PRs", "Interruptor geral — os itens abaixo escolhem o quê.", settings.prs.notify)}
        </div>
        <div class="group-box ${settings.prs.notify ? "" : "off"}" id="pr-events">
          ${PR_EVENTS.map(([k, l, d]) => toggle(`prev:${k}`, l, d, settings.prs.events[k])).join("")}
        </div>
        <div class="group-box ${settings.prs.notify ? "" : "off"}" id="pr-events-2">
          ${toggle("prs:notifyFocused", "Avisar mesmo com o Coliseu em foco", "Por padrão segue a regra geral (só em segundo plano).", settings.prs.notifyFocused)}
        </div>
      </div>
      <div class="field"><div class="label">Conta do GitHub</div><p class="hint" id="gh-who">Verificando o <code>gh</code>…</p></div>
      <label><span class="label">Organizações (opcional, separadas por vírgula)</span>
        <input data-key="prs:orgs" value="${esc(settings.prs.orgs.join(", "))}" placeholder="vazio = todas" /></label>
      <label><span class="label">Logins (opcional, separados por vírgula)</span>
        <input data-key="prs:logins" value="${esc(settings.prs.logins.join(", "))}" placeholder="vazio = a conta logada no gh" /></label>
      <label style="width: 220px"><span class="label">Atualizar a cada (minutos)</span>
        <input type="number" min="1" max="120" data-key="prs:intervalMin" value="${settings.prs.intervalMin}" /></label>
      <p class="hint">Usa o <code>gh</code> CLI com a conta logada nele. Busca as suas PRs abertas; com organizações, só nelas. Mais de uma conta do GitHub? Informe os logins.</p>`,
    remote: `
      <h3>Acesso remoto</h3>
      <p class="hint" style="margin:0">Abra o Coliseu no navegador do celular pela sua rede Tailscale: mesma sidebar, mesmos terminais.</p>
      <div id="remote-box"><div class="hint">carregando…</div></div>`,
  });

  const NAV: [Tab, string, Parameters<typeof icon>[0]][] = [
    ["look", "Aparência", "palette"],
    ["notify", "Notificações", "bell"],
    ["sidebar", "Sidebar", "panel"],
    ["prs", "Pull requests", "pr"],
    ...(api.native ? ([["remote", "Acesso remoto", "phone"]] as [Tab, string, Parameters<typeof icon>[0]][]) : []),
  ];

  root.innerHTML = `<div class="backdrop"><div class="modal settings" tabindex="-1">
    <nav class="snav">
      <div class="snav-title">Configurações</div>
      ${NAV.map(([id, label, ic]) => `<button data-tab="${id}" class="${lastTab === id ? "on" : ""}">${icon(ic, 15)}<span>${label}</span></button>`).join("")}
    </nav>
    <div class="spage">
      <button class="icon-btn close" data-act="close" title="Fechar (Esc)">${icon("x", 16)}</button>
      <div class="spage-body">${pages()[lastTab]}</div>
    </div>
  </div></div>`;

  const m = root.querySelector<HTMLElement>(".modal")!;
  const body = m.querySelector<HTMLElement>(".spage-body")!;
  const close = () => {
    root.innerHTML = "";
    onClose();
  };

  // Salva e aplica a cada mudança.
  m.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    const key = el.dataset.key;
    if (el.dataset.group) {
      const id = el.dataset.group;
      n.mutedGroups = el.checked ? n.mutedGroups.filter((g) => g !== id) : [...new Set([...n.mutedGroups, id])];
    } else if (key === "longCmdSecs") {
      n.longCmdSecs = Math.max(5, Number(el.value) || DEFAULTS.notify.longCmdSecs);
    } else if (key === "ui:termFontSize") {
      ui.termFontSize = Math.min(28, Math.max(9, Number(el.value) || DEFAULTS.ui.termFontSize));
    } else if (key === "ui:termFont") {
      ui.termFont = el.value;
    } else if (key === "prs:orgs" || key === "prs:logins") {
      const list = el.value.split(",").map((x) => x.trim()).filter(Boolean);
      if (key === "prs:orgs") settings.prs.orgs = list;
      else settings.prs.logins = list;
    } else if (key === "prs:intervalMin") {
      settings.prs.intervalMin = Math.min(120, Math.max(1, Number(el.value) || DEFAULTS.prs.intervalMin));
    } else if (key === "prs:enabled" || key === "prs:notify" || key === "prs:notifyFocused") {
      settings.prs[key.slice(4) as "enabled" | "notify" | "notifyFocused"] = el.checked;
      m.querySelectorAll("#pr-events, #pr-events-2").forEach((b) => b.classList.toggle("off", !settings.prs.notify));
    } else if (key?.startsWith("prev:")) {
      settings.prs.events[key.slice(5) as keyof PrEvents] = el.checked;
    } else if (key?.startsWith("ui:")) {
      (ui as unknown as Record<string, boolean>)[key.slice(3)] = el.checked;
    } else if (key) {
      (n as unknown as Record<string, boolean>)[key] = el.checked;
    }
    m.querySelector("#long-secs")?.classList.toggle("off", !n.longCmd);
    save();
    onChange();
  });
  m.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
    if (tab) {
      lastTab = tab;
      body.innerHTML = pages()[tab];
      if (tab === "remote") void loadRemote(m);
      if (tab === "notify") void loadPushDevices(m);
      if (tab === "prs") void loadGhUser(m);
      m.querySelectorAll(".snav [data-tab]").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.tab === tab));
      return;
    }
    const pick = t.closest<HTMLElement>("[data-theme-pick]")?.dataset.themePick as ThemeId | undefined;
    if (pick) {
      ui.theme = pick;
      m.querySelectorAll(".theme-card").forEach((c) => c.classList.toggle("on", (c as HTMLElement).dataset.themePick === pick));
      save();
      onChange();
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") close();
    // Teste: desktop e, se ligado, também os celulares (mesmo com a janela em foco).
    if (act === "test") api.notify("Coliseu", "Notificações funcionando ✔", undefined, n.sound, n.push);
    const dev = t.closest<HTMLElement>("[data-push]");
    if (dev) void pushDeviceAction(m, dev.dataset.push!, dev.dataset.endpoint!);
  });
  m.onkeydown = (e) => {
    if (e.key === "Escape") close();
  };
  root.querySelector<HTMLElement>(".backdrop")!.addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) close();
  });
  if (lastTab === "remote") void loadRemote(m);
  if (lastTab === "notify") void loadPushDevices(m);
  if (lastTab === "prs") void loadGhUser(m);
  m.focus();
}

// ---------- Celulares inscritos (Web Push) ----------

async function loadPushDevices(m: HTMLElement) {
  const box = m.querySelector<HTMLElement>("#push-devices");
  if (!box) return;
  try {
    const list = await api.pushDevices();
    box.innerHTML = list.length
      ? list
          .map(
            (d) => `<div class="push-dev"><span>${icon("phone", 14)} ${esc(d.label)} <small>desde ${new Date(d.createdAt).toLocaleDateString("pt-BR")}</small></span>
              <span><button class="btn sm" data-push="test" data-endpoint="${esc(d.endpoint)}">Testar</button>
              <button class="btn sm danger" data-push="remove" data-endpoint="${esc(d.endpoint)}">Remover</button></span></div>`,
          )
          .join("")
      : `<small>Nenhum celular inscrito ainda.</small>`;
  } catch (e) {
    box.innerHTML = `<small>Não deu para listar os aparelhos: ${esc(String(e))}</small>`;
  }
}

async function pushDeviceAction(m: HTMLElement, act: string, endpoint: string) {
  try {
    if (act === "test") await api.pushTest(endpoint);
    if (act === "remove") await api.pushUnsubscribe(endpoint);
  } catch (e) {
    alert(String(e));
  }
  void loadPushDevices(m);
}

/** "Conectado como @login" (conta do `gh`) nas configurações de PRs. */
async function loadGhUser(m: HTMLElement) {
  const who = await api.prsWhoami().catch(() => null);
  const el = m.querySelector("#gh-who");
  if (!el) return;
  el.innerHTML = who
    ? `Conectado como <b>@${esc(who)}</b> (a conta logada no <code>gh</code>).`
    : `O <code>gh</code> não está instalado ou não tem login. Rode <code>gh auth login</code> no terminal, ou informe seus logins abaixo.`;
}

// ---------- Acesso remoto ----------

function qrSvg(text: string) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true });
}

function remoteHtml(st: RemoteStatus) {
  const phoneUrl = st.urls.find((u) => !u.includes("127.0.0.1"));
  const statusLine = st.running
    ? `<span class="rs on">${icon("check", 13)} Ligado</span>`
    : st.enabled
      ? `<span class="rs warn">Ligado, mas não está escutando</span>`
      : `<span class="rs">Desligado</span>`;
  return `
    <div class="group-box">
      <label class="row toggle">
        <span class="tl"><b>Permitir acesso pelo celular</b><small>Servidor só no IP do Tailscale (${esc(st.tailscaleIp ?? "não encontrado")}) e em 127.0.0.1.</small></span>
        <input type="checkbox" data-remote="toggle" ${st.enabled ? "checked" : ""} />
        <span class="sw"></span>
      </label>
      <div class="row inline">
        <span class="tl"><small>Porta</small></span>
        <input type="number" min="1024" max="65535" data-remote="port" value="${st.port}" />
        ${statusLine}
      </div>
    </div>
    ${st.error ? `<div class="pr-errors" style="margin:0">${esc(st.error)}</div>` : ""}
    ${
      st.enabled && phoneUrl
        ? `<div class="remote-share">
            <div class="qr">${qrSvg(phoneUrl)}</div>
            <div class="remote-info">
              <b>No celular</b>
              <ol>
                <li>Abra o app do <b>Tailscale</b> e conecte.</li>
                <li>Escaneie o QR code com a câmera (ou abra o link abaixo).</li>
                <li>No navegador: menu → <b>Adicionar à tela inicial</b>, para abrir como app.</li>
              </ol>
              <div class="url-row"><code>${esc(phoneUrl.replace(/t=.*/, "t=•••"))}</code>
                <button class="btn sm" data-remote="copy" data-url="${esc(phoneUrl)}">${icon("copy", 13)} Copiar link</button></div>
            </div>
          </div>
          <div class="group-box">
            <div class="row inline">
              <span class="tl"><b>Token de acesso</b><small>Gerar um novo invalida o link/QR atual e desconecta celulares já logados.</small></span>
              <button class="btn sm" data-remote="token">${icon("refresh", 13)} Gerar novo</button>
            </div>
          </div>`
        : ""
    }`;
}

async function loadRemote(m: HTMLElement) {
  const box = m.querySelector<HTMLElement>("#remote-box");
  if (!box) return;
  const show = (st: RemoteStatus) => (box.innerHTML = remoteHtml(st));
  try {
    show(await api.remoteStatus());
  } catch (e) {
    box.innerHTML = `<div class="pr-errors" style="margin:0">${esc(String(e))}</div>`;
    return;
  }
  if (box.dataset.bound) return;
  box.dataset.bound = "1";
  box.addEventListener("change", async (e) => {
    const el = e.target as HTMLInputElement;
    const enabled = box.querySelector<HTMLInputElement>("[data-remote=toggle]")!.checked;
    const port = Number(box.querySelector<HTMLInputElement>("[data-remote=port]")?.value) || undefined;
    if (el.dataset.remote === "toggle" || el.dataset.remote === "port") show(await api.remoteSet(enabled, port));
  });
  box.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-remote]");
    if (!b) return;
    if (b.dataset.remote === "token" && confirm("Gerar um novo token? O link/QR atual para de funcionar.")) show(await api.remoteNewToken());
    if (b.dataset.remote === "copy") {
      await api.clipboardWrite(b.dataset.url!);
      b.innerHTML = `${icon("check", 13)} Copiado`;
    }
  });
}
