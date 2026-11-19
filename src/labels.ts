// Rótulos, listas e utilidades compartilhados entre o desktop (main.ts) e o app no celular.

/** Texto → HTML seguro. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Comandos que são "o shell parado" (não um programa rodando). */
export const SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash"]);

/** Por que o Claude está esperando (campo waitingFor da sessão). */
export const WAITING_LABEL: Record<string, string> = {
  "input needed": "precisa de resposta",
  "dialog open": "diálogo aberto",
  "sandbox request": "pedido de permissão",
  "worker request": "pedido de worker",
  "goal proposal": "proposta de objetivo",
};

/** "821k", "1M", "45k" */
export function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Uso do contexto: porcentagem e nível (para a cor: ok < 70% ≤ warn < 85% ≤ hi). */
export function contextLevel(c: { used: number; window: number }) {
  const pct = Math.min(100, Math.round((c.used / Math.max(1, c.window)) * 100));
  return { pct, level: pct >= 85 ? "hi" : pct >= 70 ? "warn" : "ok" };
}
