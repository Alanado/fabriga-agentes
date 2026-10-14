#!/usr/bin/env bash
# Monta um projeto de exemplo limpo e instala a fábrica nele.
set -euo pipefail
E2E="$(cd "$(dirname "$0")" && pwd)"
P="${DEMO_DIR:-/tmp/fabrica-demo}"
rm -rf "$P" "$P-worktrees"
mkdir -p "$P/src" "$P/tests/unit"
cd "$P"
git init -q -b main
git config user.email teste@example.test
git config user.name "Teste"

cat > package.json <<'EOF'
{ "name": "demo", "type": "module", "private": true,
  "scripts": { "verify": "node --test 'tests/**/*.test.mjs'" } }
EOF
echo "PORT=3000" > .env.example
echo "# demo" > README.md
cat > tests/unit/base.test.mjs <<'EOF'
import test from 'node:test';
import assert from 'node:assert';
test('base', () => assert.ok(true));
EOF
cat > tests/run-json.mjs <<'EOF'
import { run } from 'node:test';
import fs from 'node:fs';
const [report, ...files] = process.argv.slice(2);
const testes = []; let falhas = 0;
for await (const ev of run({ files })) {
  if (ev.type === 'test:pass' && ev.data.details?.type !== 'suite') testes.push({ title: ev.data.name, status: 'passed' });
  if (ev.type === 'test:fail') { falhas++; testes.push({ title: ev.data.name, status: 'failed' }); }
}
fs.writeFileSync(report, JSON.stringify({ testes }));
process.exit(falhas ? 1 : 0);
EOF
git add -A && git commit -qm "init"

"$E2E/../install.sh" "$P" --perfil trabalho >/dev/null

# profile de teste: sem npm ci, aceite via node:test
node -e '
const fs=require("fs");const p=".factory/profile.json";const j=JSON.parse(fs.readFileSync(p));
j.setup=[]; j.gate.install=null; j.gate.acceptance="node tests/run-json.mjs {report} {files}";
j.limits.gateRetries=3; fs.writeFileSync(p, JSON.stringify(j,null,2));'

tarefa() { # id onda tamanho depende permitido arquivo-aceite conteudo-aceite
  mkdir -p ".factory/acceptance/$1/tests/acceptance"
  cat > ".factory/tasks/$1.md" <<EOF
---
id: $1
titulo: Tarefa $1
onda: $2
depende_de: [$4]
tamanho: $3
---

## Objetivo
Teste.

## Critérios de aceite
- [ ] CA1: funciona
- [ ] CA2: funciona de novo

## Contexto (ler)
- package.json

## Permitido alterar
- $5

## Proibido alterar
- tests/acceptance/**
- qualquer arquivo fora de "Permitido alterar"

## Testes de aceite (já escritos pelo Claude)
- tests/acceptance/$1.test.mjs
EOF
  printf '%s\n' "$6" > ".factory/acceptance/$1/tests/acceptance/$1.test.mjs"
}
tarefa F-01 1 P "" "src/soma.js" "import test from 'node:test'; import assert from 'node:assert'; import { soma } from '../../src/soma.js';
test('CA1: soma 2+3', () => assert.equal(soma(2,3), 5));
test('CA2: soma negativos', () => assert.equal(soma(-1,-1), -2));"
tarefa F-02 1 M "" "src/mult.js" "import test from 'node:test'; import assert from 'node:assert'; import { mult } from '../../src/mult.js';
test('CA1: mult 2*3', () => assert.equal(mult(2,3), 6));
test('CA2: mult por zero', () => assert.equal(mult(5,0), 0));"
tarefa F-03 2 M "F-01" "src/texto.js" "import test from 'node:test'; import assert from 'node:assert'; import { descreve } from '../../src/texto.js';
test('CA1: descreve', () => assert.equal(descreve(1,2), '1 + 2 = 3'));
test('CA2: descreve zero', () => assert.equal(descreve(0,0), '0 + 0 = 0'));"
git add -A && git commit -qm "chore(fabrica): planeja ondas 1 e 2"
echo "demo pronto em $P"
