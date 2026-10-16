// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

const STATUS = { ok: 'Aprobado', warn: 'Con avisos', fail: 'Falló', skip: 'Omitido', running: 'En curso' };
const SEVERITY = { critica: 'Crítica', alta: 'Alta', media: 'Media', baja: 'Baja' };
const AREA = { pedido: 'Pedido', casos_borde: 'Casos borde', seguridad: 'Seguridad', calidad: 'Calidad' };

function md(text) {
  return String(text ?? '').replace(/\r/g, '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function renderVerificationReport(job) {
  const lines = [
    `# Verificación — ${job.name}`,
    '',
    `Generado por SYSTECH Studio el ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    `Ciclo ${job.cycle}, intento ${job.attempt}.`,
    '',
    '## Verificación 1 · automática',
    '',
    '| Chequeo | Resultado | Detalle |',
    '|---|---|---|',
    ...job.v1.checks.map((c) => `| ${md(c.label)} | ${STATUS[c.status] || c.status} | ${md(c.summary)} |`),
    '',
  ];
  const warnings = job.v1.checks.filter((c) => c.status === 'warn' && c.details.length);
  if (warnings.length) {
    lines.push('### Avisos', '');
    for (const c of warnings) for (const d of c.details) lines.push(`- **${c.label}:** ${md(d)}`);
    lines.push('');
  }
  lines.push(
    '## Verificación 2 · independiente',
    '',
    `- **Entorno limpio:** ${md(job.v2.clean?.summary || '—')}`,
    `- **Revisión independiente:** ${job.v2.review?.status === 'ok' ? 'Aprobada' : md(job.v2.review?.status || '—')} (ver revision-independiente.md)`,
    '',
  );
  return lines.join('\n');
}

export function renderReviewReport(job) {
  const r = job.v2.review || {};
  const lines = [
    `# Revisión independiente — ${job.name}`,
    '',
    'Realizada por un segundo agente que no participó en la generación del código y que solo tuvo acceso de lectura al contenido de este .zip.',
    '',
    '## Conclusión',
    '',
    r.summary || '—',
    '',
  ];
  if (r.requirements?.total) {
    lines.push(`**Requisitos del pedido cumplidos:** ${r.requirements.met} de ${r.requirements.total}`, '');
  }
  const findings = r.findings || [];
  lines.push('## Hallazgos', '');
  if (!findings.length) {
    lines.push('Sin hallazgos.', '');
  } else {
    lines.push('| Severidad | Área | Hallazgo | Ubicación |', '|---|---|---|---|');
    for (const f of findings) {
      lines.push(`| ${SEVERITY[f.severity] || f.severity} | ${AREA[f.area] || f.area} | ${md(f.title)} | ${md(f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '—')} |`);
    }
    lines.push('', '### Detalle', '');
    findings.forEach((f, i) => lines.push(`${i + 1}. **${md(f.title)}.** ${md(f.detail)}`));
    lines.push('');
  }
  return lines.join('\n');
}
