// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { extractZipSafe, createZip, listZipEntries } from '../src/zip.js';
import { makeZip, tmpDir, writeTree } from './helpers.js';

const limits = { maxEntries: 100, maxBytes: 1024 * 1024 };

function zipFile(dir, entries) {
  const file = path.join(dir, 'in.zip');
  fs.writeFileSync(file, makeZip(entries));
  return file;
}

test('rechaza rutas que escapan del destino (zip slip)', async () => {
  const dir = tmpDir();
  const file = zipFile(dir, [{ name: 'ok.txt', data: 'a' }, { name: '../../escapado.txt', data: 'x' }]);
  await assert.rejects(extractZipSafe(file, path.join(dir, 'out'), limits));
  assert.ok(!fs.existsSync(path.join(dir, '..', 'escapado.txt')));
});

test('rechaza rutas absolutas', async () => {
  const dir = tmpDir();
  const file = zipFile(dir, [{ name: '/tmp/absoluto.txt', data: 'x' }]);
  await assert.rejects(extractZipSafe(file, path.join(dir, 'out'), limits));
});

test('corta un zip bomb por tamaño descomprimido', async () => {
  const dir = tmpDir();
  const file = zipFile(dir, [{ name: 'a.bin', data: Buffer.alloc(800 * 1024) }, { name: 'b.bin', data: Buffer.alloc(800 * 1024) }]);
  await assert.rejects(extractZipSafe(file, path.join(dir, 'out'), limits), /supera/);
});

test('corta por cantidad de archivos', async () => {
  const dir = tmpDir();
  const file = zipFile(dir, Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
  await assert.rejects(extractZipSafe(file, path.join(dir, 'out'), { ...limits, maxEntries: 3 }), /más de 3/);
});

test('ignora enlaces simbólicos y aplana la carpeta raíz', async () => {
  const dir = tmpDir();
  const file = zipFile(dir, [
    { name: 'proyecto/', data: '', mode: 0o040755 },
    { name: 'proyecto/src/a.cs', data: 'class A {}' },
    { name: 'proyecto/link', data: '/etc/passwd', mode: 0o120777 },
  ]);
  const out = path.join(dir, 'out');
  await extractZipSafe(file, out, limits);
  assert.equal(fs.readFileSync(path.join(out, 'src', 'a.cs'), 'utf8'), 'class A {}');
  assert.ok(!fs.existsSync(path.join(out, 'link')));
  assert.ok(!fs.existsSync(path.join(out, 'proyecto')));
});

test('la entrega excluye secretos, binarios y estado local', async () => {
  const dir = tmpDir();
  const src = path.join(dir, 'src');
  writeTree(src, {
    'Api/Program.cs': 'x', '.env': 'SECRET=1', '.env.example': 'SECRET=', 'Api/bin/Release/a.dll': 'x', 'Api/obj/a.json': 'x',
    '.git/config': 'x', '.systech/adjuntos/req.pdf': 'x', 'cert.pfx': 'x', 'node_modules/a/index.js': 'x',
  });
  const out = path.join(dir, 'out.zip');
  const r = await createZip(src, out, { extra: [{ name: 'verificacion.md', content: '# ok' }] });
  const names = (await listZipEntries(out)).sort();
  assert.deepEqual(names, ['.env.example', 'Api/Program.cs', 'verificacion.md']);
  assert.equal(r.count, 3);
});
