// Coliseu — service worker do celular (docs/NOTIFY_SPEC.md).
// Recebe o Web Push do desktop e mostra a notificação; tocar abre a conversa.

// Tela "sem conexão com o PC" guardada no celular: sem ela, abrir o app com o PC
// fora do ar dava tela preta (a página nem carregava).
const CACHE = "coliseu-offline-v1";
const OFFLINE = "/offline.html";

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE)).catch(() => {}));
});
self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  ),
);

// Abrir uma página: vai à rede; se o PC não responder (ou demorar 8 s), mostra a
// tela guardada. Só navegação — o resto (WebSocket, arquivos) segue normal.
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(
    (async () => {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await fetch(e.request, { signal: ctl.signal });
        // PC respondeu: renova a cópia guardada (a tela pode ter mudado numa atualização).
        if (res.ok) e.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE)).catch(() => {}));
        return res;
      } catch {
        return (await caches.match(OFFLINE)) || Response.error();
      } finally {
        clearTimeout(t);
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Coliseu", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      // App aberto e visível neste celular: quem está olhando não precisa do aviso.
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (wins.some((w) => w.visibilityState === "visible" && w.focused)) return;
      await self.registration.showNotification(data.title || "Coliseu", {
        body: data.body || "",
        // O ícone do app já aparece à esquerda. Sem "icon", o Chrome põe a inicial do
        // site à direita; com uma imagem transparente, não aparece nada lá.
        icon: "/notify-icon.png",
        // Desenho monocromático da barra de status.
        badge: "/badge-96.png",
        // Um aviso por terminal: o novo substitui o anterior do mesmo terminal.
        tag: data.termId ? `t-${data.termId}` : undefined,
        renotify: !!data.termId,
        data: { termId: data.termId || null },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const termId = event.notification.data && event.notification.data.termId;
  const url = termId ? `/#t=${encodeURIComponent(termId)}` : "/";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        // A página troca de tela sozinha ao mudar o #t=… (popstate/hashchange).
        win.postMessage({ type: "open-term", termId });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
