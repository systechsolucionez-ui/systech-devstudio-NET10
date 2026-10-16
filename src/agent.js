// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import path from 'node:path';
import { runProcess, childEnv } from './proc.js';

const REDACT = [/sk-ant-[A-Za-z0-9_-]{10,}/g, /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g];
export function redact(text) {
  return REDACT.reduce((t, re) => t.replace(re, '[oculto]'), String(text));
}

/** Herramientas del agente que genera y corrige: editar archivos y usar dotnet; sin red ni push. */
const BUILDER_ALLOWED = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(dotnet *)', 'Bash(npm test)', 'Bash(npm test *)', 'Bash(ls *)', 'Bash(mkdir *)', 'Bash(git status *)', 'Bash(git diff *)',
];
const BUILDER_DENIED = ['WebFetch', 'WebSearch', 'Bash(curl *)', 'Bash(wget *)', 'Bash(git push *)', 'Bash(ssh *)'];
/** El revisor solo puede leer: no modifica nada de lo que revisa. */
const REVIEWER_TOOLS = ['Read', 'Glob', 'Grep'];

/** Herramientas disponibles (no solo permitidas) para el agente que construye. */
const BUILDER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];

export function buildArgs({ mode, systemPrompt, config }) {
  // dontAsk: todo lo que no está explícitamente permitido se rechaza solo, sin quedar esperando.
  const args = ['-p', '--permission-mode', 'dontAsk', '--append-system-prompt', systemPrompt];
  // --restricted encierra las herramientas de archivos en la carpeta del trabajo e ignora
  // configuraciones locales que pudieran venir dentro del proyecto del cliente.
  if (config.claudeRestricted !== false) args.push('--restricted');
  if (mode === 'review') {
    args.push('--output-format', 'json', '--tools', REVIEWER_TOOLS.join(','), '--allowedTools', ...REVIEWER_TOOLS);
  } else {
    args.push('--output-format', 'stream-json', '--verbose', '--tools', BUILDER_TOOLS.join(','),
      '--allowedTools', ...BUILDER_ALLOWED, '--disallowedTools', ...BUILDER_DENIED);
  }
  if (config.claudeModel) args.push('--model', config.claudeModel);
  if (config.maxBudgetUsd > 0) args.push('--max-budget-usd', String(config.maxBudgetUsd));
  return args;
}

/** Convierte un evento del stream del CLI en una línea legible para la consola del Taller. */
export function describeEvent(evt, cwd) {
  const rel = (p) => (p && cwd && p.startsWith(cwd) ? path.relative(cwd, p) : p);
  if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
    const out = [];
    for (const c of evt.message.content) {
      if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'text', text: c.text.trim() });
      if (c.type === 'tool_use') {
        const i = c.input || {};
        const target = rel(i.file_path || i.path) || i.command || i.pattern || '';
        out.push({ kind: 'tool', text: `${c.name}${target ? ` · ${String(target).slice(0, 200)}` : ''}` });
      }
    }
    return out;
  }
  if (evt.type === 'result') {
    return [{ kind: evt.is_error ? 'error' : 'done', text: evt.is_error ? `El agente terminó con error: ${evt.subtype || ''} ${evt.result || ''}`.trim() : 'El agente terminó.' }];
  }
  return [];
}

/**
 * Ejecuta el agente con el CLI de Claude Code en modo no interactivo.
 * El prompt va por stdin (no tiene límite de largo y nunca pasa por un shell).
 */
export async function runAgent({ mode, cwd, prompt, systemPrompt, config, signal, logFile, onActivity = () => {} }) {
  const args = buildArgs({ mode, systemPrompt, config });
  let result = null;
  const timeoutMs = mode === 'review' ? config.timeouts.reviewer : config.timeouts.agent;

  const onLine = mode === 'review' ? undefined : (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) { if (trimmed) onActivity({ kind: 'log', text: redact(trimmed).slice(0, 500) }); return; }
    let evt;
    try { evt = JSON.parse(trimmed); } catch { return; }
    if (evt.type === 'result') result = evt;
    for (const a of describeEvent(evt, cwd)) onActivity({ ...a, text: redact(a.text).slice(0, 2000) });
  };

  const r = await runProcess({
    cmd: config.claudeBin, args, cwd, env: childEnv('agent'), input: prompt, timeoutMs, signal, logFile, onLine,
    maxTail: 2 * 1024 * 1024,
  });

  if (mode === 'review') {
    try { result = JSON.parse(r.output.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() || ''); } catch { result = null; }
  }

  const ok = r.ok && result && !result.is_error;
  return {
    ok: Boolean(ok),
    text: result?.result ?? '',
    costUsd: Number(result?.total_cost_usd) || 0,
    turns: result?.num_turns ?? null,
    error: ok ? null : describeAgentError(r, result),
  };
}

function describeAgentError(r, result) {
  if (r.cancelled) return 'Cancelado.';
  if (r.timedOut) return 'El agente superó el tiempo máximo.';
  if (r.error) return `${r.error} Instalalo con: npm install -g @anthropic-ai/claude-code`;
  if (result?.is_error) return redact(`El agente devolvió un error (${result.subtype || 'desconocido'}): ${result.result || ''}`).slice(0, 1500);
  const tail = redact(r.output.trim().split('\n').slice(-8).join('\n'));
  if (/api key|authentication|login|401|invalid x-api-key/i.test(tail)) {
    return `El agente no está autenticado. Configurá ANTHROPIC_API_KEY o ejecutá "claude" una vez para iniciar sesión.\n${tail}`;
  }
  return `El agente terminó con código ${r.code}.\n${tail}`;
}

/** Extrae el informe JSON del revisor; acepta que venga dentro de un bloque ```json. */
export function parseReview(text) {
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text)) !== null) candidates.push(m[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates.reverse()) {
    try {
      const obj = JSON.parse(c);
      if (obj && typeof obj === 'object' && Array.isArray(obj.findings)) return normalizeReview(obj);
    } catch { /* probar el siguiente */ }
  }
  return null;
}

const SEVERITIES = ['critica', 'alta', 'media', 'baja'];
const AREAS = ['pedido', 'casos_borde', 'seguridad', 'calidad'];

function normalizeReview(obj) {
  const findings = obj.findings.slice(0, 50).map((f) => ({
    severity: SEVERITIES.includes(norm(f.severity)) ? norm(f.severity) : 'media',
    area: AREAS.includes(norm(f.area)) ? norm(f.area) : 'calidad',
    title: String(f.title || 'Sin título').slice(0, 200),
    file: f.file ? String(f.file).slice(0, 300) : '',
    line: Number.isInteger(f.line) ? f.line : null,
    detail: String(f.detail || '').slice(0, 2000),
  }));
  const req = obj.requirements && typeof obj.requirements === 'object' ? obj.requirements : {};
  return {
    summary: String(obj.summary || '').slice(0, 2000),
    requirements: { met: Number(req.met) || 0, total: Number(req.total) || 0, missing: Array.isArray(req.missing) ? req.missing.map(String).slice(0, 20) : [] },
    findings,
    blocking: findings.filter((f) => f.severity === 'critica' || f.severity === 'alta'),
  };
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_');
}
