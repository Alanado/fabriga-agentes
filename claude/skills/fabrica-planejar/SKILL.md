---
name: fabrica-planejar
description: Planeja uma onda da fábrica de agentes - quebra specs em pacotes de tarefa (.factory/tasks), escreve os testes de aceite e confere o plano. Use quando o pedido for planejar features, uma fase ou uma onda para os agentes construtores.
---

# Planejar uma onda da fábrica

Você é o planejador. Seu trabalho define o custo de tudo que vem depois: um pacote bem recortado é barato de construir e de validar. Planeje a onda inteira de uma vez, lendo as specs uma única vez.

## Passos

1. **Leia só o necessário.** As specs da fase, `.factory/plan.md` e a estrutura de pastas (`git ls-files | head -200` ou equivalente). Não leia o código inteiro.
2. **Quebre em features pequenas.** Cada uma deve caber em poucos arquivos e ter de 2 a 5 critérios de aceite observáveis. Marque `tamanho`: P (migration, teste, ajuste pontual), M (feature comum), G (evite; quebre se puder).
3. **Contratos primeiro.** Tudo que duas features da mesma onda precisariam alterar (schema, tipos, rotas, componentes base, config) vai para uma tarefa de contratos numa onda anterior.
4. **Escreva os pacotes** em `.factory/tasks/<id>.md`, a partir de `.factory/templates/task.md`:
   - `Contexto (ler)`: arquivos, nunca pastas inteiras; no máximo 10.
   - `Permitido alterar`: globs o mais estreitos possível. Duas tarefas da mesma onda não podem ter globs que se sobrepõem.
   - `Notas`: decisões já tomadas e padrões do projeto que o construtor deve seguir, para ele não precisar descobrir sozinho.
5. **Escreva os testes de aceite antes.** Eles ficam em `.factory/acceptance/<id>/`, espelhando o caminho final no projeto: um teste que vai morar em `tests/acceptance/F-03.spec.ts` é escrito em `.factory/acceptance/F-03/tests/acceptance/F-03.spec.ts`, e o pacote lista `tests/acceptance/F-03.spec.ts` em "Testes de aceite". O orquestrador os coloca no branch da tarefa como primeiro commit; assim eles só entram na main com o merge e não quebram o `verify` das outras tarefas da onda. Regras:
   - O título de cada teste contém o id do critério: `test('CA1: filtra por status pago', ...)`. O portão confere isso.
   - Testam comportamento observável (HTTP, tela, saída de CLI), não detalhes internos.
   - Devem **falhar** antes da implementação. Para confirmar, copie um para o caminho final, rode, e apague a cópia.
   - O `verify` do projeto deve rodar a pasta de testes de aceite (para os já mergeados virarem regressão), mas nunca `.factory/`.
6. **Atualize `.factory/plan.md`** com o mapa de dependências. Registre cada decisão no arquivo certo (ver "Onde registrar decisões").
7. **Confira:** `node .factory/fab.mjs plan-check`. Corrija até passar.
8. **Commite** pacotes, testes de aceite e plano na main (`chore(fabrica): planeja onda N`). O worktree nasce da main; sem commit, o construtor não vê os testes.
9. Mostre ao humano: a lista de tarefas da onda, o que cada uma toca e o comando para rodar (`node .factory/fab.mjs wave N`). Ele revisa os testes de aceite das primeiras ondas.

## Onde registrar decisões

Teste: "se eu removesse a fábrica amanhã, essa decisão continuaria valendo?"

- **Sim, é do produto** (stack, versões, nomes de infraestrutura, portas, formato de dados): `docs/decisoes.md`.
- **Não, é da fábrica** (perfil e modelos, número de slots, o que é versionado em `.factory/`, políticas do portão e dos testes de aceite, permissões do construtor): `.factory/DECISOES.md`.
- Decisão do produto motivada pela fábrica (ex.: container sem nome fixo para rodar 2 slots) fica em `docs/decisoes.md` com a linha "Motivo: fábrica (ver .factory/DECISOES.md)", e a razão detalhada em `.factory/DECISOES.md`.
- `.env.example` e `docs/ambiente.md` são do produto (raiz e `docs/`). A fábrica só lê o `.env.example` para gerar o `.env` de cada slot.

Formato das entradas: data, contexto, decisão, alternativa descartada. Ao planejar, decisões de recorte, dependências e políticas de teste da onda vão para `.factory/DECISOES.md`; decisões de stack e contratos do produto vão para `docs/decisoes.md`, e as `Notas` do pacote apontam para a entrada relevante.

## Dicas de custo

- Um pacote com bons `Contexto` e `Notas` economiza dezenas de leituras do construtor.
- Prefira duas tarefas P a uma G.
- Se a feature exige ver a tela, inclua no teste Playwright um `page.screenshot()` por critério; o validador olha as imagens em vez de abrir o navegador.

## Checklist antes de entregar um plano

Obrigatório. Só entregue o plano ao humano depois de cumprir todos os itens.

1. Rodar `fab plan-check` e corrigir tudo.
2. Os testes de aceite não podem rodar `npm run lint`, `npm run verify` nem qualquer comando que cubra o projeto inteiro: devem checar só os arquivos da própria tarefa.
3. Nada de `any`, `eslint-disable`, `@ts-ignore` ou valores escritos só para passar no teste.
4. Cada CA tem um teste "CAn: ...".
5. O caminho do teste de aceite é novo e fica fora de "Permitido alterar".
6. O plano não pressupõe arquivos que ainda não existem na main (por exemplo `package.json`) sem uma tarefa que os crie.
7. Todo teste que valida um formato (regex, contrato, esquema, nome de arquivo) precisa ser provado com um exemplo correto, que deve passar, e um exemplo errado, que deve reprovar. Rode essa prova rapidamente antes de entregar.
8. Cada teste de aceite deve ser rodado uma vez contra a base atual da main para confirmar que falha pelo motivo certo (arquivo ou comportamento ausente), e não por erro do próprio teste (lint, importação, tipo).

## Quando o construtor pede recorte

Leia o pedido em `.factory/requests/<id>.md` antes de agir.

- **Relatório, ou diz que nada foi necessário:** não é pedido. Mande apagar o arquivo (`rm -f .factory/requests/<id>.md`) e rodar `fab retry <id>`.
- **Pedido legítimo:** amplie "Permitido alterar" só com o necessário e confira a sobreposição com as outras tarefas da onda (`fab plan-check`). Faça commit e oriente a apagar o pedido e rodar `fab retry <id>`.
- **Aponta defeito no teste de aceite:** corrija o teste na origem (`.factory/acceptance/<id>/`), nunca a cópia no worktree, provando com um exemplo correto e um errado. Faça commit e oriente o usuário a descartar e recriar a tarefa (`fab discard <id>`, apagar o pedido, `fab task <id>`).
