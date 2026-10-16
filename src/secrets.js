// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import fsp from 'node:fs/promises';
import path from 'node:path';
import { listDeliverableFiles } from './zip.js';

/** Patrones de alta confianza: si aparecen en lo que se entrega, la verificación falla. */
const BLOCKING = [
  { name: 'Clave privada', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  { name: 'API key de Anthropic', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'API key de OpenAI', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { name: 'Token de GitHub', re: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: 'Clave de AWS', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Clave de Google', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Token de Slack', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Access token de Mercado Pago', re: /\bAPP_USR-\d{6,}-\d{6}-[0-9a-f]{32}-\d{6,}\b/ },
  { name: 'Clave secreta de Stripe', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
];

/** Contraseñas en cadenas de conexión fuera de archivos de desarrollo: aviso, no bloqueo. */
const PASSWORD_IN_CONN = /\b(?:Password|Pwd)\s*=\s*([^;"'\s]{4,})/i;
const DEV_FILE = /(?:Development|\.example|docker-compose|\.Tests?|test)/i;
const TEXT_EXT = /\.(?:cs|csproj|props|targets|json|ya?ml|xml|config|env|txt|md|sh|ps1|js|mjs|ts|py|ini|toml|properties|sql|http|razor|cshtml)$/i;

export async function scanSecrets(rootDir, { maxFileBytes = 1024 * 1024 } = {}) {
  const files = await listDeliverableFiles(rootDir);
  const blocking = [];
  const warnings = [];
  for (const rel of files) {
    if (!TEXT_EXT.test(rel) && !/(^|\/)(Dockerfile|\.gitignore)$/.test(rel)) continue;
    const abs = path.join(rootDir, rel);
    const stat = await fsp.stat(abs);
    if (stat.size > maxFileBytes) continue;
    const lines = (await fsp.readFile(abs, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const p of BLOCKING) {
        if (p.re.test(line)) blocking.push({ file: rel, line: i + 1, kind: p.name });
      }
      const m = PASSWORD_IN_CONN.exec(line);
      if (m && !DEV_FILE.test(rel) && !/^\$\{|^__|^<|^\{\{/.test(m[1])) {
        warnings.push({ file: rel, line: i + 1, kind: 'Contraseña en cadena de conexión' });
      }
    });
  }
  return { blocking, warnings, scanned: files.length };
}
