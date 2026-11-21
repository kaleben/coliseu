// Primeiros passos: tela cheia, preta, em passos (docs/ONBOARDING_SPEC.md).
import "@fontsource/besley/600.css";
import "./onboarding.css";
import qrcode from "qrcode-generator";
import { api, type Account, type Group, type SetupCheck } from "./transport";
import { settings } from "./settings";
import { Pane } from "./pane";
import { esc } from "./labels";

/** Terminais temporários das linhas de comando: o layout principal não abre aba para eles. */
export const setupTerms = new Set<string>();

export interface OnboardingHost {
  groups(): Group[];
  /** Recarrega grupos/terminais do core e redesenha o app. */
  reload(): Promise<void>;
  /** "Abrir o primeiro terminal" no fim. */
  openTerminal(groupId: string): void;
  onClose(): void;
}

export function shouldOnboard(terminals: number) {
  return api.native && !settings.onboarding.done && terminals === 0;
}

const COLORS = ["#a855f7", "#f59e0b", "#22c55e", "#3b82f6", "#ef4444", "#ec4899", "#14b8a6", "#e5e5e5"];
const APT: Record<string, string> = { tmux: "tmux", node: "nodejs", gh: "gh", xdotool: "xdotool" };
const TOOLS: [string, string, string, string, boolean][] = [
  ["tmux", "🧱", "tmux", "Mantém as sessões vivas mesmo se o app fechar.", true],
  ["claude", "✳️", "Claude Code", "O agente que o Coliseu organiza.", true],
  ["node", "🟢", "Node.js", "Necessário para o modo chat.", true],
  ["gh", "🐙", "GitHub CLI", "Painel de pull requests.", false],
  ["xdotool", "🪟", "xdotool", "Clicar numa notificação traz o Coliseu para a frente.", false],
];

interface Step {
  id: string;
  render: (el: HTMLElement) => void | Promise<void>;
  next?: string;
  optional?: boolean;
}

let host: OnboardingHost;
let root: HTMLElement | null = null;
let at = 0;
let check: SetupCheck = { tools: [], tsRunning: false, tsHttps: false, tsOperator: false, voice: false };
let projects: string[] = [];
let created: Group[] = [];
let draft = { name: "", path: "~/", color: COLORS[0] };
let remoteOn = false;
let phoneUrl = "";
let accounts: Account[] = [];
let activeAcc: string | null = null;
let loginFlow: string | null = null;
/** Primeira verificação (o passo das ferramentas espera por ela). */
let ready: Promise<unknown> = Promise.resolve();

const has = (t: string) => check.tools.includes(t);
const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector<T>(s)!;
const h = (html: string) => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content;
};

async function refresh() {
  check = await api.setupCheck().catch(() => check);
}

// ---------- terminal embutido ----------

/** O terminal temporário aberto agora (um por vez). */
let live: { id: string; pane: Pane; timer: number } | null = null;

function closeLive() {
  if (!live) return;
  const { id, pane, timer } = live;
  live = null;
  clearInterval(timer);
  pane.dispose();
  void api.termKill(id).finally(() => setupTerms.delete(id));
}

/**
 * Linha de terminal com ▶ Rodar: abre um terminal de verdade dentro do cartão e
 * digita o comando. Reverifica a cada 2,5 s; quando `ok()` passa, o passo fica ✓.
 */
function termLine(cmd: string, ok: () => boolean) {
  const box = h(`<div class="ob-term"><div class="ob-term-cmd"><span class="p">$</span><code></code>
    <button class="ob-btn" type="button" data-copy>Copiar</button>
    <button class="ob-btn primary" type="button" data-run>▶ Rodar</button></div></div>`).firstElementChild as HTMLElement;
  $("code", box).textContent = cmd;
  const copy = $<HTMLButtonElement>("[data-copy]", box);
  copy.onclick = () => void api.clipboardWrite(cmd).then(() => (copy.textContent = "Copiado"));
  const run = $<HTMLButtonElement>("[data-run]", box);
  run.onclick = async () => {
    closeLive();
    const g = host.groups()[0];
    if (!g) return;
    run.disabled = true;
    run.textContent = "Rodando…";
    let t;
    try {
      t = await api.termCreate(g.id, { cwd: "~", title: "configuração" });
    } catch (e) {
      run.disabled = false;
      run.textContent = "▶ Rodar";
      box.append(h(`<div class="ob-term-err">${esc(String(e))}</div>`));
      return;
    }
    setupTerms.add(t.id);
    const pane = new Pane(t.id, () => false, () => {});
    const wrap = document.createElement("div");
    wrap.className = "ob-term-live";
    wrap.append(pane.el);
    box.append(wrap);
    pane.open();
    pane.focus();
    wrap.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => api.termInput(t.id, cmd + "\r"), 400);
    let busy = false;
    const timer = window.setInterval(async () => {
      if (busy) return;
      busy = true;
      await refresh();
      busy = false;
      if (ok() && live?.id === t.id) {
        clearInterval(timer);
        run.textContent = "✓ Feito";
        setTimeout(() => live?.id === t.id && paint(), 1500);
      }
    }, 2500);
    live = { id: t.id, pane, timer };
  };
  return box;
}

// ---------- pedaços ----------

function toggleRow(title: string, desc: string, val: boolean, set: (v: boolean) => void) {
  const r = h(`<div class="ob-tg" role="switch" tabindex="0" aria-checked="${val}"><div><b></b><small></small></div><span class="ob-sw"></span></div>`)
    .firstElementChild as HTMLElement;
  $("b", r).textContent = title;
  $("small", r).textContent = desc;
  const flip = () => {
    const v = r.getAttribute("aria-checked") !== "true";
    r.setAttribute("aria-checked", String(v));
    set(v);
  };
  r.onclick = flip;
  r.onkeydown = (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      flip();
    }
  };
  return r;
}

const toggles = (...rows: HTMLElement[]) => {
  const b = document.createElement("div");
  b.className = "ob-toggles";
  b.append(...rows);
  return b;
};

const saveSettings = () => api.settingsSave(settings);

const head = (emoji: string, title: string, lead: string, tag?: string) =>
  h(`${tag ? `<div class="ob-tag">${tag}</div>` : ""}<div class="ob-emoji">${emoji}</div><h1>${title}</h1><p class="ob-lead">${lead}</p>`);

// ---------- passos ----------

function welcome(el: HTMLElement) {
  el.append(head("👋", "Bem-vindo à arena.",
    "Em poucos passos o Coliseu fica pronto: conferimos o que falta neste PC, conectamos sua conta do Claude e criamos seu primeiro grupo. Leva uns três minutos."));
  el.append(h(`<p class="ob-lead small">Os passos opcionais (GitHub e celular) podem ficar para depois. Tudo aqui também está em Configurações.</p>`));
}

function tools(el: HTMLElement) {
  const missingReq = TOOLS.filter(([k, , , , req]) => req && !has(k));
  el.append(head("🧰", "Primeiro, as ferramentas.",
    missingReq.length
      ? "Conferimos o que o Coliseu usa neste PC. Falta algo essencial: rode o comando abaixo aqui mesmo."
      : "Conferimos o que o Coliseu usa neste PC. O essencial já está aqui; os opcionais liberam recursos extras."));
  el.append(h(`<div class="ob-checks">${TOOLS.map(([k, ic, name, why, req]) => `<div class="ob-check"><span class="ic">${ic}</span><div><b>${name}</b><small>${why}</small></div>
    <span class="ob-chip ${has(k) ? "ok" : "no"}">${has(k) ? "instalado" : req ? "falta" : "falta · opcional"}</span></div>`).join("")}</div>`));
  const apt = Object.keys(APT).filter((k) => !has(k));
  if (!has("claude")) el.append(termLine("curl -fsSL https://claude.ai/install.sh | bash", () => has("claude")));
  if (apt.length) {
    el.append(termLine(`sudo apt install -y ${apt.map((k) => APT[k]).join(" ")}`, () => apt.every(has)));
    el.append(h(`<p class="ob-hint">A senha do sudo é digitada aqui mesmo, como em qualquer terminal. Fora do Ubuntu/Debian, instale pelo gerenciador da sua distro.</p>`));
  }
}

async function account(el: HTMLElement) {
  const st = await api.accountsList().catch(() => ({ accounts: [] as Account[], active: null }));
  accounts = st.accounts;
  activeAcc = st.active ?? null;
  el.append(head("🔑", "Conecte sua conta do Claude.",
    accounts.length
      ? "Encontramos sua conta neste PC. Dá para adicionar mais contas depois e trocar com um clique."
      : "Entre com a conta da Anthropic que você usa no Claude Code. Dá para adicionar mais contas depois e trocar com um clique."));
  for (const a of accounts) {
    const on = a.id === activeAcc;
    const name = a.alias || a.label;
    const card = h(`<div class="ob-card ${on ? "on" : ""}"><div class="ob-acct"><span class="ob-avatar"></span><div><b><span></span>${a.plan ? `<span class="ob-plan">${esc(a.plan)}</span>` : ""}</b><small>${on ? "conta ativa" : "também neste PC"}</small></div>
      ${on ? `<span class="ob-chip ok">✓ ativa</span>` : `<button class="ob-btn" type="button">Usar esta</button>`}</div></div>`).firstElementChild as HTMLElement;
    $(".ob-avatar", card).textContent = name.slice(0, 1).toUpperCase();
    $("b span", card).textContent = name;
    card.querySelector("button")?.addEventListener("click", async () => {
      await api.accountSwitch(a.id).catch(() => {});
      paint();
    });
    el.append(card);
  }
  const login = document.createElement("div");
  el.append(login);
  const idle = () => {
    login.replaceChildren(h(`<div class="ob-row"><button class="ob-btn ${accounts.length ? "" : "primary"}" type="button">${accounts.length ? "Entrar com outra conta" : "Entrar na conta do Claude"}</button></div>`));
    $("button", login).onclick = start;
  };
  const start = async () => {
    const r = await api.accountLoginBegin();
    loginFlow = r.flowId;
    api.openUrl(r.url);
    login.replaceChildren(h(`<div class="ob-card"><div class="ob-subs">
        <div class="ob-sub"><span class="n">1</span><div class="body"><b>No navegador, entre e clique em Autorizar.</b><button class="ob-link" type="button" data-again>Abrir de novo</button></div></div>
        <div class="ob-sub"><span class="n">2</span><div class="body"><b>Cole aqui o código que a página mostrar:</b>
          <input class="ob-input" placeholder="Cole o código" autocomplete="off" spellcheck="false" />
          <div class="ob-err"></div>
          <div class="ob-row"><button class="ob-btn primary" type="button" data-finish>Concluir</button><button class="ob-link" type="button" data-cancel>Cancelar</button></div></div></div>
      </div></div>`));
    $("[data-again]", login).onclick = () => api.openUrl(r.url);
    $("[data-cancel]", login).onclick = idle;
    const input = $<HTMLInputElement>("input", login);
    const finish = async () => {
      const code = input.value.trim();
      if (!code || !loginFlow) return input.focus();
      const b = $<HTMLButtonElement>("[data-finish]", login);
      b.disabled = true;
      b.textContent = "Concluindo…";
      try {
        await api.accountLoginFinish(loginFlow, code);
        loginFlow = null;
        paint();
      } catch (e) {
        $(".ob-err", login).textContent = String(e);
        b.disabled = false;
        b.textContent = "Concluir";
      }
    };
    $("[data-finish]", login).onclick = finish;
    input.onkeydown = (e) => e.key === "Enter" && void finish();
    input.focus();
  };
  idle();
  el.append(h(`<p class="ob-hint">O login é o oficial da Anthropic. As credenciais ficam só neste PC.</p>`));
}

function group(el: HTMLElement) {
  el.append(head("🗂️", "Onde você trabalha?",
    "Um grupo junta os terminais de um projeto ou empresa. Escolha uma pasta: os terminais novos do grupo abrem nela."));
  if (created.length) {
    el.append(h(`<div class="ob-groups">${created.map((g) => `<div class="ob-group"><i style="background:${esc(g.color)}"></i><b>${esc(g.name)}</b><code>${esc(g.cwd)}</code></div>`).join("")}</div>`));
    el.append(h(`<p class="ob-hint">Quer outro? Preencha de novo abaixo. Depois, Alt+1, Alt+2… troca de grupo.</p>`));
  }
  const free = projects.filter((p) => !created.some((g) => g.cwd === p));
  const form = h(`<div class="ob-card">
      ${free.length ? `<div class="ob-field"><label>Projetos com git neste PC (toque para usar)</label><div class="ob-sugg">${free.map((f) => `<button type="button" class="${f === draft.path ? "on" : ""}" data-f="${esc(f)}">${esc(f.split("/").pop()!)}</button>`).join("")}</div></div>` : ""}
      <div class="ob-field"><label for="ob-path">Pasta</label><input class="ob-input mono" id="ob-path" autocomplete="off" spellcheck="false"></div>
      <div class="ob-field"><label for="ob-name">Nome do grupo</label><input class="ob-input" id="ob-name" autocomplete="off" placeholder="ex.: Empresa, Pessoal, Cliente X"></div>
      <div class="ob-field"><label>Cor</label><div class="ob-swatches">${COLORS.map((c) => `<button type="button" aria-label="Cor ${c}" data-c="${c}" style="background:${c}" class="${c === draft.color ? "on" : ""}"></button>`).join("")}</div></div>
      <div class="ob-err"></div>
      <div class="ob-row"><button class="ob-btn primary" type="button" data-add>Criar grupo</button></div>
    </div>`).firstElementChild as HTMLElement;
  const path = $<HTMLInputElement>("#ob-path", form);
  const name = $<HTMLInputElement>("#ob-name", form);
  path.value = draft.path;
  name.value = draft.name;
  path.oninput = () => (draft.path = path.value);
  name.oninput = () => (draft.name = name.value);
  form.querySelectorAll<HTMLElement>("[data-f]").forEach((b) => (b.onclick = () => {
    draft.path = b.dataset.f!;
    draft.name = draft.path.split("/").pop()!;
    paint();
  }));
  form.querySelectorAll<HTMLElement>("[data-c]").forEach((b) => (b.onclick = () => {
    draft.color = b.dataset.c!;
    form.querySelectorAll("[data-c]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("[data-add]", form).onclick = async () => {
    const n = draft.name.trim();
    if (!n) return name.focus();
    const g: Group = {
      id: n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + "-" + Math.random().toString(36).slice(2, 6),
      name: n,
      cwd: draft.path.trim() || "~/",
      color: draft.color,
      account: null,
    };
    try {
      await api.groupUpsert(g);
      // O grupo padrão "Projetos" só existia para o primeiro uso: sai se estiver vazio.
      if (!created.length && host.groups().some((x) => x.id === "projetos")) await api.groupDelete("projetos").catch(() => {});
      created.push(g);
      await host.reload();
      draft = { name: "", path: "~/", color: COLORS[(COLORS.indexOf(g.color) + 1) % COLORS.length] };
      paint();
    } catch (e) {
      $(".ob-err", form).textContent = String(e);
    }
  };
  el.append(form);
}

function github(el: HTMLElement) {
  el.append(head("🐙", "Acompanhe suas PRs.",
    "Conecte o GitHub e o Coliseu mostra suas pull requests abertas, com o que está esperando você em destaque.", "opcional"));
  if (!has("gh")) {
    el.append(termLine("sudo apt install -y gh", () => has("gh")));
    el.append(h(`<p class="ob-hint">Primeiro o GitHub CLI. Depois de instalar, o login aparece aqui.</p>`));
  } else if (!check.ghUser) {
    el.append(termLine("gh auth login --web --git-protocol https", () => !!check.ghUser));
    el.append(h(`<p class="ob-hint">Aperte Enter no terminal para abrir o navegador e cole o código. Nenhuma senha passa pelo Coliseu.</p>`));
  } else {
    const box = h(`<div class="ob-checks"><div class="ob-check"><span class="ic">✅</span><div><b></b><small>pela conta do GitHub CLI</small></div><span class="ob-chip ok">ok</span></div></div>`);
    $("b", box).textContent = `Conectado como @${check.ghUser}`;
    el.append(box);
    el.append(toggles(toggleRow("Mostrar pull requests", "Painel com Ctrl+Shift+P e contador na lateral.", settings.prs.enabled, (v) => {
      settings.prs.enabled = v;
      saveSettings();
    })));
  }
}

async function phone(el: HTMLElement) {
  const st = await api.remoteStatus().catch(() => null);
  remoteOn = !!st?.enabled;
  phoneUrl = st?.urls.find((u) => !u.includes("127.0.0.1")) ?? "";
  el.append(head("📱", "Leve a arena no bolso.",
    "Acompanhe e responda os agentes pelo celular, com notificações. Funciona pela sua rede privada do Tailscale: nada fica aberto na internet.", "opcional"));
  const subs = document.createElement("div");
  subs.className = "ob-subs";
  el.append(subs);
  const sub = (n: number, ok: boolean, title: string, body?: Node | null) => {
    const s = h(`<div class="ob-sub ${ok ? "ok" : ""}"><span class="n">${ok ? "✓" : n}</span><div class="body"><b></b></div></div>`).firstElementChild as HTMLElement;
    $("b", s).textContent = title;
    if (body) $(".body", s).append(body);
    subs.append(s);
  };
  const ts = has("tailscale") && check.tsRunning;
  sub(1, ts, "Instale o Tailscale neste PC e entre na sua conta",
    ts ? null : termLine(has("tailscale") ? "sudo tailscale up" : "curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up", () => has("tailscale") && check.tsRunning));

  const httpsBody = h(`<div class="ob-row"><button class="ob-btn" type="button" data-dns>Abrir o painel DNS ↗</button><button class="ob-btn" type="button" data-recheck>Já liguei</button></div>`)
    .firstElementChild as HTMLElement;
  $("[data-dns]", httpsBody).onclick = () => api.openUrl("https://login.tailscale.com/admin/dns");
  $("[data-recheck]", httpsBody).onclick = async (e) => {
    (e.target as HTMLButtonElement).textContent = "Verificando…";
    await refresh();
    paint();
  };
  sub(2, check.tsHttps, "No painel do Tailscale, ligue MagicDNS e HTTPS Certificates", check.tsHttps || !ts ? null : httpsBody);

  sub(3, check.tsOperator, "Deixe o Coliseu pedir o certificado HTTPS",
    check.tsOperator || !check.tsHttps ? null : termLine("sudo tailscale set --operator=$USER", () => check.tsOperator));

  let body: Node | null = null;
  if (remoteOn && phoneUrl) {
    const qr = qrcode(0, "M");
    qr.addData(phoneUrl);
    qr.make();
    body = h(`<div class="ob-qr"><div class="code">${qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div><p>Instale o Tailscale também no celular, na mesma conta. Depois de abrir, use "Adicionar à tela inicial" para virar app.</p></div>`);
  } else if (check.tsOperator) {
    body = h(`<div class="ob-row"><button class="ob-btn primary" type="button">Ligar o acesso pelo celular</button></div>`);
    ($("button", body as DocumentFragment) as HTMLElement).onclick = async () => {
      await api.remoteSet(true).catch(() => {});
      paint();
    };
  }
  sub(4, remoteOn && !!phoneUrl, remoteOn && phoneUrl ? "Acesso ligado. Aponte a câmera do celular para o QR:" : "Ligue o acesso e escaneie o QR no celular", body);
}

function notify(el: HTMLElement) {
  const n = settings.notify;
  const set = (k: "waiting" | "done" | "sound" | "onlyUnfocused") => (v: boolean) => {
    n[k] = v;
    saveSettings();
  };
  el.append(head("🔔", "Avisos que importam.", "O Coliseu avisa quando um agente precisa de você e quando o trabalho termina. Escolha como."));
  el.append(toggles(
    toggleRow("Aguardando você", "Na hora, quando um agente pede permissão ou faz uma pergunta.", n.waiting, set("waiting")),
    toggleRow("Concluiu", "Quando a sessão principal termina (não a cada subagente).", n.done, set("done")),
    toggleRow("Som", "Um toque curto junto com o aviso.", n.sound, set("sound")),
    toggleRow("Só com o Coliseu em segundo plano", "Se você está olhando o app, ele não interrompe.", n.onlyUnfocused, set("onlyUnfocused")),
  ));
  const t = h(`<div class="ob-row"><button class="ob-btn" type="button">Testar um aviso</button></div>`);
  ($("button", t) as HTMLElement).onclick = () => api.notify("Aguardando você — teste", "É assim que os avisos do Coliseu chegam.", undefined, n.sound);
  el.append(t);
  const voice = h(`<div class="ob-card">
      <div class="ob-acct"><span class="ob-big">🎙️</span><div><b>Fale em vez de digitar</b><small>Opcional · no PC</small></div></div>
      <div class="ob-summary">
        <div><span>1.</span><span>No terminal do Claude, toque no 🎤 ou aperte <b>Alt+K</b> e fale.</span></div>
        <div><span>2.</span><span>Toque de novo para parar. O texto é enviado ao Claude.</span></div>
      </div>
      <p class="ob-hint flat">Usa o microfone do PC e o modo de voz do próprio Claude Code. No celular não precisa ligar nada: o 🎤 do chat já funciona.</p>
    </div>`).firstElementChild as HTMLElement;
  voice.append(toggles(toggleRow("Ligar o ditado no PC", "Ativa o modo de voz no seu Claude Code.", check.voice, (v) => {
    check.voice = v;
    void api.voiceSet(v);
  })));
  el.append(voice);
}

async function done(el: HTMLElement) {
  const accs = await api.accountsList().catch(() => ({ accounts: [] as Account[] }));
  const st = await api.remoteStatus().catch(() => null);
  const ok = (b: boolean, t: string, later: string) => `<div class="${b ? "" : "later"}"><span>${b ? "✅" : "⏭️"}</span><span>${esc(b ? t : later)}</span></div>`;
  const n = created.length;
  el.append(head("🏛️", "A arena é sua.", "Tudo pronto. Abra o primeiro terminal e chame o Claude; o Coliseu avisa quem precisa de você."));
  el.append(h(`<div class="ob-summary">
      ${ok(["tmux", "claude"].every(has), "Ferramentas conferidas", "Ferramentas: falta instalar algo (passo 1)")}
      ${ok(accs.accounts.length > 0, "Conta do Claude conectada", "Conta do Claude: depois, no rodapé da lateral")}
      ${ok(n > 0, `${n} grupo${n > 1 ? "s" : ""} criado${n > 1 ? "s" : ""}`, 'Grupo: fica o padrão "Projetos" na sua pasta pessoal')}
      ${ok(!!check.ghUser, "GitHub conectado", "GitHub: depois, em Configurações → Pull requests")}
      ${ok(!!st?.enabled, "Celular ligado", "Celular: depois, em Configurações → Acesso remoto")}
    </div>
    <div class="ob-keys">
      <div class="ob-key"><kbd>Ctrl+Shift+T</kbd><small>Novo terminal</small></div>
      <div class="ob-key"><kbd>Alt+1 … 9</kbd><small>Trocar de grupo</small></div>
      <div class="ob-key"><kbd>Ctrl+Shift+D</kbd><small>Dividir a tela</small></div>
    </div>`));
}

const steps: Step[] = [
  { id: "inicio", render: welcome, next: "Começar" },
  { id: "ferramentas", render: tools },
  { id: "conta", render: account },
  { id: "grupo", render: group },
  { id: "github", render: github, optional: true },
  { id: "celular", render: phone, optional: true },
  { id: "avisos", render: notify },
  { id: "pronto", render: done, next: "Abrir o primeiro terminal" },
];

let painting = 0;
async function paint() {
  if (!root) return;
  closeLive();
  const me = ++painting;
  const st = steps[at];
  $("#ob-bar", root).innerHTML = steps.map((_, i) => `<span class="${i < at ? "done" : i === at ? "now" : ""}"></span>`).join("");
  $("#ob-count", root).textContent = at === 0 ? "" : `${at} de ${steps.length - 1}`;
  $<HTMLElement>("#ob-back", root).hidden = at === 0;
  $<HTMLElement>("#ob-skip", root).hidden = !st.optional;
  $("#ob-next", root).textContent = st.next ?? "Continuar";
  const el = document.createElement("section");
  el.className = "ob-step";
  if (at > 0) await ready;
  await st.render(el);
  if (me !== painting || !root) return; // outro passo foi pedido enquanto este carregava
  $("#ob-stage", root).replaceChildren(el);
  $("main", root).scrollTop = 0;
}

function go(i: number) {
  at = Math.max(0, Math.min(steps.length - 1, i));
  void paint();
}

function close() {
  closeLive();
  settings.onboarding.done = true;
  saveSettings();
  root?.remove();
  root = null;
  host.onClose();
}

export async function openOnboarding(h0: OnboardingHost) {
  if (root) return;
  host = h0;
  at = 0;
  created = [];
  draft = { name: "", path: "~/", color: COLORS[0] };
  root = document.createElement("div");
  root.className = "onboarding";
  root.innerHTML = `
    <header class="ob-top"><div class="ob-wrap">
      <span class="ob-brand"><i aria-hidden="true"></i>coliseu</span>
      <div class="ob-bar" id="ob-bar" aria-hidden="true"></div>
      <span class="ob-count" id="ob-count"></span>
      <button class="ob-link" type="button" id="ob-close" title="Fechar e configurar depois">Configurar depois ✕</button>
    </div></header>
    <main><div class="ob-wrap" id="ob-stage" aria-live="polite"></div></main>
    <footer class="ob-foot"><div class="ob-wrap">
      <button class="ob-btn ghost" id="ob-back" type="button">Voltar</button>
      <span class="spacer"></span>
      <button class="ob-link" id="ob-skip" type="button">Pular este passo</button>
      <button class="ob-btn primary" id="ob-next" type="button">Continuar</button>
    </div></footer>`;
  // Atalhos do app (Ctrl+Shift+T…) não valem aqui; a digitação segue normal.
  root.addEventListener("keydown", (e) => e.stopPropagation());
  document.body.append(root);
  $("#ob-close", root).onclick = close;
  $("#ob-back", root).onclick = () => go(at - 1);
  $("#ob-skip", root).onclick = () => go(at + 1);
  $("#ob-next", root).onclick = () => {
    if (at < steps.length - 1) return go(at + 1);
    const g = created[0] ?? host.groups()[0];
    close();
    if (g) host.openTerminal(g.id);
  };
  // As verificações levam um instante (shell do usuário): rodam enquanto lê o boas-vindas.
  ready = Promise.all([refresh(), api.setupProjects().then((p) => (projects = p), () => {})]);
  void paint();
}
