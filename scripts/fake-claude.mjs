#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones
// Agente SIMULADO para probar el Studio sin API key y sin gastar: imita la salida del CLI de Claude Code.
// Genera un proyecto Node chico con un error a propósito, para mostrar el ciclo completo:
// verificación 1 falla → corrige → verificación 2 encuentra un problema → corrige → aprobado.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.0.0 (agente simulado)'); process.exit(0); }
if (process.env.FAKE_ARGS_LOG) fs.appendFileSync(process.env.FAKE_ARGS_LOG, JSON.stringify(args) + '\n');

const delay = Number(process.env.FAKE_DELAY_MS ?? 250);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prompt = fs.readFileSync(0, 'utf8');
const cwd = process.cwd();
const isReview = args[args.indexOf('--output-format') + 1] === 'json';
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const say = async (text) => { emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } }); await sleep(delay); };
const tool = async (name, input) => { emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }); await sleep(delay); };
const write = async (rel, content) => {
  const abs = path.join(cwd, rel);
  await tool(fs.existsSync(abs) ? 'Edit' : 'Write', { file_path: abs });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

if (process.env.FAKE_FAIL === 'auth') { console.error('Invalid API key · Please run /login'); process.exit(1); }

if (isReview) {
  await sleep(delay * 3);
  const hasValidation = fs.existsSync(path.join(cwd, 'src', 'validacion.js'));
  const review = {
    summary: hasValidation
      ? 'El cálculo es correcto, las entradas se validan y hay pruebas para los caminos principales.'
      : 'El cálculo funciona, pero acepta cualquier entrada sin validar.',
    requirements: { met: hasValidation ? 2 : 1, total: 2, missing: [] },
    findings: hasValidation
      ? [{ severity: 'baja', area: 'calidad', title: 'Agregar comentarios de uso', file: 'src/total.js', line: 1, detail: 'Un ejemplo en el encabezado facilitaría el uso.' }]
      : [{ severity: 'critica', area: 'seguridad', title: 'Las entradas no se validan', file: 'src/total.js', line: 2, detail: 'Si llega un precio negativo o un texto, el total queda mal. Validar cada ítem antes de sumar.' }],
  };
  emit({ type: 'result', subtype: 'success', is_error: false, result: '```json\n' + JSON.stringify(review) + '\n```', total_cost_usd: 0.02, num_turns: 3 });
  process.exit(0);
}

emit({ type: 'system', subtype: 'init', cwd });
const isFix = prompt.includes('La verificación encontró');

if (!isFix) {
  await say('Leo el pedido y armo un módulo que calcula el total de un carrito.');
  await write('package.json', JSON.stringify({ name: 'carrito', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  await write('src/total.js', 'export function total(items) {\n  return items.reduce((acc, i) => acc + i.precio, 0);\n}\n');
  await write('test/total.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/total.js';\n\ntest('suma precio por cantidad', () => {\n  assert.equal(total([{ precio: 10, cantidad: 2 }, { precio: 5, cantidad: 1 }]), 25);\n});\n");
  await write('ENTREGA.md', '# Total del carrito\n\nMódulo que calcula el total de un carrito.\n\n## Cómo probarlo\n\n```\nnpm test\n```\n');
} else if (!prompt.includes('Crítico')) {
  await say('El test muestra que no se multiplica por la cantidad. Lo corrijo.');
  await write('src/total.js', 'export function total(items) {\n  return items.reduce((acc, i) => acc + i.precio * i.cantidad, 0);\n}\n');
} else {
  await say('El revisor marcó que faltan validaciones. Las agrego con sus pruebas.');
  await write('src/validacion.js', "export function validarItem(i) {\n  if (typeof i?.precio !== 'number' || i.precio < 0) throw new Error('Precio inválido');\n  if (!Number.isInteger(i?.cantidad) || i.cantidad < 1) throw new Error('Cantidad inválida');\n}\n");
  await write('src/total.js', "import { validarItem } from './validacion.js';\n\nexport function total(items) {\n  return items.reduce((acc, i) => { validarItem(i); return acc + i.precio * i.cantidad; }, 0);\n}\n");
  await write('test/validacion.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/total.js';\n\ntest('rechaza precios negativos', () => {\n  assert.throws(() => total([{ precio: -1, cantidad: 1 }]), /Precio inválido/);\n});\n");
  await write('ENTREGA.md', '# Total del carrito\n\nMódulo que calcula el total de un carrito y valida cada ítem (precio no negativo, cantidad entera positiva).\n\n## Cómo probarlo\n\n```\nnpm test\n```\n');
}
await tool('Bash', { command: 'npm test' });
emit({ type: 'result', subtype: 'success', is_error: false, result: 'Listo.', total_cost_usd: 0.01, num_turns: 4 });
