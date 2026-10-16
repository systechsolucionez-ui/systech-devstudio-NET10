// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess, childEnv } from './proc.js';
import { extractZipSafe } from './zip.js';

export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
export const BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/**
 * Sube exactamente el contenido del .zip entregado a una rama nueva del repositorio indicado.
 * Nunca empuja la carpeta de trabajo (que puede tener archivos excluidos de la entrega).
 * El token se toma de GITHUB_TOKEN dentro del helper de credenciales: no aparece en la línea de comandos.
 */
export async function pushToGitHub({ zipFile, repo, branch, message, limits, timeoutMs }) {
  if (!REPO_RE.test(repo)) throw new Error('El repositorio tiene que tener la forma usuario/repositorio.');
  if (!BRANCH_RE.test(branch) || branch.endsWith('.lock') || branch.endsWith('/')) throw new Error('Nombre de rama inválido.');

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-push-'));
  const dir = path.join(tmp, 'repo');
  try {
    await extractZipSafe(zipFile, dir, { maxEntries: limits.maxZipEntries, maxBytes: limits.maxUnzippedBytes });
    const env = childEnv('git', { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' });
    const helper = process.env.GITHUB_TOKEN
      ? ['-c', 'credential.helper=', '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f']
      : [];
    const git = async (args) => {
      const r = await runProcess({ cmd: 'git', args: ['-c', 'user.name=SYSTECH Studio', '-c', 'user.email=studio@systech.local', '-c', 'commit.gpgsign=false', ...helper, ...args], cwd: dir, env, timeoutMs });
      if (!r.ok) throw new Error(explainPushError(r.output));
      return r;
    };
    await git(['init', '-q', '-b', branch]);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', message]);
    await git(['push', '--porcelain', `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch}`]);
    return { url: `https://github.com/${repo}/tree/${branch.split('/').map(encodeURIComponent).join('/')}` };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

function explainPushError(output) {
  const tail = output.replace(/x-access-token:[^@\s]+@/g, '').trim().split('\n').slice(-6).join('\n');
  if (/Authentication failed|could not read Username|403|denied|not have permission/i.test(output)) {
    return `GitHub rechazó el acceso. El token del Codespace solo puede escribir en el repositorio del Codespace; para otro repositorio ejecutá "gh auth login" en la terminal.\n${tail}`;
  }
  if (/already exists|non-fast-forward|rejected/i.test(output)) return `La rama ya existe en GitHub. Elegí otro nombre.\n${tail}`;
  if (/not found/i.test(output)) return `No se encontró el repositorio.\n${tail}`;
  return tail || 'git falló sin mensaje.';
}
