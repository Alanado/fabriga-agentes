# Como usar a fábrica de agentes

Guia de uso, etapa por etapa. Os comandos usam o atalho `fab`. Se ele não existir no terminal, rode `alias fab="$PWD/.factory/bin/fab"` dentro do projeto, ou use `node .factory/fab.mjs`.

## Quem faz o quê

| Quem | Faz |
| --- | --- |
| Você | Decide o rumo, revisa os testes de aceite, aprova ou reprova cada merge |
| Claude (sessão principal) | Planeja, escreve pacotes e testes de aceite, resolve pedidos de recorte e testes defeituosos |
| Construtor | Escreve o código de uma tarefa, só dentro do recorte |
| Portão | Confere escopo, atalhos proibidos, `verify` e critérios. Automático, sem IA |
| Validador | Outro Claude, que só lê o diff e as evidências e dá o veredito |

## Comandos

| Comando | Faz |
| --- | --- |
| `fab doctor` | Confere ferramentas, autenticação, profile e Compose |
| `fab plan-check` | Valida pacotes, testes de aceite e sobreposição de recortes |
| `fab task <id>` | Roda uma tarefa (recria do zero se estava descartada) |
| `fab wave <n>` | Roda a onda inteira, com até 2 tarefas em paralelo |
| `fab status` | Mostra o estado de cada tarefa |
| `fab retry <id> [--reset-model]` | Libera uma tarefa parada e roda de novo |
| `fab approve <id>` | Faz o merge de uma tarefa aprovada |
| `fab reject <id> "motivo"` | Devolve ao construtor com o seu motivo |
| `fab discard <id>` | Remove worktree, branch e banco da tarefa |

## Etapa 0: preparar

1. Rode `fab doctor` e corrija o que estiver em vermelho. Dois itens podem ficar vermelhos até a Fase 0 terminar: o script `verify` e o `docker-compose.yml`.
2. Confira `.factory/profile.json`: perfil, `gate.verify`, portas, Compose.
3. A `main` precisa ter uma base que o `npm ci` consiga instalar (`package.json` e `package-lock.json`). Sem isso, nenhuma tarefa começa.
4. Deixe a `main` limpa (`git status`): arquivos soltos atrapalham o merge.

## Etapa 1: planejar (Claude, sessão principal)

Peça o plano numa sessão do Claude Code aberta na raiz do projeto. Modelo de prompt:

```
Use a skill fabrica-planejar para planejar a <FASE OU FEATURE>.

Contexto:
- Specs em <PASTA DAS SPECS>.
- A fábrica já está instalada em .factory/ (perfil <trabalho|pessoal>, 2 slots).
- Esta fase <é sequencial: crie as tarefas para rodar uma por vez | pode rodar em paralelo: separe os recortes>.

Objetivo: <O QUE DEVE EXISTIR NO FIM, EM POUCAS LINHAS>. Não implemente funcionalidades fora disso.

Para cada tarefa:
- Pacote em .factory/tasks/ com critérios numerados (CA1, CA2...), contexto de leitura mínimo, "Permitido alterar" e "Proibido alterar".
- Testes de aceite em .factory/acceptance/<id>/, com títulos "CA1: ...", "CA2: ...".
- Não escreva código de aplicação agora.

Ao final: rode `fab plan-check`, corrija o que ele apontar, faça commit e me mostre a lista de tarefas (id, título, tamanho, critérios).
```

O que revisar nos testes de aceite (eles definem o que é "pronto"):

- Cada critério tem um teste `CAn: ...`.
- O teste falha antes da tarefa e passa depois, e falha pelo motivo certo (algo ausente), não por erro do próprio teste.
- O teste não roda `npm run lint` nem `verify` do projeto inteiro: só checa os arquivos da própria tarefa.
- Sem `any`, `eslint-disable`, `@ts-ignore`, nem valores escritos só para passar.
- Se o teste valida um formato (regex, contrato, esquema), ele aceita um exemplo correto e reprova um errado.
- O caminho do teste é novo e fica fora de "Permitido alterar".
- Os recortes das tarefas da mesma onda não se sobrepõem.
- O plano não supõe arquivos que ainda não existem na `main`.

## Etapa 2: conferir o plano

Rode `fab plan-check`. Ele precisa terminar sem erro. Avisos amarelos você lê e decide. Se houver erro, peça ao Claude para corrigir o plano. Não rode a tarefa com plano quebrado.

## Etapa 3: rodar

- Uma tarefa: `fab task F0-01`.
- Uma onda: `fab wave 1`. Só use quando os recortes das tarefas não se tocam.
- Fases de base (infraestrutura, configuração): rode uma tarefa por vez, na ordem.

Não rode dois comandos `fab` ao mesmo tempo sobre a mesma tarefa. O `fab retry` já roda a tarefa de novo: não rode `fab task` em seguida.

## Etapa 4: acompanhar

`fab status` mostra o estado de cada tarefa. O que olhar quando algo parar:

| Onde | O que tem |
| --- | --- |
| `.factory/state/<id>.json` | Estado, modelo atual e `feedbackPendente` |
| `.factory/evidence/<id>/gate.json` | O que o portão conferiu e onde reprovou |
| `.factory/logs/` | Saída bruta dos agentes (mais recente por último) |
| `.factory/reviews/<id>.md` | Revisão do validador |
| `.factory/requests/<id>.md` | Pedido de recorte do construtor |

## Etapa 5: revisar e decidir

Quando a tarefa chega em `aguardando-aprovacao`, leia `.factory/reviews/<id>.md`.

- **Aprove** (`fab approve <id>`) se o veredito for "aprovado" e não houver problema de gravidade "bloqueia". Sugestões podem ficar para depois: anote ou peça ao Claude.
- **Reprove** (`fab reject <id> "motivo"`) se o resultado contraria o que você queria. Escreva o motivo como instrução curta: o que está errado e o que esperar. Exemplo: "o botão não aparece no mobile; ele deve aparecer abaixo de 768px".
- **Duvide da revisão** se ela diz que algo "não pôde ser comparado" com a spec. Peça ao Claude para conferir antes de aprovar.

## O que fazer em cada situação

| Estado | O que significa | O que fazer |
| --- | --- | --- |
| `aguardando-aprovacao` | O portão e o validador passaram | Ler a revisão e aprovar ou reprovar |
| `pedido-de-recorte` | O construtor quer mexer fora do recorte | Ver a seção abaixo |
| `bloqueada` | O portão reprovou várias vezes, ou o provedor falhou | Ver "Tarefa bloqueada" |
| `conflito` | A `main` mudou e o trabalho conflitou | `fab retry <id>` refaz sobre a `main` nova |
| `pausada-limite` | A conta do Claude bateu o limite | Esperar a renovação e rodar `fab wave <n>` ou `fab task <id>` |
| `reprovada-por-voce` | Você reprovou | O construtor já recebeu o motivo; rode `fab retry <id>` se ele não retomou |
| `descartada` | Você descartou | Para refazer, `fab task <id>` recria do zero |

### Pedido de recorte

Leia `.factory/requests/<id>.md` antes de qualquer ação. Há três casos.

**1. O pedido não pede nada de verdade** (é um relatório, ou diz que nada foi necessário). Apague e rode de novo:

```bash
rm -f .factory/requests/<id>.md
fab retry <id>
```

**2. O pedido é legítimo** (a tarefa precisa de um arquivo que o recorte não cobre). Peça ao Claude:

```
O construtor da <id> pediu recorte. Leia .factory/requests/<id>.md e decida:
amplie "Permitido alterar" só com o necessário (e confira se não invade outra
tarefa da mesma onda), ou explique por que o pedido deve ser recusado.
Se ampliar, atualize o pacote, rode `fab plan-check` e faça commit.
```

Depois, `rm -f .factory/requests/<id>.md` e `fab retry <id>`.

**3. O pedido aponta defeito no teste de aceite** (o teste não passa no lint, está errado, depende de algo que não existe). O construtor não pode editar testes, então a correção é do Claude, na origem:

```
O construtor da <id> aponta defeito no teste de aceite. Leia
.factory/requests/<id>.md, corrija o teste em .factory/acceptance/<id>/
(nunca a cópia no worktree), prove com um exemplo correto e um errado que
a correção funciona, rode `fab plan-check` e faça commit.
```

Depois, `fab discard <id>`, `rm -f .factory/requests/<id>.md` se existir, e `fab task <id>`.

### Tarefa bloqueada

1. Abra `.factory/state/<id>.json` e leia `feedbackPendente` e os últimos eventos de `historico`.
2. Abra `.factory/evidence/<id>/gate.json` para ver em que passo o portão reprovou.
3. Decida:
   - **Erro no pacote ou no teste:** peça ao Claude para corrigir (prompt do caso 3 acima).
   - **Erro de provedor ou modelo:** veja o log mais recente em `.factory/logs/`. Erro de uso (flag errada, modelo inexistente) não se resolve trocando de modelo.
   - **Construtor sem fazer nada** (portão: "Nenhum arquivo foi alterado"): o modelo falhou em usar ferramentas. Troque de modelo ou de perfil.
4. Libere com `fab retry <id>` (ou `fab retry <id> --reset-model` para voltar ao primeiro modelo da lista).

### Decisões que não são do construtor

Se o construtor mudar versão ou tecnologia contra a spec, ou se a revisão apontar divergência da spec, a escolha é sua. Peça ao Claude as opções antes de aprovar:

```
O construtor/revisão apontou divergência da spec em <ponto>. Mostre as opções
(manter a spec, manter o que foi feito, outra), com prós e contras, e o que
cada uma exigiria. Não altere nada antes da minha decisão.
```

Registre a decisão tomada em `docs/decisoes.md`.

## Onde registrar decisões

Teste: "se eu removesse a fábrica amanhã, essa decisão continuaria valendo?"

- **Sim:** `docs/decisoes.md` (stack, versões, nomes de infraestrutura, portas, formato de dados).
- **Não:** `.factory/DECISOES.md` (perfil e modelos, slots, o que é versionado em `.factory/`, políticas do portão e dos testes de aceite, permissões do construtor).
- Decisão do produto motivada pela fábrica fica em `docs/decisoes.md` com a linha "Motivo: fábrica (ver .factory/DECISOES.md)".
- `.env.example` e `docs/ambiente.md` são do produto. A fábrica só lê o `.env.example`.

O `.factory/DECISOES.md` é criado pelo instalador e nunca sobrescrito.

## Ambiente por slot

O `.env` de cada slot é gerado a partir do `.env.example`, com as portas de `env` somadas por slot (`portStep × slot`; slot 1: 3000 → 3100). O que o app grava fora do repositório (bancos, caches, volumes) não é coberto por isso: use `envExtra` no `profile.json`, com `{worktree}`, `{slot}` e `{id}`, para dar a cada slot o seu próprio caminho ou nome.

## Prompts prontos

- **Replanejar uma tarefa:** "Replaneje a tarefa <id>: <motivo>. Atualize o pacote e os testes de aceite, rode `fab plan-check` e faça commit."
- **Pedir uma segunda opinião antes de aprovar:** "Releia o diff da <id> (`git diff main...feat/<id>`) procurando valores fixos, atalhos e divergências da spec, e me diga se aprova."
- **Depois de uma fase:** "Resuma o que a fase entregou, o que ficou pendente e o que mudou nas decisões."

## Regras de ouro

1. Teste de aceite é do planejador. O construtor nunca edita teste, e ninguém usa `eslint-disable` para fazer um teste passar.
2. O construtor não decide stack nem versão. Isso é decisão sua.
3. Nunca coloque segredos em `.env.example`. O `.env` real nunca vai para o git.
4. Perfil trabalho: só `claude`, direto na conta da empresa. Nada de provedor gratuito, roteador ou código confidencial fora dela.
5. Perfil pessoal: modelos gratuitos podem reter e treinar com o que você envia. Use só em projeto sem segredo. Teste antes se o modelo consegue editar arquivos (alguns travam ao usar ferramentas).
6. Se algo deu errado duas vezes do mesmo jeito, pare e leia o log. Tentar de novo sem entender gasta cota.
7. Fases de base rodam uma tarefa por vez. Paralelo só quando os recortes não se tocam.

## Problemas comuns

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| `fab: command not found` | Alias não carregado | `alias fab="$PWD/.factory/bin/fab"` ou `node .factory/fab.mjs` |
| `worktree ... already exists` | Sobrou uma pasta de tentativa antiga | `git worktree remove --force <pasta>`, `git worktree prune`, tente de novo |
| `npm ci` falha por falta de lockfile | A `main` não tem `package-lock.json` | Gerar a base na `main` antes da fase |
| "Nenhum arquivo foi alterado" | O modelo não conseguiu usar as ferramentas | Ver o log; trocar de modelo ou de perfil |
| Pedido de recorte que não some | O arquivo em `.factory/requests/` continua lá | `rm -f .factory/requests/<id>.md` e `fab retry <id>` |
| Tarefa "descartada" que não roda | Estado antigo (versões antigas da fábrica) | `fab task <id>` (recria); se não funcionar, `rm .factory/state/<id>.json` |
| Portão reprova no lint por causa de outra tarefa | Teste de aceite rodando lint global | O Claude corrige o teste (caso 3) |
| O teste reprova a forma correta | Regex ou contrato do teste está errado | O Claude corrige na origem e prova com um exemplo correto e um errado (caso 3) |
