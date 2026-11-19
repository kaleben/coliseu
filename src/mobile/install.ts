// Instalar o Coliseu como app (PWA). Android/Chrome: o convite do próprio
// navegador (beforeinstallprompt). iPhone: não há convite — só a instrução.

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
let onChange: () => void = () => {};

/** Já está rodando como app instalado (tela cheia). */
export const isInstalled = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

// iPadOS 13+ se apresenta como Mac: reconhece pelo toque.
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** O que dá para oferecer agora: "prompt" (Chrome), "ios" (instrução) ou nada. */
export function installOffer(): "prompt" | "ios" | null {
  if (isInstalled()) return null;
  if (deferred) return "prompt";
  if (isIos() && window.isSecureContext) return "ios";
  return null;
}

/** Captura o convite do navegador (chamar cedo, antes de o evento disparar). */
export function initInstall(changed: () => void) {
  onChange = changed;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // o convite aparece pelo nosso botão, não do nada
    deferred = e as InstallPromptEvent;
    onChange();
  });
  addEventListener("appinstalled", () => {
    deferred = null;
    onChange();
  });
}

/** Mostra o convite do navegador (precisa vir de um toque). */
export async function promptInstall(): Promise<boolean> {
  const d = deferred;
  if (!d) return false;
  deferred = null;
  await d.prompt();
  const { outcome } = await d.userChoice;
  onChange();
  return outcome === "accepted";
}
