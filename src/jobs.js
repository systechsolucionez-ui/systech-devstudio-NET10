// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess, childEnv } from './proc.js';
import { extractZipSafe, createZip, listZipEntries, buildChecksums, sha256File } from './zip.js';
import { runAutomaticChecks, runCleanBuild } from './checks.js';
import { runAgent, parseReview } from './agent.js';
import { APP_ROOT } from './config.js';
import { renderVerificationReport, renderReviewReport } from './reports.js';
import { signatureLine } from './about.js';

/** Informes que el Studio firma y agrega al .zip (no entran en la huella del contenido). */
const SIGNED_REPORTS = ['verificacion.md', 'revision-independiente.md', 'ENTREGA.md'];

const RUNNING = new Set(['queued', 'generating', 'verifying1', 'fixing', 'verifying2', 'packaging']);
const ID_RE = /^[a-z0-9]{12}$/;
const MAX_ACTIVITY = 400;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function newId() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function slugify(text) {
  return String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'trabajo';
}

/**
 * Orquesta los trabajos: guarda su estado en disco, los ejecuta de a uno (el Codespace tiene
 * recursos limitados) y aplica el ciclo generar → verificación 1 → verificación 2 → revisión.
 */
export class JobManager {
  constructor(config, { agentPrompt, reviewerPrompt } = {}) {
    this.config = config;
    this.jobs = new Map();
    this.queue = [];
    this.current = null;
    this.saveTimers = new Map();
    this.agentPrompt = agentPrompt ?? fs.readFileSync(path.join(APP_ROOT, 'prompts', 'agente.md'), 'utf8');
    this.reviewerPrompt = reviewerPrompt ?? fs.readFileSync(path.join(APP_ROOT, 'prompts', 'revisor.md'), 'utf8');
  }

  async init() {
    await fsp.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const dirs = await fsp.readdir(this.config.dataDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory() || !isValidId(d.name)) continue;
      try {
        const job = JSON.parse(await fsp.readFile(path.join(this.config.dataDir, d.name, 'job.json'), 'utf8'));
        if (RUNNING.has(job.status)) {
          job.status = 'interrupted';
          job.lastError = 'El Studio se reinició mientras este trabajo estaba en curso. Podés reintentarlo.';
        }
        this.jobs.set(job.id, job);
      } catch { /* carpeta incompleta: se ignora */ }
    }
  }

  dir(id) { return path.join(this.config.dataDir, id); }
  workDir(id) { return path.join(this.dir(id), 'work'); }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((j) => ({
      id: j.id, name: j.name, status: j.status, createdAt: j.createdAt, updatedAt: j.updatedAt,
      v1: j.v1?.status, v2: j.v2?.status, costUsd: j.costUsd,
    }));
  }

  get(id) { return this.jobs.get(id) || null; }

  /** Crea el trabajo con los archivos ya recibidos en uploadDir y lo encola. */
  async create({ name, request, options, uploads }) {
    const id = newId();
    const dir = this.dir(id);
    await fsp.mkdir(path.join(dir, 'logs'), { recursive: true, mode: 0o700 });
    await fsp.mkdir(path.join(dir, 'uploads'), { recursive: true });
    for (const u of uploads) await fsp.rename(u.tmpPath, path.join(dir, 'uploads', u.name));
    const now = new Date().toISOString();
    const job = {
      id, name, request, createdAt: now, updatedAt: now,
      options: { maxAttempts: options.maxAttempts, smoke: options.smoke },
      inputs: uploads.map((u) => ({ name: u.name, size: u.size, kind: u.name.toLowerCase().endsWith('.zip') ? 'zip' : 'file' })),
      status: 'queued', stage: 'received', cycle: 0, attempt: 0,
      v1: { status: 'pending', checks: [] },
      v2: { status: 'pending', clean: null, review: null },
      errors: [], activity: [], history: [{ at: now, kind: 'request', text: request }],
      costUsd: 0, deliverable: null, approvedAt: null, lastError: null,
    };
    this.jobs.set(id, job);
    await this.saveNow(job);
    this.enqueue(job, { type: 'new' });
    return job;
  }

  /** Acciones del usuario sobre un trabajo existente. Devuelve un error legible o null. */
  request(id, task) {
    const job = this.get(id);
    if (!job) return 'El trabajo no existe.';
    if (RUNNING.has(job.status)) return 'El trabajo está en curso; esperá a que termine o cancelalo.';
    if (task.type === 'approve') {
      if (job.status !== 'review' && job.status !== 'delivered') return 'Solo se puede aprobar cuando pasaron las dos verificaciones.';
      job.status = 'delivered';
      job.approvedAt = new Date().toISOString();
      job.history.push({ at: job.approvedAt, kind: 'approve', text: 'Trabajo aprobado para entregar.' });
      this.saveNow(job);
      return null;
    }
    if (task.type === 'fix') {
      const selected = job.errors.filter((e) => task.errorIds.includes(e.id));
      if (!selected.length) return 'No se encontró el error a corregir.';
      job.history.push({ at: new Date().toISOString(), kind: 'fix', text: selected.map((e) => e.title).join(' · ') });
      task = { type: 'fix', errors: selected };
    } else if (task.type === 'change') {
      job.history.push({ at: new Date().toISOString(), kind: 'change', text: task.text });
    } else if (task.type === 'retry') {
      if (!['interrupted', 'failed', 'cancelled', 'needs_attention'].includes(job.status)) return 'No hay nada que reintentar.';
      if (!fs.existsSync(path.join(this.workDir(id), '.git'))) task = { type: 'new' };
    } else {
      return 'Acción desconocida.';
    }
    job.status = 'queued';
    job.lastError = null;
    this.saveNow(job);
    this.enqueue(job, task);
    return null;
  }

  cancel(id) {
    const job = this.get(id);
    if (!job) return 'El trabajo no existe.';
    const queued = this.queue.findIndex((q) => q.job.id === id);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      job.status = 'cancelled';
      this.saveNow(job);
      return null;
    }
    if (this.current?.job.id === id) {
      this.current.controller.abort();
      return null;
    }
    return 'El trabajo no está en curso.';
  }

  enqueue(job, task) {
    this.queue.push({ job, task });
    this.pump();
  }

  async pump() {
    if (this.current || !this.queue.length) return;
    const { job, task } = this.queue.shift();
    const controller = new AbortController();
    this.current = { job, controller };
    try {
      await this.process(job, task, controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        job.status = 'cancelled';
        job.lastError = 'Cancelado por vos.';
      } else {
        job.status = 'failed';
        job.lastError = err.message;
      }
      this.activity(job, 'error', job.lastError);
    } finally {
      this.current = null;
      await this.saveNow(job);
      setImmediate(() => this.pump());
    }
  }

  async whenIdle() {
    while (this.current || this.queue.length) await new Promise((r) => setTimeout(r, 50));
  }

  // ---------------------------------------------------------------------------------------------
  // Ciclo de un trabajo
  // ---------------------------------------------------------------------------------------------

  async process(job, task, signal) {
    job.cycle += 1;
    job.attempt = 0;
    job.errors = [];
    // Una entrega anterior deja de valer en cuanto el código puede cambiar: se rehace al aprobar de nuevo.
    job.deliverable = null;
    job.approvedAt = null;
    const work = this.workDir(job.id);

    if (task.type === 'new') {
      this.setStatus(job, 'generating', 'generate');
      await this.prepareWorkspace(job);
      await this.agentStep(job, 'generate', this.generatePrompt(job), signal);
    } else if (task.type === 'change') {
      this.setStatus(job, 'generating', 'generate');
      await this.agentStep(job, 'change', this.changePrompt(job, task.text), signal);
    } else if (task.type === 'fix') {
      // La barra de pasos marca la verificación que falló, no "código generado".
      this.setStatus(job, 'fixing', task.errors.some((e) => e.source === 'v1') ? 'v1' : 'v2');
      await this.agentStep(job, 'fix', this.fixPrompt(job, task.errors), signal);
    }

    for (;;) {
      job.attempt += 1;
      job.errors = [];
      this.throwIfAborted(signal);

      // Verificación 1: automática.
      this.setStatus(job, 'verifying1', 'v1');
      job.v1 = { status: 'running', checks: [] };
      job.v2 = { status: 'pending', clean: null, review: null };
      const v1 = await runAutomaticChecks({
        dir: work, logDir: path.join(this.dir(job.id), 'logs'), logPrefix: `c${job.cycle}-a${job.attempt}-v1`,
        timeouts: this.config.timeouts, signal, smoke: job.options.smoke, jobId: job.id,
        onUpdate: (checks) => { job.v1.checks = checks.map((c) => ({ ...c })); this.touch(job); },
      });
      this.throwIfAborted(signal);
      job.v1.project = v1.project;
      job.v1.checks = v1.checks;
      const v1Errors = v1.checks.filter((c) => c.status === 'fail').map((c) => ({
        id: `v1-${c.key}`, source: 'v1', title: `${c.label}: ${c.summary}`, detail: c.details.join('\n'),
      }));
      job.v1.status = v1Errors.length ? 'fail' : 'ok';
      this.activity(job, v1Errors.length ? 'error' : 'done', v1Errors.length ? `Verificación 1: ${v1Errors.length} problemas.` : 'Verificación 1 aprobada.');

      if (v1Errors.length) {
        if (await this.handleFailure(job, v1Errors, signal)) continue;
        return;
      }

      // Verificación 2: entorno limpio + revisión independiente.
      this.setStatus(job, 'verifying2', 'v2');
      job.v2 = { status: 'running', clean: { status: 'running' }, review: { status: 'pending' } };
      this.touch(job);
      const v2Errors = await this.verifyIndependently(job, signal);
      job.v2.status = v2Errors.length ? 'fail' : 'ok';
      this.activity(job, v2Errors.length ? 'error' : 'done', v2Errors.length ? `Verificación 2: ${v2Errors.length} problemas.` : 'Verificación 2 aprobada.');

      if (v2Errors.length) {
        if (await this.handleFailure(job, v2Errors, signal)) continue;
        return;
      }

      this.setStatus(job, 'packaging', 'v2');
      await this.buildDeliverable(job);
      this.setStatus(job, 'review', 'review');
      this.activity(job, 'done', 'Doble verificación aprobada. Listo para tu revisión.');
      return;
    }
  }

  /** Si quedan intentos, el agente corrige y se vuelve a verificar. Si no, queda para el usuario. */
  async handleFailure(job, errors, signal) {
    job.errors = errors;
    if (job.attempt >= job.options.maxAttempts) {
      this.setStatus(job, 'needs_attention', job.stage);
      job.lastError = `Quedan ${errors.length} problemas después de ${job.attempt} intentos. Podés corregirlos con el agente o pedir un cambio.`;
      this.activity(job, 'error', job.lastError);
      return false;
    }
    this.setStatus(job, 'fixing', job.stage); // se queda en el paso real (v1 o v2) mientras corrige
    await this.agentStep(job, 'fix', this.fixPrompt(job, errors), signal);
    return true;
  }

  async verifyIndependently(job, signal) {
    const dir = this.dir(job.id);
    const cleanDir = path.join(dir, 'clean');
    const candidateZip = path.join(dir, 'out', 'candidato.zip');
    const errors = [];

    await createZip(this.workDir(job.id), candidateZip);
    await fsp.rm(cleanDir, { recursive: true, force: true });
    await extractZipSafe(candidateZip, cleanDir, { maxEntries: this.config.limits.maxZipEntries, maxBytes: this.config.limits.maxUnzippedBytes });

    // Entorno limpio primero: es barato y, si el .zip no compila desde cero, no tiene sentido pagar la revisión.
    this.activity(job, 'tool', 'Entorno limpio · compilando y testeando desde el .zip');
    const clean = await runCleanBuild({ dir: cleanDir, logDir: path.join(dir, 'logs'), logPrefix: `c${job.cycle}-a${job.attempt}-clean`, timeouts: this.config.timeouts, signal });
    this.throwIfAborted(signal);
    job.v2.clean = { status: clean.ok ? 'ok' : 'fail', summary: clean.summary, details: clean.details || [] };
    this.touch(job);
    if (!clean.ok) {
      job.v2.review = { status: 'skipped' };
      return [{ id: 'v2-clean', source: 'v2', title: `Entorno limpio: ${clean.summary}`, detail: (clean.details || []).join('\n') }];
    }

    // El revisor trabaja sobre la copia limpia, que es exactamente lo que recibe el cliente.
    this.activity(job, 'tool', 'Revisor independiente · leyendo el proyecto');
    job.v2.review = { status: 'running' };
    this.touch(job);
    const diff = await this.diffAgainstBase(job.id);
    const review = await this.runReviewer(job, cleanDir, diff, signal);
    job.v2.review = review;
    if (review.status === 'error') {
      errors.push({ id: 'v2-review', source: 'v2', title: 'El revisor no pudo completar la revisión', detail: review.error });
    } else {
      review.requirements.missing.forEach((missing, i) => {
        errors.push({ id: `v2-req${i}`, source: 'v2', title: `Falta del pedido: ${missing}`, detail: missing });
      });
      review.blocking.forEach((f, i) => {
        errors.push({
          id: `v2-f${i}`, source: 'v2', title: `${f.severity === 'critica' ? 'Crítico' : 'Alto'} · ${f.title}`,
          detail: `${f.file ? `${f.file}${f.line ? `:${f.line}` : ''}\n` : ''}${f.detail}`, file: f.file, line: f.line,
        });
      });
    }
    this.touch(job);
    return errors;
  }

  async runReviewer(job, cleanDir, diff, signal) {
    const prompt = this.reviewPrompt(job, diff);
    let last = null;
    for (let i = 0; i < 2; i += 1) {
      const r = await runAgent({
        mode: 'review', cwd: cleanDir, prompt, systemPrompt: this.reviewerPrompt, config: this.config, signal,
        logFile: path.join(this.dir(job.id), 'logs', `c${job.cycle}-a${job.attempt}-review.log`),
      });
      job.costUsd = round(job.costUsd + r.costUsd);
      this.throwIfAborted(signal);
      if (!r.ok) { last = r.error; break; }
      const parsed = parseReview(r.text);
      if (parsed) {
        await fsp.writeFile(path.join(this.dir(job.id), 'review.json'), JSON.stringify(parsed, null, 2));
        return { status: parsed.blocking.length || parsed.requirements.missing.length ? 'fail' : 'ok', ...parsed };
      }
      last = 'El revisor no devolvió un informe en el formato esperado.';
    }
    return { status: 'error', error: last, findings: [], blocking: [], requirements: { met: 0, total: 0, missing: [] }, summary: '' };
  }

  async buildDeliverable(job) {
    const out = path.join(this.dir(job.id), 'out');
    const file = path.join(out, `${slugify(job.name)}-${job.id}.zip`);
    for (const f of await fsp.readdir(out)) if (f !== 'candidato.zip') await fsp.rm(path.join(out, f), { force: true });
    const work = this.workDir(job.id);

    // Huella de todo lo entregado salvo los informes firmados: el cliente la verifica con sha256sum -c.
    const { manifest, contentHash } = await buildChecksums(work, new Set([...SIGNED_REPORTS, 'SHA256SUMS.txt']));
    const signature = `\n\n---\n\n${signatureLine({ date: new Date().toISOString().slice(0, 10), contentHash })}\n`;
    let entrega = '';
    try { entrega = await fsp.readFile(path.join(work, 'ENTREGA.md'), 'utf8'); } catch { /* el agente no lo escribió */ }
    const entregaSigned = `${(entrega || `# ${job.name}\n\nEntrega generada con SYSTECH Studio.`).trimEnd()}${signature}`;
    const extra = [
      { name: 'verificacion.md', content: `${renderVerificationReport(job).trimEnd()}${signature}` },
      { name: 'revision-independiente.md', content: `${renderReviewReport(job).trimEnd()}${signature}` },
      { name: 'ENTREGA.md', content: entregaSigned },
      { name: 'SHA256SUMS.txt', content: manifest },
    ];
    const { size, count } = await createZip(work, file, { extra });
    const entries = await listZipEntries(file);
    // La huella del .zip no puede ir adentro del propio .zip: se guarda al lado y se muestra en la Entrega.
    const sha256 = await sha256File(file);
    await fsp.writeFile(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`);
    job.deliverable = {
      file: path.basename(file), size, count, sha256, contentHash, builtAt: new Date().toISOString(),
      topLevel: summarizeTopLevel(entries), entrega: entregaSigned.slice(0, 20_000), hadEntrega: Boolean(entrega),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Espacio de trabajo y agente
  // ---------------------------------------------------------------------------------------------

  async prepareWorkspace(job) {
    const dir = this.dir(job.id);
    const work = this.workDir(job.id);
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(work, { recursive: true });
    for (const input of job.inputs) {
      const src = path.join(dir, 'uploads', input.name);
      if (input.kind === 'zip') {
        this.activity(job, 'tool', `Descomprimiendo ${input.name}`);
        await extractZipSafe(src, work, { maxEntries: this.config.limits.maxZipEntries, maxBytes: this.config.limits.maxUnzippedBytes });
      } else {
        await fsp.mkdir(path.join(work, '.systech', 'adjuntos'), { recursive: true });
        await fsp.copyFile(src, path.join(work, '.systech', 'adjuntos', input.name));
      }
    }
    await this.git(job.id, ['init', '-q', '-b', 'main']);
    await fsp.writeFile(path.join(work, '.git', 'info', 'exclude'), 'bin/\nobj/\nnode_modules/\nTestResults/\n.systech/\n.vs/\n.idea/\n');
    await this.commit(job.id, 'Punto de partida (archivos del pedido)', true);
    const base = await this.git(job.id, ['rev-parse', 'HEAD']);
    job.baseCommit = base.output.trim();
  }

  async agentStep(job, kind, prompt, signal) {
    const labels = { generate: 'Generando', change: 'Aplicando tu cambio', fix: 'Corrigiendo' };
    this.activity(job, 'tool', `${labels[kind]} con el agente`);
    const r = await runAgent({
      mode: kind, cwd: this.workDir(job.id), prompt, systemPrompt: this.agentPrompt, config: this.config, signal,
      logFile: path.join(this.dir(job.id), 'logs', `c${job.cycle}-a${job.attempt}-agent-${kind}.log`),
      onActivity: (a) => this.activity(job, a.kind, a.text),
    });
    job.costUsd = round(job.costUsd + r.costUsd);
    this.throwIfAborted(signal);
    if (!r.ok) throw new Error(r.error);
    await this.commit(job.id, `${labels[kind]} (ciclo ${job.cycle})`);
  }

  async git(id, args) {
    const r = await runProcess({
      cmd: 'git', args: ['-c', 'user.name=SYSTECH Studio', '-c', 'user.email=studio@systech.local', '-c', 'commit.gpgsign=false', ...args],
      cwd: this.workDir(id), env: childEnv('build', { LC_ALL: 'C', LANG: 'C' }), timeoutMs: this.config.timeouts.short,
    });
    if (!r.ok) throw new Error(`git ${args[0]} falló: ${r.output.slice(-500)}`);
    return r;
  }

  async commit(id, message, allowEmpty = false) {
    await this.git(id, ['add', '-A']);
    await this.git(id, ['commit', '-q', '-m', message, ...(allowEmpty ? ['--allow-empty'] : []), '--no-verify']).catch((err) => {
      if (!/nothing to commit|nada para hacer commit/.test(err.message)) throw err;
    });
  }

  async diffAgainstBase(id) {
    const job = this.get(id);
    const r = await this.git(id, ['diff', '--no-color', job.baseCommit, 'HEAD']);
    const max = 120_000;
    return r.output.length > max ? `${r.output.slice(0, max)}\n[diff recortado]` : r.output;
  }

  async changedFiles(id) {
    const job = this.get(id);
    if (!job?.baseCommit) return [];
    const r = await this.git(id, ['diff', '--name-status', '--no-renames', job.baseCommit, 'HEAD']);
    return r.output.split('\n').filter(Boolean).map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], path: rest.join('\t') };
    });
  }

  generatePrompt(job) {
    const zips = job.inputs.filter((i) => i.kind === 'zip').map((i) => i.name);
    const files = job.inputs.filter((i) => i.kind === 'file').map((i) => i.name);
    return [
      '# Pedido del cliente', job.request, '',
      '# Material recibido',
      zips.length ? `- Proyecto existente (descomprimido en esta carpeta): ${zips.join(', ')}` : '- No hay proyecto existente: creá la solución desde cero en esta carpeta.',
      files.length ? `- Adjuntos en .systech/adjuntos/: ${files.join(', ')}` : '- Sin adjuntos.',
      '',
      'Implementá el pedido completo. Después compilá, corré los tests, corregí lo que falle y escribí ENTREGA.md.',
    ].join('\n');
  }

  changePrompt(job, text) {
    return [
      '# Cambio pedido sobre el trabajo actual', text, '',
      '# Pedido original (referencia)', job.request, '',
      'Aplicá el cambio sin romper lo existente, actualizá las pruebas y ENTREGA.md, compilá y corré los tests.',
    ].join('\n');
  }

  fixPrompt(job, errors) {
    return [
      '# La verificación encontró estos problemas', '',
      ...errors.map((e, i) => `## ${i + 1}. ${e.title}\n${e.detail ? `\`\`\`\n${e.detail.slice(0, 6000)}\n\`\`\`` : ''}`), '',
      '# Pedido original (referencia)', job.request, '',
      'Corregí la causa de cada problema (no ocultes el síntoma ni desactives pruebas), agregá pruebas que lo cubran, compilá, corré los tests y actualizá ENTREGA.md si cambió algo relevante.',
    ].join('\n');
  }

  reviewPrompt(job, diff) {
    const changes = job.history.filter((h) => h.kind === 'change').map((h) => `- ${h.text}`);
    return [
      '# Pedido del cliente', job.request, '',
      changes.length ? `# Cambios pedidos después\n${changes.join('\n')}\n` : '',
      '# Cambios respecto del material original (git diff)',
      diff.trim() ? `\`\`\`diff\n${diff}\n\`\`\`` : '(proyecto creado desde cero; revisá toda la carpeta)', '',
      'La carpeta actual contiene exactamente el .zip que va a recibir el cliente (ignorá bin/ y obj/: son de la compilación de prueba). Revisalo y respondé solo con el JSON pedido.',
    ].join('\n');
  }

  // ---------------------------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------------------------

  setStatus(job, status, stage) {
    job.status = status;
    if (stage) job.stage = stage;
    this.touch(job);
  }

  activity(job, kind, text) {
    job.activity.push({ at: new Date().toISOString(), kind, text });
    if (job.activity.length > MAX_ACTIVITY) job.activity.splice(0, job.activity.length - MAX_ACTIVITY);
    this.touch(job);
  }

  throwIfAborted(signal) {
    if (signal?.aborted) throw new Error('Cancelado por vos.');
  }

  touch(job) {
    job.updatedAt = new Date().toISOString();
    if (this.saveTimers.has(job.id)) return;
    this.saveTimers.set(job.id, setTimeout(() => { this.saveNow(job); }, 700));
  }

  async saveNow(job) {
    clearTimeout(this.saveTimers.get(job.id));
    this.saveTimers.delete(job.id);
    job.updatedAt = new Date().toISOString();
    const file = path.join(this.dir(job.id), 'job.json');
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(job, null, 2), { mode: 0o600 });
      await fsp.rename(tmp, file);
    } catch (err) {
      // No se corta el trabajo por no poder guardar (p. ej. disco lleno): queda en memoria y se avisa.
      console.error(`No se pudo guardar el estado del trabajo ${job.id}: ${err.message}`);
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}

function summarizeTopLevel(entries) {
  const counts = new Map();
  for (const e of entries) {
    const top = e.includes('/') ? `${e.split('/')[0]}/` : e;
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  return [...counts.entries()].map(([name, files]) => ({ name, files })).sort((a, b) => (b.name.endsWith('/') - a.name.endsWith('/')) || a.name.localeCompare(b.name));
}
