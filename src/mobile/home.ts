// Home do app no celular (aba Terminais): cartão "Agora" + grupos em listas
// agrupadas do iOS. Visual em docs/mockups/mobile-app.html (#v-terms).
import "./home.css";
import { claudeMark, icon } from "../icons";
import type { Terminal } from "../transport";
import { currentScreen, escHtml, openConvo, pageHeader, sheet, shortDur, type AgentState, type AppHost, type AppTab } from "./shell";

import { contextLevel, SHELLS, WAITING_LABEL } from "../labels";
import { enablePush, lastPushState } from "./push";
import { installOffer, promptInstall } from "./install";

const INSTALL_DISMISS_KEY = "coliseu.installCardDismissed";
const flag = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const setFlag = (k: string) => {
  try {
    localStorage.setItem(k, "1");
  } catch {
    /* sem armazenamento: some só nesta sessão */
  }
};

const PUSH_DISMISS_KEY = "coliseu.pushCardDismissed";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE = 10;

export function homeTab(host: AppHost): AppTab {
  const el = document.createElement("div");
  el.className = "app-terms";

  const reason = (tid: string) => {
    const w = host.status(tid)?.claude?.waitingFor;
    return w && WAITING_LABEL[w] ? cap(WAITING_LABEL[w]) : "Aguardando você";
  };
  const runningSubs = (tid: string) => host.status(tid)?.claude?.subagents.filter((s) => !s.finished).length ?? 0;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  function hero(terms: Terminal[], states: Map<string, AgentState>) {
    let busy = 0, waiting = 0, done = 0, subs = 0;
    for (const t of terms) {
      const s = states.get(t.id);
      if (s === "busy") busy++;
      else if (s === "waiting") waiting++;
      else if (s === "done") done++;
      subs += runningSubs(t.id);
    }
    const first = terms.find((t) => states.get(t.id) === "waiting");
    const cta = first
      ? `<button class="hero-cta" data-tid="${escHtml(first.id)}" aria-label="Abrir ${escHtml(host.title(first.id))}">
          <span class="ci">${icon("hand", 18)}</span>
          <span class="ct"><b>${escHtml(host.title(first.id))}</b><span>${escHtml(reason(first.id))}</span></span>
          <span class="go" aria-hidden="true">Abrir</span>
        </button>`
      : "";
    return `<section class="hero" aria-label="Agora">
        <div>
          <div class="eyebrow">Agora</div>
          <div class="big">${busy} trabalhando <small>de ${terms.length}</small></div>
        </div>
        <div class="stats">
          <span><b><i style="background:var(--app-orange)"></i>${waiting}</b><em>aguardando</em></span>
          <span><b><i style="background:var(--app-green)"></i>${done}</b><em>${plural(done, "concluído", "concluídos")}</em></span>
          <span><b>${subs}</b><em>${plural(subs, "subagente", "subagentes")}</em></span>
        </div>
        ${cta}
      </section>`;
  }

  function row(tid: string, st: AgentState) {
    const s = host.status(tid);
    const kind = s?.claude?.kind;
    const tile =
      kind === "claude"
        ? `<span class="tile claude">${claudeMark(18)}</span>`
        : kind === "codex"
          ? `<span class="tile codex">cx</span>`
          : `<span class="tile">${icon("terminal", 18)}</span>`;

    let sub: string;
    if (st === "busy") {
      const n = runningSubs(tid);
      sub = `<i class="spin" aria-hidden="true"></i>Trabalhando${n ? ` · ${n} ${plural(n, "subagente", "subagentes")}` : ""}`;
    } else if (st === "waiting") sub = escHtml(reason(tid));
    else if (st === "done") sub = "Concluído";
    else if (st === "idle") sub = "Parado";
    else {
      const cmd = s?.command ?? "";
      sub = cmd && !SHELLS.has(cmd) ? escHtml(cmd) : "Shell";
    }

    // Tempo: ao vivo enquanto roda (o intervalo só troca o texto), senão a última duração.
    const r = host.run(tid);
    let trail = "";
    if (st === "waiting") {
      // Um "!" (não um número): o cartão "Agora" conta terminais, não pedidos.
      trail = `<span class="count-badge" aria-label="aguardando você">!</span>`;
    }
    else if (r?.start !== undefined) trail = `<span data-run-since="${r.start}">${shortDur(Date.now() - r.start)}</span>`;
    else if (r?.lastMs !== undefined) trail = `<span>${shortDur(r.lastMs)}</span>`;

    // Contexto em uso (o que o /context mostra), discreto no fim da linha de estado.
    const ctx = s?.claude?.context;
    const ctxHtml = ctx ? (({ pct, level }) => `<span class="ctxu ctxu-${level}">${pct}% contexto</span>`)(contextLevel(ctx)) : "";

    return `<button class="row" data-tid="${escHtml(tid)}">${tile}
        <span class="txt"><span class="t">${escHtml(host.title(tid))}</span><span class="s ${st}"><span class="s-txt">${sub}</span>${ctxHtml}</span></span>
        <span class="trail">${trail}${icon("chevronRight", 16)}</span>
      </button>`;
  }

  /** Um convite por vez: instalar o app primeiro, depois as notificações. */
  function inviteCard() {
    const offer = flag(INSTALL_DISMISS_KEY) ? null : installOffer();
    if (offer === "prompt")
      return `<div class="push-card"><span class="pc-ic">${icon("phone", 18)}</span>
        <span class="pc-txt"><b>Instalar o app</b><span>Abre em tela cheia, direto da tela inicial.</span></span>
        <span class="pc-acts"><button class="pc-on" data-act="install">Instalar</button><button class="pc-x" data-act="install-dismiss" aria-label="Agora não">${icon("x", 16)}</button></span></div>`;
    if (offer === "ios")
      return `<div class="push-card"><span class="pc-ic">${icon("phone", 18)}</span>
        <span class="pc-txt"><b>Instalar o app</b><span>Toque em Compartilhar e depois em "Adicionar à Tela de Início". Instalado, o iPhone também recebe notificações.</span></span>
        <button class="pc-x" data-act="install-dismiss" aria-label="Dispensar">${icon("x", 16)}</button></div>`;
    return pushCard();
  }

  /** Convite para ativar as notificações (some ao ativar ou ao dispensar). */
  function pushCard() {
    const st = lastPushState;
    if (flag(PUSH_DISMISS_KEY) || st === null || st === "on" || st === "denied") return "";
    if (st === "unsupported") {
      // Sem HTTPS (link antigo pelo IP): o caminho é o link novo das configurações.
      if (window.isSecureContext) return "";
      return `<div class="push-card"><span class="pc-ic">${icon("bell", 18)}</span>
        <span class="pc-txt"><b>Notificações no celular</b><span>Abra o Coliseu pelo link novo (https) em Configurações → Acesso remoto no desktop.</span></span>
        <button class="pc-x" data-act="push-dismiss" aria-label="Dispensar">${icon("x", 16)}</button></div>`;
    }
    return `<div class="push-card"><span class="pc-ic">${icon("bell", 18)}</span>
      <span class="pc-txt"><b>Receber notificações</b><span>Avisos de "concluiu" e "aguardando você", mesmo com o app fechado.</span></span>
      <span class="pc-acts"><button class="pc-on" data-act="push-on">Ativar</button><button class="pc-x" data-act="push-dismiss" aria-label="Agora não">${icon("x", 16)}</button></span></div>`;
  }

  function render() {
    const terms = host.terminals();
    const states = new Map(terms.map((t) => [t.id, host.state(t.id)] as const));
    const head = pageHeader("Terminais", { icon: "plus", label: "Novo terminal", id: "new" });
    if (!terms.length) {
      el.innerHTML = `${head}
        <div class="empty">
          <span class="empty-ic">${icon("terminal", 28)}</span>
          <b>Nenhum terminal aberto</b>
          <p>Crie um terminal em um dos grupos para começar.</p>
          <button class="empty-btn" data-act="new">${icon("plus", 18)}<span>Novo terminal</span></button>
        </div>`;
      return;
    }
    // Grupos vazios somem: no celular o espaço vale mais que a lista completa.
    const groups = host
      .groups()
      .map((g) => ({ g, ts: terms.filter((t) => t.groupId === g.id) }))
      .filter((x) => x.ts.length);
    el.innerHTML = `${head}${hero(terms, states)}${inviteCard()}${groups
      .map(
        ({ g, ts }) => `<section class="group" aria-label="${escHtml(g.name)}">
          <div class="group-h"><i class="gd" style="background:${escHtml(g.color)}"></i><b>${escHtml(g.name)}</b><span>${ts.length}</span></div>
          <div class="inset">${ts.map((t) => row(t.id, states.get(t.id)!)).join("")}</div>
        </section>`,
      )
      .join("")}`;
  }

  // ---------- Tempo ao vivo ----------

  let ticker = 0;
  const visible = () => !el.hidden && el.isConnected && currentScreen() === "home";
  function tick() {
    if (!visible()) {
      clearInterval(ticker);
      ticker = 0;
      return;
    }
    const now = Date.now();
    el.querySelectorAll<HTMLElement>("[data-run-since]").forEach((s) => (s.textContent = shortDur(now - Number(s.dataset.runSince))));
  }
  // refresh() roda ao entrar na aba/voltar para a home: é aí que o intervalo volta.
  const startTicker = () => {
    if (!ticker && visible()) ticker = window.setInterval(tick, 1000);
  };

  // ---------- Ações ----------

  function newTerminal() {
    void sheet(
      "Novo terminal em",
      host.groups().map((g) => ({
        label: g.name,
        dot: g.color,
        run: async () => {
          const id = await host.newTerminal(g.id);
          if (id) openConvo(id);
        },
      })),
    );
  }

  function actions(tid: string) {
    const chat = host.isChat(tid);
    void sheet(host.title(tid), [
      {
        label: chat ? "Abrir como terminal" : "Abrir como chat",
        run: async () => {
          openConvo(tid);
          await host.toggleChat(tid);
        },
      },
      { label: "Renomear", run: () => host.rename(tid) },
      { label: "Fechar terminal", danger: true, run: () => host.close(tid) },
    ]);
  }

  // ---------- Toque e toque longo (delegados: sobrevivem ao redesenho) ----------

  let press: { tid: string; x: number; y: number; timer: number; id: number } | null = null;
  let suppressClick = false;
  let dirty = false; // refresh() chegou durante o toque: redesenha ao soltar

  const endPress = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
    if (dirty) {
      dirty = false;
      refresh();
    }
  };

  el.addEventListener("pointerdown", (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>(".row[data-tid]");
    suppressClick = false;
    if (!r || e.button > 0) return;
    endPress();
    const tid = r.dataset.tid!;
    press = {
      tid,
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      timer: window.setTimeout(() => {
        suppressClick = true;
        press = null;
        navigator.vibrate?.(10);
        actions(tid);
        if (dirty) {
          dirty = false;
          refresh();
        }
      }, LONG_PRESS_MS),
    };
  });
  el.addEventListener("pointermove", (e) => {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) endPress();
  });
  // Rolar a lista dispara pointercancel no celular: o toque longo morre junto.
  for (const ev of ["pointerup", "pointercancel", "pointerleave"] as const) el.addEventListener(ev, endPress);
  el.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".row")) e.preventDefault();
  });

  el.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const t = e.target as HTMLElement;
    if (t.closest('[data-act="new"]')) return newTerminal();
    if (t.closest('[data-act="install-dismiss"]')) {
      setFlag(INSTALL_DISMISS_KEY);
      return render();
    }
    if (t.closest('[data-act="install"]')) {
      void promptInstall()
        .catch(() => host.toast("Não deu para abrir a instalação. Use o menu ⋮ do Chrome → Instalar app."))
        .finally(render);
      return;
    }
    if (t.closest('[data-act="push-dismiss"]')) {
      setFlag(PUSH_DISMISS_KEY);
      return render();
    }
    if (t.closest('[data-act="push-on"]')) {
      void enablePush()
        .then((s) => host.toast(s === "on" ? "Notificações ativadas neste celular." : s === "denied" ? "Permissão negada — libere nas configurações do navegador." : "Notificações não ativadas."))
        .catch((err) => host.toast(`Não deu para ativar: ${err}`))
        .finally(render);
      return;
    }
    const r = t.closest<HTMLElement>("[data-tid]");
    if (r) openConvo(r.dataset.tid!);
  });

  function refresh() {
    if (press) {
      dirty = true;
      return;
    }
    // A área rolável é da casca; innerHTML pode mexer na altura, então guarda a posição.
    const scroller = el.closest<HTMLElement>(".app-scroll");
    const top = scroller?.scrollTop ?? 0;
    render();
    if (scroller && scroller.scrollTop !== top) scroller.scrollTop = top;
    startTicker();
  }

  return { id: "terms", label: "Terminais", icon: "terminal", el, refresh };
}
