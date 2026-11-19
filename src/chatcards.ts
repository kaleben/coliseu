// Cartões ricos do modo chat (etapa 3 — docs/CHAT_SPEC.md §9): diff de
// edições, saída de comando com cores ANSI e lista de tarefas.

import { esc } from "./labels";

// ---------- Diff de linhas ----------

/** "~" separa trechos independentes (as edições de um MultiEdit). */
type Op = ["=" | "-" | "+" | "~", string];

const MAX_LCS = 600;

/** Diff de linhas por LCS; acima do limite, tudo removido + tudo adicionado. */
export function lineDiff(a: string, b: string): Op[] {
  // "a\nb\n" são 2 linhas, não 3 — mas só quando o "\n" final não é a própria
  // mudança (os dois lados terminam com ele, ou um lado é vazio).
  const trim = (a === "" || a.endsWith("\n")) && (b === "" || b.endsWith("\n"));
  const lines = (t: string) => (t === "" ? [] : (trim ? t.replace(/\n$/, "") : t).split("\n"));
  const x = lines(a);
  const y = lines(b);
  // Prefixo e sufixo iguais saem de graça (o caso comum de uma edição pequena).
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xm = x.slice(pre, x.length - suf);
  const ym = y.slice(pre, y.length - suf);
  const mid: Op[] = [];
  if (xm.length > MAX_LCS || ym.length > MAX_LCS) {
    for (const l of xm) mid.push(["-", l]);
    for (const l of ym) mid.push(["+", l]);
  } else {
    const n = xm.length;
    const m = ym.length;
    // dp[i][j] = LCS de xm[i..] e ym[j..]
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) dp[i][j] = xm[i] === ym[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xm[i] === ym[j]) {
        mid.push(["=", xm[i]]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) mid.push(["-", xm[i++]]);
      else mid.push(["+", ym[j++]]);
    }
    while (i < n) mid.push(["-", xm[i++]]);
    while (j < m) mid.push(["+", ym[j++]]);
  }
  return [...x.slice(0, pre).map((l): Op => ["=", l]), ...mid, ...y.slice(y.length - suf).map((l): Op => ["=", l])];
}

export function diffStats(ops: Op[]) {
  let add = 0;
  let del = 0;
  for (const [o] of ops) {
    if (o === "+") add++;
    else if (o === "-") del++;
  }
  return { add, del };
}

const CONTEXT = 3;
const MAX_ROWS = 200;

/** Linhas do diff em HTML; contexto longo entre mudanças vira "⋯". */
export function diffHtml(ops: Op[]) {
  const keep = ops.map(() => false);
  ops.forEach(([o], i) => {
    if (o === "=" || o === "~") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) keep[k] = true;
  });
  const rows: string[] = [];
  let gap = false;
  const shown = keep.filter((k, i) => k && ops[i][0] !== "~").length;
  let count = 0;
  for (let i = 0; i < ops.length; i++) {
    if (ops[i][0] === "~") {
      if (rows.length) gap = true;
      continue;
    }
    if (!keep[i]) {
      gap = true;
      continue;
    }
    if (count >= MAX_ROWS) {
      rows.push(`<div class="dl gap">… (mais ${shown - count} linhas)</div>`);
      break;
    }
    if (gap && rows.length) rows.push(`<div class="dl gap">⋯</div>`);
    gap = false;
    count++;
    const [o, l] = ops[i];
    const cls = o === "+" ? "add" : o === "-" ? "del" : "ctx";
    rows.push(`<div class="dl ${cls}"><span class="dm">${o === "=" ? " " : o === "-" ? "−" : "+"}</span>${esc(l) || " "}</div>`);
  }
  return `<div class="diff">${rows.join("")}</div>`;
}

/** Edições de Edit / MultiEdit / Write → diff (null se o input não é de edição). */
export function editOps(name: string, input: Record<string, unknown>): Op[] | null {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  if (name === "Edit") return lineDiff(s(input.old_string), s(input.new_string));
  if (name === "MultiEdit" && Array.isArray(input.edits)) {
    const ops: Op[] = [];
    input.edits.forEach((e: Record<string, unknown>, k: number) => {
      if (k) ops.push(["~", ""]);
      ops.push(...lineDiff(s(e.old_string), s(e.new_string)));
    });
    return ops;
  }
  if (name === "Write") return lineDiff("", s(input.content));
  return null;
}

// ---------- Cores ANSI ----------

const BASE16 = [
  "#3b3b3b", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d0d0d0",
  "#7f7f7f", "#ff7b86", "#b5e890", "#ffd88a", "#82c4ff", "#e19cf0", "#7fd8e3", "#ffffff",
];

function color256(n: number) {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const v = [0, 95, 135, 175, 215, 255];
    const k = n - 16;
    return `rgb(${v[Math.floor(k / 36)]},${v[Math.floor(k / 6) % 6]},${v[k % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

/** Texto com sequências SGR → HTML com cores (as demais sequências somem). */
export function ansiHtml(text: string) {
  if (!text.includes("\x1b")) return esc(text);
  let fg: string | null = null;
  let bg: string | null = null;
  let bold = false;
  let dim = false;
  let under = false;
  let out = "";
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;
  let last = 0;
  const flush = (chunk: string) => {
    if (!chunk) return;
    const st = [fg && `color:${fg}`, bg && `background:${bg}`, bold && "font-weight:600", dim && "opacity:.65", under && "text-decoration:underline"].filter(Boolean);
    out += st.length ? `<span style="${st.join(";")}">${esc(chunk)}</span>` : esc(chunk);
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    flush(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] === undefined) continue; // não é SGR
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) [fg, bg, bold, dim, under] = [null, null, false, false, false];
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 4) under = true;
      else if (c === 22) bold = dim = false;
      else if (c === 24) under = false;
      else if (c >= 30 && c <= 37) fg = BASE16[c - 30];
      else if (c >= 90 && c <= 97) fg = BASE16[c - 82];
      else if (c >= 40 && c <= 47) bg = BASE16[c - 40];
      else if (c >= 100 && c <= 107) bg = BASE16[c - 92];
      else if (c === 39) fg = null;
      else if (c === 49) bg = null;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        const col = color256(codes[i + 2] ?? 0);
        if (c === 38) fg = col;
        else bg = col;
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const col = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
        if (c === 38) fg = col;
        else bg = col;
        i += 4;
      }
    }
  }
  flush(text.slice(last));
  return out;
}

// ---------- Tarefas ----------

/** `old`: de uma lista anterior já concluída — fora do painel, mas ainda atualizável. */
export type Task = { id: string; subject: string; status: string; activeForm?: string; old?: boolean };

/**
 * Lista de tarefas do Claude, montada a partir das ferramentas:
 * TodoWrite (lista inteira) ou TaskCreate (id no resultado "Task #N") + TaskUpdate.
 */
export class TaskBoard {
  tasks: Task[] = [];
  /** tool_use_id do TaskCreate → tarefa provisória (o id vem no resultado). */
  private creating = new Map<string, Task>();

  /** true se a ferramenta é de tarefas (a linha na conversa fica discreta). */
  static isTaskTool(name: string) {
    return name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate";
  }

  onUse(id: string, name: string, input: Record<string, unknown>) {
    if (name === "TodoWrite" && Array.isArray(input.todos)) {
      this.tasks = input.todos.map((t: Record<string, unknown>, i: number) => ({
        id: String(i + 1),
        subject: String(t.content ?? ""),
        status: String(t.status ?? "pending"),
        activeForm: typeof t.activeForm === "string" ? t.activeForm : undefined,
      }));
    } else if (name === "TaskCreate") {
      // Lista anterior toda concluída: esta tarefa começa uma lista nova (as
      // antigas saem do painel, mas um TaskUpdate ainda pode reabri-las).
      if (this.visible.length && this.done === this.visible.length) for (const t of this.visible) t.old = true;
      const t: Task = {
        id: "",
        subject: String(input.subject ?? ""),
        status: "pending",
        activeForm: typeof input.activeForm === "string" ? input.activeForm : undefined,
      };
      this.creating.set(id, t);
      this.tasks.push(t);
    } else if (name === "TaskUpdate") {
      // Ids podem se repetir entre listas: a lista atual tem prioridade, depois a antiga mais recente.
      const id = String(input.taskId ?? "");
      const t = this.visible.find((x) => x.id === id) ?? [...this.tasks].reverse().find((x) => x.id === id);
      if (!t) return;
      if (input.status === "deleted") this.tasks = this.tasks.filter((x) => x !== t);
      else if (typeof input.status === "string") {
        t.status = input.status;
        if (t.status !== "completed") t.old = false;
      }
      if (typeof input.subject === "string") t.subject = input.subject;
      if (typeof input.activeForm === "string") t.activeForm = input.activeForm;
    }
  }

  onResult(toolUseId: string, text: string, isError: boolean) {
    const t = this.creating.get(toolUseId);
    if (!t) return;
    this.creating.delete(toolUseId);
    const m = /Task #(\w+)/.exec(text);
    if (isError || !m) this.tasks = this.tasks.filter((x) => x !== t);
    else t.id = m[1];
  }

  /** Tarefas da lista atual (as que aparecem no painel). */
  get visible() {
    return this.tasks.filter((t) => !t.old);
  }

  get done() {
    return this.visible.filter((t) => t.status === "completed").length;
  }

  get current() {
    return this.visible.find((t) => t.status === "in_progress");
  }
}
