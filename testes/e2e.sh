#!/usr/bin/env bash
# Teste de ponta a ponta com agentes simulados (não gasta tokens).
# Uso: testes/e2e.sh
set -uo pipefail
T="$(cd "$(dirname "$0")" && pwd)"
export DEMO_DIR="${DEMO_DIR:-/tmp/fabrica-demo}" PATH="$T/fakebin:$PATH" FAKE_LOG="/tmp/fabrica-demo-calls.log" NO_COLOR=1
"$T/setup-demo.sh" >/dev/null || { echo "✗ setup"; exit 1; }
cd "$DEMO_DIR"
falhas=0
passo() { local esperado="$1"; shift; node .factory/fab.mjs "$@" >/tmp/fabrica-e2e.out 2>&1; local c=$?
  if [[ $c == "$esperado" ]]; then echo "✓ fab $*"; else echo "✗ fab $* (exit $c, esperado $esperado)"; tail -20 /tmp/fabrica-e2e.out; falhas=$((falhas+1)); fi; }
passo 0 doctor
passo 0 plan-check
passo 0 wave 1
passo 0 approve F-01
passo 0 wave 2
passo 0 approve F-02
passo 0 approve F-03
if npm run -s verify >/dev/null 2>&1; then echo "✓ verify na main com os testes de aceite mergeados"; else echo "✗ verify na main"; falhas=$((falhas+1)); fi
[[ "$(git log --oneline | grep -c '^.* merge: F-0')" == 3 ]] && echo "✓ 3 merges --no-ff" || { echo "✗ merges"; falhas=$((falhas+1)); }
[[ $falhas == 0 ]] && echo "OK" || { echo "$falhas falha(s)"; exit 1; }
