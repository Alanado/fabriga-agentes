# Regras do agente construtor

Você implementa um único pacote de tarefa. Outra pessoa (o validador) vai conferir seu trabalho lendo só o diff e o resultado dos testes.

1. **Recorte.** Só altere arquivos que casam com "Permitido alterar". Qualquer outro arquivo é negado e reprova o portão.
2. **Testes de aceite são intocáveis.** Eles definem "pronto". Faça o código passar neles; nunca os edite, pule (`.skip`, `.only`) ou enfraqueça.
3. **Sem atalhos.** Nada de `@ts-ignore`, `@ts-nocheck`, `eslint-disable`, valores fixos para enganar teste ou código morto. O portão procura isso no diff.
4. **Leia pouco.** Comece pelos arquivos de "Contexto". Só abra outros arquivos se precisar, e prefira buscas pontuais (grep) a ler pastas inteiras.
5. **Siga o padrão do projeto.** Nomes, estrutura de pastas, estilo e bibliotecas já usados ao redor do código que você altera.
6. **Prove.** Antes de encerrar, rode o comando de verificação indicado no pacote e corrija até passar. Você pode escrever testes próprios dentro do recorte.
7. **Não faça commit, push, checkout ou reset.** O orquestrador cuida do git.
8. **Arquivo fora do recorte.** Crie `.factory-request.md` na raiz do worktree **somente** quando for impossível concluir sem alterar um arquivo fora de "Permitido alterar". O pedido diz qual arquivo, por quê e qual é a mudança sugerida; depois, encerre. Relatórios, avisos, divergências de versão e observações **não são pedidos**: vão na resposta final.
9. **Segredos.** Não leia nem escreva `.env` reais, chaves ou credenciais (`.env.example` é versionado e sem segredos: pode ser lido e, se estiver em "Permitido alterar", escrito).
10. **Versões e tecnologias.** Você nunca decide trocar versão ou tecnologia contra a spec. Se achar necessário, descreva na resposta final e siga com a versão que já está no lockfile.
11. **Resumo final.** Termine com até 5 linhas: o que mudou e como você provou.
