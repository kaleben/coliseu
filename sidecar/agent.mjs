// Coliseu — processo auxiliar do modo chat.
//
// Roda o Claude Code pelo Agent SDK (um `query()` por chat) e conversa com o
// core (Rust) por stdin/stdout: um objeto JSON por linha. Protocolo em
// docs/CHAT_SPEC.md §4. Nada aqui imprime em stdout além do protocolo
// (logs vão para stderr).

import { query, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID, createHash } from "node:crypto";
import { readdirSync, existsSync, openSync, readSync, fstatSync, closeSync, statSync, createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

/** chatId → { input, pending, q, abort, sessionId, busy } */
const chats = new Map();

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const log = (...a) => process.stderr.write(`[agent] ${a.join(" ")}\n`);

/** Fila de mensagens do usuário (modo streaming input do SDK). */
class InputQueue {
  items = [];
  waiters = [];
  closed = false;
  push(msg) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
    };
  }
}

function setBusy(chatId, chat, busy) {
  if (chat.busy === busy) return;
  chat.busy = busy;
  out({ chatId, ev: "state", busy });
}

/** Deltas de texto/raciocínio: só o necessário para a UI escrever em tempo real. */
function compactStreamEvent(chatId, msg) {
  const e = msg.event;
  if (e?.type !== "content_block_delta" || msg.parent_tool_use_id) return;
  if (e.delta?.type === "text_delta") out({ chatId, ev: "delta", kind: "text", index: e.index, text: e.delta.text });
  else if (e.delta?.type === "thinking_delta") out({ chatId, ev: "delta", kind: "thinking", index: e.index, text: e.delta.thinking });
}

async function start(cmd) {
  const { chatId } = cmd;
  if (chats.has(chatId)) {
    // Não é "closed": o chat que já existe continua vivo.
    out({ chatId, ev: "error", error: "chat já está aberto" });
    return;
  }
  const chat = {
    input: new InputQueue(),
    pending: new Map(), // requestId → resolve
    q: null,
    abort: new AbortController(),
    sessionId: cmd.resume || null,
    busy: false,
    reports: { file: null, offset: 0, sent: new Set() },
  };
  chats.set(chatId, chat);
  // Sessão retomada: relatórios antigos vêm pelo histórico; lê só o que for novo.
  try {
    const f = cmd.resume ? transcriptFile(cmd.resume) : null;
    if (f) Object.assign(chat.reports, { file: f, offset: statSync(f).size });
  } catch {
    /* sem arquivo ainda */
  }

  /** Pedido de permissão / pergunta: vai para a UI e espera a resposta. */
  const canUseTool = (toolName, input, opts) =>
    new Promise((resolve) => {
      const requestId = opts.toolUseID || randomUUID();
      chat.pending.set(requestId, resolve);
      opts.signal?.addEventListener(
        "abort",
        () => {
          if (chat.pending.delete(requestId)) {
            out({ chatId, ev: "permission_resolved", requestId });
            resolve({ behavior: "deny", message: "Interrompido pelo usuário" });
          }
        },
        { once: true },
      );
      out({
        chatId,
        ev: "permission",
        requestId,
        toolName,
        input,
        title: opts.title ?? null,
        displayName: opts.displayName ?? null,
        description: opts.description ?? null,
        decisionReason: opts.decisionReason ?? null,
        canAlways: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
        suggestions: opts.suggestions ?? [],
        defaultToNo: !!opts.defaultToNo,
        agentId: opts.agentID ?? null,
      });
    });

  try {
    const q = query({
      prompt: chat.input,
      options: {
        cwd: cmd.cwd,
        resume: cmd.resume || undefined,
        env: { ...process.env, ...(cmd.env ?? {}) },
        pathToClaudeCodeExecutable: cmd.claudePath || undefined,
        // Sem opção explícita no terminal: vale o defaultMode das configurações.
        ...(cmd.permissionMode ? { permissionMode: cmd.permissionMode } : {}),
        // Mesmas opções do `claude` do terminal (--model, --add-dir, …).
        ...(cmd.claudeOptions ?? {}),
        allowDangerouslySkipPermissions: !!cmd.allowBypass,
        includePartialMessages: true,
        // Mesmas configurações/skills/plugins/hooks do terminal.
        settingSources: ["user", "project", "local"],
        canUseTool,
        abortController: chat.abort,
        stderr: (d) => process.stderr.write(`[${chatId}] ${d}`),
      },
    });
    chat.q = q;
    // Relatório gravado com o chat parado também chega (leitura incremental, barata).
    chat.reportTimer = setInterval(() => scanAgentReports(chatId, chat), 2000);
    out({ chatId, ev: "started", sessionId: chat.sessionId });
    for await (const msg of q) {
      if (msg.session_id && msg.session_id !== chat.sessionId) {
        chat.sessionId = msg.session_id;
        Object.assign(chat.reports, { file: null, offset: 0 });
        out({ chatId, ev: "session", sessionId: msg.session_id });
      }
      if (msg.type === "stream_event") {
        compactStreamEvent(chatId, msg);
        continue;
      }
      if (msg.type === "result") setBusy(chatId, chat, false);
      // Relatório de subagente entregue como <agent-message> (não vem no stream):
      // lê o que foi acrescentado ao arquivo da sessão (incremental). Além do
      // timer do chat, confere já nas mensagens que não são texto do modelo.
      if (!msg.parent_tool_use_id && msg.type !== "assistant") scanAgentReports(chatId, chat);
      if (msg.type === "system" && (msg.subtype === "init" || msg.subtype === "status") && msg.permissionMode) {
        out({ chatId, ev: "mode", mode: msg.permissionMode });
      }
      out({ chatId, ev: "message", msg });
    }
    out({ chatId, ev: "closed", error: null });
  } catch (e) {
    const aborted = chat.abort.signal.aborted;
    out({ chatId, ev: "closed", error: aborted ? null : String(e?.message ?? e) });
  } finally {
    clearInterval(chat.reportTimer);
    for (const resolve of chat.pending.values()) resolve({ behavior: "deny", message: "Chat encerrado" });
    chats.delete(chatId);
  }
}

function send(cmd) {
  const chat = chats.get(cmd.chatId);
  if (!chat) return out({ chatId: cmd.chatId, ev: "closed", error: "chat não está aberto" });
  chat.input.push({
    type: "user",
    message: { role: "user", content: cmd.text },
    parent_tool_use_id: null,
  });
  setBusy(cmd.chatId, chat, true);
}

function respond(cmd) {
  const chat = chats.get(cmd.chatId);
  const resolve = chat?.pending.get(cmd.requestId);
  if (!resolve) return;
  chat.pending.delete(cmd.requestId);
  resolve(cmd.result);
  out({ chatId: cmd.chatId, ev: "permission_resolved", requestId: cmd.requestId });
}

async function interrupt(cmd) {
  const chat = chats.get(cmd.chatId);
  try {
    await chat?.q?.interrupt();
  } catch (e) {
    log("interrupt:", e?.message ?? e);
  }
}

async function setMode(cmd) {
  const chat = chats.get(cmd.chatId);
  try {
    await chat?.q?.setPermissionMode(cmd.mode);
    out({ chatId: cmd.chatId, ev: "mode", mode: cmd.mode });
  } catch (e) {
    out({ chatId: cmd.chatId, ev: "error", error: String(e?.message ?? e) });
  }
}

/** Fecha o chat: termina a entrada; se não sair em 5 s, aborta (mata o processo do Claude). */
async function close(cmd) {
  const chat = chats.get(cmd.chatId);
  if (!chat) return out({ chatId: cmd.chatId, ev: "closed", error: null });
  // O timer vem antes de tudo: nada aqui pode impedir o aborto.
  setTimeout(() => {
    if (chats.get(cmd.chatId) === chat) chat.abort.abort();
  }, 5000);
  if (chat.busy) {
    // interrupt() pode nunca responder (ferramenta travada): no máx. 2 s.
    await Promise.race([interrupt(cmd), new Promise((r) => setTimeout(r, 2000))]);
  }
  chat.input.close();
}

/**
 * Resultados estruturados de Agent gravados no arquivo da sessão (`toolUseResult`:
 * status async_launched/completed + relatório limpo). getSessionMessages não os
 * devolve; ao vivo o SDK manda o mesmo dado em `tool_use_result`. Leitura em
 * fluxo (não trava os outros chats com um arquivo grande).
 */
async function agentResults(sessionId) {
  const map = new Map();
  try {
    const f = transcriptFile(sessionId);
    if (f) {
      const lines = readline.createInterface({ input: createReadStream(f, "utf8"), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.includes('"toolUseResult"') || !/"agentId"|_launched"/.test(line)) continue;
        try {
          const e = JSON.parse(line);
          const r = e.toolUseResult;
          if (e.uuid && r && typeof r === "object" && (r.agentId || r.status)) map.set(e.uuid, { status: r.status, isAsync: !!r.isAsync, content: r.content, agentId: r.agentId });
        } catch {
          /* linha inválida */
        }
      }
    }
  } catch (e) {
    log("agentResults:", e?.message ?? e);
  }
  return map;
}

function transcriptFile(sessionId) {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  for (const dir of readdirSync(root)) {
    const f = join(root, dir, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

const OPEN = '<agent-message from="';
const CLOSE = "\n</agent-message>";

/**
 * Relatórios entregues como mensagem: o texto COMEÇA com <agent-message from="id">
 * (às vezes depois de uma introdução curta) e pode trazer várias em sequência;
 * depois do fechamento o Claude Code pode acrescentar uma explicação.
 * O Claude Code recua todas as linhas do relatório, então o fechamento de
 * verdade é o "</agent-message>" no início de uma linha — uma citação da tag
 * no relatório não engana. `strict` (turno de usuário): exige a introdução
 * "… sent a message" ou o cabeçalho [Subagent hand-back], para não confundir
 * com algo colado pelo usuário.
 */
function parseAgentMessages(text, strict = false) {
  text = String(text ?? "");
  const head = /^\s*([^\n<]{0,80}?)\s*(?=<agent-message from=")/.exec(text);
  if (!head) return [];
  const out = [];
  let pos = head[0].length;
  while (text.startsWith(OPEN, pos)) {
    const idEnd = text.indexOf('">', pos + OPEN.length);
    if (idEnd < 0) break;
    const agentId = text.slice(pos + OPEN.length, idEnd).split('"')[0];
    const bodyStart = idEnd + 2;
    // Fechamento no início de linha; se não houver, o último da mesma linha.
    let close = text.indexOf(CLOSE, bodyStart);
    let closeLen = CLOSE.length;
    if (close < 0) {
      close = text.lastIndexOf(CLOSE.slice(1));
      closeLen = CLOSE.length - 1;
      if (close < bodyStart) close = -1;
    }
    const body = text.slice(bodyStart, close >= 0 ? close : undefined);
    if (!strict || /sent a message/i.test(head[1]) || /^\s*\[Subagent hand-back\]/.test(body)) out.push({ agentId, text: body });
    if (close < 0) break;
    pos = close + closeLen;
    while (/\s/.test(text[pos] ?? "")) pos++;
  }
  return out;
}

/** Textos de uma mensagem de usuário (string ou blocos de texto). */
const userTexts = (content) =>
  typeof content === "string" ? [content] : Array.isArray(content) ? content.filter((b) => b?.type === "text" && b.text).map((b) => b.text) : [];

/**
 * O Claude Code entrega o relatório de alguns subagentes como uma mensagem
 * enfileirada (<agent-message from="id">) que o SDK não repassa. Lê só o que
 * foi acrescentado ao arquivo da sessão desde a última leitura.
 */
function scanAgentReports(chatId, chat) {
  const r = chat.reports;
  try {
    if (!chat.sessionId) return;
    if (!r.file) {
      // Arquivo ainda não existe: não varre ~/.claude/projects a cada 2 s.
      if (Date.now() - (r.missAt ?? 0) < 10000) return;
      r.file = transcriptFile(chat.sessionId);
      if (!r.file) {
        r.missAt = Date.now();
        return;
      }
      r.offset = 0;
    }
    const fd = openSync(r.file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= r.offset) return;
      const buf = Buffer.alloc(size - r.offset);
      readSync(fd, buf, 0, buf.length, r.offset);
      // Só até a última linha completa.
      const end = buf.lastIndexOf(10);
      if (end < 0) return;
      r.offset += end + 1;
      for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.includes("agent-message from=")) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        // Mensagem enfileirada (attachment queued_command) ou entregue como turno
        // do usuário ("Another Claude session sent a message: …").
        const reps =
          e.attachment?.type === "queued_command"
            ? parseAgentMessages(e.attachment.prompt)
            : e.type === "user"
              ? userTexts(e.message?.content).flatMap((t) => parseAgentMessages(t, true))
              : [];
        for (const rep of reps) {
          // Um 2º relatório do mesmo agente (continuado com SendMessage) é outro.
          const key = createHash("sha1").update(`${rep.agentId}\0${rep.text}`).digest("hex");
          if (r.sent.has(key)) continue;
          r.sent.add(key);
          out({ chatId, ev: "agent_report", ...rep });
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    log("scanAgentReports:", e?.message ?? e);
  }
}

async function history(cmd) {
  try {
    const all = await getSessionMessages(cmd.sessionId, cmd.cwd ? { dir: cmd.cwd } : undefined);
    const limit = cmd.limit ?? 300;
    const messages = all.slice(-limit);
    const results = await agentResults(cmd.sessionId);
    for (const m of messages) {
      if (results.has(m.uuid)) m.tool_use_result = results.get(m.uuid);
      // Relatório entregue como mensagem: vai já interpretado (a UI não reinterpreta).
      if (m.type === "user") {
        const reps = userTexts(m.message?.content).flatMap((t) => parseAgentMessages(t, true));
        if (reps.length) m.agent_reports = reps;
      }
    }
    out({ reqId: cmd.reqId, ev: "history", messages });
  } catch (e) {
    out({ reqId: cmd.reqId, ev: "history", messages: [], error: String(e?.message ?? e) });
  }
}

const OPS = { start, send, respond, interrupt, mode: setMode, close, history };

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return log("linha inválida:", line.slice(0, 200));
  }
  const fn = OPS[cmd.op];
  if (!fn) return log("op desconhecida:", cmd.op);
  Promise.resolve(fn(cmd)).catch((e) => log(cmd.op, "falhou:", e?.stack ?? e));
});

// O core fechou o stdin (app fechou): encerra todos os chats.
process.stdin.on("end", () => {
  for (const chat of chats.values()) chat.abort.abort();
  setTimeout(() => process.exit(0), 500);
});

out({ ev: "ready" });
