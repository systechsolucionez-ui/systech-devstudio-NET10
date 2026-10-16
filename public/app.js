// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 José Antonio Vivas — Systech Soluciones

// SYSTECH Studio — interfaz. Todo el contenido dinámico se inserta con textContent: nunca HTML del servidor.

const RUNNING = new Set(['queued', 'generating', 'verifying1', 'fixing', 'verifying2', 'packaging']);
const STATUS_LABEL = {
  queued: 'En cola', generating: 'Generando', fixing: 'Corrigiendo', verifying1: 'Verificación 1', verifying2: 'Verificación 2',
  packaging: 'Armando la entrega', review: 'Listo para tu revisión', needs_attention: 'Necesita tu atención',
  delivered: 'Entregado', failed: 'Falló', cancelled: 'Cancelado', interrupted: 'Interrumpido',
};
const ICONS = {
  upload: '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#D4A64A" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
  zip: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D4A64A" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M10 7h1M10 10h1M10 13h1"/></svg>',
  file: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#A3AECA" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
  x: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  download: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5l12 7-12 7z"/></svg>',
};

// ------------------------------------------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') el.style.cssText = v; // vía CSSOM: compatible con la CSP sin 'unsafe-inline'
    else if (k === 'icon') el.insertAdjacentHTML('afterbegin', ICONS[v]); // íconos constantes, nunca datos
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (method !== 'GET') opts.headers['X-Studio'] = '1';
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); } catch { throw new Error('No hay conexión con el Studio. ¿Sigue corriendo en la terminal?'); }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`);
  return data;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'hace instantes';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  return new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
}

function statusPill(status, extra = '') {
  const cls = RUNNING.has(status) ? 'run' : ['review', 'delivered'].includes(status) ? 'ok' : ['needs_attention', 'failed'].includes(status) ? 'err' : '';
  return h('span', { class: `pill ${cls}`, text: (STATUS_LABEL[status] || status) + extra });
}

function toast(message) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status', text: message });
  document.body.append(t);
  setTimeout(() => t.remove(), 4000);
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* sin almacenamiento */ } },
};

// ------------------------------------------------------------------------------------------------
// Entorno (barra lateral)
// ------------------------------------------------------------------------------------------------

async function loadEnv() {
  const box = document.getElementById('env');
  try {
    const env = await api('/api/env');
    const row = (state, text) => h('div', { class: 'env-row' }, h('span', { class: `dot ${state}` }), text);
    box.replaceChildren(
      row(env.claude ? 'ok' : 'err', env.claude ? `Agente ${env.claude.replace(/\s*\(.*\)/, '')}` : 'Agente no instalado'),
      row(env.auth === 'none' ? 'err' : 'ok', env.auth === 'api-key' ? 'API key configurada' : env.auth === 'login' ? 'Sesión de Claude iniciada' : 'Falta API key o sesión'),
      row(env.dotnet ? 'ok' : 'warn', env.dotnet ? `.NET ${env.dotnet} SDK` : '.NET SDK no encontrado'),
      row(env.docker ? 'ok' : 'warn', env.docker ? 'Docker activo' : 'Docker no disponible'),
      row(env.codespace ? 'ok' : '', env.codespace ? 'Codespace conectado' : 'Fuera de un Codespace'),
    );
  } catch {
    box.replaceChildren(h('div', { class: 'env-row' }, h('span', { class: 'dot err' }), 'Sin conexión'));
  }
}

// ------------------------------------------------------------------------------------------------
// Router
// ------------------------------------------------------------------------------------------------

const view = document.getElementById('view');
let cleanup = () => {};

async function route() {
  cleanup();
  cleanup = () => {};
  const [, section = 'nuevo', id] = (location.hash || '#/nuevo').split('/');
  const navKey = { trabajo: 'taller', entrega: 'entregas' }[section] || section;
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === navKey) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  try {
    if (section === 'nuevo') await renderNew();
    else if (section === 'trabajo' && id) await renderWorkshop(id);
    else if (section === 'taller') await renderLatest('trabajo');
    else if (section === 'entrega' && id) await renderDelivery(id);
    else if (section === 'entregas') await renderList('entregas');
    else if (section === 'historial') await renderList('historial');
    else location.hash = '#/nuevo';
  } catch (err) {
    view.replaceChildren(h('div', { class: 'alert err', role: 'alert', text: err.message }));
  }
  view.focus({ preventScroll: true });
}

// ------------------------------------------------------------------------------------------------
// Firma y "Acerca de" (datos de package.json, servidos por el propio Studio)
// ------------------------------------------------------------------------------------------------

async function loadAbout() {
  try {
    const about = await api('/api/about');
    document.querySelectorAll('[data-version]').forEach((el) => { el.textContent = `v${about.version}`; });
    document.querySelectorAll('[data-author-link]').forEach((a) => { a.href = about.authorUrl; });
    document.querySelectorAll('[data-repo-link]').forEach((a) => {
      a.href = about.repository + a.dataset.repoLink;
      if (!a.dataset.repoLink) a.textContent = about.repository.replace(/^https:\/\//, '');
    });
  } catch { /* si falla, queda el texto fijo del HTML */ }
}

function setupAbout() {
  const dialog = document.getElementById('about');
  const opener = document.getElementById('about-open');
  opener.addEventListener('click', () => dialog.showModal());
  document.getElementById('about-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // clic afuera cierra
  dialog.addEventListener('close', () => opener.focus());
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => { setupAbout(); loadAbout(); loadEnv(); route(); setInterval(loadEnv, 60_000); });

// ------------------------------------------------------------------------------------------------
// 1 · Nuevo trabajo
// ------------------------------------------------------------------------------------------------

async function renderNew() {
  const selected = [];
  const fileList = h('ul', { class: 'files', 'aria-label': 'Archivos adjuntos' });
  const input = h('input', { type: 'file', multiple: true, class: 'sr-only', id: 'files', tabindex: '-1' });
  const errorBox = h('div', { role: 'alert' });

  const name = h('input', { class: 'input', id: 'job-name', maxlength: '120', placeholder: 'Ej.: Saga de pagos para la API de pedidos', value: store.get('draft.name') || '' });
  const request = h('textarea', { class: 'textarea', id: 'job-request', maxlength: '20000', rows: '8', placeholder: 'Contale al agente qué tiene que construir o cambiar, con el mayor detalle posible: reglas de negocio, integraciones, restricciones de seguridad…' });
  request.value = store.get('draft.request') || '';
  name.addEventListener('input', () => store.set('draft.name', name.value));
  request.addEventListener('input', () => store.set('draft.request', request.value));

  const attempts = h('select', { class: 'input', id: 'attempts' }, [1, 2, 3, 4, 5].map((n) => h('option', { value: n, selected: n === 3, text: String(n) })));
  const smoke = h('input', { type: 'checkbox', id: 'smoke' });

  const renderFiles = () => {
    fileList.replaceChildren(...selected.map((f, i) => h('li', { class: 'file-item' },
      h('span', { icon: f.name.toLowerCase().endsWith('.zip') ? 'zip' : 'file' }),
      h('span', { class: 'name', text: f.name }),
      h('span', { class: 'size', text: fmtBytes(f.size) }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Quitar ${f.name}`, icon: 'x', onclick: () => { selected.splice(i, 1); renderFiles(); } }),
    )));
  };
  const addFiles = (files) => {
    for (const f of files) {
      if (selected.length >= 20) { toast('Máximo 20 archivos por trabajo.'); break; }
      if (!selected.some((s) => s.name === f.name && s.size === f.size)) selected.push(f);
    }
    renderFiles();
  };
  input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });

  const drop = h('label', { class: 'dropzone', for: 'files' },
    h('span', { icon: 'upload' }),
    h('strong', { text: 'Arrastrá un .zip o archivos acá' }),
    h('span', { class: 'hint', text: 'o hacé clic para elegirlos. El .zip es el proyecto; PDF y documentos se usan como referencia.' }),
  );
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });

  const submit = h('button', { type: 'submit', class: 'btn primary', icon: 'play' }, 'Generar y verificar');
  const form = h('form', { class: 'card', novalidate: true },
    h('h2', { text: 'Pedido' }),
    h('div', { class: 'field' }, h('label', { for: 'job-name', text: 'Nombre del trabajo' }), name),
    h('div', { class: 'field' }, h('label', { for: 'job-request', text: 'Qué tiene que hacer el agente' }), request),
    h('div', { class: 'field' }, h('span', { class: 'label', text: 'Archivos (opcional)' }), drop, input, fileList),
    h('div', { class: 'options' },
      h('label', { class: 'inline-field', for: 'attempts' }, 'Intentos de corrección automática', attempts),
      h('label', { class: 'check', for: 'smoke' }, smoke, 'Incluir prueba de humo con Docker'),
    ),
    errorBox,
    h('div', { class: 'btns' }, submit),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.replaceChildren();
    if (!request.value.trim()) {
      errorBox.replaceChildren(h('div', { class: 'alert err', text: 'Describí el pedido antes de continuar.' }));
      request.focus();
      return;
    }
    const fd = new FormData();
    fd.append('name', name.value.trim());
    fd.append('request', request.value.trim());
    fd.append('maxAttempts', attempts.value);
    fd.append('smoke', String(smoke.checked));
    for (const f of selected) fd.append('files', f, f.name);
    submit.disabled = true;
    submit.lastChild.textContent = 'Subiendo…';
    try {
      const { id } = await api('/api/jobs', { method: 'POST', form: fd });
      store.del('draft.name');
      store.del('draft.request');
      location.hash = `#/trabajo/${id}`;
    } catch (err) {
      errorBox.replaceChildren(h('div', { class: 'alert err', text: err.message }));
      submit.disabled = false;
      submit.lastChild.textContent = 'Generar y verificar';
    }
  });

  const jobs = await api('/api/jobs').catch(() => []);
  const recent = jobs.slice(0, 5);

  view.replaceChildren(
    h('header', { class: 'page-head' }, h('div', {},
      h('span', { class: 'eyebrow', text: 'Paso 1 de 3' }),
      h('h1', { text: 'Nuevo trabajo' }),
      h('p', { class: 'muted', style: 'margin:0', text: 'Cargá el pedido y los archivos. El agente genera el código y lo verifica dos veces antes de mostrártelo.' }),
    )),
    h('div', { class: 'row' },
      h('div', { class: 'col-main' }, form),
      h('aside', { class: 'col-side' },
        h('section', { class: 'card' }, h('h2', { text: 'Trabajos recientes' }),
          recent.length
            ? h('ul', { class: 'recent' }, recent.map((j) => h('li', {}, h('a', { href: j.status === 'delivered' || j.status === 'review' ? `#/entrega/${j.id}` : `#/trabajo/${j.id}` },
              h('span', { class: 't', text: j.name }),
              h('span', { class: 'meta' }, statusPill(j.status), h('span', { class: 'small', text: fmtAgo(j.createdAt) })),
            ))))
            : h('p', { class: 'empty', text: 'Todavía no hay trabajos.' })),
        h('section', { class: 'card' }, h('h2', { text: 'Cómo trabaja el agente' }),
          h('ol', { class: 'howto' },
            h('li', { text: 'Lee tu pedido y los archivos, y genera o modifica el código.' }),
            h('li', { text: 'Verificación 1: compila, corre los tests, busca paquetes vulnerables y secretos.' }),
            h('li', { text: 'Verificación 2: un revisor independiente audita el resultado y el .zip se prueba en un entorno limpio.' }),
            h('li', { text: 'Si algo falla, corrige solo y vuelve a verificar. Después lo revisás vos y lo entregás.' }),
          )),
      ),
    ),
  );
}

// ------------------------------------------------------------------------------------------------
// 2 · Taller
// ------------------------------------------------------------------------------------------------

async function renderLatest() {
  const jobs = await api('/api/jobs');
  if (!jobs.length) {
    view.replaceChildren(h('div', { class: 'card' }, h('h2', { text: 'Todavía no hay trabajos en el taller' }), h('a', { class: 'btn primary', href: '#/nuevo', text: 'Crear el primero' })));
    return;
  }
  const active = jobs.find((j) => RUNNING.has(j.status)) || jobs[0];
  location.replace(`#/trabajo/${active.id}`);
}

const STEPS = [
  ['received', 'Pedido recibido'], ['generate', 'Código generado'], ['v1', 'Verificación 1 · automática'],
  ['v2', 'Verificación 2 · independiente'], ['review', 'Tu revisión'],
];

function stepState(job, i) {
  const idx = STEPS.findIndex(([k]) => k === job.stage);
  if (job.status === 'delivered') return 'done';
  if (i < idx) return 'done';
  if (i > idx) return '';
  if (job.status === 'review') return 'current';
  if (['needs_attention', 'failed', 'interrupted', 'cancelled'].includes(job.status)) return 'error';
  return 'current';
}

async function renderWorkshop(id) {
  let job = await api(`/api/jobs/${id}`);
  let selectedFile = null;
  let highlightLine = null;
  let lastFilesKey = '';
  const openDetails = new Set();

  const head = h('header', { class: 'page-head' });
  const stepper = h('ol', { class: 'stepper', 'aria-label': 'Progreso del trabajo' });
  const notice = h('div', { 'aria-live': 'polite' });
  const tree = h('ul', { class: 'tree', 'aria-label': 'Archivos modificados' });
  const viewerHead = h('div', { class: 'viewer-head', text: 'Elegí un archivo para verlo' });
  const code = h('pre', { class: 'code', tabindex: '0', 'aria-label': 'Código' });
  const verif = h('section', { class: 'card', 'aria-labelledby': 'verif-t' });
  const consoleBody = h('pre', { class: 'console-body', 'aria-live': 'off' });
  const logs = h('div', { class: 'logs' });
  const changeText = h('textarea', { class: 'textarea', id: 'change', rows: '2', style: 'min-height:72px', maxlength: '20000', placeholder: 'Ej.: que el plazo para pagar sea configurable desde appsettings.' });
  const sendChange = h('button', { type: 'button', class: 'btn outline-gold', text: 'Enviar al agente' });
  const approve = h('button', { type: 'button', class: 'btn primary', text: 'Aprobar y preparar entrega' });

  const act = async (path, body, okMsg) => {
    try {
      await api(`/api/jobs/${id}/${path}`, { method: 'POST', body });
      if (okMsg) toast(okMsg);
      await refresh();
    } catch (err) { toast(err.message); }
  };

  sendChange.addEventListener('click', async () => {
    if (!changeText.value.trim()) { changeText.focus(); return; }
    await act('change', { text: changeText.value.trim() }, 'Cambio enviado al agente.');
    changeText.value = '';
  });
  approve.addEventListener('click', async () => {
    try { await api(`/api/jobs/${id}/approve`, { method: 'POST' }); location.hash = `#/entrega/${id}`; } catch (err) { toast(err.message); }
  });

  async function openFile(path, line = null) {
    selectedFile = path;
    highlightLine = line;
    viewerHead.replaceChildren(h('span', { text: path }));
    code.replaceChildren(h('span', { class: 'ln', text: 'Cargando…' }));
    tree.querySelectorAll('button[data-path]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.path === path)));
    try {
      const f = await api(`/api/jobs/${id}/file?path=${encodeURIComponent(path)}`);
      if (f.binary || f.tooLarge) {
        code.replaceChildren(h('span', { class: 'ln', text: f.binary ? 'Archivo binario: no se puede mostrar.' : `Archivo demasiado grande para verlo acá (${fmtBytes(f.size)}).` }));
        return;
      }
      const lines = f.content.split('\n');
      viewerHead.replaceChildren(h('span', { text: path }), h('span', { class: 'muted', style: 'font-family:var(--font)', text: `${lines.length} líneas` }));
      code.replaceChildren(...lines.map((l, i) => h('span', { class: `ln${highlightLine === i + 1 ? ' hl' : ''}`, 'data-n': i + 1, text: l || ' ' })));
      const target = code.querySelector('.hl');
      if (target) target.scrollIntoView({ block: 'center' });
    } catch (err) {
      code.replaceChildren(h('span', { class: 'ln', text: err.message }));
    }
  }

  async function refreshFiles() {
    const key = `${job.cycle}-${job.attempt}-${job.status}`;
    if (key === lastFilesKey) return;
    lastFilesKey = key;
    const { changed } = await api(`/api/jobs/${id}/files`).catch(() => ({ changed: [] }));
    const label = { A: 'Nuevo', M: 'Modificado', D: 'Borrado' };
    tree.replaceChildren(
      h('li', { class: 'head', text: `Cambios (${changed.length})` }),
      ...(changed.length ? changed.map((c) => h('li', {}, h('button', {
        type: 'button', 'data-path': c.path, 'aria-pressed': String(c.path === selectedFile), disabled: c.status === 'D',
        title: label[c.status] || c.status, onclick: () => openFile(c.path),
      }, h('span', { class: `tag-${c.status}`, text: c.status }), c.path.split('/').pop()))) : [h('li', { class: 'empty', style: 'padding:6px 10px', text: 'Sin cambios todavía.' })]),
    );
    if (!selectedFile && changed.length) {
      const first = changed.find((c) => c.status !== 'D');
      if (first) openFile(first.path);
    }
  }

  function renderHead() {
    const running = RUNNING.has(job.status);
    const attempt = job.status === 'fixing' || job.status.startsWith('verifying') ? ` · intento ${job.attempt} de ${job.options.maxAttempts}` : '';
    head.replaceChildren(
      h('div', {},
        h('span', { class: 'eyebrow', text: 'Paso 2 de 3 · Taller' }),
        h('h1', { text: job.name }),
        h('div', { class: 'meta' }, statusPill(job.status, attempt), h('span', { text: `Iniciado ${fmtAgo(job.createdAt)}` }),
          job.costUsd ? h('span', { text: `Costo del agente: US$ ${job.costUsd.toFixed(2)}` }) : null),
      ),
      h('div', { class: 'btns' },
        running ? h('button', { type: 'button', class: 'btn small', text: 'Cancelar', onclick: () => act('cancel', undefined, 'Cancelando…') }) : null,
        ['interrupted', 'failed', 'cancelled', 'needs_attention'].includes(job.status)
          ? h('button', { type: 'button', class: 'btn small', text: 'Reintentar verificación', onclick: () => act('retry', undefined, 'Reintentando.') }) : null,
        job.deliverable ? h('a', { class: 'btn small', href: `#/entrega/${id}`, text: 'Ver entrega' }) : null,
      ),
    );
    stepper.replaceChildren(...STEPS.map(([, label], i) => {
      const st = stepState(job, i);
      return h('li', { class: st, 'aria-current': st === 'current' ? 'step' : null }, h('span', { class: 'n', 'aria-hidden': 'true', text: st === 'done' ? '✓' : st === 'error' ? '!' : String(i + 1) }), label);
    }));
    notice.replaceChildren(job.lastError ? h('div', { class: `alert ${job.status === 'needs_attention' ? 'warn' : 'err'}`, text: job.lastError }) : '');
    approve.disabled = !['review', 'delivered'].includes(job.status);
    approve.title = approve.disabled ? 'Se habilita cuando pasan las dos verificaciones' : '';
    sendChange.disabled = running;
  }

  function renderVerification() {
    const v1 = job.v1 || { status: 'pending', checks: [] };
    const v2 = job.v2 || { status: 'pending' };
    const pill = (st, okText) => {
      if (st === 'ok') return h('span', { class: 'pill sm ok', text: okText });
      if (st === 'fail') return h('span', { class: 'pill sm err', text: 'Con errores' });
      if (st === 'running') return h('span', { class: 'pill sm run', text: 'En curso' });
      return h('span', { class: 'pill sm', text: st === 'pending' && v1.status !== 'ok' ? 'En espera de la 1' : 'Pendiente' });
    };

    const checks = v1.checks.length
      ? h('div', { class: 'metric-grid' }, v1.checks.map((c) => h('div', { class: 'metric' },
        h('span', { class: 'k', text: c.label }),
        h('span', { class: `v ${c.status}`, text: c.status === 'running' ? 'En curso…' : c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'Aviso' : 'Falló' }),
        c.summary ? h('span', { class: 's', text: c.summary }) : null)))
      : h('p', { class: 'empty', text: 'Se ejecuta cuando el agente termina de generar.' });

    const review = v2.review || {};
    const mark = (st) => h('span', { class: `mark ${st === 'ok' ? 'ok' : st === 'fail' || st === 'error' ? 'fail' : 'wait'}`, 'aria-hidden': 'true', text: st === 'ok' ? '✓' : st === 'fail' || st === 'error' ? '✕' : '○' });
    const reviewSummary = review.status === 'ok' || review.status === 'fail'
      ? `${review.requirements?.total ? `${review.requirements.met}/${review.requirements.total} requisitos · ` : ''}${review.blocking?.length || 0} graves · ${(review.findings?.length || 0) - (review.blocking?.length || 0)} ${(review.findings?.length || 0) - (review.blocking?.length || 0) === 1 ? 'menor' : 'menores'}`
      : review.status === 'running' ? 'Revisando…' : review.status === 'skipped' ? 'No se ejecutó: falló el entorno limpio' : review.status === 'error' ? 'No pudo completarse' : 'Pendiente';

    const minor = (review.findings || []).filter((f) => f.severity === 'media' || f.severity === 'baja');

    verif.replaceChildren(...[
      h('h2', { id: 'verif-t', text: 'Doble verificación' }),
      h('div', { class: `verif-block${v1.status === 'pending' ? ' waiting' : ''}` },
        h('div', { class: 'card-head' }, h('h3', { text: '1 · Automática' }), pill(v1.status, 'Aprobada')),
        checks),
      h('div', { class: `verif-block${v2.status === 'pending' ? ' waiting' : ''}` },
        h('div', { class: 'card-head' }, h('h3', { text: '2 · Revisión independiente' }), pill(v2.status, 'Aprobada')),
        h('p', { class: 'small muted', style: 'margin:0', text: 'Un segundo agente, sin ver cómo se generó el código, revisa el resultado contra tu pedido. Antes, el .zip se compila y se testea en un entorno limpio.' }),
        h('ul', { class: 'checklist' },
          h('li', {}, h('span', {}, mark(v2.clean?.status), 'Entorno limpio'), h('span', { class: 'muted', text: v2.clean?.summary || (v2.clean?.status === 'running' ? 'Compilando…' : 'Pendiente') })),
          h('li', {}, h('span', {}, mark(review.status), 'Revisor independiente'), h('span', { class: 'muted', text: reviewSummary })),
        ),
        review.summary ? h('p', { class: 'small', style: 'margin:0;color:var(--text-2)', text: review.summary }) : null,
        minor.length ? h('details', {}, h('summary', { class: 'small', style: 'cursor:pointer;color:var(--gold-2)', text: minor.length === 1 ? 'Ver 1 sugerencia menor' : `Ver ${minor.length} sugerencias menores` }),
          h('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:10px' }, minor.map((f) => h('div', { class: 'finding' },
            h('span', { class: `sev ${f.severity}`, text: `${f.severity} · ${f.area.replace('_', ' ')}` }),
            h('strong', { text: f.title }),
            f.file ? h('button', { type: 'button', class: 'btn small', style: 'align-self:flex-start', text: `${f.file}${f.line ? `:${f.line}` : ''}`, onclick: () => openFile(f.file, f.line) }) : null,
            h('span', { class: 'muted', text: f.detail }))))) : null,
      ),
      job.errors.length ? h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
        h('div', { class: 'card-head' }, h('h3', { text: `Errores a corregir (${job.errors.length})` }),
          job.errors.length > 1 && !RUNNING.has(job.status) ? h('button', { type: 'button', class: 'btn small', text: 'Corregir todos', onclick: () => act('fix', { errorIds: job.errors.map((e) => e.id) }, 'El agente está corrigiendo.') }) : null),
        h('ul', { class: 'errors' }, job.errors.map((e) => {
          const open = openDetails.has(e.id);
          return h('li', { class: 'error-item' },
            h('span', { class: 't', text: e.title }),
            open && e.detail ? h('pre', { text: e.detail }) : null,
            h('div', { class: 'btns' },
              h('button', { type: 'button', class: 'btn primary small', disabled: RUNNING.has(job.status), text: 'Corregir con el agente', onclick: () => act('fix', { errorIds: [e.id] }, 'El agente está corrigiendo.') }),
              e.detail ? h('button', { type: 'button', class: 'btn small', 'aria-expanded': String(open), text: open ? 'Ocultar detalle' : 'Ver detalle', onclick: () => { if (open) openDetails.delete(e.id); else openDetails.add(e.id); renderVerification(); } }) : null,
              e.file ? h('button', { type: 'button', class: 'btn small', text: 'Ver en el código', onclick: () => openFile(e.file, e.line) }) : null,
            ));
        }))) : null,
    ].filter(Boolean));
  }

  function renderConsole() {
    const nearBottom = consoleBody.scrollHeight - consoleBody.scrollTop - consoleBody.clientHeight < 40;
    const lines = job.activity.slice(-200);
    consoleBody.replaceChildren(...lines.map((a) => h('span', { class: a.kind, text: `${new Date(a.at).toLocaleTimeString('es-AR')}  ${a.kind === 'tool' ? '▸ ' : ''}${a.text}\n` })));
    if (!lines.length) consoleBody.textContent = 'Esperando al agente…';
    if (nearBottom) consoleBody.scrollTop = consoleBody.scrollHeight;
  }

  async function renderLogs() {
    const names = await api(`/api/jobs/${id}/logs`).catch(() => []);
    logs.replaceChildren(...names.slice(-12).map((n) => h('a', { href: `/api/jobs/${id}/logs/${encodeURIComponent(n)}`, target: '_blank', rel: 'noopener', class: 'mono', text: n })));
  }

  let timer = null;
  let stopped = false;
  async function refresh() {
    try {
      job = await api(`/api/jobs/${id}`);
    } catch (err) { toast(err.message); return; }
    renderHead();
    renderVerification();
    renderConsole();
    refreshFiles();
    renderLogs();
  }
  async function loop() {
    if (stopped) return;
    await refresh();
    if (!stopped) timer = setTimeout(loop, RUNNING.has(job.status) ? 2000 : 8000);
  }
  cleanup = () => { stopped = true; clearTimeout(timer); };

  view.replaceChildren(
    head, stepper, notice,
    h('div', { class: 'row' },
      h('section', { class: 'card code-card', 'aria-label': 'Archivos y código', style: 'flex:3 1 560px' }, tree, h('div', { class: 'viewer' }, viewerHead, code)),
      h('div', { class: 'col-side' }, verif,
        h('div', { class: 'console' }, h('span', { class: 'brand-sub', text: 'Consola del agente' }), consoleBody, h('span', { class: 'brand-sub', text: 'Registros completos' }), logs)),
    ),
    h('section', { class: 'card', 'aria-labelledby': 'cambio-t' },
      h('h2', { id: 'cambio-t', text: 'Pedir un cambio' }),
      h('div', { class: 'row', style: 'align-items:flex-end;gap:12px' },
        h('div', { class: 'field', style: 'flex:999 1 420px;min-width:0' },
          h('label', { for: 'change', text: 'Escribí qué querés ajustar; el agente lo aplica y repite las dos verificaciones. La entrega se habilita cuando pasan ambas.' }), changeText),
        h('div', { class: 'btns', style: 'flex:1 1 260px' }, sendChange, approve)),
    ),
  );
  await loop();
}

// ------------------------------------------------------------------------------------------------
// 3 · Entrega
// ------------------------------------------------------------------------------------------------

async function renderDelivery(id) {
  const job = await api(`/api/jobs/${id}`);
  if (!job.deliverable || !['review', 'delivered'].includes(job.status)) {
    view.replaceChildren(h('div', { class: 'card' },
      h('h2', { text: 'Este trabajo todavía no tiene entrega' }),
      h('p', { class: 'muted', style: 'margin:0', text: 'La entrega se arma cuando el trabajo pasa las dos verificaciones.' }),
      h('a', { class: 'btn primary', href: `#/trabajo/${id}`, text: 'Ir al taller', style: 'align-self:flex-start' })));
    return;
  }
  const d = job.deliverable;
  const review = job.v2.review || {};
  const metric = (k, v, s, cls) => h('div', { class: 'metric' }, h('span', { class: 'k', text: k }), h('span', { class: `v ${cls}`, text: v }), s ? h('span', { class: 's', text: s }) : null);

  const repo = h('input', { class: 'input', id: 'repo', placeholder: 'usuario/repositorio', autocomplete: 'off', spellcheck: 'false', value: store.get('push.repo') || '' });
  const branch = h('input', { class: 'input', id: 'branch', placeholder: 'Rama (opcional: se genera sola)', autocomplete: 'off', spellcheck: 'false' });
  const pushResult = h('div', { 'aria-live': 'polite' });
  const pushBtn = h('button', { type: 'button', class: 'btn wide', text: 'Subir a GitHub en una rama nueva' });
  pushBtn.addEventListener('click', async () => {
    if (!repo.value.trim()) { repo.focus(); return; }
    store.set('push.repo', repo.value.trim());
    pushBtn.disabled = true;
    pushBtn.textContent = 'Subiendo…';
    try {
      const r = await api(`/api/jobs/${id}/push`, { method: 'POST', body: { repo: repo.value.trim(), branch: branch.value.trim() } });
      pushResult.replaceChildren(h('div', { class: 'alert ok' }, 'Subido a la rama ', h('strong', { text: r.branch }), '. ', h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer', text: 'Abrir en GitHub' })));
    } catch (err) {
      pushResult.replaceChildren(h('div', { class: 'alert err', text: err.message }));
    } finally {
      pushBtn.disabled = false;
      pushBtn.textContent = 'Subir a GitHub en una rama nueva';
    }
  });

  const copyBtn = h('button', { type: 'button', class: 'btn wide', text: 'Copiar informe para el cliente' });
  // El informe copiado lleva la huella del .zip: el cliente la compara con sha256sum / Get-FileHash.
  const informe = `${d.entrega.trimEnd()}\n\nArchivo: ${d.file}\nSHA-256 del .zip: ${d.sha256 || '—'}\n`;
  copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(informe); toast('Informe copiado, con la huella del .zip. Pegalo en tu mail o mensaje.'); } catch { toast('No se pudo copiar. Seleccioná el texto del informe a mano.'); }
  });
  const hashBox = d.sha256 ? h('div', { class: 'hash' },
    h('span', { class: 'small muted', text: 'Huella SHA-256 del .zip (para que el cliente compruebe que no cambió)' }),
    h('code', { class: 'hash-value', text: d.sha256 }),
    h('a', { class: 'small', href: `/api/jobs/${id}/download.sha256`, download: `${d.file}.sha256`, text: 'Descargar archivo .sha256' })) : null;

  view.replaceChildren(
    h('header', { class: 'page-head' }, h('div', {},
      h('span', { class: 'eyebrow', text: 'Paso 3 de 3 · Entrega' }),
      h('h1', { text: job.name }),
      h('div', { class: 'meta' },
        h('span', { class: 'pill ok', text: job.status === 'delivered' ? 'Doble verificación aprobada · entregado' : 'Doble verificación aprobada · listo para enviar' }),
        h('span', { text: `${job.cycle} ${job.cycle === 1 ? 'ciclo' : 'ciclos'} · ${job.attempt} ${job.attempt === 1 ? 'intento' : 'intentos'} en el último` }),
        job.costUsd ? h('span', { text: `Costo del agente: US$ ${job.costUsd.toFixed(2)}` }) : null),
    ), h('div', { class: 'btns' }, h('a', { class: 'btn small', href: `#/trabajo/${id}`, text: 'Volver al taller' }))),
    h('div', { class: 'row' },
      h('div', { class: 'col-main' },
        h('section', { class: 'card' }, h('h2', { text: 'Verificación 1 · automática' }),
          h('div', { class: 'metric-grid' }, job.v1.checks.map((c) => metric(c.label, c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'Aviso' : 'Falló', c.summary, c.status)))),
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', { text: 'Verificación 2 · revisión independiente' }), h('span', { class: 'pill ok', text: 'Aprobada' })),
          h('ul', { class: 'checklist' },
            h('li', {}, h('span', {}, h('span', { class: 'mark ok', text: '✓' }), 'Cumple el pedido'), h('span', { class: 'muted', text: review.requirements?.total ? `${review.requirements.met} de ${review.requirements.total} requisitos` : 'Sin requisitos faltantes' })),
            h('li', {}, h('span', {}, h('span', { class: 'mark ok', text: '✓' }), 'Revisión de seguridad y casos borde'), h('span', { class: 'muted', text: `0 graves · ${(review.findings || []).length} ${(review.findings || []).length === 1 ? 'sugerencia menor' : 'sugerencias menores'}` })),
            h('li', {}, h('span', {}, h('span', { class: 'mark ok', text: '✓' }), 'Entorno limpio'), h('span', { class: 'muted', text: job.v2.clean?.summary || '' })),
          ),
          review.summary ? h('p', { class: 'small', style: 'margin:0;color:var(--text-2)', text: review.summary }) : null),
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', { text: 'Informe para el cliente' }), h('span', { class: 'mono small muted', text: 'ENTREGA.md' })),
          d.hadEntrega === false ? h('p', { class: 'empty', text: 'El agente no dejó ENTREGA.md: el Studio armó uno mínimo. Podés pedirle uno completo desde el taller.' }) : null,
          h('div', { class: 'doc', text: d.entrega })),
      ),
      h('aside', { class: 'col-side' },
        h('section', { class: 'card accent' }, h('h2', { text: 'Enviar el trabajo' }),
          h('a', { class: 'btn primary wide', href: `/api/jobs/${id}/download`, download: d.file, icon: 'download' }, 'Descargar .zip'),
          h('span', { class: 'small muted', style: 'text-align:center', text: `${d.file} · ${fmtBytes(d.size)} · ${d.count} archivos` }),
          hashBox,
          h('div', { class: 'field' }, h('label', { for: 'repo', text: 'Repositorio de GitHub' }), repo, branch),
          pushBtn, pushResult, copyBtn,
          h('span', { class: 'small muted', text: 'El .zip excluye .env, bin/, obj/ y .git, e incluye verificacion.md, revision-independiente.md y SHA256SUMS.txt como evidencia, firmados por SYSTECH Studio.' })),
        h('section', { class: 'card' }, h('h2', { text: 'Qué incluye' }),
          h('ul', { class: 'kv' }, d.topLevel.slice(0, 30).map((t) => h('li', {}, h('span', { class: 'k', text: t.name }), h('span', { class: 'muted', text: t.name.endsWith('/') ? `${t.files} archivos` : '' }))))),
      ),
    ),
  );
}

// ------------------------------------------------------------------------------------------------
// Entregas e historial
// ------------------------------------------------------------------------------------------------

async function renderList(kind) {
  let jobs = await api('/api/jobs');
  if (kind === 'entregas') jobs = jobs.filter((j) => j.status === 'review' || j.status === 'delivered');
  const title = kind === 'entregas' ? 'Entregas' : 'Historial';
  view.replaceChildren(
    h('header', { class: 'page-head' }, h('div', {}, h('h1', { text: title }),
      h('p', { class: 'muted', style: 'margin:0', text: kind === 'entregas' ? 'Trabajos con la doble verificación aprobada.' : 'Todos tus trabajos.' }))),
    h('section', { class: 'card' }, jobs.length
      ? h('div', { class: 'table-wrap' }, h('table', { class: 'list' },
        h('thead', {}, h('tr', {}, h('th', { text: 'Trabajo' }), h('th', { text: 'Estado' }), h('th', { text: 'Creado' }), h('th', { text: 'Costo' }))),
        h('tbody', {}, jobs.map((j) => h('tr', {},
          h('td', {}, h('a', { href: ['review', 'delivered'].includes(j.status) ? `#/entrega/${j.id}` : `#/trabajo/${j.id}`, text: j.name })),
          h('td', {}, statusPill(j.status)),
          h('td', { class: 'muted', text: fmtAgo(j.createdAt) }),
          h('td', { class: 'muted', text: j.costUsd ? `US$ ${j.costUsd.toFixed(2)}` : '—' }))))))
      : h('p', { class: 'empty', text: kind === 'entregas' ? 'Todavía no hay entregas.' : 'Todavía no hay trabajos.' })),
  );
}
