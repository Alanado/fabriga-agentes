---
name: fabrica-operar
description: Opera a fábrica de agentes - roda ondas e tarefas com o comando fab, interpreta bloqueios, pedidos de recorte e conflitos, e prepara a aprovação do humano. Use quando o pedido for rodar, acompanhar, destravar ou aprovar tarefas da fábrica.
---

# Operar a fábrica

O orquestrador é determinístico: `node .factory/fab.mjs <comando>`. Ele chama os construtores, o portão e o validador sozinho. Seu papel é decidir nos pontos em que ele para. Não leia código nem logs inteiros: leia estado, revisão e o trecho de erro.

## Comandos

| Comando | Quando |
| --- | --- |
| `fab status` | Sempre que precisar saber onde as coisas estão |
| `fab wave N` | Rodar a onda N (até `slots` tarefas em paralelo) |
| `fab task ID` | Rodar uma tarefa isolada |
| `fab retry ID [--reset-model]` | Depois de resolver um bloqueio, pedido ou conflito |
| `fab approve ID` | Só quando o humano disser que aprova |
| `fab reject ID "motivo"` | Quando o humano reprovar |
| `fab discard ID` | Abandonar a tarefa |

Rode `fab wave` em segundo plano quando o terminal permitir; uma onda pode levar bastante tempo.

## Quando a fila para

- **aguardando-aprovacao:** leia `.factory/reviews/ID.md` e o `diffstat.txt` em `.factory/evidence/ID/`. Mostre ao humano o resumo da revisão e o diffstat. Não aprove por ele.
- **bloqueada:** leia o último evento em `.factory/state/ID.json` e o `feedbackPendente`. Causas comuns: pacote ambíguo (corrija o pacote e rode `fab retry ID`), teste de aceite errado (corrija o teste, commite e rode `fab retry ID`), tarefa grande demais (quebre em duas).
- **pedido-de-recorte:** leia `.factory/requests/ID.md`. Se fizer sentido, adicione o arquivo a "Permitido alterar" (conferindo que não colide com outra tarefa da onda), commite o pacote e rode `fab retry ID`. Se não, explique no pacote, em Notas, como resolver sem esse arquivo.
- **conflito:** a main recebeu outra feature. `fab retry ID` faz o agente refazer sobre a main nova.
- **pausada-limite:** a conta do Claude atingiu o limite. Avise o humano e retome com `fab wave N` depois que a janela renovar.

## Economia

- Não releia o pacote inteiro para diagnosticar: o estado e o feedback bastam na maioria dos casos.
- Não rode o validador à mão (`fab review`) sem necessidade; o `fab task` já roda.
- Entre tarefas não relacionadas, use `/clear`.
