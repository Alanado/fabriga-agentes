---
id: F-00
titulo: Título curto da feature
onda: 1
depende_de: []
tamanho: M            # P -> Haiku, M/G -> Sonnet (perfil trabalho)
slot:                 # opcional; vazio = primeiro slot livre
tentativas_max: 2     # reprovações do validador antes de trocar de modelo
---

## Objetivo
Uma frase do que o usuário passa a conseguir fazer.

## Critérios de aceite
- [ ] CA1: comportamento observável e testável
- [ ] CA2: ...

## Contexto (ler)
- caminho/do/arquivo.ts

## Permitido alterar
- src/pasta/da/feature/**

## Proibido alterar
- tests/acceptance/**
- qualquer arquivo fora de "Permitido alterar"

## Testes de aceite (já escritos pelo Claude)
<!-- caminho final no projeto; o arquivo fica em .factory/acceptance/F-00/<caminho> -->
- tests/acceptance/F-00.spec.ts

## Notas
Decisões já tomadas, armadilhas conhecidas, padrões do projeto a seguir.
