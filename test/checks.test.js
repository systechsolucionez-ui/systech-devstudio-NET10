// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAutomaticChecks, runCleanBuild, detectProject } from '../src/checks.js';
import { tmpDir, writeTree } from './helpers.js';

const fakeBin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bin');
process.env.PATH = `${fakeBin}:${process.env.PATH}`;
const timeouts = { build: 10_000, test: 10_000, short: 10_000, smoke: 10_000 };

function dotnetProject(extra = {}) {
  const dir = tmpDir();
  writeTree(dir, { 'Tienda.sln': '', 'src/Api/Api.csproj': '<Project/>', 'src/Api/Program.cs': 'x', ...extra });
  fs.mkdirSync(path.join(dir, 'logs'));
  return dir;
}

async function run(dir) {
  return runAutomaticChecks({ dir, logDir: path.join(dir, 'logs'), logPrefix: 't', timeouts, smoke: false, jobId: 'abc' });
}

test('detecta la solución .NET más cercana a la raíz', async () => {
  const dir = tmpDir();
  writeTree(dir, { 'tests/Otra.sln': '', 'Principal.sln': '', 'src/A/A.csproj': '' });
  assert.deepEqual(await detectProject(dir), { kind: 'dotnet', target: 'Principal.sln' });
});

test('proyecto .NET sano: compila, tests, vulnerabilidades medias como aviso', async () => {
  const dir = dotnetProject();
  const r = await run(dir);
  const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  assert.equal(by.build.status, 'ok');
  assert.equal(by.build.summary, '0 errores · 1 advertencias');
  assert.equal(by.test.status, 'ok');
  assert.equal(by.test.summary, '43 / 43');
  assert.equal(by.vuln.status, 'warn');
  assert.equal(by.secrets.status, 'ok');
  assert.ok(fs.existsSync(path.join(dir, 'logs', 't-build.log')));
});

test('si no compila, no sigue con los tests y muestra el error', async () => {
  const r = await run(dotnetProject({ FAIL_BUILD: '' }));
  assert.deepEqual(r.checks.map((c) => c.key), ['build']);
  assert.equal(r.checks[0].status, 'fail');
  assert.match(r.checks[0].details[0], /CS1002/);
});

test('tests que fallan y paquetes con vulnerabilidad alta bloquean', async () => {
  const r = await run(dotnetProject({ FAIL_TEST: '', VULN_HIGH: '' }));
  const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  assert.equal(by.test.status, 'fail');
  assert.equal(by.test.summary, '42 / 43');
  assert.deepEqual(by.test.details, ['PaymentSagaTests.Retry_DoesNotChargeTwice']);
  assert.equal(by.vuln.status, 'fail');
});

test('un secreto en el código bloquea la verificación', async () => {
  const r = await run(dotnetProject({ 'src/Api/Keys.cs': 'const string K = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";' }));
  assert.equal(r.checks.find((c) => c.key === 'secrets').status, 'fail');
});

test('entorno limpio: informa compilación y tests desde cero', async () => {
  const ok = await runCleanBuild({ dir: dotnetProject(), logDir: tmpDir(), logPrefix: 'c', timeouts });
  assert.deepEqual(ok, { ok: true, summary: 'Compila y pasa 43/43 desde cero' });
  const bad = await runCleanBuild({ dir: dotnetProject({ FAIL_TEST: '' }), logDir: tmpDir(), logPrefix: 'c', timeouts });
  assert.equal(bad.ok, false);
});
