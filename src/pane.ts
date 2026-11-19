// Um painel = um xterm.js ligado a uma sessão tmux.
import { Terminal as XTerm, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { api } from "./transport";
import { icon } from "./icons";

/** Aparência atual dos terminais (tema, fonte, tamanho). */
export interface Look {
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
}

let look: Look = { theme: {}, fontFamily: "monospace", fontSize: 15 };

/** Transforma o que o usuário digita (ex.: Ctrl "travado" da barra de teclas do celular). */
let inputFilter: (d: string) => string = (d) => d;
export function setInputFilter(fn: (d: string) => string) {
  inputFilter = fn;
}
const all = new Set<Pane>();

/** Aplica tema/fonte em todos os terminais abertos e nos próximos. */
export function setLook(next: Look) {
  look = next;
  for (const p of all) {
    p.term.options.theme = look.theme;
    p.term.options.fontFamily = look.fontFamily;
    p.term.options.fontSize = look.fontSize;
    p.fitNow();
  }
}

export type KeyHandler = (e: KeyboardEvent) => boolean; // true = consumido pelo app

/** keyCode para reenviar ao xterm uma tecla engolida pela composição (0 = não reenviar). */
const REPLAY_KEYS: Record<string, number> = {
  Enter: 13, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Delete: 46,
};
function replayKeyCode(k: KeyboardEvent) {
  if (REPLAY_KEYS[k.key]) return REPLAY_KEYS[k.key];
  // Ctrl/Alt + letra ou número (Ctrl+C, Alt+B…): o código vem do "code" (KeyC → 67).
  if (k.ctrlKey || k.altKey || k.metaKey) {
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(k.code);
    if (m) return (m[1] ?? m[2]).charCodeAt(0);
  }
  return 0;
}

export class Pane {
  readonly el: HTMLDivElement;
  readonly term: XTerm;
  private fit = new FitAddon();
  private search = new SearchAddon();
  private searchBar?: HTMLDivElement;
  private lastClaim = 0;
  private attached = false;
  private resizeTimer = 0;
  private ro: ResizeObserver;

  constructor(readonly id: string, private onKey: KeyHandler, onFocus: () => void) {
    this.el = document.createElement("div");
    this.el.className = "pane";
    this.el.dataset.id = id;

    this.term = new XTerm({
      fontFamily: look.fontFamily,
      fontSize: look.fontSize,
      lineHeight: 1.1,
      scrollback: 50000,
      cursorBlink: true,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: look.theme,
    });
    all.add(this);
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(new WebLinksAddon((_e, uri) => api.openUrl(uri)));

    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (onKey(e)) {
        e.preventDefault();
        return false;
      }
      // Shift+Enter → nova linha no Claude Code / Codex (Meta+Enter).
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey) {
        api.termInput(this.id, "\x1b\r");
        e.preventDefault();
        return false;
      }
      return true;
    });
    this.term.onData((d) => {
      api.termInput(this.id, inputFilter(d));
      // No celular, digitar também reassume o tamanho (no máx. a cada 2s).
      if (!api.native && Date.now() - this.lastClaim > 2000) {
        this.lastClaim = Date.now();
        this.claim();
      }
    });
    if (!api.native) this.enableTouchScroll();
    this.term.onBinary((d) => api.termInput(this.id, d));
    this.el.addEventListener("focusin", onFocus);
    this.el.addEventListener("mousedown", onFocus);
    // Quem toca/clica/foca o terminal assume o tamanho dele (desktop ↔ celular).
    const claim = () => this.claim();
    this.el.addEventListener("focusin", claim);
    this.el.addEventListener("pointerdown", claim);
    this.el.addEventListener("touchstart", claim, { passive: true });

    this.ro = new ResizeObserver(() => this.scheduleFit());
  }

  /**
   * Acentos por tecla morta (´ + e = é) no WebKitGTK (Linux). Lá cada acento
   * vira duas composições e toda tecla do meio chega como keydown 229; a cada
   * 229 o xterm.js compara o campo interno e manda a diferença, o que vazava
   * acentos repetidos, "´", espaço não separável e espaços ("você está" virava
   * "você eê ŝtaá"). Aqui a composição é tratada antes do xterm (captura no
   * elemento pai): o texto composto entra como digitação normal e o campo é limpo.
   */
  private fixComposition() {
    const ta = this.term.textarea;
    if (!ta) return;
    let composing = false;
    /** Reenviando uma tecla para o xterm (não passa pelo filtro abaixo). */
    let replaying = false;
    let lastComposed = "";
    /** Hora do último keydown engolido (229) e teclas cujo keydown o xterm viu. */
    let lastSwallowAt = 0;
    /** Hora da última tecla normal (que o xterm processa sozinho). */
    let lastRealDownAt = 0;
    const seenDown = new Set<string>();
    /** Hora em que cada modificador foi solto (para saber se valia na tecla engolida). */
    const modUpAt: Record<string, number> = { Shift: 0, Control: 0, Alt: 0, Meta: 0 };
    const isMod = (key: string) => key in modUpAt;

    const on = (type: string, fn: (e: Event) => void) =>
      this.el.addEventListener(type, (e) => e.target === ta && fn(e), true);

    on("compositionstart", (e) => {
      composing = true;
      e.stopImmediatePropagation();
    });
    on("compositionupdate", (e) => e.stopImmediatePropagation());
    on("compositionend", (e) => {
      e.stopImmediatePropagation();
      composing = false;
      const d = (e as CompositionEvent).data;
      // Pelo xterm (term.input): rola para o fim, limpa a seleção etc., como digitar.
      if (d) this.term.input(d, true);
      lastComposed = d ?? "";
      ta.value = "";
    });
    on("keydown", (e) => {
      if (replaying) return;
      const k = e as KeyboardEvent;
      if (k.keyCode === 229) {
        lastSwallowAt = performance.now();
        e.stopImmediatePropagation();
        return;
      }
      seenDown.add(k.code);
      if (isMod(k.key)) return; // Ctrl/Shift sozinhos não dizem nada sobre a composição
      // Durante a composição o WebKitGTK manda toda tecla como 229. Uma tecla com o
      // código real quer dizer que a composição acabou (às vezes ele a abandona sem
      // compositionend, ex.: acento + Ctrl+C) — então não fica nada preso.
      composing = false;
      lastComposed = "";
      // Não zera a sequência engolida: na digitação rápida a próxima letra desce antes
      // de o Enter engolido subir, e ele ainda precisa ser reenviado.
      lastRealDownAt = performance.now();
    });
    // Enter/Tab/Esc/setas/Ctrl+… logo depois de uma tecla morta chegam como 229,
    // sem dizer qual tecla: só o keyup traz a tecla real. Ela é reenviada ao
    // próprio xterm como keydown — modificadores, Shift+Enter e atalhos do app
    // seguem o caminho normal. Backspace fica de fora: depois do acento ele só
    // cancela o acento, como no GTK. Teclas imprimíveis sem Ctrl/Alt já vieram
    // no texto composto.
    on("keyup", (e) => {
      const k = e as KeyboardEvent;
      if (isMod(k.key)) {
        modUpAt[k.key] = performance.now();
        seenDown.delete(k.code);
        return;
      }
      // O xterm já viu o keydown desta tecla (digitação rápida sobrepondo teclas).
      if (seenDown.delete(k.code) || !lastSwallowAt) return;
      // Modificador vale se está no evento ou foi solto depois do keydown engolido
      // (o keyup do Shift pode chegar antes do Enter). Um Shift solto antes — o do
      // próprio acento, como em " e ^ — não conta.
      const held = (mod: string, flag: boolean) => flag || modUpAt[mod] > lastSwallowAt;
      const m = {
        shiftKey: held("Shift", k.shiftKey),
        ctrlKey: held("Control", k.ctrlKey),
        altKey: held("Alt", k.altKey),
        metaKey: held("Meta", k.metaKey),
      };
      const code = replayKeyCode({ ...m, key: k.key, code: k.code } as KeyboardEvent);
      // A tecla do acento e as letras compostas não são reenviadas (e não encerram a
      // sequência: com Ctrl o GTK nem manda keydown da tecla seguinte).
      if (!code) return;
      // Uma sequência engolida, um reenvio — exceto com o acento ainda pendente (com
      // Ctrl o GTK não manda keydown nenhum: um 2º Ctrl+C seguido também vale).
      if (!composing) lastSwallowAt = 0;
      // Sem bubbles: o atalho do documento (handleKey) não roda duas vezes — o xterm
      // já chama o mesmo handler pelo attachCustomKeyEventHandler.
      const ev = new KeyboardEvent("keydown", { ...m, key: k.key, code: k.code, bubbles: false, cancelable: true });
      Object.defineProperty(ev, "keyCode", { get: () => code });
      Object.defineProperty(ev, "which", { get: () => code });
      // Com Ctrl/Alt o GTK deixa o acento pendente (a composição continua). Um keydown
      // sintético nesse estado trava o método de entrada do WebKitGTK (os acentos
      // seguintes somem): primeiro os atalhos do app (Ctrl+Shift+C…), senão só o
      // caractere de controle (Ctrl+C → \x03); o acento segue pendente, como antes.
      if (composing) {
        if (this.onKey(ev)) return;
        const letter = code >= 65 && code <= 90;
        if (m.ctrlKey && !m.shiftKey && letter) this.term.input(String.fromCharCode(code - 64), true);
        else if (m.altKey && !m.ctrlKey && (letter || (code >= 48 && code <= 57)))
          this.term.input(`\x1b${m.shiftKey ? String.fromCharCode(code) : String.fromCharCode(code).toLowerCase()}`, true);
        return;
      }
      replaying = true;
      try {
        ta.dispatchEvent(ev);
      } finally {
        replaying = false;
      }
    });
    on("input", (e) => {
      const ie = e as InputEvent;
      if (composing || ie.isComposing) {
        e.stopImmediatePropagation();
        return;
      }
      // Texto entregue fora da composição atrás de uma tecla engolida: o xterm não
      // manda (achou que não houve tecla). A repetição imediata do texto recém-composto
      // é eco (só uma vez).
      if (lastSwallowAt > lastRealDownAt && ie.inputType === "insertText" && ie.data) {
        e.stopImmediatePropagation();
        if (ie.data !== lastComposed) this.term.input(ie.data, true);
        lastComposed = "";
        ta.value = "";
      }
    });
    // Composição cancelada sem compositionend (troca de janela/painel): não fica presa.
    on("focusout", () => {
      composing = false;
      lastSwallowAt = 0;
      lastComposed = "";
      seenDown.clear();
      ta.value = "";
    });
  }

  /** Chamar depois que `el` estiver no DOM. */
  open() {
    if (this.term.element) return;
    this.term.open(this.el);
    // Só no desktop: no celular o teclado virtual manda tudo como composição e o
    // xterm depende do próprio tratamento dela.
    if (api.native) this.fixComposition();
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      this.term.loadAddon(gl);
    } catch {
      /* fallback: renderer DOM */
    }
    this.ro.observe(this.el);
    this.fitNow();
    void this.attach();
  }

  async attach() {
    if (this.attached) return;
    this.attached = true;
    this.term.reset();
    try {
      await api.termAttach(this.id, this.term.cols, this.term.rows, (d) => this.term.write(d));
      // Ao conectar, este aparelho assume o tamanho (evita as "bolinhas" do tmux).
      if (this.el.isConnected && this.el.offsetWidth) this.claim();
    } catch (e) {
      this.attached = false;
      this.term.write(`\r\n\x1b[31m[coliseu] falha ao conectar: ${e}\x1b[0m\r\n`);
    }
  }

  markDetached() {
    this.attached = false;
  }

  private scheduleFit() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.fitNow(), 40);
  }

  fitNow() {
    if (!this.el.isConnected || this.el.offsetWidth === 0) return;
    const { cols, rows } = this.term;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    if (this.term.cols !== cols || this.term.rows !== rows || !this.attached) {
      api.termResize(this.id, this.term.cols, this.term.rows);
      // Janela em tamanho "manual" (ver claim): reafirma o tamanho após redimensionar.
      if (this.el.contains(document.activeElement)) setTimeout(() => this.claim(), 60);
    }
  }

  focus() {
    this.term.focus();
  }

  /** Este aparelho assume o terminal (janela tmux = tamanho deste xterm). */
  claim() {
    if (this.term.cols && this.term.rows) api.termClaim(this.id, this.term.cols, this.term.rows);
  }

  /**
   * Celular: o Coliseu controla o gesto (o xterm.js foca — e abre o teclado —
   * já no primeiro toque). Toque curto = foca/abre o teclado; arrastar = rola.
   */
  private enableTouchScroll() {
    let startY = 0;
    let lastY = 0;
    let acc = 0;
    let moved = false;
    // Busca e chat cuidam dos próprios toques.
    const mine = (e: TouchEvent) => !(e.target as HTMLElement).closest(".searchbar, .chatview");
    this.el.addEventListener("touchstart", (e) => {
      if (!mine(e) || e.touches.length !== 1) return;
      startY = lastY = e.touches[0].clientY;
      acc = 0;
      moved = false;
      e.stopPropagation(); // o xterm não vê o toque (não foca sozinho)
    }, { capture: true, passive: true });
    this.el.addEventListener("touchmove", (e) => {
      if (!mine(e) || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      if (Math.abs(y - startY) > 8) moved = true;
      acc += lastY - y;
      lastY = y;
      const cell = (this.term.element?.clientHeight ?? 0) / Math.max(1, this.term.rows) || 16;
      const lines = Math.trunc(acc / cell);
      if (lines) {
        this.term.scrollLines(lines);
        acc -= lines * cell;
      }
      e.preventDefault();
      e.stopPropagation();
    }, { capture: true, passive: false });
    this.el.addEventListener("touchend", (e) => {
      if (!mine(e)) return;
      // Bloqueia o clique "fantasma" que o navegador gera depois do toque.
      e.preventDefault();
      e.stopPropagation();
      if (!moved) {
        this.term.focus(); // toque curto: abre o teclado
        this.claim();
      }
    }, { capture: true, passive: false });
  }

  // ---------- Busca (Ctrl+Shift+F) ----------

  openSearch() {
    if (!this.searchBar) this.searchBar = this.buildSearchBar();
    this.searchBar.hidden = false;
    const input = this.searchBar.querySelector<HTMLInputElement>("input")!;
    const sel = this.term.getSelection();
    if (sel && !sel.includes("\n")) input.value = sel;
    input.focus();
    input.select();
    if (input.value) this.find(1);
  }

  closeSearch() {
    if (!this.searchBar || this.searchBar.hidden) return;
    this.searchBar.hidden = true;
    this.search.clearDecorations();
    this.term.clearSelection();
    this.focus();
  }

  private opts(): ISearchOptions {
    const bar = this.searchBar!;
    return {
      caseSensitive: bar.querySelector<HTMLElement>("[data-opt=case]")!.classList.contains("on"),
      regex: bar.querySelector<HTMLElement>("[data-opt=regex]")!.classList.contains("on"),
      incremental: false,
      decorations: {
        matchBackground: "#4a4a20",
        matchBorder: "#facc15",
        matchOverviewRuler: "#facc15",
        activeMatchBackground: "#a16207",
        activeMatchBorder: "#fde047",
        activeMatchColorOverviewRuler: "#fde047",
      },
    };
  }

  private find(dir: 1 | -1, incremental = false) {
    const term = this.searchBar!.querySelector<HTMLInputElement>("input")!.value;
    if (!term) {
      this.search.clearDecorations();
      this.setCount("");
      return;
    }
    const o = { ...this.opts(), incremental };
    let found = false;
    try {
      found = dir === 1 ? this.search.findNext(term, o) : this.search.findPrevious(term, o);
    } catch {
      found = false; // regex inválida
    }
    if (!found) this.setCount("0 resultados");
  }

  private setCount(text: string) {
    this.searchBar!.querySelector<HTMLElement>(".count")!.textContent = text;
  }

  private buildSearchBar() {
    const bar = document.createElement("div");
    bar.className = "searchbar";
    bar.innerHTML = `${icon("search", 14, "lead")}<input placeholder="Buscar no terminal" spellcheck="false" />
      <span class="count"></span>
      <button class="opt" data-opt="case" title="Diferenciar maiúsculas">${icon("caseSensitive", 15)}</button>
      <button class="opt" data-opt="regex" title="Expressão regular">${icon("regex", 15)}</button>
      <span class="sep"></span>
      <button data-act="prev" title="Anterior (Shift+Enter)">${icon("arrowUp", 15)}</button>
      <button data-act="next" title="Próximo (Enter)">${icon("arrowDown", 15)}</button>
      <button data-act="close" title="Fechar (Esc)">${icon("x", 15)}</button>`;
    const input = bar.querySelector<HTMLInputElement>("input")!;
    input.addEventListener("input", () => this.find(1, true));
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        this.find(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeSearch();
      } else if (e.key === "F3") {
        e.preventDefault();
        this.find(e.shiftKey ? -1 : 1);
      }
    });
    bar.addEventListener("mousedown", (e) => e.stopPropagation());
    bar.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button");
      if (!b) return;
      if (b.dataset.opt) {
        b.classList.toggle("on");
        this.find(1, true);
      } else if (b.dataset.act === "next") this.find(1);
      else if (b.dataset.act === "prev") this.find(-1);
      else if (b.dataset.act === "close") this.closeSearch();
      if (b.dataset.act !== "close") input.focus();
    });
    this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (resultCount === 0) this.setCount(input.value ? "0 resultados" : "");
      else if (resultIndex < 0) this.setCount(`${resultCount}+`);
      else this.setCount(`${resultIndex + 1} de ${resultCount}`);
    });
    this.el.appendChild(bar);
    return bar;
  }

  dispose() {
    all.delete(this);
    this.ro.disconnect();
    void api.termDetach(this.id);
    this.term.dispose();
    this.el.remove();
  }
}
