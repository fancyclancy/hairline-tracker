// Progress screen: compare (side-by-side + swipe slider), milestones, impression trend, weekly timeline, timelapse.
import { ANGLES, RATINGS, ratingInfo, el, esc, toast, photoUrl, loadImage, confirmDialog, shareOrDownload, canvasToBlob } from './ui.js';
import * as store from './store.js';
import { fmt, fmtShort, weekLabel, weekStart, weekEnd, addDays, photoDayOfWeek, todayKey, dayNumber } from './dates.js';
import { importPhotos, openImpression } from './camera.js';

const ui = { angle: null, a: null, b: null, sig: '', mode: 'slider', sliderPos: 50 };

const MILESTONES = [
  { days: 91, label: '3 months' },
  { days: 182, label: '6 months' },
  { days: 273, label: '9 months' },
  { days: 365, label: '12 months' },
];

const photoLabel = (p) => `${weekLabel(store.photoWeek(p))} · ${fmtShort(p.date)}`;

export function renderProgress(view) {
  const { settings } = store.state;
  if (!ui.angle || !settings.angles.includes(ui.angle)) ui.angle = settings.angles[0];
  const byWeek = store.photosByWeek(ui.angle);
  const weeks = [...byWeek.keys()].sort((x, y) => x - y);
  // Reset to "first vs latest" whenever the set of photo weeks changes (new photos, new angle).
  const sig = `${ui.angle}:${weeks.join(',')}`;
  if (sig !== ui.sig || !weeks.includes(ui.a) || !weeks.includes(ui.b)) {
    ui.sig = sig;
    ui.a = weeks[0] ?? null;
    ui.b = weeks[weeks.length - 1] ?? null;
  }

  view.innerHTML = '';
  view.appendChild(el(`
    <header class="top"><div>
      <div class="eyebrow">Progress</div>
      <h1>${weekLabel(Math.max(store.currentWeek(), 0))}</h1>
      <div class="sub">Day ${Math.max(0, dayNumber(store.start(), todayKey()))} on fin + min</div>
    </div></header>`));

  if (settings.angles.length > 1) {
    const seg = el(`<div class="seg">${settings.angles.map((a) => `<button data-angle="${a}" class="${a === ui.angle ? 'on' : ''}">${esc(ANGLES[a].short)}</button>`).join('')}</div>`);
    seg.addEventListener('click', (e) => { const a = e.target.closest('button')?.dataset.angle; if (a) { ui.angle = a; ui.a = ui.b = null; renderProgress(view); } });
    view.appendChild(seg);
  }

  if (!weeks.length) {
    const empty = el(`
      <section class="card empty">
        <div class="empty-icon">📸</div>
        <h2>No ${esc(ANGLES[ui.angle].label.toLowerCase())} photos yet</h2>
        <p class="muted">Take your weekly photos on the Today screen, or import ones you already have.</p>
        <div class="row-actions">
          <button class="btn primary" data-act="import">Import photos</button>
        </div>
      </section>`);
    empty.querySelector('[data-act=import]').addEventListener('click', () => importPhotos({ onDone: () => renderProgress(view) }));
    view.appendChild(empty);
    view.appendChild(timeline(view));
    return;
  }

  if (weeks.length === 1) {
    const p = byWeek.get(weeks[0]);
    const one = el(`
      <section class="card">
        <div class="card-head"><h2>Baseline</h2><span class="muted small">${esc(photoLabel(p))}</span></div>
        <button class="single-photo" data-photo="${p.id}"><img src="${photoUrl(p, 'blob')}" alt=""></button>
        <p class="muted small">Compare, slider and timelapse unlock once you have a second week of photos.</p>
      </section>`);
    one.querySelector('[data-photo]').addEventListener('click', () => openViewer(p.id, view));
    view.appendChild(one);
  } else {
    view.appendChild(compareCard(view, byWeek, weeks));
  }
  const ms = milestoneCard(view, weeks);
  if (ms) view.appendChild(ms);
  view.appendChild(trendCard());
  view.appendChild(timeline(view));
}

// ---------- compare ----------
function nearestAtOrBefore(weeks, target) {
  let best = weeks[0];
  for (const w of weeks) if (w <= target) best = w;
  return best;
}

function compareCard(view, byWeek, weeks) {
  const A = byWeek.get(ui.a);
  const B = byWeek.get(ui.b);
  const opts = (sel) => weeks.map((w) => `<option value="${w}" ${w === sel ? 'selected' : ''}>${esc(photoLabel(byWeek.get(w)))}</option>`).join('');
  // Quick picks for "Before", relative to the "After" week. Hidden when they'd land on the same week.
  const seen = new Set();
  const quick = [
    { label: 'Start', w: weeks[0] },
    { label: '3 mo ago', w: nearestAtOrBefore(weeks, ui.b - 13), min: 14 },
    { label: '1 mo ago', w: nearestAtOrBefore(weeks, ui.b - 4), min: 5 },
    { label: 'Last week', w: nearestAtOrBefore(weeks, ui.b - 1), min: 2 },
  ].filter((q) => q.w < ui.b && (!q.min || ui.b - weeks[0] + 1 >= q.min) && !seen.has(q.w) && seen.add(q.w));

  const card = el(`
    <section class="card compare">
      <div class="card-head">
        <h2>Compare</h2>
        <div class="seg small">
          <button data-mode="slider" class="${ui.mode === 'slider' ? 'on' : ''}">Slider</button>
          <button data-mode="side" class="${ui.mode === 'side' ? 'on' : ''}">Side by side</button>
        </div>
      </div>
      <div class="cmp-selects">
        <label><span>Before</span><select data-pick="a">${opts(ui.a)}</select></label>
        <label><span>After</span><select data-pick="b">${opts(ui.b)}</select></label>
      </div>
      <div class="chips">${quick.map((q) => `<button class="chip ${q.w === ui.a ? 'on' : ''}" data-quick="${q.w}">${q.label}</button>`).join('')}</div>
      <div class="cmp-stage"></div>
      <div class="row-actions">
        <button class="btn ghost" data-act="timelapse">▶ Timelapse</button>
        <button class="btn ghost" data-act="save">Save image</button>
      </div>
    </section>`);

  const stage = card.querySelector('.cmp-stage');
  if (ui.mode === 'side') {
    stage.appendChild(el(`
      <div class="side">
        <figure><img src="${photoUrl(A, 'blob')}" alt=""><figcaption>${esc(photoLabel(A))}</figcaption></figure>
        <figure><img src="${photoUrl(B, 'blob')}" alt=""><figcaption>${esc(photoLabel(B))}</figcaption></figure>
      </div>`));
  } else {
    const sl = el(`
      <div class="slider" style="--pos:${ui.sliderPos}%">
        <img class="s-b" src="${photoUrl(B, 'blob')}" alt="">
        <img class="s-a" src="${photoUrl(A, 'blob')}" alt="">
        <div class="s-line"><span class="s-knob">‹ ›</span></div>
        <span class="s-lbl l">${esc(photoLabel(A))}</span>
        <span class="s-lbl r">${esc(photoLabel(B))}</span>
      </div>`);
    const move = (e) => {
      const r = sl.getBoundingClientRect();
      ui.sliderPos = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
      sl.style.setProperty('--pos', `${ui.sliderPos}%`);
    };
    let dragging = false;
    sl.addEventListener('pointerdown', (e) => { dragging = true; sl.setPointerCapture(e.pointerId); move(e); });
    sl.addEventListener('pointermove', (e) => { if (dragging) move(e); });
    sl.addEventListener('pointerup', () => { dragging = false; });
    sl.addEventListener('pointercancel', () => { dragging = false; });
    stage.appendChild(sl);
  }

  card.addEventListener('change', (e) => {
    const k = e.target.dataset.pick;
    if (k) { ui[k] = Number(e.target.value); renderProgress(view); }
  });
  card.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) { ui.mode = b.dataset.mode; renderProgress(view); }
    if (b.dataset.quick) { ui.a = Number(b.dataset.quick); renderProgress(view); }
    if (b.dataset.act === 'timelapse') openTimelapse(ui.angle);
    if (b.dataset.act === 'save') saveComparison(A, B);
  });
  return card;
}

async function saveComparison(A, B) {
  toast('Preparing image…');
  const [ia, ib] = await Promise.all([loadImage(A.blob), loadImage(B.blob)]);
  const W = 900, H = 1200, bar = 96, foot = 64;
  const c = document.createElement('canvas');
  c.width = W * 2 + 12; c.height = H + bar + foot;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#0e161e'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(ia, 0, bar, W, H);
  ctx.drawImage(ib, W + 12, bar, W, H);
  ctx.fillStyle = '#e8eef2';
  ctx.font = '600 40px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(photoLabel(A), W / 2, 62);
  ctx.fillText(photoLabel(B), W + 12 + W / 2, 62);
  ctx.fillStyle = '#8a9aa8';
  ctx.font = '400 30px -apple-system, system-ui, sans-serif';
  ctx.fillText(`${ANGLES[A.angle].label} · ${store.photoWeek(B) - store.photoWeek(A)} weeks apart`, c.width / 2, H + bar + 44);
  const blob = await canvasToBlob(c, 0.9);
  await shareOrDownload(blob, `hairline-${A.date}-vs-${B.date}.jpg`);
}

// ---------- milestones ----------
function milestoneCard(view, weeks) {
  const s = store.start();
  const today = todayKey();
  const latest = weeks[weeks.length - 1];
  const reached = MILESTONES.filter((m) => addDays(s, m.days) <= today);
  const next = MILESTONES.find((m) => addDays(s, m.days) > today);
  if (!reached.length) {
    if (!next) return null;
    const day = photoDayOfWeek(s, Math.floor(next.days / 7) + 1, store.state.settings.photoWeekday);
    return el(`<section class="card slim"><div class="milestone-next">🎯 <span>Next milestone: <b>${next.label}</b> · photo day ${esc(fmt(day))}</span></div></section>`);
  }
  const m = reached[reached.length - 1];
  const target = nearestAtOrBefore(weeks, Math.floor(m.days / 7) + 1);
  const card = el(`
    <section class="card milestone">
      <div>
        <div class="eyebrow">Milestone reached</div>
        <h2>${m.label} check-in</h2>
        <p class="muted">Compare your first photo with ${weekLabel(target)}${target !== latest ? ', or with your latest' : ''}.</p>
      </div>
      <button class="btn primary" data-act="go">Compare</button>
    </section>`);
  card.querySelector('[data-act=go]').addEventListener('click', () => {
    ui.a = weeks[0]; ui.b = target; ui.mode = 'slider';
    renderProgress(view);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  return card;
}

// ---------- impression trend ----------
function trendCard() {
  const cw = Math.max(1, store.currentWeek());
  const cells = [];
  for (let w = 1; w <= cw; w++) {
    const imp = store.state.impressions.get(w);
    const r = imp?.rating ? ratingInfo(imp.rating) : null;
    cells.push(`<span class="dot ${r ? r.cls : 'none'}" title="${weekLabel(w)}${r ? `: ${r.label}` : ''}"></span>`);
  }
  return el(`
    <section class="card">
      <div class="card-head"><h2>Impressions</h2><span class="muted small">Week 1 → ${cw}</span></div>
      <div class="trend">${cells.join('')}</div>
      <div class="legend">${RATINGS.map((r) => `<span><i class="dot ${r.cls}"></i>${r.label}</span>`).join('')}</div>
    </section>`);
}

// ---------- weekly timeline ----------
function timeline(view) {
  const { settings } = store.state;
  const s = store.start();
  const cw = store.currentWeek();
  const wrap = el('<section class="timeline"><h2 class="section-title">Week by week</h2></section>');
  if (cw < 1) { wrap.appendChild(el('<p class="muted">Your timeline starts on your start date.</p>')); return wrap; }
  const maps = Object.fromEntries(settings.angles.map((a) => [a, store.photosByWeek(a)]));

  for (let w = cw; w >= 1; w--) {
    const ad = store.weekAdherence(w);
    const imp = store.state.impressions.get(w);
    const r = imp?.rating ? ratingInfo(imp.rating) : null;
    const fin = store.pct(ad.fin);
    const min = store.pct(ad.min);
    const item = el(`
      <article class="card week">
        <div class="card-head">
          <h3>${weekLabel(w)}${w === cw ? ' <span class="tag">This week</span>' : ''}</h3>
          <span class="muted small">${esc(fmtShort(weekStart(s, w)))} – ${esc(fmtShort(weekEnd(s, w)))}</span>
        </div>
        <div class="week-photos">
          ${settings.angles.map((a) => {
            const p = maps[a].get(w);
            return p
              ? `<button class="thumb" data-photo="${p.id}"><img src="${photoUrl(p)}" alt=""><span>${esc(ANGLES[a].short)}</span></button>`
              : `<div class="thumb missing"><span>${esc(ANGLES[a].short)}</span><em>No photo</em></div>`;
          }).join('')}
        </div>
        <div class="adh">
          <div><span>Fin</span><div class="bar"><i style="width:${fin ?? 0}%"></i></div><b>${ad.fin[0]}/${ad.fin[1]}</b></div>
          <div><span>Min</span><div class="bar"><i style="width:${min ?? 0}%"></i></div><b>${ad.min[0]}/${ad.min[1]}</b></div>
        </div>
        ${imp
          ? `<button class="impression" data-imp="${w}">${r ? `<span class="pill ${r.cls}">${esc(r.label)}</span>` : ''}${imp.text ? `<span class="imp-text">“${esc(imp.text)}”</span>` : ''}</button>`
          : `<button class="link" data-imp="${w}">+ Add impression</button>`}
      </article>`);
    wrap.appendChild(item);
  }

  wrap.addEventListener('click', (e) => {
    const t = e.target.closest('[data-photo],[data-imp]');
    if (!t) return;
    if (t.dataset.photo) openViewer(t.dataset.photo, view);
    if (t.dataset.imp) openImpression(Number(t.dataset.imp), { onSave: () => renderProgress(view) });
  });
  return wrap;
}

// ---------- full-screen viewer ----------
function openViewer(id, view) {
  const p = store.state.photos.find((x) => x.id === id);
  if (!p) return;
  const root = el(`
    <div class="viewer">
      <div class="cam-top">
        <button class="cam-btn" data-act="close" aria-label="Close">✕</button>
        <div class="cam-title">${esc(ANGLES[p.angle].label)}<span>${esc(photoLabel(p))}</span></div>
        <button class="cam-btn danger" data-act="delete" aria-label="Delete">
          <svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13"/></svg>
        </button>
      </div>
      <div class="viewer-img"><img src="${photoUrl(p, 'blob')}" alt=""></div>
    </div>`);
  document.getElementById('overlay-root').appendChild(root);
  document.body.classList.add('no-scroll');
  const close = () => { root.remove(); document.body.classList.remove('no-scroll'); };
  root.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') close();
    if (act === 'delete' && await confirmDialog(`Delete this ${ANGLES[p.angle].label.toLowerCase()} photo from ${fmt(p.date)}? This can’t be undone.`, { ok: 'Delete', danger: true })) {
      await store.deletePhoto(p.id);
      close();
      toast('Photo deleted');
      renderProgress(view);
    }
  });
}

// ---------- timelapse ----------
function openTimelapse(angle) {
  const byWeek = store.photosByWeek(angle);
  const frames = [...byWeek.keys()].sort((x, y) => x - y).map((w) => byWeek.get(w));
  if (frames.length < 2) return toast('Need at least 2 weeks of photos');
  let i = 0;
  let speed = 1;
  let playing = true;
  let t = null;

  const root = el(`
    <div class="viewer">
      <div class="cam-top">
        <button class="cam-btn" data-act="close" aria-label="Close">✕</button>
        <div class="cam-title">Timelapse<span class="tl-label"></span></div>
        <span class="cam-btn-spacer"></span>
      </div>
      <div class="viewer-img tl-stage">${frames.map((f, k) => `<img src="${photoUrl(f, 'blob')}" data-k="${k}" alt="">`).join('')}</div>
      <div class="tl-progress"><i></i></div>
      <div class="cam-controls live">
        <button class="cam-pill" data-act="speed">1×</button>
        <button class="shutter play" data-act="play" aria-label="Play or pause"><span></span></button>
        <button class="cam-pill" data-act="restart">Restart</button>
      </div>
    </div>`);
  document.getElementById('overlay-root').appendChild(root);
  document.body.classList.add('no-scroll');
  const imgs = [...root.querySelectorAll('.tl-stage img')];
  const label = root.querySelector('.tl-label');
  const bar = root.querySelector('.tl-progress i');

  const show = () => {
    imgs.forEach((im, k) => im.classList.toggle('on', k === i));
    label.textContent = photoLabel(frames[i]);
    bar.style.width = `${((i + 1) / frames.length) * 100}%`;
    root.querySelector('[data-act=play]').classList.toggle('paused', !playing);
  };
  const schedule = () => {
    clearTimeout(t);
    if (!playing) return;
    const last = i === frames.length - 1;
    t = setTimeout(() => { i = last ? 0 : i + 1; show(); schedule(); }, (last ? 1800 : 700) / speed);
  };
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') { clearTimeout(t); root.remove(); document.body.classList.remove('no-scroll'); }
    if (act === 'play') { playing = !playing; show(); schedule(); }
    if (act === 'restart') { i = 0; playing = true; show(); schedule(); }
    if (act === 'speed') {
      speed = speed === 1 ? 2 : speed === 2 ? 0.5 : 1;
      e.target.textContent = `${speed}×`;
      schedule();
    }
  });
  show();
  schedule();
}
