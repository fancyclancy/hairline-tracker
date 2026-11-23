// Shared UI helpers: element builder, toasts, sheets, dialogs, image processing.

export const ANGLES = {
  front: { label: 'Front hairline', short: 'Front', tip: 'Face the camera, hair dry and pushed back. Line your eyes up with the dashed line.' },
  crown: { label: 'Crown', short: 'Crown', tip: 'Back of the head, hair dry. Use the 10-second timer or ask someone to take it.' },
  left: { label: 'Left temple', short: 'Left', tip: 'Turn your head right so your left temple faces the camera.' },
  right: { label: 'Right temple', short: 'Right', tip: 'Turn your head left so your right temple faces the camera.' },
};

export const RATINGS = [
  { value: 1, label: 'Worse', cls: 'r-worse' },
  { value: 2, label: 'No change', cls: 'r-same' },
  { value: 3, label: 'Maybe better', cls: 'r-maybe' },
  { value: 4, label: 'Clearly better', cls: 'r-better' },
];
export const ratingInfo = (v) => RATINGS.find((r) => r.value === v);

// Navigation hooks, filled in by app.js (avoids circular imports).
export const router = { go: () => {}, refresh: () => {} };

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Build a DOM element from an HTML string. */
export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/** Bottom sheet. Returns { el, close }. */
export function openSheet(contentHtml, { onClose } = {}) {
  const root = document.getElementById('overlay-root');
  const wrap = el(`<div class="sheet-wrap"><div class="sheet-backdrop"></div><div class="sheet"><div class="sheet-grip"></div>${contentHtml}</div></div>`);
  root.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 250);
    onClose && onClose();
  };
  wrap.querySelector('.sheet-backdrop').addEventListener('click', close);
  return { el: wrap.querySelector('.sheet'), close };
}

export function confirmDialog(message, { ok = 'OK', cancel = 'Cancel', danger = false, title = '' } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const s = openSheet(`
      ${title ? `<h2 class="sheet-title">${esc(title)}</h2>` : ''}
      <p class="sheet-text">${esc(message)}</p>
      <div class="sheet-actions">
        <button class="btn ghost" data-r="0">${esc(cancel)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button>
      </div>`, { onClose: () => { if (!answered) resolve(false); } });
    s.el.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
      answered = true;
      resolve(b.dataset.r === '1');
      s.close();
    }));
  });
}

// ---------- images ----------
export const PHOTO_W = 1200;
export const PHOTO_H = 1600; // all photos are 3:4 portrait so they line up

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const url = src instanceof Blob ? URL.createObjectURL(src) : src;
    const img = new Image();
    img.onload = () => { if (src instanceof Blob) URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { if (src instanceof Blob) URL.revokeObjectURL(url); reject(new Error('Could not read that image')); };
    img.src = url;
  });
}

/** Center-crop any source (image, video) to 3:4 and draw it on a new canvas. */
export function cropTo34(source, srcW, srcH, { mirror = false } = {}) {
  const target = 3 / 4;
  let sw, sh, sx, sy;
  if (srcW / srcH > target) { sh = srcH; sw = srcH * target; sx = (srcW - sw) / 2; sy = 0; }
  else { sw = srcW; sh = srcW / target; sx = 0; sy = (srcH - sh) / 2; }
  const outW = Math.min(PHOTO_W, Math.round(sw));
  const outH = Math.round(outW / target);
  const c = document.createElement('canvas');
  c.width = outW; c.height = outH;
  const ctx = c.getContext('2d');
  if (mirror) { ctx.translate(outW, 0); ctx.scale(-1, 1); }
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, outW, outH);
  return c;
}

export function flipCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0);
  return c;
}

export const canvasToBlob = (c, q = 0.86, type = 'image/jpeg') =>
  new Promise((res) => c.toBlob(res, type, q));

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export async function makePhotoRecord(canvas, date, angle) {
  const thumb = document.createElement('canvas');
  thumb.width = 300; thumb.height = 400;
  thumb.getContext('2d').drawImage(canvas, 0, 0, 300, 400);
  return {
    id: newId(),
    date,
    angle,
    blob: await canvasToBlob(canvas, 0.86),
    thumb: await canvasToBlob(thumb, 0.8),
    createdAt: new Date().toISOString(),
  };
}

// Object URLs for stored photos, cached so lists don't leak memory.
const urlCache = new Map();
export function photoUrl(photo, kind = 'thumb') {
  const key = `${photo.id}:${kind}`;
  if (!urlCache.has(key)) urlCache.set(key, URL.createObjectURL(photo[kind]));
  return urlCache.get(key);
}
export function forgetPhotoUrls(id) {
  for (const kind of ['thumb', 'blob']) {
    const key = `${id}:${kind}`;
    if (urlCache.has(key)) { URL.revokeObjectURL(urlCache.get(key)); urlCache.delete(key); }
  }
}

/** iPhone: opens the share sheet (Save Image / Save to Files). Elsewhere: downloads. */
export async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  return true;
}

/** Share several files at once (iPhone: "Save N Images" puts them in Photos). Falls back to downloads. */
export async function shareFiles(files) {
  if (!files.length) return false;
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  for (const f of files) await shareOrDownload(f, f.name);
  return true;
}

export const pickFiles =({ accept = 'image/*', multiple = false, capture } = {}) =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
