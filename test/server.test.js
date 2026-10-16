// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { JobManager } from '../src/jobs.js';
import { createServer } from '../server.js';
import { tmpDir } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server; let base; let manager;

test.before(async () => {
  const config = loadConfig({ dataDir: tmpDir('studio-srv-'), claudeBin: path.join(root, 'scripts', 'fake-claude.mjs'), limits: { maxUploadBytes: 1024 * 1024 } });
  manager = new JobManager(config);
  await manager.init();
  server = createServer(config, manager);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await manager.whenIdle(); server.close(); });

const post = (p, init = {}) => fetch(base + p, { method: 'POST', ...init, headers: { 'X-Studio': '1', ...init.headers } });

test('sirve la interfaz con cabeceras de seguridad', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('rechaza hosts desconocidos (DNS rebinding)', async () => {
  const http = await import('node:http');
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/jobs', headers: { Host: 'atacante.com' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 421);
});

test('rechaza escrituras sin el encabezado anti-CSRF', async () => {
  const r = await fetch(`${base}/api/jobs`, { method: 'POST', body: new FormData() });
  assert.equal(r.status, 403);
});

test('valida el pedido y la cantidad de intentos', async () => {
  const fd = new FormData();
  fd.append('request', '   ');
  assert.equal((await post('/api/jobs', { body: fd })).status, 400);
  const fd2 = new FormData();
  fd2.append('request', 'algo');
  fd2.append('maxAttempts', '9');
  assert.equal((await post('/api/jobs', { body: fd2 })).status, 400);
});

test('limita el tamaño de los archivos subidos', async () => {
  const fd = new FormData();
  fd.append('request', 'algo');
  fd.append('files', new Blob([Buffer.alloc(2 * 1024 * 1024)]), 'grande.zip');
  const r = await post('/api/jobs', { body: fd });
  assert.equal(r.status, 413);
});

test('crea un trabajo, bloquea rutas fuera del proyecto y sirve la entrega solo cuando corresponde', async () => {
  const fd = new FormData();
  fd.append('name', 'Prueba');
  fd.append('request', 'Total del carrito');
  fd.append('files', new Blob(['hola']), '../../nota.txt');
  const r = await post('/api/jobs', { body: fd });
  assert.equal(r.status, 201);
  const { id } = await r.json();
  assert.equal(manager.get(id).inputs[0].name, 'nota.txt');

  const early = await fetch(`${base}/api/jobs/${id}/download`);
  assert.equal(early.status, 409);

  await manager.whenIdle();
  for (const bad of ['../job.json', '.git/config', '/etc/passwd', 'src/../../job.json']) {
    const res = await fetch(`${base}/api/jobs/${id}/file?path=${encodeURIComponent(bad)}`);
    assert.ok([400, 404].includes(res.status), `${bad} → ${res.status}`);
  }
  const ok = await (await fetch(`${base}/api/jobs/${id}/file?path=src/total.js`)).json();
  assert.match(ok.content, /export function total/);

  const zip = await fetch(`${base}/api/jobs/${id}/download`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');

  const logName = (await (await fetch(`${base}/api/jobs/${id}/logs`)).json())[0];
  assert.equal((await fetch(`${base}/api/jobs/${id}/logs/${logName}`)).status, 200);
  assert.equal((await fetch(`${base}/api/jobs/${id}/logs/..%2Fjob.json`)).status, 400);

  const push = await post(`/api/jobs/${id}/push`, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: 'a/b; rm -rf ~' }) });
  assert.equal(push.status, 400);
});

test('ids inválidos y JSON mal formado', async () => {
  assert.equal((await fetch(`${base}/api/jobs/..%2F..%2Fetc`)).status, 404);
  const job = manager.list()[0];
  const r = await post(`/api/jobs/${job.id}/change`, { headers: { 'Content-Type': 'application/json' }, body: '{malo' });
  assert.equal(r.status, 400);
});
