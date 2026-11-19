# Coliseu — notificações no celular (spec)

> Branch: `notificacoes`. HTTPS pelo Tailscale + app instalável (PWA) + Web Push.

## 1. Objetivo

O celular recebe as mesmas notificações do desktop ("Claude concluiu",
"aguardando você", PRs), **mesmo com o app fechado ou a tela bloqueada**.
Tocar na notificação abre a conversa daquele terminal.

**Pré-requisitos (já feitos):** MagicDNS + HTTPS Certificates ativos no
Tailscale; usuário é operador do Tailscale (`tailscale cert` sem sudo).
Nome da máquina: `<máquina>.<tailnet>.ts.net` (o nome dela na tailnet).

## 2. Decisões

| Tema | Decisão | Motivo |
|---|---|---|
| HTTPS | Certificado do Tailscale (Let's Encrypt) via `tailscale cert`, servido pelo próprio servidor do Coliseu (rustls) | Notificações, service worker e PWA só funcionam em HTTPS; continua só dentro do Tailscale |
| Endereço | `https://<máquina>.<tailnet>.ts.net:<porta>/?t=<token>` (QR novo) | O certificado vale para o nome, não para o IP |
| Local | `http://127.0.0.1:<porta>` continua (só nesta máquina) | Testes e uso local |
| Renovação | Na abertura e a cada 24 h, `tailscale cert` (ele só renova perto de vencer); o servidor recarrega o certificado sem reiniciar | Nada manual |
| Sem certificado | Volta para HTTP no IP do Tailscale e avisa nas configurações | Nunca fica sem acesso |
| Push | Web Push padrão (VAPID + criptografia aes128gcm, RFC 8291/8292), crate `web-push`, envio com o `reqwest` que já existe | Funciona com o app fechado; o serviço de push do Android (Google) só entrega, não lê |
| Quando envia | Os mesmos eventos e filtros das notificações do desktop (grupos silenciados, "só com a janela sem foco"…); um interruptor "Enviar também para o celular" | Mesmo comportamento nos dois; sem configuração dobrada |
| Celular em uso | Se o app está aberto e visível no celular, o service worker não mostra a notificação | Não incomoda quem já está olhando |

## 3. Peças

### 3.1 Backend (Rust)
- `tls.rs`: obtém/renova o certificado (`tailscale cert --cert-file … --key-file …`
  em `~/.local/share/coliseu/tls/`, chave com permissão 600), informa o nome
  (`Self.DNSName` do `tailscale status --json`).
- `remote.rs`: no IP do Tailscale escuta **HTTPS** (axum + rustls, recarregável);
  em 127.0.0.1 continua HTTP. Cookie do token ganha `Secure` no HTTPS.
  `RemoteStatus.urls` passa a trazer o link https com o nome.
- `push.rs`:
  - Chaves VAPID geradas uma vez (`~/.local/share/coliseu/push/vapid.pem`, 600).
  - Inscrições em `push/subs.json`: `{ endpoint, p256dh, auth, label, createdAt }`.
  - `send_all(title, body, term_id)`: envia para todas; inscrição que responde
    404/410 é removida.
  - Comandos (WebSocket e Tauri): `push_key`, `push_subscribe`,
    `push_unsubscribe`, `push_test`, `push_devices`.
- O comando `notify` (que hoje só mostra a notificação do GNOME) também chama
  `push::send_all` quando o interruptor está ligado.

### 3.2 Celular (web)
- `public/sw.js` (service worker, escopo `/`):
  - `push` → `showNotification(title, { body, tag: termId, data: { termId } })`,
    exceto se houver uma janela do app visível.
  - `notificationclick` → foca a janela do app (ou abre) em `/#t=<termId>`.
- Manifesto já existe; o app passa a ser instalável ("Adicionar à tela inicial").
- **Ativar no aparelho:** na home, um cartão discreto "Receber notificações
  neste celular" enquanto não estiver ativo (some ao ativar ou dispensar); na
  aba Contas, uma linha "Notificações neste celular" (ativar/desativar/testar).
  Pedir permissão só por toque do usuário.

### 3.3 Desktop (configurações → Notificações)
- Interruptor "Enviar também para o celular (push)".
- Lista de aparelhos inscritos (nome do navegador + data) com "Remover" e
  "Enviar teste".
- Configurações → Acesso pelo celular: QR e link novos (https). Aviso de que é
  preciso escanear de novo uma vez.

## 4. Critérios de aceite

- [ ] Celular abre `https://<máquina>.<tailnet>.ts.net:<porta>` com cadeado válido (sem aviso).
- [ ] App instalável na tela inicial; abre em tela cheia.
- [ ] "Receber notificações" pede permissão e inscreve o aparelho.
- [ ] Com o app fechado/tela bloqueada: "Claude concluiu" e "aguardando você" chegam; tocar abre a conversa certa.
- [ ] Com o app aberto e visível no celular, não duplica.
- [ ] Notificação de teste pelo desktop e pelo celular.
- [ ] Aparelho removido/expirado para de receber; inscrição inválida é limpa sozinha.
- [ ] Sem certificado: continua acessível por HTTP no IP (com aviso).
