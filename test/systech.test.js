// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

// Firma de Systech Soluciones, licencia, privacidad y versión 1.1.0.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { JobManager } from '../src/jobs.js';
import { ABOUT, banner, signatureLine } from '../src/about.js';
import { createServer } from '../server.js';
import { extractZipSafe } from '../src/zip.js';
import { tmpDir } from './helpers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const SIGNATURE = `Verificado con SYSTECH Studio v${pkg.version} — Systech Soluciones`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('package.json: versión 1.1.0, licencia Apache-2.0 y autor', () => {
  assert.equal(pkg.version, '1.1.0');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.author, 'José Antonio Vivas — Systech Soluciones');
  assert.match(pkg.config.authorUrl, /\?ref=studio$/);
});

test('LICENSE (Apache 2.0 completa) y NOTICE con la autoría', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.match(license, /Copyright 2026 José Antonio Vivas — Systech Soluciones/);
  const notice = read('NOTICE');
  assert.match(notice, /SYSTECH Studio\. Copyright 2026 José Antonio Vivas — Systech Soluciones\./);
  assert.match(notice, /sección 4d/);
});

test('todos los .js del servidor, src/ y public/ tienen el encabezado SPDX', () => {
  const files = ['server.js', ...fs.readdirSync(path.join(root, 'src')).map((f) => `src/${f}`), ...fs.readdirSync(path.join(root, 'public')).map((f) => `public/${f}`)]
    .filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const head = read(f).split('\n').slice(0, 3).join('\n');
    assert.match(head, /SPDX-License-Identifier: Apache-2\.0/, f);
    assert.match(head, /Copyright 2026 José Antonio Vivas — Systech Soluciones/, f);
  }
});

test('el pie con la firma está en la interfaz, con la versión de package.json y el enlace ?ref=studio', () => {
  const html = read('public/index.html');
  const footer = /<footer class="signature"[\s\S]*?<\/footer>/.exec(html)?.[0];
  assert.ok(footer, 'falta el pie');
  assert.match(footer, /SYSTECH Studio/);
  assert.match(footer, new RegExp(`v${pkg.version.replace(/\./g, '\\.')}`));
  assert.match(footer, /Creado por José Antonio Vivas/);
  assert.match(footer, /Systech Soluciones/);
  assert.match(footer, /href="[^"]+\?ref=studio"/);
  // El pie está fuera de <main>: se ve en todas las pantallas.
  assert.ok(html.indexOf('<footer class="signature"') > html.indexOf('</main>'));
  assert.match(read('public/app.css'), /\.signature \{ position: fixed;/);
});

test('la ventana "Acerca de" tiene logo, versión, autor, licencia, repositorio y el aviso de Claude Code', () => {
  const html = read('public/index.html');
  assert.match(html, /id="about-open"/);
  const dialog = /<dialog class="about"[\s\S]*?<\/dialog>/.exec(html)?.[0];
  assert.ok(dialog, 'falta el diálogo');
  for (const re of [/<img src="\/logo\.webp"/, /data-version/, /José Antonio Vivas/, /Apache 2\.0/, /github\.com\//, /Claude Code/, /propia clave/, /sin garantía/]) {
    assert.match(dialog, re);
  }
  // Solo texto plano: sin logos de terceros.
  assert.doesNotMatch(dialog, /anthropic|claude[^ ]*\.(png|svg|webp)/i);
});

test('sin recursos externos: tipografías locales y CSP con font-src self', () => {
  const html = read('public/index.html');
  const css = read('public/app.css') + read('public/fonts/fonts.css');
  assert.doesNotMatch(html + css, /googleapis|gstatic/);
  for (const m of read('public/fonts/fonts.css').matchAll(/url\(\/fonts\/([\w.-]+\.woff2)\)/g)) {
    assert.ok(fs.existsSync(path.join(root, 'public', 'fonts', m[1])), m[1]);
  }
  for (const f of ['LICENSE-Sora.txt', 'LICENSE-IBM-Plex-Sans.txt', 'LICENSE-JetBrains-Mono.txt']) {
    assert.match(read(`public/fonts/${f}`), /SIL Open Font License, Version 1\.1/);
  }
  // Ni la interfaz ni el servidor llaman a servidores de terceros (no hay telemetría).
  const code = ['server.js', 'public/app.js', ...fs.readdirSync(path.join(root, 'src')).map((f) => `src/${f}`)].map(read).join('\n');
  assert.doesNotMatch(code, /fetch\(\s*['"`]https?:/);
  assert.doesNotMatch(code, /https?\.request\(/);
});

test('el servidor sirve las tipografías y /api/about, y la CSP no permite orígenes externos', async () => {
  const config = loadConfig({ dataDir: tmpDir('studio-about-') });
  const m = new JobManager(config);
  await m.init();
  const server = createServer(config, m);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /font-src 'self'/);
    assert.match(csp, /style-src 'self';/);
    assert.doesNotMatch(csp, /googleapis|gstatic/);
    const fontCss = await fetch(`${base}/fonts/fonts.css`);
    assert.equal(fontCss.status, 200);
    const woff = await fetch(`${base}/fonts/sora-latin-700-normal.woff2`);
    assert.equal(woff.headers.get('content-type'), 'font/woff2');
    assert.equal((await fetch(`${base}/fonts/..%2Fapp.js`)).status, 404);
    const about = await (await fetch(`${base}/api/about`)).json();
    assert.equal(about.version, pkg.version);
    assert.equal(about.license, 'Apache-2.0');
    assert.equal(about.company, 'Systech Soluciones');
    assert.match(about.authorUrl, /\?ref=studio$/);
  } finally {
    server.close();
  }
});

test('el encabezado de la terminal muestra versión y Systech Soluciones', () => {
  const text = banner();
  assert.match(text, new RegExp(`SYSTECH Studio v${pkg.version.replace(/\./g, '\\.')} · Systech Soluciones`));
  assert.match(read('scripts/start.sh'), /banner\(\)/);
});

test('entrega firmada: los tres informes llevan la firma y las huellas se pueden verificar', async () => {
  const config = loadConfig({ dataDir: tmpDir('studio-sign-'), claudeBin: path.join(root, 'scripts', 'fake-claude.mjs') });
  const m = new JobManager(config);
  await m.init();
  const stages = [];
  const original = m.setStatus.bind(m);
  m.setStatus = (job, status, stage) => { original(job, status, stage); stages.push(`${job.status}:${job.stage}`); };

  const up = path.join(tmpDir(), 'nota.txt');
  fs.writeFileSync(up, 'x');
  const job = await m.create({ name: 'Carrito', request: 'Total del carrito con validación', options: { maxAttempts: 3, smoke: false }, uploads: [{ name: 'nota.txt', tmpPath: up, size: 1 }] });
  await m.whenIdle();
  assert.equal(job.status, 'review', job.lastError);

  // Arreglo de la barra de pasos: mientras corrige, marca la verificación que falló.
  assert.ok(stages.includes('fixing:v1'), stages.join(' '));
  assert.ok(stages.includes('fixing:v2'), stages.join(' '));
  assert.ok(!stages.includes('fixing:generate'), stages.join(' '));

  const zip = path.join(m.dir(job.id), 'out', job.deliverable.file);
  const zipHash = sha256(fs.readFileSync(zip));
  assert.equal(job.deliverable.sha256, zipHash);
  assert.equal(fs.readFileSync(`${zip}.sha256`, 'utf8'), `${zipHash}  ${job.deliverable.file}\n`);

  const out = path.join(tmpDir(), 'x');
  await extractZipSafe(zip, out, { maxEntries: 1000, maxBytes: 10 * 1024 * 1024 });
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8');
  const contentHash = sha256(sums);
  assert.equal(job.deliverable.contentHash, contentHash);
  for (const name of ['verificacion.md', 'revision-independiente.md', 'ENTREGA.md']) {
    const last = fs.readFileSync(path.join(out, name), 'utf8').trimEnd().split('\n').at(-1);
    assert.ok(last.startsWith(SIGNATURE), `${name}: ${last}`);
    assert.match(last, /· \d{4}-\d{2}-\d{2} ·/);
    assert.ok(last.includes(contentHash), name);
  }
  // Cada línea de SHA256SUMS.txt coincide con el archivo real (lo mismo que hace `sha256sum -c`).
  const lines = sums.trim().split('\n');
  assert.ok(lines.length >= 4);
  for (const line of lines) {
    const [hash, rel] = line.split('  ');
    assert.equal(sha256(fs.readFileSync(path.join(out, rel))), hash, rel);
  }
  assert.ok(!lines.some((l) => /ENTREGA\.md|verificacion\.md|revision-independiente\.md/.test(l)));
  // El informe que se copia para el cliente incluye la firma.
  assert.ok(job.deliverable.entrega.includes(SIGNATURE));
});

test('la firma tiene el formato pedido', () => {
  const line = signatureLine({ date: '2026-10-16', contentHash: 'abc' });
  assert.equal(line, `Verificado con SYSTECH Studio v${ABOUT.version} — Systech Soluciones · 2026-10-16 · Huella SHA-256 del contenido: abc (detalle por archivo en SHA256SUMS.txt)`);
});
