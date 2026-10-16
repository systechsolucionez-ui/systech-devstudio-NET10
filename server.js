// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Busboy from 'busboy';
import { loadConfig, APP_ROOT } from './src/config.js';
import { JobManager, isValidId, slugify } from './src/jobs.js';
import { runProcess, childEnv } from './src/proc.js';
import { pushToGitHub, REPO_RE, BRANCH_RE } from './src/github.js';
import { ABOUT, banner } from './src/about.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/logo-mark.webp': ['logo-mark.webp', 'image/webp'],
  '/logo.webp': ['logo.webp', 'image/webp'],
};

const SECURITY_HEADERS = {
  // Todo se sirve desde el propio Studio (también las tipografías): ningún recurso externo, sin filtrar la IP del usuario.
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createServer(config, manager) {
  const staticFiles = new Map(Object.entries(STATIC).map(([route, [file, type]]) => [route, { body: fs.readFileSync(path.join(APP_ROOT, 'public', file)), type }]));
  // Tipografías locales: lista cerrada leída al arrancar (nunca se arma una ruta con datos del request).
  const fontsDir = path.join(APP_ROOT, 'public', 'fonts');
  for (const f of fs.readdirSync(fontsDir)) {
    const type = f.endsWith('.woff2') ? 'font/woff2' : f.endsWith('.css') ? 'text/css; charset=utf-8' : f.endsWith('.txt') ? 'text/plain; charset=utf-8' : null;
    if (type) staticFiles.set(`/fonts/${f}`, { body: fs.readFileSync(path.join(fontsDir, f)), type, immutable: f.endsWith('.woff2') });
  }
  const allowedHosts = (process.env.STUDIO_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  let envCache = null;

  function hostAllowed(hostHeader) {
    if (!hostHeader) return false;
    const host = hostHeader.toLowerCase().replace(/:\d+$/, '');
    // Protege contra DNS rebinding: solo se responde a localhost y al reenvío de puertos de Codespaces.
    return ['localhost', '127.0.0.1', '[::1]'].includes(host) || host.endsWith('.app.github.dev') || allowedHosts.includes(host);
  }

  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (!hostAllowed(req.headers.host)) throw new HttpError(421, 'Host no permitido.');

    const url = new URL(req.url, 'http://studio.local');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Anti-CSRF: un formulario o un fetch de otro sitio no pueden enviar este encabezado
      // sin pasar por un preflight CORS, que este servidor nunca aprueba.
      if (req.headers['x-studio'] !== '1') throw new HttpError(403, 'Solicitud rechazada.');
    }

    if (req.method === 'GET' && staticFiles.has(url.pathname)) {
      const f = staticFiles.get(url.pathname);
      res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': f.immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
      return res.end(f.body);
    }

    if (parts[0] !== 'api') throw new HttpError(404, 'No encontrado.');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET' && url.pathname === '/api/env') return json(res, 200, await environment());
    if (req.method === 'GET' && url.pathname === '/api/about') return json(res, 200, ABOUT);
    if (url.pathname === '/api/jobs') {
      if (req.method === 'GET') return json(res, 200, manager.list());
      if (req.method === 'POST') return createJob(req, res);
    }

    if (parts[1] === 'jobs' && parts[2]) {
      const id = parts[2];
      if (!isValidId(id)) throw new HttpError(404, 'El trabajo no existe.');
      const job = manager.get(id);
      if (!job) throw new HttpError(404, 'El trabajo no existe.');
      const action = parts[3] || '';

      if (req.method === 'GET') {
        if (!action) return json(res, 200, { ...job, running: manager.current?.job.id === id });
        if (action === 'files') return json(res, 200, { changed: await manager.changedFiles(id).catch(() => []) });
        if (action === 'file') return json(res, 200, await readWorkFile(id, url.searchParams.get('path')));
        if (action === 'logs' && !parts[4]) return json(res, 200, await listLogs(id));
        if (action === 'logs' && parts[4]) return sendLog(res, id, parts[4]);
        if (action === 'download') return sendDeliverable(res, job);
        if (action === 'download.sha256') return sendChecksum(res, job);
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        let error = null;
        if (action === 'fix') {
          const ids = Array.isArray(body.errorIds) ? body.errorIds.filter((x) => typeof x === 'string').slice(0, 50) : [];
          if (!ids.length) throw new HttpError(400, 'Indicá qué error corregir.');
          error = manager.request(id, { type: 'fix', errorIds: ids });
        } else if (action === 'change') {
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) throw new HttpError(400, 'Escribí el cambio que querés.');
          if (text.length > config.limits.maxRequestChars) throw new HttpError(400, 'El cambio es demasiado largo.');
          error = manager.request(id, { type: 'change', text });
        } else if (action === 'retry') error = manager.request(id, { type: 'retry' });
        else if (action === 'approve') error = manager.request(id, { type: 'approve' });
        else if (action === 'cancel') error = manager.cancel(id);
        else if (action === 'push') return push(res, job, body);
        else throw new HttpError(404, 'Acción desconocida.');
        if (error) throw new HttpError(409, error);
        return json(res, 202, { ok: true });
      }
    }
    throw new HttpError(404, 'No encontrado.');
  }

  async function createJob(req, res) {
    const ctype = req.headers['content-type'] || '';
    if (!ctype.startsWith('multipart/form-data')) throw new HttpError(415, 'Se esperaba un formulario multipart.');
    const incoming = path.join(config.dataDir, '.incoming', crypto.randomBytes(8).toString('hex'));
    await fsp.mkdir(incoming, { recursive: true, mode: 0o700 });
    try {
      const { fields, uploads } = await parseMultipart(req, incoming);
      const request = (fields.request || '').trim();
      if (!request) throw new HttpError(400, 'Describí el pedido.');
      if (request.length > config.limits.maxRequestChars) throw new HttpError(400, `El pedido supera ${config.limits.maxRequestChars} caracteres.`);
      const name = ((fields.name || '').trim() || request.split('\n')[0]).slice(0, config.limits.maxNameChars);
      const maxAttempts = Number.parseInt(fields.maxAttempts || String(config.maxAttemptsDefault), 10);
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) throw new HttpError(400, 'Los intentos tienen que ser entre 1 y 5.');
      const job = await manager.create({ name, request, options: { maxAttempts, smoke: fields.smoke === 'true' }, uploads });
      return json(res, 201, { id: job.id });
    } finally {
      await fsp.rm(incoming, { recursive: true, force: true });
    }
  }

  function parseMultipart(req, dir) {
    return new Promise((resolve, reject) => {
      let bb;
      try {
        bb = Busboy({ headers: req.headers, limits: { fileSize: config.limits.maxUploadBytes, files: config.limits.maxFiles, fields: 10, fieldSize: 64 * 1024, parts: 40 } });
      } catch {
        reject(new HttpError(400, 'Formulario inválido.'));
        return;
      }
      const fields = {};
      const uploads = [];
      const pending = [];
      const used = new Set();
      let total = 0;
      let failed = null;
      const fail = (err) => { if (!failed) { failed = err; req.unpipe(bb); req.resume(); reject(err); } };

      bb.on('field', (name, value, info) => {
        if (info.valueTruncated) return fail(new HttpError(413, 'Un campo del formulario es demasiado largo.'));
        if (['name', 'request', 'maxAttempts', 'smoke'].includes(name)) fields[name] = value;
        return undefined;
      });
      bb.on('file', (field, stream, info) => {
        if (failed || field !== 'files') { stream.resume(); return; }
        const safe = uniqueName(sanitizeFileName(info.filename), used);
        if (!safe) { stream.resume(); return; }
        const tmpPath = path.join(dir, safe);
        const out = fs.createWriteStream(tmpPath, { mode: 0o600 });
        const entry = { name: safe, tmpPath, size: 0 };
        stream.on('data', (chunk) => {
          entry.size += chunk.length;
          total += chunk.length;
          if (total > config.limits.maxUploadBytes) { stream.unpipe(out); out.destroy(); fail(new HttpError(413, `Los archivos superan ${Math.round(config.limits.maxUploadBytes / 1048576)} MB en total.`)); }
        });
        stream.on('limit', () => fail(new HttpError(413, `${safe} supera el tamaño máximo.`)));
        pending.push(new Promise((ok, ko) => { out.on('close', ok); out.on('error', ko); }));
        stream.pipe(out);
        uploads.push(entry);
      });
      bb.on('filesLimit', () => fail(new HttpError(413, `Máximo ${config.limits.maxFiles} archivos por trabajo.`)));
      bb.on('partsLimit', () => fail(new HttpError(413, 'Demasiadas partes en el formulario.')));
      bb.on('error', () => fail(new HttpError(400, 'Formulario inválido.')));
      bb.on('close', async () => {
        if (failed) return;
        try { await Promise.all(pending); } catch (err) { fail(err); return; }
        resolve({ fields, uploads: uploads.filter((u) => u.size > 0) });
      });
      req.pipe(bb);
    });
  }

  async function readWorkFile(id, rel) {
    if (typeof rel !== 'string' || !rel || rel.length > 500 || rel.includes('\0') || path.isAbsolute(rel)) throw new HttpError(400, 'Ruta inválida.');
    const root = await fsp.realpath(manager.workDir(id)).catch(() => { throw new HttpError(404, 'Todavía no hay archivos.'); });
    let real;
    try { real = await fsp.realpath(path.resolve(root, rel)); } catch { throw new HttpError(404, 'El archivo no existe (puede haber sido borrado).'); }
    if (!real.startsWith(root + path.sep) || real.split(path.sep).includes('.git')) throw new HttpError(400, 'Ruta inválida.');
    const stat = await fsp.stat(real);
    if (!stat.isFile()) throw new HttpError(400, 'No es un archivo.');
    if (stat.size > config.limits.maxViewBytes) return { path: rel, tooLarge: true, size: stat.size };
    const buf = await fsp.readFile(real);
    if (buf.subarray(0, 8000).includes(0)) return { path: rel, binary: true, size: stat.size };
    return { path: rel, content: buf.toString('utf8'), size: stat.size };
  }

  async function listLogs(id) {
    const dir = path.join(manager.dir(id), 'logs');
    const files = await fsp.readdir(dir).catch(() => []);
    return files.filter((f) => f.endsWith('.log')).sort();
  }

  async function sendLog(res, id, name) {
    if (!/^[\w.-]{1,120}\.log$/.test(name)) throw new HttpError(400, 'Nombre inválido.');
    const file = path.join(manager.dir(id), 'logs', name);
    let stat;
    try { stat = await fsp.stat(file); } catch { throw new HttpError(404, 'No existe ese registro.'); }
    const max = 256 * 1024;
    const fh = await fsp.open(file, 'r');
    try {
      const len = Math.min(stat.size, max);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, stat.size - len);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end((stat.size > max ? '[…registro recortado: se muestran los últimos 256 KB]\n' : '') + buf.toString('utf8'));
    } finally { await fh.close(); }
  }

  async function sendDeliverable(res, job) {
    if (!job.deliverable) throw new HttpError(409, 'Todavía no hay entrega: tienen que pasar las dos verificaciones.');
    const file = path.join(manager.dir(job.id), 'out', job.deliverable.file);
    let stat;
    try { stat = await fsp.stat(file); } catch { throw new HttpError(404, 'No se encontró el .zip.'); }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${job.deliverable.file}"`,
    });
    fs.createReadStream(file).pipe(res);
  }

  async function sendChecksum(res, job) {
    if (!job.deliverable?.sha256) throw new HttpError(409, 'Todavía no hay entrega.');
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${job.deliverable.file}.sha256"`,
    });
    res.end(`${job.deliverable.sha256}  ${job.deliverable.file}\n`);
  }

  async function push(res, job, body) {
    if (!job.deliverable || !['review', 'delivered'].includes(job.status)) throw new HttpError(409, 'Solo se sube a GitHub un trabajo con la doble verificación aprobada.');
    const repo = typeof body.repo === 'string' ? body.repo.trim() : '';
    const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : `systech/${slugify(job.name)}-${job.id.slice(0, 6)}`;
    if (!REPO_RE.test(repo)) throw new HttpError(400, 'El repositorio tiene que tener la forma usuario/repositorio.');
    if (!BRANCH_RE.test(branch)) throw new HttpError(400, 'Nombre de rama inválido.');
    try {
      const r = await pushToGitHub({
        zipFile: path.join(manager.dir(job.id), 'out', job.deliverable.file), repo, branch,
        message: `${job.name}\n\nEntregado por SYSTECH Studio con doble verificación aprobada.`,
        limits: config.limits, timeoutMs: config.timeouts.short,
      });
      job.history.push({ at: new Date().toISOString(), kind: 'push', text: `${repo} · ${branch}` });
      await manager.saveNow(job);
      return json(res, 200, { url: r.url, branch });
    } catch (err) {
      throw new HttpError(502, err.message);
    }
  }

  async function environment() {
    if (envCache && Date.now() - envCache.at < 60_000) return envCache.data;
    const probe = async (cmd, args) => {
      const r = await runProcess({ cmd, args, env: childEnv('build'), timeoutMs: 15_000 });
      return r.ok ? r.output.trim().split('\n')[0].slice(0, 120) : null;
    };
    const [claude, dotnet, docker] = await Promise.all([
      probe(config.claudeBin, ['--version']),
      probe('dotnet', ['--list-sdks']).then((s) => s && s.split(' ')[0]),
      probe('docker', ['info', '--format', '{{.ServerVersion}}']),
    ]);
    const home = os.homedir();
    const hasLogin = fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), '.credentials.json'));
    const auth = process.env.ANTHROPIC_API_KEY ? 'api-key' : process.env.CLAUDE_CODE_OAUTH_TOKEN || hasLogin ? 'login' : 'none';
    const data = { claude, dotnet, docker, auth, codespace: process.env.CODESPACE_NAME || null };
    envCache = { at: Date.now(), data };
    return data;
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (res.headersSent) { res.destroy(); return; }
      json(res, status, { error: status === 500 ? 'Error interno. Revisá la terminal del Studio.' : err.message });
    });
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  const ctype = req.headers['content-type'] || '';
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'El cuerpo es demasiado grande.');
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!ctype.startsWith('application/json')) throw new HttpError(415, 'Se esperaba JSON.');
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new HttpError(400, 'JSON inválido.'); }
}

export function sanitizeFileName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC');
  const clean = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return clean || null;
}

function uniqueName(name, used) {
  if (!name) return null;
  let candidate = name;
  const ext = path.extname(name);
  for (let i = 2; used.has(candidate.toLowerCase()); i += 1) candidate = `${path.basename(name, ext)}-${i}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

async function main() {
  const config = loadConfig();
  const manager = new JobManager(config);
  await manager.init();
  const server = createServer(config, manager);
  server.requestTimeout = 0; // las subidas grandes pueden tardar; los límites de tamaño ya protegen
  server.headersTimeout = 30_000;
  // scripts/start.sh ya muestra el encabezado; si se arranca directo con node, lo muestra el servidor.
  if (process.env.STUDIO_BANNER_SHOWN !== '1') console.log(banner());
  server.listen(config.port, config.host, () => {
    console.log(`SYSTECH Studio escuchando en http://${config.host}:${config.port}`);
    console.log(`Trabajos guardados en ${config.dataDir}`);
    if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
      console.warn('ATENCIÓN: el Studio no tiene usuarios ni contraseñas. No lo expongas fuera del Codespace.');
    }
  });
  const shutdown = () => {
    if (manager.current) manager.current.controller.abort();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
