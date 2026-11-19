// Temas: tokens de CSS (em styles.css, por [data-theme]) + paleta do terminal.
import type { ITheme } from "@xterm/xterm";

export type ThemeId = "preto" | "grafite" | "claro";

export const THEMES: { id: ThemeId; label: string; desc: string }[] = [
  { id: "preto", label: "Preto", desc: "Fundo preto, contraste alto" },
  { id: "grafite", label: "Grafite", desc: "Cinza-escuro, mais suave" },
  { id: "claro", label: "Claro", desc: "Fundo branco" },
];

const ANSI_DARK = {
  black: "#27272a", red: "#f87171", green: "#4ade80", yellow: "#facc15",
  blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#d4d4d8",
  brightBlack: "#71717a", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde68a",
  brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#fafafa",
};

export const TERM_THEMES: Record<ThemeId, ITheme> = {
  preto: {
    ...ANSI_DARK,
    background: "#09090b",
    foreground: "#e4e4e7",
    cursor: "#e4e4e7",
    cursorAccent: "#09090b",
    selectionBackground: "#3b3b52",
    scrollbarSliderBackground: "#ffffff14",
    scrollbarSliderHoverBackground: "#ffffff26",
    scrollbarSliderActiveBackground: "#ffffff33",
  },
  grafite: {
    ...ANSI_DARK,
    background: "#18181b",
    foreground: "#e4e4e7",
    cursor: "#e4e4e7",
    cursorAccent: "#18181b",
    selectionBackground: "#3f3f5a",
    scrollbarSliderBackground: "#ffffff14",
    scrollbarSliderHoverBackground: "#ffffff26",
    scrollbarSliderActiveBackground: "#ffffff33",
  },
  claro: {
    background: "#ffffff",
    foreground: "#27272a",
    cursor: "#27272a",
    cursorAccent: "#ffffff",
    selectionBackground: "#c7d2fe",
    black: "#27272a", red: "#dc2626", green: "#16a34a", yellow: "#b45309",
    blue: "#2563eb", magenta: "#9333ea", cyan: "#0891b2", white: "#a1a1aa",
    brightBlack: "#71717a", brightRed: "#ef4444", brightGreen: "#22c55e", brightYellow: "#ca8a04",
    brightBlue: "#3b82f6", brightMagenta: "#a855f7", brightCyan: "#06b6d4", brightWhite: "#3f3f46",
    scrollbarSliderBackground: "#0000001a",
    scrollbarSliderHoverBackground: "#0000002e",
    scrollbarSliderActiveBackground: "#0000003d",
  },
};

export const TERM_FONTS: { id: string; label: string; css: string }[] = [
  { id: "ubuntu", label: "Ubuntu Mono", css: '"Ubuntu Mono", "DejaVu Sans Mono", monospace' },
  { id: "jetbrains", label: "JetBrains Mono", css: '"JetBrains Mono", "DejaVu Sans Mono", monospace' },
  { id: "dejavu", label: "DejaVu Sans Mono", css: '"DejaVu Sans Mono", monospace' },
];

export function fontCss(id: string) {
  return (TERM_FONTS.find((f) => f.id === id) ?? TERM_FONTS[0]).css;
}

export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id;
}
