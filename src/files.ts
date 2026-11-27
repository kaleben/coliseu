import { api, type FsEntry, type Group } from "./transport";
import { icon, type IconName } from "./icons";
import { esc } from "./labels";

export interface FilesHost {
  groups(): Group[];
  activeGroupId(): string | undefined;
  insertPath(path: string): void;
  openFile(path: string): void;
  setFolders(groupId: string, folders: string[]): Promise<void>;
  pickFolder(start?: string): Promise<string | null>;
  newTerminalAt(groupId: string, cwd: string): void;
  contextMenu(x: number, y: number, items: [string, () => unknown, IconName?][]): void;
  toast(msg: string): void;
  onResize(): void;
}

const listings = new Map<string, FsEntry[]>();
const loading = new Set<string>();
const expanded = new Set<string>();
const openGroups = new Set<string>();
let host: FilesHost;
let root: HTMLElement;
let seenActive: string | undefined;

const shellQuote = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

async function load(path: string) {
  if (loading.has(path)) return;
  loading.add(path);
  try {
    listings.set(path, await api.fsList(path));
  } catch (e) {
    listings.set(path, []);
    host.toast(`Não deu para abrir ${path}: ${e}`);
  } finally {
    loading.delete(path);
    renderFiles();
  }
}

function toggleDir(path: string) {
  if (expanded.has(path)) expanded.delete(path);
  else {
    expanded.add(path);
    if (!listings.has(path)) void load(path);
  }
  renderFiles();
}

const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const foldersOf = (g: Group) => g.folders ?? [];

function toggleGroup(g: Group) {
  if (openGroups.has(g.id)) openGroups.delete(g.id);
  else openGroups.add(g.id);
  renderFiles();
}

async function addFolder(g: Group) {
  const picked = await host.pickFolder(g.cwd);
  if (!picked) return;
  const clean = picked.replace(/\/+$/, "") || "/";
  if (foldersOf(g).includes(clean)) return host.toast("Essa pasta já está no grupo");
  openGroups.add(g.id);
  expanded.add(clean);
  await host.setFolders(g.id, [...foldersOf(g), clean]);
  void load(clean);
}

async function removeFolder(g: Group, folder: string) {
  expanded.delete(folder);
  await host.setFolders(g.id, foldersOf(g).filter((f) => f !== folder));
}

function tree(path: string, gid: string, depth: number): string {
  const items = listings.get(path);
  if (!items) return `<div class="fx-note" style="--d:${depth}">${icon("loader", 12, "spin")} carregando…</div>`;
  if (!items.length) return `<div class="fx-note" style="--d:${depth}">vazia</div>`;
  return items
    .map((e) => {
      const open = e.dir && expanded.has(e.path);
      const ic: IconName = e.dir ? (open ? "folder" : "folderClosed") : "fileBlank";
      const row = `<div class="fx-row ${e.dir ? "fx-dir" : "fx-file"}${e.name.startsWith(".") ? " fx-hidden" : ""}" style="--d:${depth}"
        data-path="${esc(e.path)}" data-gid="${gid}" data-dir="${e.dir ? 1 : ""}" title="${esc(e.path)}">
        <span class="fx-chev">${e.dir ? icon(open ? "chevronDown" : "chevronRight", 12) : ""}</span>
        ${icon(ic, 14)}<span class="fx-name">${esc(e.name)}</span></div>`;
      return open ? row + tree(e.path, gid, depth + 1) : row;
    })
    .join("");
}

const parentOf = (p: string) => {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
};

function rootRow(f: string, gid: string) {
  const open = expanded.has(f);
  if (open && !listings.has(f)) void load(f);
  return `<div class="fx-row fx-dir fx-root" style="--d:1" data-path="${esc(f)}" data-gid="${gid}" data-dir="1" data-root="1" title="${esc(f)}">
      <span class="fx-chev">${icon(open ? "chevronDown" : "chevronRight", 12)}</span>
      <span class="fx-root-ic">${icon(open ? "folder" : "folderClosed", 13)}</span>
      <span class="fx-name">${esc(folderName(f))}</span>
      <span class="fx-parent">${esc(parentOf(f))}</span>
      <button class="icon fx-remove" data-act="remove" title="Remover do grupo (não apaga nada)">${icon("x", 12)}</button>
    </div>${open ? tree(f, gid, 2) : ""}`;
}

export function renderFiles() {
  if (!root || root.hidden) return;
  const ag = host.activeGroupId();
  if (ag && ag !== seenActive) {
    seenActive = ag;
    openGroups.add(ag);
  }
  const body = root.querySelector(".fx-body") as HTMLElement;
  const scroll = body.scrollTop;
  body.innerHTML = host
    .groups()
    .map((g) => {
      const open = openGroups.has(g.id);
      const folders = foldersOf(g);
      const content = !open
        ? ""
        : folders.length
          ? folders.map((f) => rootRow(f, g.id)).join("") +
            `<button class="fx-add-row" data-act="add" data-gid="${g.id}">${icon("plus", 12)}<span>Adicionar pasta</span></button>`
          : `<button class="fx-empty" data-act="add" data-gid="${g.id}">
              <span class="fx-empty-ic">${icon("folderClosed", 15)}</span>
              <span class="fx-empty-txt"><b>Adicionar pasta</b><small>Escolha os projetos deste grupo</small></span>
            </button>`;
      return `<section class="fx-group ${g.id === ag ? "active" : ""}" style="--c:${g.color}">
        <div class="fx-ghead" data-gid="${g.id}">
          <span class="fx-chev">${icon(open ? "chevronDown" : "chevronRight", 12)}</span>
          <span class="dot"></span><span class="fx-gname">${esc(g.name)}</span>
          ${folders.length ? `<span class="fx-gcount">${folders.length}</span>` : ""}
          <button class="icon fx-gadd" data-act="add" data-gid="${g.id}" title="Adicionar pasta">${icon("plus", 14)}</button>
        </div>
        ${content}
      </section>`;
    })
    .join("");
  body.scrollTop = scroll;
}

function refreshAll() {
  const paths = [...expanded];
  listings.clear();
  paths.forEach((p) => void load(p));
}

function menuFor(path: string, gid: string, dir: boolean, x: number, y: number, isRoot = false) {
  const items: [string, () => unknown, IconName?][] = [];
  const g = host.groups().find((x) => x.id === gid);
  if (dir) items.push(["Novo terminal aqui", () => host.newTerminalAt(gid, path), "terminal"]);
  else
    items.push(
      ["Abrir", () => host.openFile(path), "file"],
      ["Abrir no app padrão", () => api.fsOpen(path).catch((e) => host.toast(`${e}`)), "external"],
    );
  items.push(
    ["Inserir caminho no terminal", () => host.insertPath(shellQuote(path)), "pencil"],
    ["Copiar caminho", () => api.clipboardWrite(path), "copy"],
    ["Mostrar no gerenciador de arquivos", () => api.fsReveal(path).catch((e) => host.toast(`${e}`)), "folder"],
  );
  if (isRoot && g) items.push(["Remover do grupo", () => removeFolder(g, path), "trash"]);
  host.contextMenu(x, y, items);
}

const W_KEY = "coliseu-files-w";
const OPEN_KEY = "coliseu-files-open";
const W_DEFAULT = 280;

function store(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    return;
  }
}
function read(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function applyWidth(w: number) {
  document.documentElement.style.setProperty("--files-w", `${w}px`);
}

export function filesOpen() {
  return !!root && !root.hidden;
}

export function toggleFiles(open = !filesOpen()) {
  root.hidden = !open;
  document.body.classList.toggle("files-open", open);
  store(OPEN_KEY, open ? "1" : "");
  if (open) renderFiles();
  host.onResize();
}

export function initFiles(h: FilesHost) {
  host = h;
  root = document.querySelector("#files") as HTMLElement;
  root.innerHTML = `<header class="fx-head"><span>Arquivos</span>
      <button class="icon" data-act="refresh" title="Atualizar">${icon("refresh", 14)}</button>
      <button class="icon" data-act="close" title="Fechar (Ctrl+Shift+B)">${icon("x", 14)}</button></header>
    <div class="fx-body"></div><div class="files-resize" title="Arraste para ajustar · duplo clique para o tamanho padrão"></div>`;
  applyWidth(Number(read(W_KEY)) || W_DEFAULT);

  root.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") return toggleFiles(false);
    if (act === "refresh") return refreshAll();
    if (act === "remove") {
      const row = t.closest<HTMLElement>(".fx-row")!;
      const g = host.groups().find((x) => x.id === row.dataset.gid);
      if (g) void removeFolder(g, row.dataset.path!);
      return;
    }
    if (act === "add") {
      const g = host.groups().find((x) => x.id === t.closest<HTMLElement>("[data-gid]")!.dataset.gid);
      if (g) void addFolder(g);
      return;
    }
    const gh = t.closest<HTMLElement>(".fx-ghead");
    if (gh) {
      const g = host.groups().find((x) => x.id === gh.dataset.gid);
      if (g) toggleGroup(g);
      return;
    }
    const row = t.closest<HTMLElement>(".fx-row");
    if (!row) return;
    const path = row.dataset.path!;
    if (row.dataset.dir) toggleDir(path);
    else host.openFile(path);
  });

  root.addEventListener("contextmenu", (ev) => {
    const t = ev.target as HTMLElement;
    const row = t.closest<HTMLElement>(".fx-row");
    const gh = t.closest<HTMLElement>(".fx-ghead");
    if (!row && !gh) return;
    ev.preventDefault();
    if (row) return menuFor(row.dataset.path!, row.dataset.gid!, !!row.dataset.dir, ev.clientX, ev.clientY, !!row.dataset.root);
    const g = host.groups().find((x) => x.id === gh!.dataset.gid);
    if (g) host.contextMenu(ev.clientX, ev.clientY, [["Adicionar pasta", () => addFolder(g), "plus"]]);
  });

  const handle = root.querySelector(".files-resize") as HTMLElement;
  handle.addEventListener("mousedown", (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startW = root.getBoundingClientRect().width;
    document.body.classList.add("resizing-sidebar");
    let w = startW;
    const move = (m: MouseEvent) => {
      w = Math.round(Math.min(640, Math.max(180, startW - (m.clientX - startX))));
      applyWidth(w);
    };
    const up = () => {
      document.body.classList.remove("resizing-sidebar");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      store(W_KEY, String(w));
      host.onResize();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  handle.addEventListener("dblclick", () => {
    applyWidth(W_DEFAULT);
    store(W_KEY, "");
    host.onResize();
  });

  if (read(OPEN_KEY)) toggleFiles(true);
}
