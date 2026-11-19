# Coliseu — Modo Chat (spec)

> Branch: `chat`. Escopo desta entrega: **Etapa 1** (chat básico) e **Etapa 2**
> (permissões, perguntas, plano, interromper, modo). Etapas 3 e 4 ficam
> descritas no fim como trabalho futuro.

## 1. Objetivo

Permitir conversar com o Claude Code de um terminal do Coliseu em **formato de
chat** (bolhas, botões), principalmente no celular, onde o terminal é ruim de
usar. A conversa é a **mesma sessão** do Claude do terminal: dá para ir e voltar
entre Terminal e Chat sem perder contexto.

**Não-objetivos (agora):** Codex no chat (etapa 4), renderização rica de diffs e
cartões detalhados (etapa 3), imagens/anexos, múltiplos chats por terminal.

## 2. Decisões

| Tema | Decisão | Motivo |
|---|---|---|
| Motor | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, TS) | Eventos estruturados: mensagens, `canUseTool` (permissões e `AskUserQuestion`), `resume`, `interrupt()`, `setPermissionMode()`, `getSessionMessages()` |
| Onde roda | **Processo auxiliar Node** (`sidecar/agent.mjs`), um por app, vários chats | O SDK é TS; o backend é Rust. Comunicação por stdin/stdout, JSON por linha |
| Binário do Claude | `pathToClaudeCodeExecutable` = o `claude` do usuário (`~/.local/bin/claude`) | Mesma versão, mesmo login/assinatura, mesmas skills/plugins/hooks |
| Conta | `env.CLAUDE_SECURESTORAGE_CONFIG_DIR` = link do terminal (`term/<id>`) | Mesma conta (fixa ou global) do terminal |
| Uso/cobrança | Assinatura (login), **sem** `--bare` / API key | Igual ao terminal; desconta das mesmas barras 5h/7d |
| Terminal × Chat | **Nunca os dois ao mesmo tempo** na mesma sessão (padrão do Happy) | Dois processos não podem escrever a mesma sessão |
| Identidade | `chatId = termId` (um chat por terminal) | Simples; o chat "é" o terminal em outro modo |
| Estado do chat | Em memória (core Rust + sidecar). Fechar o app encerra o chat; a sessão continua no disco e pode ser retomada | Evita estados órfãos |

## 3. Fluxos

### 3.1 Terminal → Chat ("Abrir como chat")
1. O core identifica o Claude do terminal (scan atual): `pid`, `sessionId`, `cwd`, opções da linha de comando.
2. Se o Claude está **processando**, recusa com mensagem ("espere terminar ou interrompa"). Se está parado/aguardando, segue.
3. Encerra o Claude do terminal com **SIGTERM** e espera o processo sumir (≤ 5 s). O shell do terminal volta ao prompt.
4. Inicia o chat no sidecar com `resume = sessionId`, `cwd`, conta do terminal e modo de permissão derivado das opções originais (`--dangerously-skip-permissions` → `bypassPermissions`; `--permission-mode X` → `X`; senão `default`).
5. A UI troca o painel do terminal pela tela de chat e carrega o histórico (`getSessionMessages`).

Sem Claude no terminal: "Novo chat" inicia uma sessão nova no `cwd` atual do terminal.

### 3.2 Chat → Terminal ("Voltar ao terminal")
1. Se o chat está processando: `interrupt()` e espera o fim do turno (≤ 5 s).
2. Fecha o chat (encerra a entrada do SDK; o processo do Claude termina).
3. Digita no terminal `claude --resume <sessionId> <opções equivalentes>` (mesmo construtor da restauração pós-reboot).
4. A UI volta a mostrar o terminal.

### 3.3 Mensagens
- Envio: o texto entra na fila de entrada (modo *streaming input*) — dá para mandar mensagem enquanto o Claude trabalha (fica na fila do SDK).
- Resposta em tempo real com `includePartialMessages` (deltas de texto).
- Fim de turno: mensagem `result` (duração, custo estimado — só informativo).

### 3.4 Permissões e perguntas (etapa 2)
`canUseTool(toolName, input, opts)` no sidecar vira um **pedido** para a UI e espera a resposta:

| Caso | UI | Resposta ao SDK |
|---|---|---|
| Ferramenta comum | Cartão com `opts.title` (ou nome+resumo do input), botões **Permitir**, **Sempre permitir** (se há `suggestions` e não `suppressAlwaysAllowRule`), **Negar** (com motivo opcional) | `allow{updatedInput: input [, updatedPermissions]}` / `deny{message}` |
| `AskUserQuestion` | Cada pergunta com opções em botões (`multiSelect` = vários), opção **Outro** com texto livre, **Enviar** | `allow{updatedInput:{questions, answers}}` |
| `ExitPlanMode` | Plano renderizado + **Aprovar plano** / **Continuar planejando** | `allow{updatedInput}` / `deny{message}` |

- Um pedido pendente deixa o terminal com estado **aguardando você** (sidebar, notificação).
- Pedido respondido em um aparelho some nos outros (evento `permission_resolved`).
- Se o turno for interrompido, pedidos pendentes são cancelados (sinal `opts.signal`).

### 3.5 Interromper e modo
- **Parar**: `interrupt()`.
- **Modo**: seletor `default | acceptEdits | plan | auto | bypassPermissions` → `setPermissionMode()`. `bypassPermissions` só se o chat foi iniciado com `allowDangerouslySkipPermissions` (derivado do terminal).

## 4. Protocolo core ⇄ sidecar (JSON por linha)

Core → sidecar:
```jsonc
{ "op": "start",    "chatId": "…", "cwd": "…", "resume": "uuid|null", "env": {…}, "claudePath": "…", "permissionMode": "default", "allowBypass": false }
{ "op": "send",     "chatId": "…", "text": "…" }
{ "op": "respond",  "chatId": "…", "requestId": "…", "result": { "behavior": "allow", … } }
{ "op": "interrupt","chatId": "…" }
{ "op": "mode",     "chatId": "…", "mode": "acceptEdits" }
{ "op": "close",    "chatId": "…" }
{ "op": "history",  "chatId": "…", "reqId": 1, "sessionId": "…", "limit": 200 }
```
Sidecar → core:
```jsonc
{ "chatId": "…", "ev": "started",  "sessionId": "…|null" }
{ "chatId": "…", "ev": "message",  "msg": { /* SDKMessage */ } }
{ "chatId": "…", "ev": "permission", "requestId": "…", "toolName": "…", "input": {…}, "title": "…", "description": "…", "canAlways": true, "suggestions": [...] }
{ "chatId": "…", "ev": "permission_resolved", "requestId": "…" }
{ "chatId": "…", "ev": "state",    "busy": true }
{ "chatId": "…", "ev": "closed",   "error": "…|null" }
{ "reqId": 1, "ev": "history", "messages": [...] }
```

## 5. Core (Rust) — `chat.rs`

- Sobe o sidecar sob demanda (`node sidecar/agent.mjs`), localizando o `node` via shell de login; reinicia se cair.
- Repassa eventos para a UI desktop (`app.emit("chat-event")`) e para todos os celulares conectados (WebSocket).
- Mantém por `chatId`: `sessionId`, `busy`, pedidos pendentes, modo, opções originais (para voltar ao terminal).
- Comandos (Tauri e WebSocket): `chat_open(termId)`, `chat_send`, `chat_respond`, `chat_interrupt`, `chat_set_mode`, `chat_close(termId)` (volta ao terminal), `chat_history(termId)`, `chat_state()`.
- `terms_status`: terminal em modo chat reporta `claude` a partir do estado do chat (processando / aguardando você / parado), para sidebar e notificações continuarem funcionando.

## 6. UI

- Botão **Chat ⇄ Terminal** na barra de abas (e no menu do terminal). No celular o botão fica visível no topo.
- Painel em modo chat: lista de mensagens + compositor.
  - Usuário: bolha à direita. Claude: texto em **markdown** (sanitizado) à esquerda; *thinking* recolhido; uso de ferramenta como linha compacta (`Bash · comando`, `Edit · arquivo`) com resultado recolhível.
  - Cartões de permissão / pergunta / plano conforme 3.4.
  - Compositor: Enter envia (desktop), Shift+Enter quebra linha; no celular, botão Enviar. Botão **Parar** enquanto processa. Seletor de modo.
- A barra de teclas do celular some no modo chat.

## 7. Critérios de aceite

**Etapa 1**
- [x] Terminal com Claude parado → "Abrir como chat" encerra o TUI e abre o chat com o histórico da mesma sessão.
- [x] Enviar mensagem → resposta aparece em tempo real; fim de turno registrado.
- [x] "Voltar ao terminal" → `claude --resume` no terminal continua a mesma conversa (inclui o que foi dito no chat).
- [x] Mesma conta do terminal; consumo aparece nas barras de uso.
- [x] Funciona no celular (WebSocket) e no desktop; estado sincronizado entre os dois.
- [x] Sidebar mostra processando/parado para terminal em modo chat.

**Etapa 2**
- [x] Pedido de permissão vira cartão; Permitir/Negar/Sempre permitir funcionam; estado "aguardando você" + notificação.
- [x] `AskUserQuestion` com escolha única, múltipla e texto livre.
- [x] Aprovação de plano.
- [x] Parar interrompe o turno; pedidos pendentes somem.
- [x] Trocar o modo de permissão no meio da conversa.

## 8. Riscos

| Risco | Mitigação |
|---|---|
| SDK muda rápido | Versão fixada no `package.json` do sidecar; protocolo próprio isola a UI |
| SIGTERM com turno em andamento perde o turno | Só permite abrir como chat com o Claude parado/aguardando |
| `node` fora do PATH do app (aberto pelo menu) | Localiza via shell de login; erro claro se não houver |
| Texto do modelo em markdown → XSS na UI | Sanitização (DOMPurify) antes de inserir |
| Pedidos de permissão do celular | Já protegidos pelo token do acesso remoto |

## 9. Etapa 3 — cartões ricos

Só frontend (`src/chat.ts` + CSS); o sidecar já repassa tudo. Prioridade pelo
uso real (transcripts): Bash ≫ Edit > Read > Agent > Write; tarefas são raras.

| Ferramenta | Linha (resumo) | Corpo (ao expandir) |
|---|---|---|
| `Edit` / `MultiEdit` | arquivo + `+N −M` | diff de linhas (old → new), linhas de contexto recolhidas |
| `Write` | arquivo + `+N linhas` | conteúdo como adições (até 200 linhas) |
| `Bash` | `description` (ou o comando) | comando completo + saída com **cores ANSI** |
| `Agent` / `Task` | tipo · descrição + estado (rodando/concluído) | atividade ao vivo do subagente (nº de ferramentas, última ação) e resposta final em markdown |
| `TodoWrite`, `TaskCreate`, `TaskUpdate` | linha discreta | — (vai para o painel de tarefas) |

- **Permissão** de `Edit`/`Write`: o cartão mostra o diff (para aprovar pelo celular sabendo o que muda).
- **Painel de tarefas**: barra fixa acima do compositor com `concluídas/total` e a tarefa atual; toque expande a lista. Montado a partir de `TodoWrite.todos` ou de `TaskCreate` (id lido do resultado `Task #N`) + `TaskUpdate`. Some quando não há tarefas.
- **Subagente ao vivo**: mensagens com `parent_tool_use_id` (hoje ignoradas) atualizam o cartão do `Agent` correspondente; não entram na conversa principal.
- **Resultado do Agent** — preferir o dado estruturado (`tool_use_result` ao vivo; no histórico o sidecar anexa o `toolUseResult` lido do arquivo da sessão): `status: async_launched` = segundo plano (cartão segue rodando até `system/task_notification` ou `<task-notification>`). O texto (aviso "Async agent launched…") só é usado como reserva.
- **Relatório entregue à parte**: versões novas do Claude Code mandam o relatório como mensagem enfileirada `<agent-message from="agentId">` e o resultado da ferramenta só aponta para ela. O SDK não repassa essa mensagem ao vivo; o sidecar lê as linhas novas do arquivo da sessão quando chega o ponteiro ou um `task_notification` e emite `agent_report {agentId, text}`. No histórico ela vem como mensagem do usuário (escondida da conversa) e vai para o cartão pelo `agentId`.
- Limites: diff calculado por LCS só até 600×600 linhas (acima disso: tudo removido/adicionado); saídas cortadas em 6000 caracteres.

**Critérios de aceite (etapa 3)**
- [x] Edit mostra diff com +/− e cores; Write mostra o conteúdo novo.
- [x] Pedido de permissão de Edit/Write mostra o diff.
- [x] Saída de comando com cores ANSI renderizadas (sem códigos crus).
- [x] Agent mostra progresso ao vivo e a resposta final.
- [ ] Painel de tarefas acompanha TaskCreate/TaskUpdate e TodoWrite. *(lógica testada isolada; o Claude do SDK nesta versão não expõe essas ferramentas, então não deu para ver ao vivo)*
- [x] Histórico (sessão retomada) renderiza os mesmos cartões.

## 10. Futuro

- Anexos/imagens no compositor.
- **Etapa 4:** Codex no chat via `codex app-server` (JSON-RPC), com o cliente do Happy (MIT) como referência.
