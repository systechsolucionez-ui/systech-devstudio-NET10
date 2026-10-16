// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT } from './config.js';

const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));

/** Datos de la aplicación: un solo origen (package.json) para la interfaz, la terminal y los informes. */
export const ABOUT = Object.freeze({
  name: 'SYSTECH Studio',
  version: pkg.version,
  author: 'José Antonio Vivas',
  company: 'Systech Soluciones',
  license: pkg.license,
  repository: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, ''),
  authorUrl: pkg.config.authorUrl,
});

/** Firma que va al final de los informes del .zip. */
export function signatureLine({ date, contentHash }) {
  return `Verificado con ${ABOUT.name} v${ABOUT.version} — ${ABOUT.company} · ${date} · `
    + `Huella SHA-256 del contenido: ${contentHash} (detalle por archivo en SHA256SUMS.txt)`;
}

/** Encabezado para la terminal. */
export function banner() {
  const gold = (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s);
  return [
    '',
    gold('  ███████╗██╗   ██╗███████╗████████╗███████╗ ██████╗██╗  ██╗'),
    gold('  ██╔════╝╚██╗ ██╔╝██╔════╝╚══██╔══╝██╔════╝██╔════╝██║  ██║'),
    gold('  ███████╗ ╚████╔╝ ███████╗   ██║   █████╗  ██║     ███████║'),
    gold('  ╚════██║  ╚██╔╝  ╚════██║   ██║   ██╔══╝  ██║     ██╔══██║'),
    gold('  ███████║   ██║   ███████║   ██║   ███████╗╚██████╗██║  ██║'),
    gold('  ╚══════╝   ╚═╝   ╚══════╝   ╚═╝   ╚══════╝ ╚═════╝╚═╝  ╚═╝'),
    `  ${ABOUT.name} v${ABOUT.version} · ${ABOUT.company}`,
    `  Creado por ${ABOUT.author} · Licencia ${ABOUT.license}`,
    '',
  ].join('\n');
}
