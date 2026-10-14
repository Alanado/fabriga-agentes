# Decisões da fábrica

Decisões sobre a própria fábrica neste projeto: perfil e modelos, número de slots, o que é versionado em `.factory/`, políticas do portão e dos testes de aceite, permissões do construtor.
Decisões do produto (stack, versões, portas, formato de dados) ficam em `docs/decisoes.md`.

Cada entrada: data, contexto, decisão, alternativa descartada.

<!--
## 2026-01-15 · Dois slots em paralelo

- **Contexto:** a máquina aguenta dois bancos e dois servidores de desenvolvimento ao mesmo tempo.
- **Decisão:** `slots: 2` no `profile.json`.
- **Alternativa descartada:** 4 slots; os testes de integração ficaram instáveis por falta de memória.
-->
