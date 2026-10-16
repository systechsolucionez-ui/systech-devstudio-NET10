// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess, childEnv } from './proc.js';
import { scanSecrets } from './secrets.js';

/** Encuentra qué tipo de proyecto es y cuál es el punto de entrada para compilarlo. */
export async function detectProject(dir) {
  const found = { sln: [], csproj: [] };
  async function walk(rel, depth) {
    if (depth > 3) return;
    let items;
    try { items = await fsp.readdir(path.join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.isDirectory()) {
        if (!['.git', 'bin', 'obj', 'node_modules', '.systech'].includes(it.name)) await walk(rel ? `${rel}/${it.name}` : it.name, depth + 1);
      } else if (it.name.endsWith('.sln') || it.name.endsWith('.slnx')) found.sln.push(rel ? `${rel}/${it.name}` : it.name);
      else if (it.name.endsWith('.csproj')) found.csproj.push(rel ? `${rel}/${it.name}` : it.name);
    }
  }
  await walk('', 0);
  const byDepth = (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b);
  if (found.sln.length) return { kind: 'dotnet', target: found.sln.sort(byDepth)[0] };
  if (found.csproj.length) {
    // Sin .sln: dotnet build/test sobre la carpeta raíz no sirve con varios proyectos; se usa el primero.
    return { kind: 'dotnet', target: found.csproj.sort(byDepth)[0], multipleProjectsWithoutSln: found.csproj.length > 1 };
  }
  try {
    await fsp.access(path.join(dir, 'package.json'));
    return { kind: 'node', target: 'package.json' };
  } catch { /* no es node */ }
  return { kind: 'unknown' };
}

export function parseBuildOutput(out) {
  const errors = [...new Set(out.split('\n').filter((l) => /:\s*error\s+[A-Z]+\d+\s*:/.test(l)).map(cleanMsBuildLine))];
  const warnings = [...new Set(out.split('\n').filter((l) => /:\s*warning\s+[A-Z]+\d+\s*:/.test(l)).map(cleanMsBuildLine))];
  return { errors, warnings };
}

function cleanMsBuildLine(l) {
  return l.trim().replace(/\s*\[[^\]]+\.(?:cs|fs|vb)proj\]\s*$/, '');
}

/** Interpreta el resumen de "dotnet test" (formato de VSTest). */
export function parseTestOutput(out) {
  const re = /(Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)(?:,\s*Duration:[^-\n]*)?(?:\s*-\s*(\S+))?/g;
  const assemblies = [];
  let m;
  while ((m = re.exec(out)) !== null) {
    assemblies.push({ failed: +m[2], passed: +m[3], skipped: +m[4], total: +m[5], name: m[6] || '' });
  }
  const failedTests = [...new Set([...out.matchAll(/^\s*Failed\s+([\w.`<>,+\s()-]+?)\s+\[[^\]]*\]\s*$/gm)].map((x) => x[1].trim()))];
  const sum = (k) => assemblies.reduce((a, x) => a + x[k], 0);
  return { assemblies, failed: sum('failed'), passed: sum('passed'), skipped: sum('skipped'), total: sum('total'), failedTests };
}

export function parseVulnerableOutput(out) {
  const blocking = [];
  const minor = [];
  for (const line of out.split('\n')) {
    const m = /^\s*>\s*(\S+)\s+(\S+)\s+(\S+)\s+(Critical|High|Moderate|Low)\b/.exec(line);
    if (!m) continue;
    const item = `${m[1]} ${m[3]} (${m[4]})`;
    if (m[4] === 'Critical' || m[4] === 'High') blocking.push(item); else minor.push(item);
  }
  return { blocking: [...new Set(blocking)], minor: [...new Set(minor)] };
}

function check(key, label) {
  return { key, label, status: 'running', summary: '', details: [] };
}

/**
 * Verificación 1 (automática). onUpdate se llama cada vez que cambia un paso, para que la
 * interfaz lo muestre en vivo. Devuelve la lista de chequeos con su estado final.
 */
export async function runAutomaticChecks({ dir, logDir, logPrefix, timeouts, signal, smoke, jobId, onUpdate = () => {}, onLine }) {
  const project = await detectProject(dir);
  const results = [];
  const push = (c) => { results.push(c); onUpdate(results); return c; };
  const done = (c, status, summary, details = []) => { Object.assign(c, { status, summary, details }); onUpdate(results); };
  const log = (name) => path.join(logDir, `${logPrefix}-${name}.log`);
  const env = childEnv('build', { DOTNET_CLI_UI_LANGUAGE: 'en' });
  const run = (name, cmd, args, timeoutMs) => runProcess({ cmd, args, cwd: dir, env, timeoutMs, signal, logFile: log(name), onLine });

  if (project.kind === 'dotnet') {
    const build = push(check('build', 'Compilación'));
    build.log = path.basename(log('build'));
    const b = await run('build', 'dotnet', ['build', project.target, '-c', 'Release', '-nologo', '-v', 'minimal'], timeouts.build);
    const pb = parseBuildOutput(b.output);
    if (b.ok) {
      done(build, 'ok', `0 errores · ${pb.warnings.length} advertencias`, pb.warnings.slice(0, 10));
    } else {
      done(build, 'fail', describeFailure(b, `${pb.errors.length || 'Hay'} errores de compilación`), pb.errors.slice(0, 15).length ? pb.errors.slice(0, 15) : [lastLines(b.output, 25)]);
      return { project, checks: results, skipped: 'build' };
    }

    const test = push(check('test', 'Tests'));
    test.log = path.basename(log('test'));
    const t = await run('test', 'dotnet', ['test', project.target, '-c', 'Release', '--no-build', '-nologo'], timeouts.test);
    const pt = parseTestOutput(t.output);
    if (pt.total === 0 && t.code === 0) done(test, 'warn', 'No se encontraron tests', ['El proyecto no tiene pruebas automatizadas.']);
    else if (t.ok && pt.failed === 0) done(test, 'ok', `${pt.passed} / ${pt.total}`);
    else done(test, 'fail', pt.total ? `${pt.passed} / ${pt.total}` : describeFailure(t, 'Los tests no se pudieron ejecutar'), pt.failedTests.length ? pt.failedTests.slice(0, 20) : [lastLines(t.output, 30)]);

    const vuln = push(check('vuln', 'Paquetes vulnerables'));
    vuln.log = path.basename(log('vuln'));
    const v = await run('vuln', 'dotnet', ['list', project.target, 'package', '--vulnerable', '--include-transitive'], timeouts.short);
    const pv = parseVulnerableOutput(v.output);
    if (!v.ok) done(vuln, 'warn', 'No se pudo consultar la base de vulnerabilidades', [lastLines(v.output, 10)]);
    else if (pv.blocking.length) done(vuln, 'fail', `${pv.blocking.length} graves`, pv.blocking);
    else if (pv.minor.length) done(vuln, 'warn', `${pv.minor.length} de severidad media o baja`, pv.minor);
    else done(vuln, 'ok', 'Sin vulnerabilidades conocidas');
  } else if (project.kind === 'node') {
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
    const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
    if (hasDeps) {
      const inst = push(check('install', 'Dependencias'));
      const lock = await exists(path.join(dir, 'package-lock.json'));
      const r = await run('install', 'npm', [lock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'], timeouts.build);
      if (!r.ok) { done(inst, 'fail', describeFailure(r, 'No se pudieron instalar'), [lastLines(r.output, 20)]); return { project, checks: results, skipped: 'install' }; }
      done(inst, 'ok', 'Instaladas');
    }
    if (pkg.scripts?.build) {
      const build = push(check('build', 'Compilación'));
      const r = await run('build', 'npm', ['run', 'build'], timeouts.build);
      if (!r.ok) { done(build, 'fail', describeFailure(r, 'Falló la compilación'), [lastLines(r.output, 25)]); return { project, checks: results, skipped: 'build' }; }
      done(build, 'ok', 'Sin errores');
    }
    const test = push(check('test', 'Tests'));
    if (!pkg.scripts?.test || /no test specified/.test(pkg.scripts.test)) {
      done(test, 'warn', 'No se encontraron tests', ['El proyecto no tiene pruebas automatizadas.']);
    } else {
      const r = await run('test', 'npm', ['test'], timeouts.test);
      const counts = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(r.output);
      const summary = counts ? `${counts[1]} / ${+counts[1] + +counts[2]}` : (r.ok ? 'Pasaron' : 'Fallaron');
      done(test, r.ok ? 'ok' : 'fail', summary, r.ok ? [] : [lastLines(r.output, 30)]);
    }
  } else {
    const c = push(check('build', 'Compilación'));
    done(c, 'warn', 'No se detectó un proyecto .NET ni Node', ['No hay .sln, .csproj ni package.json: no hay nada que compilar.']);
  }

  const sec = push(check('secrets', 'Secretos'));
  const s = await scanSecrets(dir);
  if (s.blocking.length) done(sec, 'fail', `${s.blocking.length} secretos expuestos`, s.blocking.map((x) => `${x.kind} en ${x.file}:${x.line}`));
  else if (s.warnings.length) done(sec, 'warn', `${s.warnings.length} avisos`, s.warnings.map((x) => `${x.kind} en ${x.file}:${x.line}`));
  else done(sec, 'ok', `${s.scanned} archivos revisados`);

  if (smoke) {
    const sm = push(check('smoke', 'Prueba de humo (Docker)'));
    const hasCompose = await exists(path.join(dir, 'docker-compose.yml'));
    const hasScript = await exists(path.join(dir, 'scripts', 'smoke-test.sh'));
    if (!hasCompose || !hasScript) {
      done(sm, 'warn', 'No disponible', ['Hace falta docker-compose.yml y scripts/smoke-test.sh en el proyecto.']);
    } else {
      const projectName = `studio-${jobId}`.toLowerCase();
      try {
        const up = await run('smoke-up', 'docker', ['compose', '-p', projectName, 'up', '-d', '--build', '--wait', '--wait-timeout', '300'], timeouts.smoke);
        if (!up.ok) {
          done(sm, 'fail', describeFailure(up, 'Los contenedores no levantaron'), [lastLines(up.output, 25)]);
        } else {
          const r = await run('smoke', 'bash', ['scripts/smoke-test.sh'], timeouts.smoke);
          const passed = (r.output.match(/\bOK\b|✔|PASS/g) || []).length;
          done(sm, r.ok ? 'ok' : 'fail', r.ok ? 'Pasó' : describeFailure(r, 'Falló'), r.ok ? [] : [lastLines(r.output, 30)]);
          if (passed && r.ok) sm.summary = `Pasó (${passed} comprobaciones)`;
        }
      } finally {
        await runProcess({ cmd: 'docker', args: ['compose', '-p', projectName, 'down', '-v', '--remove-orphans'], cwd: dir, env, timeoutMs: timeouts.short, logFile: log('smoke-down') });
      }
    }
  }

  return { project, checks: results };
}

/** Entorno limpio: compila y testea el contenido exacto del .zip, en una carpeta nueva. */
export async function runCleanBuild({ dir, logDir, logPrefix, timeouts, signal, onLine }) {
  const project = await detectProject(dir);
  const env = childEnv('build', { DOTNET_CLI_UI_LANGUAGE: 'en' });
  const run = (name, cmd, args, t) => runProcess({ cmd, args, cwd: dir, env, timeoutMs: t, signal, logFile: path.join(logDir, `${logPrefix}-${name}.log`), onLine });
  if (project.kind === 'dotnet') {
    const b = await run('build', 'dotnet', ['build', project.target, '-c', 'Release', '-nologo', '-v', 'minimal'], timeouts.build);
    if (!b.ok) return { ok: false, summary: 'El .zip no compila desde cero', details: parseBuildOutput(b.output).errors.slice(0, 15) };
    const t = await run('test', 'dotnet', ['test', project.target, '-c', 'Release', '--no-build', '-nologo'], timeouts.test);
    const pt = parseTestOutput(t.output);
    if (!t.ok || pt.failed > 0) return { ok: false, summary: `Tests desde cero: ${pt.passed} / ${pt.total}`, details: pt.failedTests.length ? pt.failedTests : [lastLines(t.output, 25)] };
    return { ok: true, summary: pt.total ? `Compila y pasa ${pt.passed}/${pt.total} desde cero` : 'Compila desde cero (sin tests)' };
  }
  if (project.kind === 'node') {
    const pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8'));
    if (Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) {
      const lock = await exists(path.join(dir, 'package-lock.json'));
      const i = await run('install', 'npm', [lock ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund'], timeouts.build);
      if (!i.ok) return { ok: false, summary: 'Las dependencias no se instalan desde cero', details: [lastLines(i.output, 20)] };
    }
    if (pkg.scripts?.build) {
      const b = await run('build', 'npm', ['run', 'build'], timeouts.build);
      if (!b.ok) return { ok: false, summary: 'El .zip no compila desde cero', details: [lastLines(b.output, 20)] };
    }
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) {
      const t = await run('test', 'npm', ['test'], timeouts.test);
      if (!t.ok) return { ok: false, summary: 'Los tests fallan desde cero', details: [lastLines(t.output, 25)] };
    }
    return { ok: true, summary: 'Instala, compila y pasa los tests desde cero' };
  }
  return { ok: true, summary: 'Sin proyecto compilable; se verificó que el .zip se abre completo' };
}

function describeFailure(r, fallback) {
  if (r.timedOut) return 'Superó el tiempo máximo';
  if (r.cancelled) return 'Cancelado';
  if (r.error) return r.error;
  return fallback;
}

export function lastLines(text, n) {
  return text.trimEnd().split('\n').slice(-n).join('\n');
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}
