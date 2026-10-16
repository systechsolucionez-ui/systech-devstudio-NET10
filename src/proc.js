// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Variables que heredan los procesos hijos. Es una lista blanca: el token de GitHub del Codespace,
 * los secretos del Codespace y cualquier otra variable quedan afuera salvo que se pidan explícitamente.
 */
const BASE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TERM',
  'DOTNET_ROOT', 'DOTNET_CLI_HOME', 'NUGET_PACKAGES', 'DOTNET_NOLOGO',
  'DOCKER_HOST', 'DOCKER_CONFIG', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

/**
 * profile:
 *  - 'build': compilar, testear, docker. Ejecuta código del cliente → no recibe ningún secreto.
 *  - 'agent': el CLI del agente. Recibe solo la API key de Anthropic (si existe).
 *  - 'git':   push a GitHub. Recibe el token de GitHub del Codespace.
 */
export function childEnv(profile, extra = {}) {
  const env = {};
  for (const key of BASE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.DOTNET_CLI_TELEMETRY_OPTOUT = '1';
  env.DOTNET_NOLOGO = '1';
  env.CI = 'true';
  if (profile === 'agent') {
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) {
      if (process.env[key]) env[key] = process.env[key];
    }
  } else if (profile === 'git') {
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'GIT_ASKPASS', 'GITHUB_USER', 'CODESPACES', 'GITHUB_SERVER_URL']) {
      if (process.env[key]) env[key] = process.env[key];
    }
  } else if (profile !== 'build') {
    throw new Error(`Perfil de entorno desconocido: ${profile}`);
  }
  return { ...env, ...extra };
}

/**
 * Ejecuta un proceso sin shell (los argumentos nunca se interpretan), con tiempo máximo,
 * cancelación y salida acotada. Mata todo el grupo de procesos al cortar, para no dejar
 * huérfanos (dotnet build server, testhost, docker compose).
 */
export function runProcess({
  cmd, args = [], cwd, env, input, timeoutMs = 120_000, signal, logFile, onLine, maxTail = 64 * 1024,
}) {
  return new Promise((resolve) => {
    let tail = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const log = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
    if (log) log.write(`\n$ ${[cmd, ...args].map(quoteForLog).join(' ')}\n`);

    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ code: -1, error: err.message });
      return;
    }

    const killTree = () => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ya terminó */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* ya terminó */ } }, 5000).unref();
    };

    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    timer.unref();
    const onAbort = () => { cancelled = true; killTree(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let partial = '';
    const onData = (chunk) => {
      const text = chunk.toString('utf8');
      if (log) log.write(text);
      tail += text;
      if (tail.length > maxTail) tail = tail.slice(tail.length - maxTail);
      if (onLine) {
        partial += text;
        const lines = partial.split('\n');
        partial = lines.pop();
        for (const line of lines) safeCall(onLine, line);
        if (partial.length > 1_000_000) { safeCall(onLine, partial); partial = ''; }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => { /* el proceso cerró stdin antes de tiempo */ });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();

    child.on('error', (err) => finish({ code: -1, error: err.code === 'ENOENT' ? `No se encontró el programa "${cmd}".` : err.message }));
    child.on('close', (code, sig) => {
      if (onLine && partial) safeCall(onLine, partial);
      finish({ code: code ?? -1, signal: sig });
    });

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const done = () => resolve({ ...result, timedOut, cancelled, output: tail, ok: result.code === 0 && !timedOut && !cancelled });
      if (log) log.end(done); else done();
    }
  });
}

function safeCall(fn, line) {
  try { fn(line); } catch { /* un error al mostrar una línea no debe cortar el proceso */ }
}

function quoteForLog(a) {
  const s = String(a);
  if (s.length > 200) return `'${s.slice(0, 200)}…'`;
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
