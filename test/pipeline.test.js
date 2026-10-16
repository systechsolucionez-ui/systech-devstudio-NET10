// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { JobManager } from '../src/jobs.js';
import { listZipEntries } from '../src/zip.js';
import { tmpDir } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.FAKE_DELAY_MS = '0';

async function manager(extra = {}) {
  const config = loadConfig({ dataDir: tmpDir('studio-jobs-'), claudeBin: path.join(root, 'scripts', 'fake-claude.mjs'), ...extra });
  const m = new JobManager(config);
  await m.init();
  return m;
}

async function newJob(m, maxAttempts = 3) {
  const up = path.join(tmpDir(), 'requisitos.txt');
  fs.writeFileSync(up, 'precio por cantidad');
  return m.create({ name: 'Carrito', request: 'Total del carrito con validación', options: { maxAttempts, smoke: false }, uploads: [{ name: 'requisitos.txt', tmpPath: up, size: 19 }] });
}

test('ciclo completo: falla la 1, corrige, falla la 2, corrige y aprueba las dos', async () => {
  const m = await manager();
  const job = await newJob(m);
  await m.whenIdle();
  assert.equal(job.status, 'review', job.lastError);
  assert.equal(job.attempt, 3);
  assert.equal(job.v1.status, 'ok');
  assert.equal(job.v2.status, 'ok');
  assert.equal(job.v2.clean.status, 'ok');
  assert.equal(job.v2.review.status, 'ok');
  const fixes = job.activity.filter((a) => a.text === 'Corrigiendo con el agente').length;
  assert.equal(fixes, 2);

  const zip = path.join(m.dir(job.id), 'out', job.deliverable.file);
  const entries = await listZipEntries(zip);
  assert.ok(entries.includes('verificacion.md') && entries.includes('revision-independiente.md') && entries.includes('src/validacion.js'));
  assert.ok(!entries.some((e) => e.startsWith('.systech')), 'los adjuntos internos no se entregan');
  assert.ok(job.costUsd > 0);

  // El historial de git tiene un commit por paso del agente.
  const changed = await m.changedFiles(job.id);
  assert.ok(changed.some((c) => c.path === 'src/total.js'));

  assert.equal(m.request(job.id, { type: 'approve' }), null);
  assert.equal(job.status, 'delivered');
});

test('sin intentos suficientes queda para el usuario con los errores listos para corregir', async () => {
  const m = await manager();
  const job = await newJob(m, 1);
  await m.whenIdle();
  assert.equal(job.status, 'needs_attention');
  assert.equal(job.deliverable, null);
  assert.equal(job.errors.length, 1);
  assert.equal(job.errors[0].id, 'v1-test');
  assert.match(m.request(job.id, { type: 'approve' }), /dos verificaciones/);

  // "Corregir con el agente" sobre ese error.
  assert.equal(m.request(job.id, { type: 'fix', errorIds: ['v1-test'] }), null);
  await m.whenIdle();
  assert.equal(job.status, 'needs_attention'); // ahora lo frena el revisor independiente
  assert.equal(job.v1.status, 'ok');
  assert.equal(job.errors[0].source, 'v2');
  assert.match(job.errors[0].title, /Crítico/);
});

test('un pedido de cambio invalida la entrega anterior hasta volver a verificar', async () => {
  const m = await manager();
  const job = await newJob(m);
  await m.whenIdle();
  assert.ok(job.deliverable);
  assert.equal(m.request(job.id, { type: 'change', text: 'Agregá descuentos' }), null);
  assert.equal(job.deliverable, null);
  assert.ok(['queued', 'generating'].includes(job.status));
  assert.match(m.request(job.id, { type: 'change', text: 'otro' }), /en curso/);
  await m.whenIdle();
  assert.ok(['review', 'needs_attention'].includes(job.status));
  assert.equal(job.history.at(-1).text, 'Agregá descuentos');
});

test('si el agente no está autenticado, el error lo dice claramente', async () => {
  const bin = path.join(tmpDir(), 'claude-sin-login.sh');
  fs.writeFileSync(bin, '#!/bin/sh\necho "Invalid API key · Please run /login" >&2\nexit 1\n', { mode: 0o755 });
  const m = await manager({ claudeBin: bin });
  const job = await newJob(m);
  await m.whenIdle();
  assert.equal(job.status, 'failed');
  assert.match(job.lastError, /no está autenticado/);
});

test('los secretos del Codespace no llegan al agente simulado', async () => {
  const log = path.join(tmpDir(), 'env.txt');
  const bin = path.join(tmpDir(), 'claude-env.sh');
  fs.writeFileSync(bin, `#!/bin/sh\nenv > ${log}\nexit 1\n`, { mode: 0o755 });
  process.env.GITHUB_TOKEN = 'ghs_no_debe_llegar';
  try {
    const m = await manager({ claudeBin: bin });
    await newJob(m);
    await m.whenIdle();
  } finally { delete process.env.GITHUB_TOKEN; }
  assert.ok(!fs.readFileSync(log, 'utf8').includes('ghs_no_debe_llegar'));
});

test('cancelar corta el trabajo en curso', async () => {
  process.env.FAKE_DELAY_MS = '400';
  try {
    const m = await manager();
    const job = await newJob(m);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(m.cancel(job.id), null);
    await m.whenIdle();
    assert.equal(job.status, 'cancelled');
  } finally {
    process.env.FAKE_DELAY_MS = '0';
  }
});

test('al reiniciar, un trabajo en curso queda como interrumpido y se puede reintentar', async () => {
  const m = await manager();
  const job = await newJob(m);
  await m.whenIdle();
  const file = path.join(m.dir(job.id), 'job.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.status = 'verifying1';
  fs.writeFileSync(file, JSON.stringify(saved));
  const m2 = new JobManager(m.config);
  await m2.init();
  assert.equal(m2.get(job.id).status, 'interrupted');
  assert.equal(m2.request(job.id, { type: 'retry' }), null);
  await m2.whenIdle();
  assert.equal(m2.get(job.id).status, 'review');
});
