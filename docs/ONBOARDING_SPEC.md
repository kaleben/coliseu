# Primeiros passos (onboarding) — spec

Tela cheia, preta, em passos, que aparece no primeiro uso do app do PC e deixa o
Coliseu pronto: ferramentas, conta do Claude, primeiro grupo, GitHub, celular e
avisos. Baseada no protótipo aprovado (artefato "Onboarding do Coliseu").

## Quando aparece

- Só no app do PC (`api.native`). No celular, nunca.
- Na primeira abertura: `settings.onboarding.done` ausente **e** nenhum terminal
  criado (quem já usava o Coliseu não vê a tela ao atualizar).
- Pode ser refeita em Configurações → Aparência → "Refazer os primeiros passos".
- Fechar (✕ "Configurar depois") ou concluir grava `onboarding.done = true`.

## Passos

| # | Passo | O que faz de verdade |
|---|-------|----------------------|
| 0 | 👋 Bem-vindo | Texto. |
| 1 | 🧰 Ferramentas | Verifica `tmux`, `claude`, `node` (obrigatórios) e `gh`, `xdotool` (opcionais) no shell do usuário. Para o que falta, oferece a linha de terminal com o comando de instalação (`sudo apt install …` para os do apt; o instalador oficial para o Claude Code). |
| 2 | 🔑 Conta | Lista as contas (`accounts_list`; a logada no `~/.claude` já entra sozinha). Sem conta: login oficial (abre o navegador e pede o código colado, o mesmo fluxo da tela de contas). |
| 3 | 🗂️ Grupo | Sugere pastas com git em `~` (até 3 níveis), campo de pasta com o seletor de pastas do sistema (plugin de diálogo do Tauri; dentro do HOME vira `~/…` e o nome do grupo vem da pasta), nome e cor. "Criar grupo" grava de verdade. Ao criar o primeiro, o grupo padrão "Projetos" some se estiver vazio. |
| 4 | 🐙 GitHub (opcional) | Mostra o login do `gh` ou a linha `gh auth login --web`. Chave "Mostrar pull requests" = `settings.prs.enabled`. |
| 5 | 📱 Celular (opcional) | Um passo por vez, em dois lados (💻 Neste PC / 📱 No celular); os feitos viram uma linha com ✓ e os próximos só a contagem. PC: Tailscale conectado (instalador + `sudo tailscale up`), HTTPS na tailnet (painel DNS, confere sozinho), operador (`sudo tailscale set --operator=$USER`), ligar o acesso. Celular: Android/iPhone → QR da loja do Tailscale e espera o celular aparecer na tailnet; QR do Coliseu; "Adicionar à tela inicial" do sistema escolhido + Receber notificações. |
| 6 | 🔔 Avisos | Chaves de `settings.notify` (aguardando, concluiu, som, só em segundo plano), "Testar um aviso" e o cartão do ditado com a chave "Ligar o ditado no PC". |
| 7 | 🏛️ Pronto | Resumo do que foi feito/ficou para depois, atalhos e "Abrir o primeiro terminal" (no primeiro grupo criado). |

## Linha de terminal

O Coliseu é um terminal, então o comando roda num terminal de verdade, embutido
no cartão: um terminal tmux temporário (título "configuração") recebe o comando,
e a senha do `sudo` é digitada ali mesmo. Enquanto ele está aberto, a tela
reverifica a cada 2 s; quando a verificação passa, o passo fica ✓. O terminal
temporário é encerrado ao sair do passo ou fechar a tela. Também há "Copiar".

## Backend (`onboard.rs`)

- `setup_check()` → ferramentas encontradas (no shell interativo do usuário, para
  achar `nvm`, `~/.local/bin`…), login do `gh`, estado do Tailscale (instalado,
  conectado, HTTPS, operador), ditado ligado.
- `setup_projects()` → pastas com `.git` em `~` (até 3 níveis, sem ocultas e
  `node_modules`), mais recentes primeiro, no máximo 8.
- `voice_set(on)` → liga/desliga `voiceEnabled` + `voice` (modo tap) em
  `~/.claude/settings.json` e o atalho `meta+k → voice:pushToTalk` em
  `~/.claude/keybindings.json`, preservando o resto dos arquivos.

## Fora do escopo

Instalação sem apt (outras distros recebem só o comando para copiar).
