## Fábrica de agentes

Este projeto usa a fábrica de agentes (`.factory/`).

- **Se você recebeu um `<pacote-de-tarefa>`, você é o agente construtor:** siga só o pacote e as regras do construtor, e ignore o resto desta seção.
- **Na sessão principal (planejador e orquestrador):** para planejar uma onda, use a skill `fabrica-planejar`; para rodar, acompanhar ou aprovar, use `fabrica-operar`. O código de feature é escrito pelos construtores, não na sessão principal. Nunca rode `fab approve` sem o humano pedir.
- Guia de uso passo a passo: `.factory/COMO-USAR.md`.
