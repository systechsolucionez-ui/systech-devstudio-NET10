// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBuildOutput, parseTestOutput, parseVulnerableOutput } from '../src/checks.js';
import { buildArgs, parseReview, redact, describeEvent } from '../src/agent.js';
import { childEnv } from '../src/proc.js';
import { scanSecrets } from '../src/secrets.js';
import { sanitizeFileName } from '../server.js';
import { slugify } from '../src/jobs.js';
import { REPO_RE, BRANCH_RE } from '../src/github.js';
import { tmpDir, writeTree } from './helpers.js';

const config = { claudeModel: '', maxBudgetUsd: 5 };

test('interpreta el resumen de dotnet test con varios ensamblados', () => {
  const out = [
    '  Failed PaymentSagaTests.Retry_DoesNotChargeTwice [12 ms]',
    'Failed!  - Failed:     1, Passed:    41, Skipped:     0, Total:    42, Duration: 2 s - App.Tests.dll (net10.0)',
    'Passed!  - Failed:     0, Passed:     1, Skipped:     0, Total:     1, Duration: 1 s - Domain.Tests.dll (net10.0)',
  ].join('\n');
  const r = parseTestOutput(out);
  assert.equal(r.total, 43);
  assert.equal(r.passed, 42);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.failedTests, ['PaymentSagaTests.Retry_DoesNotChargeTwice']);
});

test('separa errores y advertencias de MSBuild sin duplicados', () => {
  const out = 'a.cs(1,1): error CS1002: ; expected [x.csproj]\na.cs(1,1): error CS1002: ; expected [x.csproj]\nb.cs(2,2): warning CS8618: nullable [x.csproj]';
  const r = parseBuildOutput(out);
  assert.deepEqual(r.errors, ['a.cs(1,1): error CS1002: ; expected']);
  assert.equal(r.warnings.length, 1);
});

test('solo las vulnerabilidades altas o críticas bloquean', () => {
  const out = '   > Newtonsoft.Json   12.0.1   12.0.1   High   https://x\n   > OpenTelemetry.Api   1.10.0   1.10.0   Moderate   https://y';
  const r = parseVulnerableOutput(out);
  assert.deepEqual(r.blocking, ['Newtonsoft.Json 12.0.1 (High)']);
  assert.deepEqual(r.minor, ['OpenTelemetry.Api 1.10.0 (Moderate)']);
});

test('el revisor solo tiene herramientas de lectura', () => {
  const args = buildArgs({ mode: 'review', systemPrompt: 'x', config });
  const tools = args[args.indexOf('--tools') + 1];
  assert.equal(tools, 'Read,Glob,Grep');
  assert.ok(!args.includes('Edit') && !args.includes('Write') && !args.some((a) => a.startsWith('Bash')));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
});

test('el agente que genera no tiene red ni push', () => {
  const args = buildArgs({ mode: 'generate', systemPrompt: 'x', config });
  const denied = args.slice(args.indexOf('--disallowedTools') + 1);
  for (const t of ['WebFetch', 'WebSearch', 'Bash(curl *)', 'Bash(git push *)']) assert.ok(denied.includes(t), t);
  assert.ok(args.includes('--max-budget-usd'));
});

test('lee el informe del revisor aunque venga en un bloque de código', () => {
  const text = 'Listo.\n```json\n{"summary":"ok","requirements":{"met":2,"total":3,"missing":["Webhook"]},"findings":[{"severity":"Crítica","area":"Seguridad","title":"BOLA","file":"a.cs","line":4,"detail":"d"},{"severity":"baja","area":"calidad","title":"t","detail":"d"}]}\n```';
  const r = parseReview(text);
  assert.equal(r.findings[0].severity, 'critica');
  assert.equal(r.findings[0].area, 'seguridad');
  assert.equal(r.blocking.length, 1);
  assert.deepEqual(r.requirements.missing, ['Webhook']);
  assert.equal(parseReview('no es json'), null);
});

test('oculta claves en la consola', () => {
  assert.equal(redact('clave sk-ant-api03-abcdefghijklmnop y ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'clave [oculto] y [oculto]');
});

test('describe eventos del stream con rutas relativas', () => {
  const lines = describeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/src/a.cs' } }] } }, '/w');
  assert.deepEqual(lines, [{ kind: 'tool', text: 'Edit · src/a.cs' }]);
});

test('los procesos de compilación no reciben secretos', () => {
  process.env.GITHUB_TOKEN = 'ghs_x';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-x';
  process.env.MI_SECRETO = 'y';
  try {
    const build = childEnv('build');
    assert.equal(build.GITHUB_TOKEN, undefined);
    assert.equal(build.ANTHROPIC_API_KEY, undefined);
    assert.equal(build.MI_SECRETO, undefined);
    const agent = childEnv('agent');
    assert.equal(agent.ANTHROPIC_API_KEY, 'sk-ant-x');
    assert.equal(agent.GITHUB_TOKEN, undefined);
    assert.equal(childEnv('git').GITHUB_TOKEN, 'ghs_x');
  } finally {
    delete process.env.GITHUB_TOKEN; delete process.env.ANTHROPIC_API_KEY; delete process.env.MI_SECRETO;
  }
});

test('detecta secretos reales y tolera contraseñas de desarrollo', async () => {
  const dir = tmpDir();
  writeTree(dir, {
    'src/Pagos.cs': 'var token = "APP_USR-1234567-101512-0123456789abcdef0123456789abcdef-12345678";',
    'appsettings.json': '{"ConnectionStrings":{"Db":"Host=db;Password=SuperSecreta1"}}',
    'appsettings.Development.json': '{"ConnectionStrings":{"Db":"Host=db;Password=postgres"}}',
    'bin/Release/x.json': 'sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '.env': 'ANTHROPIC_API_KEY=sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  const r = await scanSecrets(dir);
  assert.deepEqual(r.blocking.map((b) => b.file), ['src/Pagos.cs']);
  assert.deepEqual(r.warnings.map((w) => w.file), ['appsettings.json']);
});

test('limpia nombres de archivo subidos', () => {
  assert.equal(sanitizeFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('C:\\x\\proyecto final.zip'), 'proyecto final.zip');
  assert.equal(sanitizeFileName('.env'), 'env');
  assert.equal(sanitizeFileName('<script>.zip'), '_script_.zip');
  assert.equal(sanitizeFileName(''), null);
});

test('valida repositorios, ramas y nombres', () => {
  assert.ok(REPO_RE.test('systechsolucionez-ui/mi-proyecto'));
  assert.ok(!REPO_RE.test('a/b;rm -rf /'));
  assert.ok(!REPO_RE.test('https://github.com/a/b'));
  assert.ok(BRANCH_RE.test('systech/saga-pagos-abc123'));
  assert.ok(!BRANCH_RE.test('-x'));
  assert.ok(!BRANCH_RE.test('a..b'));
  assert.equal(slugify('Saga de pagos: versión 2!'), 'saga-de-pagos-version-2');
});
