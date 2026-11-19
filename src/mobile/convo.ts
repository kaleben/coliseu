// Tela da conversa no app do celular (docs/MOBILE_SPEC.md §2.2): barra de topo
// (← · título com grupo e estado · ⋯) e o menu ⋯ (chat ⇄ terminal, modo de
// permissão, renomear, fechar). O chat e o terminal são os do desktop
// (#workspace), restilizados em convo.css só com body.app.
import "./convo.css";
import { icon } from "../icons";
import { CHAT_MODES } from "../chat";
import { contextLevel } from "../labels";
import { goHome, sheet, type AgentState, type AppHost, type ConvoBar, type SheetOption } from "./shell";

/** Palavra do estado embaixo do título. */
const STATE_WORD: Record<AgentState, string> = {
  busy: "trabalhando",
  waiting: "aguardando você",
  idle: "parado",
  done: "concluído",
  none: "terminal",
};

export function createConvoBar(host: AppHost): ConvoBar {
  const el = document.createElement("header");
  el.className = "app-cbar";
  el.innerHTML = `
    <button class="app-round" data-act="back" aria-label="Voltar">${icon("chevronLeft", 22)}</button>
    <div class="ttl">
      <b></b>
      <small><i class="gd"></i><span class="grp"></span><span class="st"></span></small>
    </div>
    <button class="app-round" data-act="more" aria-label="Mais opções" aria-haspopup="dialog">${icon("more", 22)}</button>`;
  const titleEl = el.querySelector<HTMLElement>(".ttl b")!;
  const dotEl = el.querySelector<HTMLElement>(".ttl .gd")!;
  const groupEl = el.querySelector<HTMLElement>(".ttl .grp")!;
  const stateEl = el.querySelector<HTMLElement>(".ttl .st")!;

  /** Terminal mostrado agora. */
  let current: string | undefined;
  /** Terminais que já estiveram em chat nesta sessão ("Voltar para o chat" em vez de "Abrir como chat"). */
  const wasChat = new Set<string>();

  function update(tid: string) {
    current = tid;
    const t = host.terminals().find((x) => x.id === tid);
    if (!t) return;
    const chat = host.isChat(tid);
    if (chat) wasChat.add(tid);
    const g = host.groups().find((x) => x.id === t.groupId);
    titleEl.textContent = host.title(tid);
    dotEl.style.background = g?.color ?? "var(--app-label-3)";
    dotEl.hidden = !g;
    groupEl.textContent = g?.name ?? "";

    const st = host.state(tid); // já considera o estado do chat
    const ctx = host.status(tid)?.claude?.context;
    const pct = ctx ? ` · ${contextLevel(ctx).pct}% contexto` : "";
    stateEl.textContent = `${g ? " · " : ""}${STATE_WORD[st]}${pct}`;
    stateEl.className = `st s-${st}`;
  }

  /** Folha com os modos de permissão (o atual marcado). */
  function modeSheet(tid: string) {
    const cs = host.chatState(tid);
    if (!cs) return;
    const opts: SheetOption[] = CHAT_MODES.filter(([v]) => v !== "bypassPermissions" || cs.allowBypass || cs.mode === v).map(([v, l]) => ({
      label: v === cs.mode ? `✓ ${l}` : l,
      run: () => (v === cs.mode ? undefined : host.setChatMode(tid, v)),
    }));
    void sheet("Modo de permissão", opts);
  }

  function moreSheet(tid: string) {
    const chat = host.isChat(tid);
    const opts: SheetOption[] = [
      {
        label: chat ? "Ver como terminal" : wasChat.has(tid) ? "Voltar para o chat" : "Abrir como chat",
        run: async () => {
          await host.toggleChat(tid);
          if (current === tid) update(tid);
        },
      },
    ];
    if (chat) opts.push({ label: "Modo de permissão", run: () => modeSheet(tid) });
    opts.push(
      {
        label: "Renomear",
        run: async () => {
          await host.rename(tid);
          if (current === tid) update(tid);
        },
      },
      { label: "Fechar terminal", danger: true, run: () => host.close(tid) },
    );
    void sheet(host.title(tid), opts);
  }

  el.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "back") goHome();
    else if (act === "more" && current) moreSheet(current);
  });

  // Selo do modo acima do campo do chat (chat.ts dispara o evento).
  document.addEventListener("chat-mode-chip", (e) => {
    const tid = (e as CustomEvent<{ termId: string }>).detail?.termId;
    if (tid && document.body.classList.contains("app")) modeSheet(tid);
  });

  // Chat ⇄ terminal muda body.chat-active (às vezes sem mudança de status): atualiza a barra.
  let chatActive = document.body.classList.contains("chat-active");
  new MutationObserver(() => {
    const now = document.body.classList.contains("chat-active");
    if (now === chatActive) return;
    chatActive = now;
    const id = host.activeId();
    if (id && document.body.classList.contains("app-convo")) update(id);
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  fitViewport();
  return { el, update };
}

/**
 * A conversa (#main, fixa) ocupa só a área visível: no iPhone o teclado não
 * encolhe a viewport de layout, então a altura vem do visualViewport.
 */
function fitViewport() {
  const vv = window.visualViewport;
  const main = document.getElementById("main");
  if (!vv || !main) return;
  const fit = () => main.style.setProperty("--convo-h", `${vv.height}px`);
  vv.addEventListener("resize", fit);
  fit();
}
