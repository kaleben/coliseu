# Coliseu — app no celular (spec)

> Branch: `mobile-app`. Só UI/UX do celular: o desktop não muda.

## 1. Objetivo

Hoje o celular é a tela do desktop "encolhida": sidebar vira gaveta, barra de
abas no topo, terminal ocupando o resto. Funciona, mas parece página
responsiva. A ideia é o celular ter **cara de app**: uma **home** com os grupos
e terminais em cartões, e a conversa (chat ou terminal) em **tela cheia** com
uma barra de topo simples.

**Não muda:** conexão (WebSocket/Tailscale), terminal (xterm), chat, status,
notificações, PRs e contas — tudo é reaproveitado. Nada do desktop é alterado.

## 2. Estrutura

Três telas, navegação em pilha (como um app):

```
Home ──toque no cartão──▶ Conversa (chat ou terminal)
  │                          ◀── voltar (botão / gesto do Android)
  └─ barra inferior: Terminais · PRs · Contas
```

### 2.1 Home (Terminais)
- **Barra de topo:** pílula "Conectado ao desktop" (ponto verde; vermelho
  quando cai) e botão redondo **+** (novo terminal → folha com os grupos).
- **Título grande** "Terminais" (estilo iOS).
- **Cartão "Agora"** (monocromático, grafite): `N trabalhando de M`, e em três
  colunas aguardando (ponto laranja) · concluídos (ponto verde) · subagentes.
  Se algum terminal aguarda você, uma linha no rodapé do cartão com o nome, o
  motivo e o botão **Abrir** (branco).
- **Grupos** como **listas agrupadas do iOS**: cabeçalho com o
  ponto da cor do grupo, nome e contagem; um bloco arredondado com linhas
  separadas por traço fino.
- **Linha do terminal:** ícone do tipo (Claude / Codex / shell) · nome (o do
  Claude, se houver) · estado em cor (amarelo com spinner = trabalhando,
  laranja = aguardando você, verde = concluído, cinza = parado; subagentes
  entram no texto) · tempo · seta.
- **Segurar a linha:** folha de ações do iOS (abrir como chat, abrir como
  terminal, renomear, fechar) com "Cancelar" separado.

### 2.2 Conversa
- **Barra de topo:** botão redondo ← · título centralizado (grupo e estado
  embaixo) · botão redondo ⋯. Entra deslizando da direita (pilha do iOS).
- **Chat é o padrão.** O menu ⋯ (folha de ações) tem: ver como terminal /
  voltar para o chat, modo de permissão, renomear, fechar.
- **Chat:** balão violeta para o usuário; Claude com avatar pequeno; edições e
  pedidos em blocos agrupados; botões grandes (Permitir em destaque, Sempre
  permitir, Negar em vermelho); campo em cápsula com o modo atual acima.
- **Terminal:** xterm em tela cheia + barra de teclas (esc, tab, ctrl, setas).
- Sem abas, sem divisões de painel (no celular é um terminal por vez).

### 2.3 PRs e Contas
- Reaproveitam as telas atuais dentro do shell do app (barra de topo + barra
  inferior). Contas: uso 5h/7d de cada conta e qual está ativa.

## 3. Navegação

- Cada tela entra no histórico do navegador (`history.pushState`): o **voltar
  do Android** (gesto ou botão) volta para a home em vez de sair da página.
- Abrir pelo link de notificação/QR cai direto na conversa daquele terminal.
- A tela atual sobrevive a recarregar a página (hash na URL: `#/t/<id>`).

## 4. Visual

- Idioma visual do iOS sobre o tema escuro: fundo preto, listas agrupadas
  (#121214, cantos 18 px, separadores de 0,5 px), títulos grandes (34 px),
  texto 16 px, alvos de toque ≥ 44 px. Fonte do sistema (SF no iPhone,
  Inter no Android). Ícones Lucide.
- Cor com parcimônia: violeta só na aba ativa, nos balões do usuário e no
  Permitir; estados em amarelo/laranja/verde; o resto em tons de cinza.
- **Barra de abas flutuante** (pílula com desfoque): Terminais · PRs · Contas;
  a ativa vira botão violeta com o nome.
- O mockup aprovado foi a referência visual (não faz parte do repositório).
- Área segura (`env(safe-area-inset-*)`) no topo e embaixo.
- Transições leves (deslizar ao abrir a conversa, ~180 ms); respeita
  "reduzir movimento".

## 5. Implementação

- Novo módulo `src/mobile.ts` (home, barra inferior, navegação) + CSS em
  bloco próprio `body.app …`. O modo celular atual (gaveta, abas) sai.
- Reaproveita: `status`/`agentState`/`stateLine`, `ChatView`, `Pane`,
  `accounts`, `prs`, e as ações já existentes (criar/renomear/fechar
  terminal, abrir chat).
- `main.ts` ganha só os ganchos (o que a home precisa ler e as ações).

## 6. Critérios de aceite

- [ ] Home mostra grupos e terminais em cartões, com estado ao vivo.
- [ ] "Aguardando você" aparece em destaque no topo.
- [ ] Toque abre a conversa em tela cheia; voltar (botão e gesto) volta à home.
- [ ] Chat por padrão; terminal pelo menu ⋯.
- [ ] Novo terminal pelo botão +; renomear/fechar pelo toque longo e pelo ⋯.
- [ ] PRs e Contas pela barra inferior.
- [ ] Recarregar a página mantém a tela; nada muda no desktop.
