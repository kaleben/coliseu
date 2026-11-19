// Tela de chat de um terminal (modo chat — docs/CHAT_SPEC.md).
import DOMPurify from "dompurify";
import { marked } from "marked";
import { api, type ChatEvent, type ChatState } from "./transport";
import { icon } from "./icons";
import { ansiHtml, diffHtml, diffStats, editOps, TaskBoard } from "./chatcards";
import { esc } from "./labels";
import { Dictation, dictationSupported } from "./voice";

/** Modos de permissão do Claude Code (rótulos curtos para o seletor). */
export const CHAT_MODES: [string, string, string][] = [
  ["default", "Perguntar", "Pede aprovação para ações sensíveis"],
  ["acceptEdits", "Aceitar edições", "Edita arquivos sem perguntar"],
  ["plan", "Planejar", "Só analisa e propõe um plano"],
  ["auto", "Auto", "Um classificador aprova ou bloqueia cada ação"],
  ["bypassPermissions", "Sem aprovações", "Executa tudo sem perguntar"],
];

/** Markdown do modelo → HTML sanitizado. */
function md(text: string) {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }) as string);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Block = { type: string; [k: string]: any };

/** Resumo de uma chamada de ferramenta para a linha compacta. */
function toolSummary(name: string, input: Record<string, unknown> = {}, cwd = "") {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  // Caminho relativo à pasta do chat (no celular o caminho inteiro não cabe).
  const path = (p: string) => (cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p.replace(/^\/home\/[^/]+/, "~"));
  const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);
  switch (name) {
    case "Bash":
      return short(str("description") || str("command"));
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return path(str("file_path"));
    case "Glob":
    case "Grep":
      return short(str("pattern"));
    case "WebFetch":
      return short(str("url"));
    case "WebSearch":
      return short(str("query"));
    case "Agent":
    case "Task":
      return short([str("subagent_type"), str("description")].filter(Boolean).join(" · "));
    case "TodoWrite":
      return "lista de tarefas";
    case "TaskCreate":
      return short(str("subject"));
    case "TaskUpdate":
      return `#${String(input.taskId ?? "")} → ${str("status") || "atualizada"}`;
    case "AskUserQuestion":
      return Array.isArray(input.questions) ? input.questions.map((q: { question?: string }) => q.question ?? "").join(" · ") : "";
    case "ExitPlanMode":
      return "proposto para aprovação";
    default:
      return short(JSON.stringify(input), 100);
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c?.type === "text" ? c.text : "")).join("\n");
  return "";
}

/**
 * Resposta de um subagente sem o que o Claude Code põe para o modelo: o
 * cabeçalho ("[Subagent hand-back] … The report follows:"), o recuo de cada
 * linha e o rodapé com o id do agente.
 */
function agentReport(text: string, raw = true) {
  // Rodapé para o modelo (só no resultado cru; o estruturado não tem):
  // "agentId: X (…)" perto do fim + uso de tokens.
  // Só corta se depois da linha vierem apenas linhas "chave: valor"/<usage>.
  const foot = raw ? text.search(/\n+agentId: \w+ \([^\n]*(?:\n(?:\s*|<\/?usage>.*|\w+: \S.*))*$/) : -1;
  if (foot >= 0) text = text.slice(0, foot);
  const m = /^\s*\[Subagent hand-back\][\s\S]*?The report follows:[ \t]*\n?/.exec(text);
  if (!m) return text.trim();
  return text
    .slice(m[0].length)
    .split("\n")
    .map((l) => l.replace(/^ {1,2}/, ""))
    .join("\n")
    .trim();
}

/**
 * Resultado estruturado do Agent (`tool_use_result` ao vivo; anexado pelo
 * sidecar no histórico): status async_launched/completed e o relatório limpo.
 */
type AgentResult = { status?: string; isAsync?: boolean; content?: unknown; agentId?: string };

/** Resultado que só aponta para o relatório entregue em <agent-message>. */
const isReportPointer = (t: string) => /^\s*This agent's report was delivered to you as a message/.test(t);

/** Sem o dado estruturado (versões antigas): reconhece o aviso de segundo plano pelo texto. */
const isLaunchNotice = (t: string) => /^\s*Async agent launched/.test(t);

/** Status do resultado estruturado que significam "lançado, ainda rodando". */
const LAUNCHED = new Set(["async_launched", "remote_launched"]);

const BG_BADGE = `<span class="steps bg">Em segundo plano · </span>`;

/** Saídas longas: corta para não pesar a tela (nunca usado em pedido de permissão). */
const cut = (t: string) => (t.length > 6000 ? `${t.slice(0, 6000)}\n… (cortado)` : t);

/** Comando do Bash para o pedido de permissão: sempre inteiro, sem corte (a caixa rola). */
function bashCommand(c: unknown) {
  if (c == null || c === "") return "(comando vazio)";
  return typeof c === "string" ? c : JSON.stringify(c);
}

/** Mensagens do usuário que são "internas" do Claude Code (comandos, lembretes). */
const isInternal = (text: string) =>
  /^\s*<(command-|local-command|system-reminder|bash-|task-notification)/.test(text) ||
  // Entrega de relatório de subagente (o conteúdo vai para o cartão pelo sidecar).
  /^\s*(?:[^\n<]{0,80}\n)?<agent-message from="/.test(text);

export class ChatView {
  readonly el: HTMLDivElement;
  private list: HTMLDivElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private busyEl: HTMLDivElement;
  private state: ChatState | null = null;
  /** Bolha recebendo o texto em tempo real (deltas). */
  private streaming: HTMLDivElement | null = null;
  /** tool_use_id → elemento da ferramenta (para anexar o resultado). */
  private tools = new Map<string, HTMLElement>();
  /** agentId → cartão do Agent; relatórios (<agent-message>) que chegaram antes do cartão saber o id. */
  private agentCards = new Map<string, HTMLElement>();
  private agentReportBodies = new Map<string, string[]>();
  /** Tarefas do Claude (painel acima do compositor). */
  private board = new TaskBoard();
  private tasksEl!: HTMLDetailsElement;
  private loaded = false;
  /** Pedidos pendentes (requestId → evento com o input original). */
  private pendingReqs = new Map<string, ChatEvent>();
  /** Enquanto o histórico carrega, eventos ao vivo esperam aqui (ordem + sem duplicar). */
  private queue: ChatEvent[] | null = null;
  private historyUuids = new Set<string>();
  private historyUserTexts: string[] = [];
  private dictation: Dictation | null = null;

  constructor(
    readonly termId: string,
    private onBack: () => void,
    private toast: (msg: string) => void,
  ) {
    this.el = document.createElement("div");
    this.el.className = "chatview";
    this.el.innerHTML = `
      <div class="chat-head">
        <span class="chat-title">${icon("message", 15)} Chat</span>
        <span class="chat-cwd"></span>
        <span class="spacer"></span>
        <select class="chat-mode-sel" title="Modo de permissão">${CHAT_MODES.map(([v, l, d]) => `<option value="${v}" title="${esc(d)}">${l}</option>`).join("")}</select>
        <button class="btn sm" data-act="to-terminal" title="Voltar ao terminal (continua a mesma conversa)">${icon("terminal", 14)} Terminal</button>
      </div>
      <div class="chat-list"></div>
      <details class="chat-tasks" hidden><summary></summary><ul></ul></details>
      <div class="chat-busy" hidden><span class="dots"><i></i><i></i><i></i></span> Claude está trabalhando…</div>
      <button class="chat-modechip" data-act="mode-chip" aria-label="Modo de permissão">${icon("shield", 13)}<span></span></button>
      <div class="chat-composer">
        <textarea rows="1" placeholder="Mensagem para o Claude…" enterkeyhint="send"></textarea>
        <button class="icon chat-mic" data-act="mic" title="Ditar" hidden>${icon("mic", 17)}</button>
        <button class="primary chat-send" data-act="send" title="Enviar">${icon("arrowUp", 16)}</button>
      </div>`;
    this.list = this.el.querySelector(".chat-list")!;
    this.input = this.el.querySelector("textarea")!;
    this.sendBtn = this.el.querySelector(".chat-send")!;
    this.busyEl = this.el.querySelector(".chat-busy")!;
    this.tasksEl = this.el.querySelector(".chat-tasks")!;

    // Ditado pelo navegador (celular). No app do PC o ditado é o /voice do Claude.
    if (!api.native && dictationSupported()) {
      const mic = this.el.querySelector<HTMLButtonElement>(".chat-mic")!;
      mic.hidden = false;
      this.el.querySelector(".chat-composer")!.classList.add("has-mic");
      this.dictation = new Dictation(
        this.input,
        (on) => {
          mic.classList.toggle("rec", on);
          mic.title = on ? "Parar ditado" : "Ditar";
        },
        (msg) => this.toast(msg),
      );
    }
    this.el.addEventListener("click", (e) => this.onClick(e));
    this.el.querySelector<HTMLSelectElement>(".chat-mode-sel")!.addEventListener("change", async (e) => {
      const sel = e.target as HTMLSelectElement;
      const prev = this.state?.mode ?? "default";
      try {
        await api.chatSetMode(this.termId, sel.value);
      } catch (err) {
        this.toast(String(err));
        sel.value = prev;
      }
    });
    this.input.addEventListener("input", () => this.autosize());
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // atalhos do app não roubam o que se digita aqui
      const touch = document.body.classList.contains("mobile");
      if (e.key === "Enter" && !e.shiftKey && !touch) {
        e.preventDefault();
        void this.submit();
      }
    });
  }

  /** Carrega estado + histórico (uma vez). */
  async load(state?: ChatState) {
    if (state) this.applyState(state);
    if (this.loaded) return;
    this.loaded = true;
    this.queue = [];
    for (const p of this.state?.pending ?? []) this.pendingReqs.set(p.requestId, p);
    try {
      const history = (await api.chatHistory(this.termId)) as { type: string; uuid?: string; message: { content: unknown } }[];
      for (const m of history) this.renderStored(m);
    } catch (e) {
      this.system(`Não foi possível carregar o histórico: ${e}`);
    }
    for (const p of this.pendingReqs.values()) this.permissionCard(p);
    // Agora os eventos que chegaram durante o carregamento, sem repetir o que já veio do arquivo.
    const queued = this.queue;
    this.queue = null;
    // Só a última mensagem do usuário no arquivo pode ser o mesmo eco que chegou ao vivo.
    let lastHistoryUser: string | undefined = this.historyUserTexts[this.historyUserTexts.length - 1];
    for (const e of queued) {
      if (e.ev === "message" && e.msg?.uuid && this.historyUuids.has(e.msg.uuid)) continue;
      // Pedaços parciais: a mensagem final (ou os próximos pedaços) bastam; replay duplicaria.
      if (e.ev === "delta") continue;
      if (e.ev === "user" && lastHistoryUser !== undefined && e.text === lastHistoryUser) {
        lastHistoryUser = undefined;
        continue;
      }
      this.handle(e);
    }
    this.scroll(true);
  }

  focus() {
    this.input.focus();
  }

  private applyState(s: ChatState) {
    this.state = s;
    this.el.querySelector(".chat-cwd")!.textContent = s.cwd.replace(/^\/home\/[^/]+/, "~");
    const bypass = this.el.querySelector<HTMLOptionElement>('.chat-mode-sel option[value="bypassPermissions"]');
    if (bypass) bypass.hidden = !s.allowBypass;
    this.setMode(s.mode);
    this.setBusy(s.busy);
  }

  private setMode(mode: string) {
    if (this.state) this.state.mode = mode;
    const sel = this.el.querySelector<HTMLSelectElement>(".chat-mode-sel")!;
    if (![...sel.options].some((o) => o.value === mode)) sel.add(new Option(mode, mode));
    sel.value = mode;
    // Selo do modo acima do campo (só aparece no app do celular; ver mobile/convo.css).
    this.el.querySelector(".chat-modechip span")!.textContent = CHAT_MODES.find(([v]) => v === mode)?.[1] ?? mode;
  }

  /** A sessão do SDK já subiu (a 1ª mensagem espera hooks/plugins carregarem). */
  private initialized = false;

  private setBusy(busy: boolean) {
    if (this.state) this.state.busy = busy;
    this.busyEl.hidden = !busy;
    this.busyEl.lastChild!.textContent = this.pendingReqs.size
      ? " Aguardando sua resposta…"
      : this.initialized
        ? " Claude está trabalhando…"
        : " Iniciando sessão — a primeira mensagem demora um pouco…";
    this.sendBtn.dataset.act = busy ? "stop" : "send";
    this.sendBtn.title = busy ? "Parar" : "Enviar";
    this.sendBtn.innerHTML = busy ? icon("x", 16) : icon("arrowUp", 16);
    this.sendBtn.classList.toggle("stop", busy);
  }

  private autosize() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 180)}px`;
  }

  private nearBottom() {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 120;
  }

  private scroll(force = false) {
    if (force || this.nearBottom()) requestAnimationFrame(() => (this.list.scrollTop = this.list.scrollHeight));
  }

  private add(node: HTMLElement) {
    const stick = this.nearBottom();
    this.list.appendChild(node);
    if (stick) this.scroll(true);
    return node;
  }

  private system(text: string) {
    const d = document.createElement("div");
    d.className = "chat-sys";
    d.textContent = text;
    this.add(d);
  }

  // ---------- Renderização ----------

  private userBubble(text: string) {
    const d = document.createElement("div");
    d.className = "msg user";
    d.textContent = text;
    this.add(d);
  }

  private assistantBlocks(blocks: Block[]) {
    for (const b of blocks) {
      if (b.type === "text" && b.text?.trim()) {
        const d = document.createElement("div");
        d.className = "msg assistant md";
        d.innerHTML = md(b.text);
        this.add(d);
      } else if (b.type === "thinking" && b.thinking?.trim()) {
        const d = document.createElement("details");
        d.className = "msg thinking";
        d.innerHTML = `<summary>Raciocínio</summary><div class="md"></div>`;
        d.querySelector(".md")!.innerHTML = md(b.thinking);
        this.add(d);
      } else if (b.type === "tool_use") {
        this.toolLine(b.id, b.name, b.input);
      }
    }
  }

  private toolLine(id: string, name: string, input: Record<string, unknown> = {}) {
    const d = document.createElement("details");
    d.className = "tool";
    const label = name === "AskUserQuestion" ? "Pergunta" : name === "ExitPlanMode" ? "Plano" : name === "Task" ? "Agent" : name;
    const arg = esc(toolSummary(name, input, this.state?.cwd));
    let stat = "";
    let body = `<pre class="tout">…</pre>`;
    const ops = editOps(name, input);
    if (TaskBoard.isTaskTool(name)) {
      // Vai para o painel de tarefas; na conversa só uma linha discreta.
      d.classList.add("mini");
      d.dataset.kind = "task";
      body = "";
      this.board.onUse(id, name, input);
      this.renderTasks();
    } else if (ops) {
      d.dataset.kind = "edit";
      const { add, del } = diffStats(ops);
      stat =
        name === "Write"
          ? `<span class="dstat">${add} ${add === 1 ? "linha" : "linhas"}</span>`
          : `<span class="dstat">${add ? `<b class="add">+${add}</b>` : ""}${del ? ` <b class="del">−${del}</b>` : ""}</span>`;
      body = `${diffHtml(ops)}<pre class="tout" hidden></pre>`;
    } else if (name === "Bash") {
      d.dataset.kind = "bash";
      body = `<pre class="tcmd">${esc(String(input.command ?? ""))}</pre><pre class="tout">…</pre>`;
    } else if (name === "Agent" || name === "Task") {
      d.dataset.kind = "agent";
      d.classList.add("agent", "running");
      if (input.run_in_background) d.dataset.background = "1";
      body = `<div class="agent-live">Iniciando…</div><div class="tres md"></div>`;
    } else if (name === "ExitPlanMode" && typeof input.plan === "string") {
      // Plano: o texto fica guardado na conversa (o cartão de aprovação some depois).
      body = `<div class="tplan md">${md(input.plan)}</div>${body}`;
    }
    d.innerHTML = `<summary><span class="tname">${esc(label)}</span><span class="targ">${arg}</span>${stat}<span class="tstat"></span></summary>${body}`;
    this.tools.set(id, d);
    this.add(d);
  }

  private toolResult(b: Block, structured?: AgentResult) {
    const d = this.tools.get(b.tool_use_id);
    if (!d) return;
    let text = resultText(b.content);
    const err = !!b.is_error;
    if (d.dataset.kind === "agent") {
      const agentId = structured?.agentId ?? /agentId: (\w+)/.exec(text)?.[1] ?? /delivered to you as a message from "(\w+)"/.exec(text)?.[1];
      if (agentId) {
        d.dataset.agentId = agentId;
        this.agentCards.set(agentId, d);
      }
      // Em segundo plano (pedido ou mandado no meio): o resultado é só o aviso
      // de início; o cartão continua "rodando" até a notificação de término.
      const launched = structured?.status ? LAUNCHED.has(structured.status) : !err && isLaunchNotice(text);
      if (launched) {
        d.dataset.background = "1";
        const live = d.querySelector(".agent-live");
        if (live && !d.dataset.steps) live.textContent = "Em segundo plano…";
        else if (live && !live.querySelector(".bg")) live.insertAdjacentHTML("afterbegin", BG_BADGE);
        return;
      }
      // Terminou de fato (mesmo tendo pedido segundo plano): notificações não mexem mais.
      delete d.dataset.background;
      // Relatório limpo (sem o rodapé para o modelo) quando há o dado estruturado.
      const clean = resultText(structured?.content);
      if (clean) {
        text = clean;
        d.dataset.clean = "1";
      }
      // O relatório veio (ou vem) numa <agent-message> separada.
      if (isReportPointer(text)) {
        this.finishTool(d, err);
        const report = agentId ? this.agentReportText(agentId) : undefined;
        if (report !== undefined) this.showReport(d, report, false);
        else d.querySelector(".agent-live")?.replaceChildren("Aguardando o relatório…");
        return;
      }
    }
    this.finishTool(d, err);
    const out = d.querySelector<HTMLElement>(".tout");
    switch (d.dataset.kind) {
      case "task":
        this.board.onResult(b.tool_use_id, text, err);
        this.renderTasks();
        return;
      case "edit":
        // Sucesso: o diff já diz tudo. Erro: mostra o motivo.
        if (out && err) {
          out.hidden = false;
          out.textContent = cut(text);
        }
        return;
      case "agent":
        this.showReport(d, text, !d.dataset.clean);
        return;
      case "bash":
        if (out) out.innerHTML = ansiHtml(cut(text)) || "(sem saída)";
        return;
      default:
        if (out) out.textContent = cut(text) || "(sem saída)";
    }
  }

  private finishTool(d: HTMLElement, err: boolean) {
    d.classList.toggle("err", err);
    d.classList.remove("running");
    d.querySelector(".tstat")!.innerHTML = err ? icon("circleX", 13) : icon("check", 13);
  }

  /**
   * Relatório de subagente entregue como <agent-message> (interpretado pelo
   * sidecar: evento agent_report ao vivo, campo agent_reports no histórico).
   * Um 2º relatório do mesmo agente (continuado com SendMessage) vem embaixo.
   */
  /** Relatórios do agente já limpos, juntos (um 2º relatório vem embaixo). */
  private agentReportText(id: string) {
    const bodies = this.agentReportBodies.get(id);
    return bodies && bodies.map((b) => agentReport(b, false)).join("\n\n---\n\n");
  }

  private agentReportFor(id: string, body: string) {
    const bodies = this.agentReportBodies.get(id) ?? [];
    if (bodies.includes(body)) return; // o mesmo relatório (histórico + ao vivo)
    bodies.push(body);
    this.agentReportBodies.set(id, bodies);
    const all = this.agentReportText(id)!;
    const d = this.agentCards.get(id);
    if (d && !d.classList.contains("running")) this.showReport(d, all, false);
  }

  /**
   * Fim de um agente em segundo plano: chega como mensagem interna
   * <task-notification> com o tool-use-id do Agent e o relatório.
   */
  private taskNotification(text: string) {
    if (!text.trimStart().startsWith("<task-notification>")) return;
    // Pode vir mais de uma notificação na mesma mensagem. Cada bloco vai até o
    // início do próximo (o relatório pode citar a tag de fechamento).
    // Bloco de verdade começa direto com um campo (<task-id>, <tool-use-id>…).
    for (const block of text.split(/<task-notification>\s*(?=<[a-z-]+>)/).slice(1)) {
      const first = (t: string) => new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(block)?.[1]?.trim() ?? "";
      // <result> é o último campo: vai até o último </result>.
      const result = /<result>([\s\S]*)<\/result>/.exec(block)?.[1]?.trim() ?? "";
      this.finishBackground(first("tool-use-id"), first("status"), result || first("summary"), !!result);
    }
  }

  /**
   * Agente em segundo plano terminou (ao vivo: system/task_notification, que
   * traz só um resumo; histórico: <task-notification> com o relatório).
   * Cartões de agentes em primeiro plano já terminados não mudam.
   */
  private finishBackground(toolUseId: string, status: string, text: string, full: boolean) {
    const d = this.tools.get(toolUseId);
    if (!d || d.dataset.kind !== "agent" || !d.dataset.background) return;
    this.finishTool(d, status !== "" && status !== "completed");
    // Relatório entregue como <agent-message> tem prioridade sobre resumo/ponteiro.
    const delivered = d.dataset.agentId ? this.agentReportText(d.dataset.agentId) : undefined;
    if (delivered !== undefined) return this.showReport(d, delivered, false);
    // O resumo ao vivo não substitui o relatório completo já mostrado (replay).
    if (d.dataset.reported && !full) return;
    if (isReportPointer(text)) return void d.querySelector(".agent-live")?.replaceChildren("Aguardando o relatório…");
    this.showReport(d, text);
    if (full) d.dataset.reported = "1";
  }

  /** `raw`: texto cru do resultado (pode ter o rodapé para o modelo). */
  private showReport(d: HTMLElement, text: string, raw = true) {
    d.querySelector(".agent-live")?.remove();
    d.querySelector(".tres")!.innerHTML = md(cut(agentReport(text, raw)) || "(sem resposta)");
  }

  /** Mensagem de um subagente (parent_tool_use_id): atualiza o cartão do Agent. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private subagentActivity(msg: any) {
    const d = this.tools.get(msg.parent_tool_use_id);
    const live = d?.querySelector<HTMLElement>(".agent-live");
    if (!d || !live || msg.type !== "assistant") return;
    for (const b of (msg.message?.content ?? []) as Block[]) {
      // SubagentHandback é a entrega do relatório, não uma ação a mostrar.
      if (b.type !== "tool_use" || b.name === "SubagentHandback") continue;
      const n = Number(d.dataset.steps ?? 0) + 1;
      d.dataset.steps = String(n);
      const bg = d.dataset.background ? BG_BADGE : "";
      live.innerHTML = `${bg}<span class="tname">${esc(b.name)}</span> ${esc(toolSummary(b.name, b.input, this.state?.cwd))} <span class="steps">· ${n} ${n === 1 ? "ação" : "ações"}</span>`;
    }
  }

  private renderTasks() {
    const tasks = this.board.visible;
    // Lista já concluída no histórico não aparece (é coisa velha); concluída ao
    // vivo continua visível como "Tarefas concluídas".
    const finished = tasks.length > 0 && this.board.done === tasks.length;
    this.tasksEl.hidden = !tasks.length || (finished && this.queue !== null);
    if (this.tasksEl.hidden) return;
    const cur = this.board.current;
    this.tasksEl.querySelector("summary")!.innerHTML =
      `<span class="tk-count">${this.board.done}/${tasks.length}</span> ${esc(cur ? cur.activeForm || cur.subject : this.board.done === tasks.length ? "Tarefas concluídas" : "Tarefas")}`;
    this.tasksEl.querySelector("ul")!.innerHTML = tasks
      .map((t) => `<li class="tk ${esc(t.status)}"><span class="tk-mark">${t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "○"}</span>${esc(t.subject)}</li>`)
      .join("");
  }

  /** Mensagem guardada no arquivo da sessão (histórico). */
  private renderStored(m: {
    type: string;
    uuid?: string;
    message: { content: unknown };
    tool_use_result?: AgentResult;
    /** Relatórios entregues como mensagem (interpretados pelo sidecar). */
    agent_reports?: { agentId: string; text: string }[];
  }) {
    // Entrega de relatório: vai para o cartão; o texto dela some (isInternal),
    // mas o resto da mensagem (resultados de ferramenta etc.) segue normal.
    for (const r of m.agent_reports ?? []) this.agentReportFor(r.agentId, r.text);
    if (m.uuid) this.historyUuids.add(m.uuid);
    const content = m.message?.content;
    if (m.type === "assistant" && Array.isArray(content)) this.assistantBlocks(content as Block[]);
    else if (m.type === "user") {
      if (typeof content === "string") {
        this.taskNotification(content);
        if (!isInternal(content)) {
          this.userBubble(content);
          this.historyUserTexts.push(content);
        }
      } else if (Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b.type === "tool_result") this.toolResult(b, m.tool_use_result);
          else if (b.type === "text" && b.text) this.taskNotification(b.text);
          if (b.type === "text" && b.text && !isInternal(b.text)) {
            this.userBubble(b.text);
            this.historyUserTexts.push(b.text);
          }
        }
      }
    }
  }

  // ---------- Eventos ao vivo ----------

  handle(e: ChatEvent) {
    if (this.queue && ["user", "delta", "message", "permission", "permission_resolved", "agent_report"].includes(e.ev)) {
      this.queue.push(e);
      return;
    }
    switch (e.ev) {
      case "opened":
        this.applyState(e.state);
        break;
      case "user":
        this.userBubble(e.text);
        break;
      case "delta":
        if (e.kind !== "text") break;
        if (!this.streaming) {
          this.streaming = document.createElement("div");
          this.streaming.className = "msg assistant streaming";
          this.add(this.streaming);
        }
        this.streaming.textContent += e.text;
        this.scroll();
        break;
      case "message":
        this.onMessage(e.msg);
        break;
      case "state":
        this.setBusy(!!e.busy);
        break;
      case "mode":
        this.setMode(e.mode);
        break;
      case "permission":
        this.permissionCard(e);
        break;
      case "agent_report":
        this.agentReportFor(e.agentId, e.text);
        break;
      case "permission_resolved":
        this.el.querySelector(`.perm[data-req="${CSS.escape(e.requestId)}"]`)?.remove();
        break;
      case "error":
        this.system(`Erro: ${e.error}`);
        break;
      case "closed":
        if (e.error) this.system(`Chat encerrado: ${e.error}`);
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onMessage(msg: any) {
    if (msg.type === "system" && msg.subtype === "init") {
      this.initialized = true;
      if (this.state?.busy) this.setBusy(true); // troca o texto do indicador
      return;
    }
    if (msg.type === "system" && msg.subtype === "task_notification") {
      if (msg.tool_use_id) this.finishBackground(msg.tool_use_id, msg.status ?? "", msg.summary ?? "", false);
      return;
    }
    if (msg.parent_tool_use_id) {
      this.subagentActivity(msg);
      return;
    }
    if (msg.type === "assistant") {
      this.streaming?.remove();
      this.streaming = null;
      this.assistantBlocks(msg.message?.content ?? []);
    } else if (msg.type === "user" && typeof msg.message?.content === "string") {
      this.taskNotification(msg.message.content);
    } else if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const b of msg.message.content as Block[]) {
        if (b.type === "tool_result") this.toolResult(b, msg.tool_use_result);
        else if (b.type === "text" && b.text) this.taskNotification(b.text);
      }
    } else if (msg.type === "result") {
      this.streaming?.remove();
      this.streaming = null;
      const secs = Math.round((msg.duration_ms ?? 0) / 1000);
      const label: Record<string, string> = {
        success: `Concluído em ${secs}s`,
        error_during_execution: "Interrompido",
        error_max_turns: "Parou: limite de turnos",
        error_max_budget_usd: "Parou: limite de custo",
      };
      this.system(label[msg.subtype] ?? `Terminou: ${msg.subtype}`);
      this.setBusy(false);
    }
  }

  // ---------- Permissões, perguntas e plano (etapa 2) ----------

  private permissionCard(p: ChatEvent) {
    if (this.el.querySelector(`.perm[data-req="${CSS.escape(p.requestId)}"]`)) return;
    const d = document.createElement("div");
    d.className = "perm";
    d.dataset.req = p.requestId;
    if (p.toolName === "AskUserQuestion") d.innerHTML = this.questionHtml(p);
    else if (p.toolName === "ExitPlanMode") d.innerHTML = this.planHtml(p);
    else d.innerHTML = this.toolPermHtml(p);
    this.add(d);
  }

  private toolPermHtml(p: ChatEvent) {
    const title = p.title || `Claude quer usar ${p.displayName || p.toolName}`;
    const ops = editOps(p.toolName, p.input ?? {});
    // Bash: o comando inteiro, nunca só a descrição escrita pelo modelo.
    const detail = ops ? "" : p.toolName === "Bash" ? bashCommand(p.input?.command) : toolSummary(p.toolName, p.input, this.state?.cwd);
    const overwrite = p.toolName === "Write" ? `<div class="perm-desc">Grava o arquivo inteiro: se ele já existe, o conteúdo atual é substituído por este.</div>` : "";
    const file = ops ? toolSummary(p.toolName, p.input, this.state?.cwd) : "";
    return `
      <div class="perm-title">${icon("userCheck", 15)} ${esc(title)}</div>
      ${detail ? `<pre class="perm-detail">${esc(detail)}</pre>` : ""}
      ${ops ? `<div class="perm-file">${esc(file)}</div>${overwrite}${diffHtml(ops)}` : ""}
      ${p.description && p.description !== p.input?.file_path && p.description !== file ? `<div class="perm-desc">${esc(p.description)}</div>` : ""}
      <div class="perm-actions">
        <button class="primary" data-perm="allow">Permitir</button>
        ${p.canAlways ? `<button data-perm="always" title="Não perguntar de novo para ações como esta neste projeto">Sempre permitir</button>` : ""}
        <button class="danger" data-perm="deny">Negar…</button>
      </div>
      ${this.denyBox("O que o Claude deve fazer no lugar? (opcional)")}`;
  }

  private planHtml(p: ChatEvent) {
    const plan = typeof p.input?.plan === "string" ? p.input.plan : "";
    return `
      <div class="perm-title">${icon("check", 15)} Plano pronto para aprovação</div>
      ${plan ? `<div class="perm-plan md">${md(plan)}</div>` : ""}
      <div class="perm-actions">
        <button class="primary" data-perm="allow">Aprovar plano</button>
        <button data-perm="deny">Continuar planejando…</button>
      </div>
      ${this.denyBox("O que mudar no plano? (opcional)")}`;
  }

  private denyBox(placeholder: string) {
    return `<div class="deny-box" hidden>
        <textarea rows="2" placeholder="${esc(placeholder)}"></textarea>
        <div class="perm-actions"><button class="danger" data-perm="deny-send">Enviar</button><button data-perm="deny-cancel">Cancelar</button></div>
      </div>`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private questionHtml(p: ChatEvent) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qs: any[] = Array.isArray(p.input?.questions) ? p.input.questions : [];
    return `
      <div class="perm-title">${icon("message", 15)} ${qs.length > 1 ? "O Claude tem algumas perguntas" : "O Claude tem uma pergunta"}</div>
      ${qs
        .map(
          (q, qi) => `<fieldset class="q" data-q="${qi}" data-multi="${q.multiSelect ? 1 : 0}">
            <legend>${q.header ? `<span class="q-head">${esc(q.header)}</span>` : ""}${esc(q.question ?? "")}</legend>
            ${(q.options ?? [])
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .map((o: any, oi: number) => `<button class="q-opt" data-opt="${oi}">
                  <b>${esc(o.label ?? "")}</b>${o.description ? `<small>${esc(o.description)}</small>` : ""}</button>`)
              .join("")}
            <input class="q-other" placeholder="Outro (digite sua resposta)" />
            ${q.multiSelect ? `<small class="q-hint">Pode escolher mais de uma.</small>` : ""}
          </fieldset>`,
        )
        .join("")}
      <div class="perm-actions">
        <button class="primary" data-perm="answer">Enviar respostas</button>
        <button data-perm="deny">Pular…</button>
      </div>
      ${this.denyBox("Responder de outro jeito (opcional)")}`;
  }

  /** Marca/desmarca opção de uma pergunta (única: troca; múltipla: alterna). */
  private toggleOption(btn: HTMLElement) {
    const fs = btn.closest<HTMLElement>(".q")!;
    if (fs.dataset.multi !== "1") fs.querySelectorAll(".q-opt.on").forEach((b) => b !== btn && b.classList.remove("on"));
    btn.classList.toggle("on");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private collectAnswers(card: HTMLElement, p: ChatEvent): Record<string, any> | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qs: any[] = p.input?.questions ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answers: Record<string, any> = {};
    for (const fs of card.querySelectorAll<HTMLElement>(".q")) {
      const q = qs[Number(fs.dataset.q)];
      if (!q) continue;
      const other = fs.querySelector<HTMLInputElement>(".q-other")!.value.trim();
      const picked = [...fs.querySelectorAll<HTMLElement>(".q-opt.on")].map((b) => q.options[Number(b.dataset.opt)]?.label).filter(Boolean);
      const values = other ? [...picked, other] : picked;
      if (!values.length) {
        this.toast(`Responda: ${q.header || q.question}`);
        fs.querySelector<HTMLElement>(".q-opt")?.focus();
        return null;
      }
      // O campo `answers` é texto: múltiplas escolhas vão juntas, separadas por vírgula.
      answers[q.question] = values.join(", ");
    }
    return answers;
  }

  private async answerPermission(card: HTMLElement, choice: string) {
    const req = card.dataset.req!;
    const p = this.pendingReqs.get(req);
    if (!p) {
      // Sem o input original não dá para aprovar com segurança.
      this.toast("Este pedido não está mais pendente.");
      card.remove();
      return;
    }
    const box = card.querySelector<HTMLElement>(".deny-box");
    if (choice === "deny") {
      // Abre a caixa de motivo (opcional) antes de negar.
      if (box) {
        box.hidden = false;
        box.querySelector("textarea")?.focus();
      }
      return;
    }
    if (choice === "deny-cancel") {
      if (box) box.hidden = true;
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    if (choice === "deny-send") {
      const why = box?.querySelector("textarea")?.value.trim() ?? "";
      const base =
        p.toolName === "ExitPlanMode"
          ? "O usuário quer continuar planejando antes de executar."
          : p.toolName === "AskUserQuestion"
            ? "O usuário preferiu não responder às perguntas assim."
            : "O usuário negou esta ação.";
      result = { behavior: "deny", message: why ? `${base} Instrução do usuário: ${why}` : base };
    } else if (choice === "answer") {
      const answers = this.collectAnswers(card, p);
      if (!answers) return;
      result = { behavior: "allow", updatedInput: { ...p.input, questions: p.input.questions, answers } };
    } else {
      result = { behavior: "allow", updatedInput: p.input };
      if (choice === "always" && p.suggestions?.length) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const local = p.suggestions.filter((s: any) => s.destination === "localSettings");
        result.updatedPermissions = local.length ? local : p.suggestions;
      }
    }
    card.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await api.chatRespond(this.termId, req, result);
    } catch (e) {
      this.toast(`Falha ao responder: ${e}`);
      card.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }

  /** Mantém a lista de pedidos pendentes (para montar a resposta com o input original). */
  trackPending(e: ChatEvent) {
    if (e.ev === "permission") this.pendingReqs.set(e.requestId, e);
    if (e.ev === "permission_resolved") this.pendingReqs.delete(e.requestId);
    if (e.ev === "permission" || e.ev === "permission_resolved") this.setBusy(!!this.state?.busy);
  }

  // ---------- Ações ----------

  private async submit() {
    this.dictation?.cancel(); // enviar encerra o ditado (o que está no campo é o que vai)
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    this.autosize();
    try {
      await api.chatSend(this.termId, text);
    } catch (e) {
      this.toast(`Não foi possível enviar: ${e}`);
      this.input.value = text;
    }
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const opt = t.closest<HTMLElement>(".q-opt");
    if (opt) return this.toggleOption(opt);
    const perm = t.closest<HTMLElement>("[data-perm]");
    if (perm) return void this.answerPermission(perm.closest<HTMLElement>(".perm")!, perm.dataset.perm!);
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "mic") return this.dictation?.toggle();
    if (act === "send") return void this.submit();
    if (act === "stop") return void api.chatInterrupt(this.termId).catch((err) => this.toast(String(err)));
    if (act === "to-terminal") this.onBack();
    // O app do celular abre a folha de modos (mobile/convo.ts escuta este evento).
    if (act === "mode-chip") this.el.dispatchEvent(new CustomEvent("chat-mode-chip", { bubbles: true, detail: { termId: this.termId } }));
  }
}
