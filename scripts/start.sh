#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 José Antonio Vivas — Systech Soluciones
# Inicia SYSTECH Studio. Uso:  bash scripts/start.sh          (agente real)
#                              bash scripts/start.sh --demo   (agente simulado, sin costo)
set -euo pipefail
cd "$(dirname "$0")/.."

if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; then
  echo "Hace falta Node.js 20 o superior (tenés: $(node -v 2>/dev/null || echo 'ninguno'))." >&2
  exit 1
fi

# Encabezado de SYSTECH Studio (el servidor no lo repite).
node -e 'import("./src/about.js").then((m) => console.log(m.banner()))'
export STUDIO_BANNER_SHOWN=1

if [ ! -d node_modules ]; then
  echo "Instalando dependencias del Studio…"
  npm ci --no-audit --no-fund
fi

if [ "${1:-}" = "--demo" ]; then
  export STUDIO_CLAUDE_BIN=./scripts/fake-claude.mjs
  echo "Modo demostración: el agente es simulado y no gasta créditos."
else
  if ! command -v claude >/dev/null 2>&1; then
    echo "Instalando el agente (Claude Code)…"
    npm install -g @anthropic-ai/claude-code
  fi
  if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ ! -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" ]; then
    echo
    echo "AVISO: el agente no tiene credenciales."
    echo "  · Con API key: cargala como secreto de Codespaces llamado ANTHROPIC_API_KEY y reiniciá el Codespace."
    echo "  · Con tu suscripción de Claude: ejecutá 'claude' una vez en la terminal e iniciá sesión."
    echo
  fi
fi

if [ "${STUDIO_HOST:-127.0.0.1}" != "127.0.0.1" ] && [ "${STUDIO_HOST:-}" != "localhost" ]; then
  echo "ATENCIÓN: STUDIO_HOST=${STUDIO_HOST}. El Studio no tiene usuarios: no lo expongas fuera del Codespace." >&2
fi

echo "Abrí la pestaña PORTS, puerto ${STUDIO_PORT:-5080}, y hacé clic en el globo. Dejá la visibilidad en Private."
exec node server.js
