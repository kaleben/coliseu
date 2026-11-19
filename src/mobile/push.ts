// Notificações no celular (Web Push — docs/NOTIFY_SPEC.md): registra o
// service worker e inscreve este aparelho no desktop.
import { api } from "../transport";

export type PushState =
  /** Navegador sem suporte ou página sem HTTPS. */
  | "unsupported"
  /** Permissão negada nas configurações do navegador/sistema. */
  | "denied"
  | "off"
  | "on";

let reg: ServiceWorkerRegistration | null = null;

/** Último estado conhecido (as telas redesenham o tempo todo; a consulta é assíncrona). */
export let lastPushState: PushState | null = null;
const remember = (s: PushState) => ((lastPushState = s), s);

/** HTTPS + service worker + Push API (no Android: Chrome; no iPhone: app instalado na tela inicial). */
export const pushSupported = () =>
  window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** Registra o service worker (chamado ao abrir o app). Tocar numa notificação chama `onOpen`. */
export async function initPush(onOpen: (termId: string) => void) {
  if (!pushSupported()) {
    remember("unsupported");
    return;
  }
  try {
    reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (e) {
    console.warn("service worker:", e);
    return;
  }
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open-term" && typeof e.data.termId === "string") onOpen(e.data.termId);
  });
  // Inscrição que o navegador renovou sozinho: atualiza no desktop.
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  if (sub && Notification.permission === "granted") {
    const key = await api.pushKey().then(b64urlToBytes).catch(() => null);
    const same = key ? sameKey(sub.options.applicationServerKey, key) : null;
    if (same === false) {
      // Chave antiga (o desktop trocou a dele): tira daqui e de lá; o convite volta na home.
      await api.pushUnsubscribe(sub.endpoint).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    } else if (key) void register(sub);
  }
  await pushState();
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return remember("unsupported");
  if (Notification.permission === "denied") return remember("denied");
  const r = reg ?? (await navigator.serviceWorker.getRegistration("/").catch(() => undefined)) ?? null;
  const sub = await r?.pushManager.getSubscription().catch(() => null);
  return remember(sub && Notification.permission === "granted" ? "on" : "off");
}

/** Pede permissão (precisa vir de um toque) e inscreve este aparelho. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return remember("unsupported");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return remember(perm === "denied" ? "denied" : "off");
  // Precisa de um service worker ATIVO para inscrever (recém-registrado ainda está
  // instalando). Sem nenhum, registra de novo; se não ativar em 10 s, avisa.
  if (!reg) await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  const r = (reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("o app não terminou de instalar; recarregue a página e tente de novo")), 10_000)),
  ]));
  const key = b64urlToBytes(await api.pushKey());
  let sub = await r.pushManager.getSubscription();
  // Ativar de propósito: só reaproveita a inscrição se a chave confere (chave
  // trocada ou que o navegador não informa: refaz, para não ficar "ativado" e mudo).
  if (sub && sameKey(sub.options.applicationServerKey, key) !== true) {
    await api.pushUnsubscribe(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await register(sub);
  return remember("on");
}

export async function disablePush() {
  const r = reg ?? (await navigator.serviceWorker.getRegistration("/")) ?? null;
  const sub = await r?.pushManager.getSubscription();
  remember("off");
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

export async function testPush() {
  const r = reg ?? (await navigator.serviceWorker.getRegistration("/")) ?? null;
  const sub = await r?.pushManager.getSubscription();
  if (!sub) throw new Error("notificações não estão ativas neste celular");
  await api.pushTest(sub.endpoint);
}

async function register(sub: PushSubscription) {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) return;
  await api.pushSubscribe(j.endpoint, j.keys.p256dh, j.keys.auth, deviceLabel());
}

/** "Chrome · Android" — só para reconhecer o aparelho na lista do desktop. */
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "outro";
  const br = /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Edg\//.test(ua) ? "Edge" : /Firefox/.test(ua) ? "Firefox" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Navegador";
  return `${br} · ${os}`;
}

/** null = o navegador não informa a chave (não dá para saber: não mexe). */
function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean | null {
  if (!a) return null;
  if (a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = (s + "=".repeat((4 - (s.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
