import DOMPurify from "dompurify";
import { marked } from "marked";
import type * as Monaco from "monaco-editor";
import { api, type FsContent } from "./transport";
import { icon } from "./icons";
import { esc } from "./labels";

export interface ViewerHost {
  show(): void;
  hide(): void;
  toast(msg: string): void;
  confirm(html: string): Promise<boolean>;
}

interface OpenFile {
  path: string;
  content?: FsContent;
  error?: string;
  preview: boolean;
  model?: Monaco.editor.ITextModel;
  savedVersion: number;
  mtime: number;
  viewState?: Monaco.editor.ICodeEditorViewState | null;
  saving?: boolean;
}

type MonacoModule = typeof import("./monaco");

const files: OpenFile[] = [];
let active = -1;
let host: ViewerHost;
let root: HTMLElement;
let tabsEl: HTMLElement;
let barEl: HTMLElement;
let editorEl: HTMLElement;
let previewEl: HTMLElement;
let messageEl: HTMLElement;
let mod: MonacoModule | undefined;
let editor: Monaco.editor.IStandaloneCodeEditor | undefined;

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const ext = (p: string) => {
  const n = baseName(p).toLowerCase();
  return n.includes(".") ? n.slice(n.lastIndexOf(".") + 1) : n;
};
const isMarkdown = (p: string) => ["md", "markdown", "mdx"].includes(ext(p));
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const editable = (f: OpenFile) => !!f.content && !f.content.binary && !f.content.truncated;
const dirty = (f: OpenFile) => !!f.model && f.model.getAlternativeVersionId() !== f.savedVersion;

async function monaco(): Promise<MonacoModule> {
  if (mod) return mod;
  mod = await import("./monaco");
  mod.defineTheme();
  return mod;
}

async function ensureEditor() {
  const m = await monaco();
  if (editor) return editor;
  editor = m.monaco.editor.create(editorEl, {
    theme: "coliseu",
    automaticLayout: true,
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    renderWhitespace: "selection",
    smoothScrolling: true,
    model: null,
  });
  editor.addCommand(m.monaco.KeyMod.CtrlCmd | m.monaco.KeyCode.KeyS, () => {
    const f = files[active];
    if (f) void save(f);
  });
  return editor;
}

function renderTabs() {
  tabsEl.innerHTML = files
    .map(
      (x, i) => `<div class="fv-tab ${i === active ? "active" : ""}${dirty(x) ? " dirty" : ""}" data-i="${i}" title="${esc(x.path)}">
        ${icon("fileBlank", 13)}<span>${esc(baseName(x.path))}</span>
        <button class="icon" data-act="close-tab" data-i="${i}" title="Fechar">${dirty(x) ? '<i class="fv-dot"></i>' : ""}${icon("x", 12)}</button></div>`,
    )
    .join("");
}

function renderBar(f: OpenFile) {
  const md = isMarkdown(f.path) && editable(f);
  const ro = f.content && !editable(f) ? `<span class="fv-meta">somente leitura</span>` : "";
  barEl.innerHTML = `
    <span class="fv-path" title="${esc(f.path)}">${esc(f.path)}</span>
    ${ro}${f.content ? `<span class="fv-meta">${kb(f.content.size)}</span>` : ""}
    ${md ? `<div class="seg">
        <button class="${f.preview ? "on" : ""}" data-act="preview">Visualizar</button>
        <button class="${f.preview ? "" : "on"}" data-act="source">Editar</button></div>` : ""}
    ${editable(f) ? `<button class="fv-save ${dirty(f) ? "on" : ""}" data-act="save" title="Salvar (Ctrl/Cmd+S)" ${dirty(f) && !f.saving ? "" : "disabled"}>${f.saving ? "Salvando…" : "Salvar"}</button>` : ""}
    <button class="icon" data-act="reload" title="Recarregar do disco">${icon("refresh", 14)}</button>
    <button class="icon" data-act="copy" title="Copiar caminho">${icon("copy", 14)}</button>
    <button class="icon" data-act="external" title="Abrir no app padrão">${icon("external", 14)}</button>
    <button class="icon" data-act="close" title="Voltar aos terminais">${icon("x", 14)}</button>`;
}

function show(which: "editor" | "preview" | "message", html = "") {
  editorEl.hidden = which !== "editor";
  previewEl.hidden = which !== "preview";
  messageEl.hidden = which !== "message";
  if (which === "message") messageEl.innerHTML = html;
}

async function renderPreview(f: OpenFile) {
  const text = f.model?.getValue() ?? f.content?.text ?? "";
  previewEl.innerHTML = `<article class="md fv-md">${DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true }) as string)}</article>`;
  show("preview");
  const m = await monaco();
  previewEl.querySelectorAll<HTMLElement>("pre code[class*='language-']").forEach((el) => {
    el.dataset.lang = /language-(\S+)/.exec(el.className)?.[1] ?? "";
    void m.monaco.editor.colorizeElement(el, { theme: "coliseu" });
  });
}

async function render() {
  const f = files[active];
  if (!f) return;
  renderTabs();
  renderBar(f);
  if (f.error) return show("message", esc(f.error));
  if (!f.content) return show("message", `${icon("loader", 14, "spin")} carregando…`);
  if (f.content.binary) return show("message", `Arquivo binário (${kb(f.content.size)}). Use "Abrir no app padrão".`);
  if (f.preview && isMarkdown(f.path)) return renderPreview(f);
  const ed = await ensureEditor();
  if (files[active] !== f) return;
  const m = await monaco();
  if (!f.model) {
    f.model = m.monaco.editor.createModel(f.content.text, undefined, m.monaco.Uri.file(f.path));
    f.savedVersion = f.model.getAlternativeVersionId();
    f.model.onDidChangeContent(() => {
      renderTabs();
      if (files[active] === f) renderBar(f);
    });
  }
  if (ed.getModel() !== f.model) {
    const prev = files.find((x) => x.model === ed.getModel());
    if (prev) prev.viewState = ed.saveViewState();
    ed.setModel(f.model);
    if (f.viewState) ed.restoreViewState(f.viewState);
  }
  ed.updateOptions({ readOnly: !editable(f) });
  show("editor");
  if (f.content.truncated) {
    host.toast(`Mostrando os primeiros 2 MB de ${kb(f.content.size)} (somente leitura).`);
  }
  ed.focus();
}

async function load(f: OpenFile) {
  f.error = undefined;
  try {
    f.content = await api.fsRead(f.path);
    f.mtime = f.content.mtime;
  } catch (e) {
    f.error = `Não deu para abrir: ${e}`;
  }
  if (files[active] === f) void render();
}

async function syncFromDisk(f: OpenFile, force = false) {
  if (!f.content || !f.model || (dirty(f) && !force)) return;
  let fresh: FsContent;
  try {
    fresh = await api.fsRead(f.path);
  } catch {
    return;
  }
  if (!force && fresh.mtime === f.mtime) return;
  f.content = fresh;
  f.mtime = fresh.mtime;
  if (fresh.binary) return void render();
  if (f.model.getValue() !== fresh.text) {
    f.model.pushEditOperations([], [{ range: f.model.getFullModelRange(), text: fresh.text }], () => null);
  }
  f.savedVersion = f.model.getAlternativeVersionId();
  if (files[active] === f) void render();
}

async function save(f: OpenFile, overwrite = false) {
  if (!f.model || !editable(f) || f.saving) return;
  const version = f.model.getAlternativeVersionId();
  f.saving = true;
  renderBar(f);
  try {
    f.mtime = await api.fsWrite(f.path, f.model.getValue(), overwrite ? undefined : f.mtime);
    f.savedVersion = version;
  } catch (e) {
    if (e === "changed-on-disk") {
      f.saving = false;
      const ok = await host.confirm(
        `<b>${esc(baseName(f.path))}</b> mudou no disco depois que você abriu.<br>Sobrescrever com a sua versão?`,
      );
      if (ok) return save(f, true);
    } else host.toast(`Não deu para salvar: ${e}`);
  } finally {
    f.saving = false;
    renderTabs();
    if (files[active] === f) renderBar(f);
  }
}

export function openFile(path: string) {
  let i = files.findIndex((f) => f.path === path);
  if (i < 0) {
    files.push({ path, preview: isMarkdown(path), savedVersion: 0, mtime: 0 });
    i = files.length - 1;
    void load(files[i]);
  } else void syncFromDisk(files[i]);
  active = i;
  host.show();
  void render();
}

export function viewerHasUnsaved() {
  return files.some(dirty);
}

async function closeTab(i: number) {
  const f = files[i];
  if (dirty(f) && !(await host.confirm(`Descartar as alterações em <b>${esc(baseName(f.path))}</b>?`))) return;
  if (editor?.getModel() === f.model) editor?.setModel(null);
  f.model?.dispose();
  files.splice(i, 1);
  if (!files.length) {
    active = -1;
    host.hide();
    return;
  }
  if (active >= files.length || active > i) active = Math.max(0, active - 1);
  void render();
}

export function initViewer(h: ViewerHost) {
  host = h;
  root = document.querySelector("#file-view") as HTMLElement;
  root.innerHTML = `<div class="fv-tabs"></div><div class="fv-bar"></div>
    <div class="fv-body"><div class="fv-editor" hidden></div><div class="fv-preview" hidden></div><div class="fv-empty" hidden></div></div>`;
  tabsEl = root.querySelector(".fv-tabs")!;
  barEl = root.querySelector(".fv-bar")!;
  editorEl = root.querySelector(".fv-editor")!;
  previewEl = root.querySelector(".fv-preview")!;
  messageEl = root.querySelector(".fv-empty")!;

  root.addEventListener("click", async (ev) => {
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLElement>("[data-act]");
    const f = files[active];
    if (btn) {
      ev.stopPropagation();
      switch (btn.dataset.act) {
        case "close-tab": return closeTab(Number(btn.dataset.i));
        case "close": return host.hide();
        case "preview": f.preview = true; return render();
        case "source": f.preview = false; return render();
        case "save": return save(f);
        case "reload":
          if (dirty(f) && !(await host.confirm(`Descartar as alterações e recarregar <b>${esc(baseName(f.path))}</b>?`))) return;
          return syncFromDisk(f, true);
        case "copy": return void api.clipboardWrite(f.path).then(() => host.toast("Caminho copiado"));
        case "external": return void api.fsOpen(f.path).catch((e) => host.toast(`${e}`));
      }
      return;
    }
    const tab = t.closest<HTMLElement>(".fv-tab");
    if (tab) {
      active = Number(tab.dataset.i);
      void syncFromDisk(files[active]);
      void render();
    }
  });
  root.addEventListener("auxclick", (ev) => {
    const tab = (ev.target as HTMLElement).closest<HTMLElement>(".fv-tab");
    if (tab && ev.button === 1) void closeTab(Number(tab.dataset.i));
  });
  window.addEventListener("focus", () => {
    if (!root.hidden && files[active]) void syncFromDisk(files[active]);
  });
}
