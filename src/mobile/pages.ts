// Abas PRs e Contas do app no celular (docs/MOBILE_SPEC.md §2.3).
// Só leem o estado dos módulos prs.ts/accounts.ts: refresh() nunca vai à rede;
// a rede só é consultada pelo botão de atualizar ou pelos timers dos módulos.
import "./pages.css";
import type { PullRequest, Usage, UsageWindow } from "../transport";
import { prsEnabled, prState, refreshPrsNow, waitingCount } from "../prs";
import { accounts, activeId, age, codexState, refreshAccountsNow, resetIn, shortName, switchAccount, usageOf } from "../accounts";
import { icon } from "../icons";
import { escHtml, pageHeader, sheet, type AppHost, type AppTab } from "./shell";
import { disablePush, enablePush, lastPushState, testPush } from "./push";

// ---------- Utilidades ----------


/** Troca o conteúdo só se mudou (refresh() roda a cada ~1,5 s: não recria a lista no meio de um toque). */
const painted = new WeakMap<HTMLElement, string>();
function paint(el: HTMLElement, html: string, spinning: boolean) {
  if (spinning) html = html.replace('class="app-round"', 'class="app-round pg-spinning"');
  if (painted.get(el) === html) return;
  painted.set(el, html);
  el.innerHTML = html;
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

// ---------- PRs ----------

type Tone = "warn" | "ok" | "bad" | "";

/** Palavra de status (e cor) mostrada na linha da PR. */
function prStatus(p: PullRequest): { word: string; tone: Tone } {
  if (p.decision === "changes_requested") return { word: "mudanças pedidas", tone: "warn" };
  if (p.action === "waiting_me") return { word: "aguardando você", tone: "warn" };
  if (p.decision === "approved") return { word: "aprovada", tone: "ok" };
  if (p.draft) return { word: "rascunho", tone: "" };
  if (p.action === "waiting_reviewer") return { word: "aguardando revisão", tone: "" };
  return { word: "sem pendências", tone: "" };
}

function prRow(p: PullRequest) {
  const st = prStatus(p);
  const ci = p.checks === "failure" ? `<span class="bad">CI falhou</span>` : "";
  return `<a class="pg-row pg-pr" href="${escHtml(p.url)}" target="_blank" rel="noopener">
      <span class="pg-tile ${st.tone}">${icon(p.draft ? "prDraft" : "pr", 18)}</span>
      <span class="pg-txt">
        <span class="pg-t">${escHtml(p.title)}</span>
        <span class="pg-tag"><span class="repo">${escHtml(p.repo)} #${p.number}</span><span class="${st.tone}">${st.word}</span>${ci}</span>
      </span>
      <span class="pg-trail">${icon("chevronRight", 18)}</span>
    </a>`;
}

function prGroup(title: string, prs: PullRequest[], tone = "") {
  if (!prs.length) return "";
  return `<div class="pg-group">
      <div class="pg-group-h"><b class="${tone}">${escHtml(title)}</b><span>${prs.length}</span></div>
      <div class="pg-inset">${prs.map(prRow).join("")}</div>
    </div>`;
}

function notice(text: string, ic?: Parameters<typeof icon>[0], cls = "") {
  return `<div class="pg-group"><div class="pg-inset pg-notice ${cls}">${ic ? icon(ic, 18, ic === "loader" ? "spin" : "") : ""}<span>${escHtml(text)}</span></div></div>`;
}

export function prsTab(_host: AppHost): AppTab {
  const el = document.createElement("div");
  el.className = "pg pg-prs";
  el.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("[data-act=refresh]")) {
      refreshPrsNow();
      el.querySelector(".app-round")?.classList.add("pg-spinning");
      painted.delete(el); // o próximo refresh redesenha (tira o giro se a busca já acabou)
    }
  });

  function render() {
    const s = prState();
    const prs = s.prs;
    const waiting = prs.filter((p) => p.action === "waiting_me");
    const reviewer = prs.filter((p) => p.action === "waiting_reviewer");
    const rest = prs.filter((p) => p.action === "none");
    const loading = !s.generatedAt && !s.errors.length;

    const sub = [
      `${prs.length} ${prs.length === 1 ? "aberta" : "abertas"}`,
      waiting.length ? `<b>${waiting.length} aguardando você</b>` : "",
      s.refreshing ? "atualizando…" : s.generatedAt ? `atualizado às ${hhmm(s.generatedAt)}` : "",
    ].filter(Boolean);

    let body: string;
    if (!prs.length) {
      if (s.refreshing || loading) body = notice("Buscando suas PRs…", "loader");
      else if (s.errors.length) body = "";
      else body = notice("Nenhuma PR aberta sua.", "circleCheck", "muted");
    } else
      body =
        prGroup("Aguardando você", waiting, "warn") +
        prGroup("Aguardando revisão", reviewer) +
        prGroup("Sem pendências", rest);

    const errors = s.errors.length ? notice(s.errors.join(" | "), "circleX", "err") : "";

    paint(el, `${pageHeader("Pull requests", { icon: "refresh", label: "Atualizar", id: "refresh" })}
      ${loading ? "" : `<p class="pg-sub">${sub.join(" · ")}</p>`}
      ${errors}${body}`, s.refreshing);
  }

  return { id: "prs", label: "PRs", icon: "pr", el, refresh: render, badge: () => waitingCount() > 0, enabled: prsEnabled };
}

// ---------- Contas ----------

function meter(label: string, w?: UsageWindow | null) {
  if (!w) return `<div class="pg-meter empty"><span>${label}</span><span class="tr"><span class="fl"></span></span><em>—</em><small></small></div>`;
  const p = Math.round(w.percent);
  const r = resetIn(w.resetsAt);
  return `<div class="pg-meter"><span>${label}</span>
      <span class="tr"><span class="fl${p >= 80 ? " hi" : ""}" style="width:${Math.min(100, Math.max(0, p))}%"></span></span>
      <em>${p}%</em><small>${r ? `renova em ${r}` : ""}</small></div>`;
}

/** Medidores quando há números (mesmo antigos); senão, o motivo. */
function usageMeters(u: Usage | undefined, long: string) {
  if (!u?.fiveHour && !u?.sevenDay) {
    if (!u) return `<div class="pg-note">carregando uso…</div>`;
    const rate = /429|rate/i.test(u.error ?? "");
    return `<div class="pg-note warn">${rate ? "limite de consultas: tenta de novo em instantes" : "uso indisponível"}</div>`;
  }
  const stale = u.stale && u.fetchedAt ? `<div class="pg-note">atualizado ${age(u.fetchedAt)}</div>` : "";
  return meter("5h", u.fiveHour) + meter(long, u.sevenDay) + stale;
}

export function accountsTab(host: AppHost): AppTab {
  const el = document.createElement("div");
  el.className = "pg pg-acc";
  let busy = false;

  el.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("[data-act=refresh]")) {
      if (busy) return;
      busy = true;
      render();
      void refreshAccountsNow().finally(() => {
        busy = false;
        render();
      });
      return;
    }
    if (t.closest('[data-act="push"]')) return pushMenu();
    const id = t.closest<HTMLElement>("[data-acc]")?.dataset.acc;
    const a = accounts.find((x) => x.id === id);
    // A conta ativa não tem o que escolher: nada abre.
    if (!a || a.id === activeId) return;
    const head = `${a.label}${a.orgName ? ` · ${a.orgName}` : ""}`;
    void sheet(head, [
      {
        label: "Usar esta conta",
        run: async () => {
          try {
            await switchAccount(a.id);
            host.toast(`Conta global: ${shortName(a)}`);
          } catch (err) {
            host.toast(`Falha ao trocar conta: ${err}`);
          }
          render();
        },
      },
    ]);
  });

  function pushMenu() {
    const st = lastPushState;
    const done = (msg: string) => {
      host.toast(msg);
      render();
    };
    if (st === "unsupported" || st === "denied") {
      host.toast(st === "denied" ? "Libere as notificações do Coliseu nas configurações do navegador." : "Abra o Coliseu pelo link https (Configurações → Acesso remoto, no desktop).");
      return;
    }
    void sheet(
      "Notificações neste celular",
      st === "on"
        ? [
            { label: "Enviar teste", run: () => testPush().then(() => done("Teste enviado.")).catch((e) => done(`Falhou: ${e}`)) },
            { label: "Desativar", danger: true, run: () => disablePush().then(() => done("Notificações desativadas.")) },
          ]
        : [
            {
              label: "Ativar",
              run: () =>
                enablePush()
                  .then((s) => done(s === "on" ? "Notificações ativadas." : s === "denied" ? "Permissão negada no navegador." : "Não ativadas."))
                  .catch((e) => done(`Não deu para ativar: ${e}`)),
            },
          ],
    );
  }

  function render() {
    const claude = accounts.length
      ? accounts
          .map((a) => {
            const active = a.id === activeId;
            return `<button class="pg-usage ${active ? "active" : ""}" data-acc="${escHtml(a.id)}">
                <div class="h"><span class="n">${escHtml(shortName(a))}</span>${a.plan ? `<span class="plan">${escHtml(a.plan)}</span>` : ""}
                  ${active ? `<span class="chk" aria-label="Conta ativa">${icon("check", 18)}</span>` : ""}</div>
                ${usageMeters(usageOf(a.id), "7d")}
              </button>`;
          })
          .join("")
      : `<div class="pg-notice muted"><span>Nenhuma conta do Claude no Coliseu. Adicione pelo desktop.</span></div>`;

    const cx = codexState();
    const codex = cx?.loggedIn
      ? `<div class="pg-group">
          <div class="pg-group-h"><b>Codex</b>${cx.email ? `<span>${escHtml(cx.email.split("@")[0])}</span>` : ""}</div>
          <div class="pg-inset"><div class="pg-usage static">
            <div class="h"><span class="n">ChatGPT</span>${cx.plan ? `<span class="plan">${escHtml(cx.plan)}</span>` : ""}</div>
            ${
              cx.fiveHour || cx.weekly
                ? meter("5h", cx.fiveHour) + meter("sem", cx.weekly) + (cx.updatedAt ? `<div class="pg-note">atualizado ${age(cx.updatedAt)}</div>` : "")
                : `<div class="pg-note">sem uso registrado ainda</div>`
            }
          </div></div>
        </div>`
      : "";

    paint(el, `${pageHeader("Contas", { icon: "refresh", label: "Atualizar", id: "refresh" })}
      <div class="pg-group pg-first">
        <div class="pg-group-h"><b>Claude</b><span>conta global</span></div>
        <div class="pg-inset pg-accs">${claude}</div>
      </div>
      ${codex}
      ${notifyGroup()}`, busy);
  }

  /** Notificações neste celular (Web Push). */
  function notifyGroup() {
    const st = lastPushState;
    const label: Record<string, string> = {
      on: "Ativadas",
      off: "Desativadas",
      denied: "Bloqueadas no navegador",
      unsupported: window.isSecureContext ? "Não suportadas neste navegador" : "Precisa do link https",
    };
    return `<div class="pg-group">
        <div class="pg-group-h"><b>Notificações</b><span>neste celular</span></div>
        <div class="pg-inset"><button class="pg-usage pg-notify" data-act="push">
          <div class="h"><span class="n">Avisos do Coliseu</span><span class="pg-push-st ${st ?? ""}">${label[st ?? "off"] ?? "…"}</span></div>
        </button></div>
      </div>`;
  }

  return { id: "accounts", label: "Contas", icon: "gauge", el, refresh: render };
}
