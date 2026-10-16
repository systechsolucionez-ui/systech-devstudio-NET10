// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '..');

function int(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max} (valor: ${raw})`);
  }
  return n;
}

function num(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} debe ser un número entre ${min} y ${max} (valor: ${raw})`);
  }
  return n;
}

const MIN = 60_000;

function resolveBin(bin) {
  return bin.includes('/') ? path.resolve(bin) : bin;
}

/** Toda la configuración sale de variables de entorno; nada sensible vive en el código. */
export function loadConfig(overrides = {}) {
  const base = {
    host: process.env.STUDIO_HOST || '127.0.0.1',
    port: int('STUDIO_PORT', 5080, 1, 65535),
    dataDir: path.resolve(process.env.STUDIO_DATA_DIR || path.join(os.homedir(), 'systech-jobs')),
    // Si es una ruta relativa se resuelve ahora: el agente se ejecuta dentro de la carpeta de cada trabajo.
    claudeBin: resolveBin(process.env.STUDIO_CLAUDE_BIN || 'claude'),
    claudeModel: process.env.STUDIO_CLAUDE_MODEL || '',
    // 0 desactiva --restricted (solo si tu versión del CLI no lo reconoce).
    claudeRestricted: process.env.STUDIO_CLAUDE_RESTRICTED !== '0',
    // Tope de gasto por cada ejecución del agente (generar, corregir o revisar). 0 = sin tope.
    maxBudgetUsd: num('STUDIO_MAX_BUDGET_USD', 5, 0, 1000),
    maxAttemptsDefault: int('STUDIO_MAX_ATTEMPTS', 3, 1, 5),
    limits: {
      maxUploadBytes: int('STUDIO_MAX_UPLOAD_MB', 300, 1, 2048) * 1024 * 1024,
      maxFiles: 20,
      maxRequestChars: 20_000,
      maxNameChars: 120,
      maxZipEntries: 10_000,
      maxUnzippedBytes: int('STUDIO_MAX_UNZIPPED_MB', 600, 1, 8192) * 1024 * 1024,
      maxViewBytes: 512 * 1024,
    },
    timeouts: {
      agent: int('STUDIO_AGENT_TIMEOUT_MIN', 40, 1, 240) * MIN,
      reviewer: int('STUDIO_REVIEW_TIMEOUT_MIN', 20, 1, 240) * MIN,
      build: int('STUDIO_BUILD_TIMEOUT_MIN', 15, 1, 240) * MIN,
      test: int('STUDIO_TEST_TIMEOUT_MIN', 20, 1, 240) * MIN,
      smoke: int('STUDIO_SMOKE_TIMEOUT_MIN', 15, 1, 240) * MIN,
      short: 2 * MIN,
    },
  };
  return { ...base, ...overrides, limits: { ...base.limits, ...overrides.limits }, timeouts: { ...base.timeouts, ...overrides.timeouts } };
}
