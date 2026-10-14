# Fábrica de agentes

O Claude planeja e valida; agentes construtores mais baratos escrevem o código, cada um no seu git worktree. Um portão automático prova o trabalho antes de qualquer token de validação, e você aprova cada merge.

- **Perfil trabalho:** construtores em Claude Sonnet/Haiku (`claude -p`), tudo dentro da conta Team.
- **Perfil pessoal:** construtores gratuitos via OpenCode (NVIDIA Kimi K3, GLM 5.3), validador Claude (conta Pro).

Requisitos: Node 20+, git, Claude Code autenticado; OpenCode no perfil pessoal; Docker Compose se o projeto usa banco.

## Instalar num projeto

```bash
./install.sh /caminho/do/projeto --perfil trabalho   # ou --perfil pessoal
cd /caminho/do/projeto
alias fab="$PWD/.factory/bin/fab"
fab doctor
```

O instalador cria `.factory/` (orquestrador, templates, configuração), as skills `fabrica-planejar` e `fabrica-operar` em `.claude/skills/`, uma seção curta no `CLAUDE.md` e entradas no `.gitignore`, e copia o guia de uso para `.factory/COMO-USAR.md` (sobrescrito a cada execução; o `CLAUDE.md` do projeto ganha uma linha apontando para ele).

Estrutura criada no projeto:

```
.factory/
  fab.mjs  lib/  bin/fab     orquestrador (sempre atualizado)
  templates/                 regras do construtor e do revisor, modelo de tarefa
  examples/                  perfis de exemplo
  COMO-USAR.md               guia de uso (sobrescrito)
  profile.json models.json plan.md   configuração (criada uma vez)
  DECISOES.md                decisões da fábrica (criado uma vez, nunca sobrescrito)
  tasks/ acceptance/         pacotes e testes de aceite (versionados)
  state/ logs/ evidence/ reviews/ requests/   operacional (no .gitignore)
.claude/skills/              fabrica-planejar, fabrica-operar
docs/decisoes.md             decisões do produto (do projeto, não da fábrica)
```

Decisões do produto vão em `docs/decisoes.md`; decisões da fábrica em `.factory/DECISOES.md`. `.env.example` e `docs/ambiente.md` são do produto.

Rodar de novo atualiza o código e as regras, sem tocar em `profile.json`, `models.json` e `plan.md`.

Para versionar as skills, o `.gitignore` do projeto deve usar `.claude/*` seguido de `!.claude/skills/` (um `.claude/` inteiro ignorado impede a exceção).

## Ciclo de trabalho

1. **Planejar (Claude, sessão principal):** "planeje a onda 1 a partir de docs/specs/…". A skill `fabrica-planejar` escreve os pacotes em `.factory/tasks/`, os testes de aceite em `.factory/acceptance/<id>/`, roda `fab plan-check` e commita.
2. **Revisar os testes de aceite (você),** pelo menos nas primeiras ondas. Eles são a definição de pronto.
3. **Rodar:** `fab wave 1`. Para cada tarefa, até `slots` em paralelo:
   - cria o worktree `feat/<id>` com os testes de aceite como primeiro commit, `.env` com portas do slot e banco próprio;
   - roda o construtor com permissões restritas ao recorte;
   - roda o portão (escopo, testes de aceite intocados, atalhos proibidos, `verify`, cobertura de cada CA);
   - se o portão reprova, devolve só o trecho do erro ao construtor; se passa, o Claude valida com o diff e as evidências.
4. **Aprovar (você):** leia `.factory/reviews/<id>.md` e rode `fab approve <id>` (ou `fab reject <id> "motivo"`). O merge é `--no-ff`; os outros worktrees abertos recebem a main nova e passam no portão de novo.

## Comandos

| Comando | Faz |
| --- | --- |
| `fab doctor` | Confere ferramentas, autenticação, profile, Compose e scripts |
| `fab plan-check` | Valida pacotes, critérios, testes de aceite e sobreposição de recortes por onda |
| `fab wave <n>` | Roda a onda inteira |
| `fab task <id>` | Roda uma tarefa |
| `fab retry <id> [--reset-model]` | Libera tarefa bloqueada, em conflito, reprovada ou com pedido de recorte |
| `fab approve <id>` | Commit, merge na main, limpeza do slot, rebase dos abertos |
| `fab reject <id> "motivo"` | Devolve ao construtor com o seu motivo |
| `fab discard <id>` | Remove worktree, branch e banco do slot |
| `fab status` | Tabela das tarefas |
| `fab new`, `fab gate`, `fab review`, `fab sync` | Etapas avulsas, para diagnóstico |

## Estados de uma tarefa

| Estado | O que fazer |
| --- | --- |
| `aguardando-aprovacao` | Ler a revisão e aprovar ou reprovar |
| `bloqueada` | Ver `feedbackPendente` em `.factory/state/<id>.json`; corrigir o pacote ou o teste e `fab retry` |
| `pedido-de-recorte` | Ler `.factory/requests/<id>.md`; ampliar o pacote (ou explicar em Notas) e `fab retry` |
| `conflito` | `fab retry` refaz a tarefa sobre a main nova |
| `pausada-limite` | A conta do Claude bateu o limite; `fab wave <n>` depois da renovação (retoma sem gastar o construtor de novo quando o portão já tinha passado) |

## Configuração (`.factory/profile.json`)

| Chave | Para quê |
| --- | --- |
| `perfil` | `trabalho` (Claude) ou `pessoal` (OpenCode) |
| `slots` | Agentes em paralelo |
| `env` | Portas base; cada slot soma `portStep × slot` (slot 1: 3000 → 3100) |
| `envExtra` | Variáveis por slot, com `{worktree}`, `{slot}`, `{id}`. Use para todo estado que o app grava fora do repositório |
| `compose` | Um projeto Docker Compose por slot (`fab-<repo>-s<n>`), recriado a cada tarefa |
| `setup` | Comandos rodados no worktree novo (ex.: `npm ci`) |
| `gate.verify` | Comando único de prova (lint, build, testes). Deve rodar a pasta de testes de aceite e nunca `.factory/` |
| `gate.acceptance` | Roda só os testes de aceite da tarefa e grava um relatório JSON (`{files}`, `{report}`). Os títulos dos testes contêm o id do critério (`CA1: …`) |
| `gate.lintAcceptance` | Opcional (padrão `null`, desligado). Comando de lint (`{files}`) rodado pelo `fab plan-check` sobre os testes de aceite de cada tarefa; erros reprovam o plano. Exemplo: `npx eslint --no-ignore {files}` |
| `limits` | Tentativas do portão e do validador, trocas de modelo, turnos e timeout do construtor |
| `review` | Modelo e esforço do validador |

Os modelos de cada perfil ficam em `.factory/models.json`, em ordem de troca. No perfil trabalho, o `tamanho` do pacote escolhe a cadeia (P → Haiku, M/G → Sonnet).

O exemplo para a Trilha DTI-Mob está em `.factory/examples/profile.trilha-dtimob.json`.

## Segurança

- O perfil trabalho só chama `claude`. Código da empresa nunca vai para um provedor gratuito.
- O construtor só edita o recorte (regras de permissão geradas por tarefa, fora do worktree); não lê `.env`; não faz commit, push, checkout, reset, curl ou wget; não acessa a web.
- O portão confere o escopo de novo pelo diff, então a permissão é a primeira barreira, não a única.
- O validador roda numa pasta só com o pacote de revisão e só tem ferramentas de leitura.
