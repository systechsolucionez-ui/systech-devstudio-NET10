// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yauzl from 'yauzl';
import yazl from 'yazl';

/** Carpetas y archivos que nunca se entregan: binarios, dependencias, estado local y secretos. */
export const EXCLUDED_DIRS = new Set(['.git', 'bin', 'obj', 'node_modules', '.vs', '.idea', 'TestResults', '.systech']);
const EXCLUDED_FILE_PATTERNS = [/^\.env$/, /^\.env\..+$/, /\.user$/, /^salida\.txt$/, /\.pfx$/i, /\.p12$/i, /^\.DS_Store$/];

export function isExcludedFile(name) {
  return EXCLUDED_FILE_PATTERNS.some((re) => re.test(name)) && name !== '.env.example';
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true, strictFileNames: false, validateEntrySizes: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

/**
 * Descomprime de forma segura:
 *  - rechaza rutas absolutas y "..": imposible escribir fuera del destino (zip slip);
 *  - ignora enlaces simbólicos;
 *  - corta si hay demasiadas entradas o si el contenido descomprimido supera el límite (zip bomb);
 *  - si el zip trae una sola carpeta raíz (p. ej. "mi-proyecto/"), la aplana.
 */
export async function extractZipSafe(zipPath, destDir, { maxEntries, maxBytes }) {
  const staging = await fsp.mkdtemp(path.join(path.dirname(destDir), '.unzip-'));
  try {
    await extractInto(zipPath, staging, { maxEntries, maxBytes });
    const root = await singleRootDir(staging);
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.cp(root, destDir, { recursive: true, force: true, verbatimSymlinks: true });
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
}

async function extractInto(zipPath, dest, { maxEntries, maxBytes }) {
  const zip = await openZip(zipPath);
  const destReal = path.resolve(dest);
  let entries = 0;
  let total = 0;

  await new Promise((resolve, reject) => {
    const fail = (err) => { try { zip.close(); } catch { /* ya cerrado */ } reject(err); };
    zip.on('error', fail);
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      entries += 1;
      if (entries > maxEntries) return fail(new Error(`El zip tiene más de ${maxEntries} archivos.`));

      const name = entry.fileName.replace(/\\/g, '/');
      const target = path.resolve(destReal, name);
      if (target !== destReal && !target.startsWith(destReal + path.sep)) {
        return fail(new Error(`Ruta no permitida dentro del zip: ${name}`));
      }
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (mode === 0o120000) { zip.readEntry(); return undefined; } // enlace simbólico: se ignora

      if (name.endsWith('/')) {
        fs.mkdir(target, { recursive: true }, (err) => (err ? fail(err) : zip.readEntry()));
        return undefined;
      }

      total += entry.uncompressedSize;
      if (total > maxBytes) return fail(new Error(`El contenido descomprimido supera ${Math.round(maxBytes / 1048576)} MB.`));

      fs.mkdir(path.dirname(target), { recursive: true }, (mkErr) => {
        if (mkErr) return fail(mkErr);
        zip.openReadStream(entry, (err, stream) => {
          if (err) return fail(err);
          const out = fs.createWriteStream(target, { mode: 0o644 });
          stream.on('error', fail);
          out.on('error', fail);
          out.on('finish', () => zip.readEntry());
          stream.pipe(out);
          return undefined;
        });
        return undefined;
      });
      return undefined;
    });
    zip.readEntry();
  });
}

async function singleRootDir(dir) {
  const items = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.name !== '__MACOSX');
  if (items.length === 1 && items[0].isDirectory()) return path.join(dir, items[0].name);
  return dir;
}

/** Recorre el proyecto devolviendo rutas relativas (con "/") de lo que se entrega. */
export async function listDeliverableFiles(rootDir) {
  const out = [];
  async function walk(rel) {
    const abs = path.join(rootDir, rel);
    const items = await fsp.readdir(abs, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (!EXCLUDED_DIRS.has(item.name)) await walk(childRel);
      } else if (item.isFile() && !isExcludedFile(item.name)) {
        out.push(childRel);
      }
    }
  }
  await walk('');
  return out;
}

/** Crea el .zip de entrega. extra: [{ name, content }] para informes generados por el Studio. */
export async function createZip(rootDir, outFile, { prefix = '', extra = [] } = {}) {
  const files = await listDeliverableFiles(rootDir);
  const zip = new yazl.ZipFile();
  const extraNames = new Set(extra.map((e) => e.name));
  for (const rel of files) {
    if (extraNames.has(rel)) continue;
    zip.addFile(path.join(rootDir, rel), prefix + rel, { mode: 0o100644 });
  }
  for (const e of extra) zip.addBuffer(Buffer.from(e.content, 'utf8'), prefix + e.name, { mode: 0o100644 });
  zip.end();
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    zip.outputStream.on('error', reject);
    out.on('error', reject);
    out.on('close', resolve);
    zip.outputStream.pipe(out);
  });
  await fsp.rename(tmp, outFile);
  const { size } = await fsp.stat(outFile);
  return { size, count: files.filter((f) => !extraNames.has(f)).length + extra.length };
}

/** SHA-256 de un archivo, leído en streaming (sirve para .zip grandes). */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Huella de cada archivo entregable, en el formato de `sha256sum` ("<hash>  <ruta>").
 * El cliente la comprueba con `sha256sum -c SHA256SUMS.txt`. skip: rutas que no se incluyen.
 */
export async function buildChecksums(rootDir, skip = new Set()) {
  const files = (await listDeliverableFiles(rootDir)).filter((rel) => !skip.has(rel));
  const lines = [];
  for (const rel of files) lines.push(`${await sha256File(path.join(rootDir, rel))}  ${rel}`);
  const manifest = lines.length ? `${lines.join('\n')}\n` : '';
  return { manifest, contentHash: crypto.createHash('sha256').update(manifest).digest('hex'), count: files.length };
}

export async function listZipEntries(zipPath) {
  const zip = await openZip(zipPath);
  const names = [];
  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (e) => { if (!e.fileName.endsWith('/')) names.push(e.fileName); zip.readEntry(); });
    zip.readEntry();
  });
  return names;
}
