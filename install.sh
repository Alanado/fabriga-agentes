#!/usr/bin/env bash
# Instala ou atualiza a fábrica de agentes num projeto.
# Uso: ./install.sh /caminho/do/projeto [--perfil trabalho|pessoal]
set -euo pipefail

ORIGEM="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTINO="${1:-}"
PERFIL=""
if [[ "${2:-}" == "--perfil" ]]; then PERFIL="${3:-}"; fi

if [[ -z "$DESTINO" ]]; then
  echo "Uso: $0 /caminho/do/projeto [--perfil trabalho|pessoal]" >&2
  exit 1
fi
DESTINO="$(cd "$DESTINO" && pwd)"
if ! git -C "$DESTINO" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "✗ $DESTINO não é um repositório git." >&2
  exit 1
fi
if [[ -n "$PERFIL" && "$PERFIL" != "trabalho" && "$PERFIL" != "pessoal" ]]; then
  echo "✗ --perfil deve ser trabalho ou pessoal." >&2
  exit 1
fi

FAB="$DESTINO/.factory"
mkdir -p "$FAB/tasks" "$FAB/templates" "$FAB/bin" "$DESTINO/.claude/skills"

# Código do orquestrador e regras: sempre atualizados.
rm -rf "$FAB/lib"
cp -R "$ORIGEM/factory/lib" "$FAB/lib"
cp "$ORIGEM/factory/fab.mjs" "$FAB/fab.mjs"
cp "$ORIGEM/factory/templates/"*.md "$FAB/templates/"
mkdir -p "$FAB/examples" && cp "$ORIGEM/factory/examples/"* "$FAB/examples/"

# Configuração do projeto: só cria se não existir.
for f in profile.json models.json plan.md; do
  if [[ ! -e "$FAB/$f" ]]; then
    cp "$ORIGEM/factory/$f" "$FAB/$f"
    echo "✓ criado .factory/$f"
  else
    echo "– mantido .factory/$f (já existia)"
  fi
done
if [[ -n "$PERFIL" ]]; then
  node -e '
    const fs = require("fs"); const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8")); j.perfil = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");' "$FAB/profile.json" "$PERFIL"
  echo "✓ perfil: $PERFIL"
fi

# Decisões da fábrica: só cria se não existir, nunca sobrescreve.
if [[ ! -e "$FAB/DECISOES.md" ]]; then
  cp "$ORIGEM/factory/templates/DECISOES.md" "$FAB/DECISOES.md"
  echo "✓ criado .factory/DECISOES.md"
else
  echo "– mantido .factory/DECISOES.md (já existia)"
fi

# Atalho de linha de comando.
cat > "$FAB/bin/fab" <<'EOF'
#!/usr/bin/env bash
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/fab.mjs" "$@"
EOF
chmod +x "$FAB/bin/fab" "$FAB/fab.mjs"

# Skills do Claude.
for s in "$ORIGEM/claude/skills/"*/; do
  nome="$(basename "$s")"
  rm -rf "$DESTINO/.claude/skills/$nome"
  cp -R "$s" "$DESTINO/.claude/skills/$nome"
done
echo "✓ skills fabrica-planejar e fabrica-operar em .claude/skills/"

# Guia de uso: sempre sobrescrito.
cp "$ORIGEM/docs/COMO-USAR.md" "$FAB/COMO-USAR.md"
echo "✓ .factory/COMO-USAR.md"

# CLAUDE.md: acrescenta a seção curta uma vez.
if ! grep -q '^## Fábrica de agentes' "$DESTINO/CLAUDE.md" 2>/dev/null; then
  { [[ -s "$DESTINO/CLAUDE.md" ]] && echo; cat "$ORIGEM/claude/CLAUDE.factory.md"; } >> "$DESTINO/CLAUDE.md"
  echo "✓ seção da fábrica adicionada ao CLAUDE.md"
fi

# CLAUDE.md: aponta para o guia de uso, uma vez só.
if ! grep -qF '.factory/COMO-USAR.md' "$DESTINO/CLAUDE.md" 2>/dev/null; then
  echo '- Guia de uso passo a passo: `.factory/COMO-USAR.md`.' >> "$DESTINO/CLAUDE.md"
  echo "✓ referência ao guia adicionada ao CLAUDE.md"
fi

# .gitignore: estado operacional não vai para o repositório.
MARCA="# fábrica de agentes"
if ! grep -qF "$MARCA" "$DESTINO/.gitignore" 2>/dev/null; then
  cat >> "$DESTINO/.gitignore" <<EOF

$MARCA
.factory/state/
.factory/logs/
.factory/evidence/
.factory/reviews/
.factory/requests/
.slot/
.factory-request.md
EOF
  echo "✓ .gitignore atualizado"
fi

echo
echo "Pronto. Próximos passos:"
echo "  1. Ajuste .factory/profile.json (perfil, portas, compose, comando verify)."
echo "  2. alias fab=\"$FAB/bin/fab\"   (ou use: node .factory/fab.mjs)"
echo "  3. fab doctor"
echo "  4. No Claude Code: \"planeje a onda 1\" (skill fabrica-planejar)"
