// App shell: tab routing plus the Today, Calendar and Settings screens.
import * as store from './store.js';
import { ANGLES, el, esc, toast, confirmDialog, shareOrDownload, shareFiles, pickFiles, router } from './ui.js';
import { todayKey, addDays, fmt, fmtShort, fmtTime, dayNumber, weekNumber, weekLabel, toKey, fromKey, WEEKDAYS } from './dates.js';
import { startPhotoSession, importPhotos } from './camera.js';
import { renderProgress } from './progress.js';

const VERSION = '1.2.0';
const view = document.getElementById('view');
const nav = {
  tab: 'today',
  date: null, // null = follow today
  calMonth: null, // 'YYYY-MM-01'
};

function go(tab, opts = {}) {
  const changed = tab !== nav.tab;
  nav.tab = tab;
  if ('date' in opts) nav.date = opts.date;
  if (tab !== 'today' && !('date' in opts)) nav.date = null;
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
  render();
  if (changed || opts.top) window.scrollTo(0, 0);
}
function render() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === nav.tab));
  view.onclick = null;
  ({ today: renderToday, calendar: renderCalendar, progress: renderProgress, settings: renderSettings }[nav.tab] || renderToday)(view);
}
router.go = go;
router.refresh = render;

// =====================================================================
// TODAY
// =====================================================================
function renderToday(v) {
  const s = store.state.settings;
  const today = todayKey();
  const date = nav.date && nav.date < today ? nav.date : today;
  const isToday = date === today;
  const dn = dayNumber(s.startDate, date);
  const wn = weekNumber(s.startDate, date);
  const rec = store.doseRecord(date);
  const st = store.streaks();
  const wk = store.weekAdherence(Math.max(wn, 1));

  v.innerHTML = '';
  v.appendChild(el(`
    <header class="top datenav">
      <button class="icon-btn" data-act="prev" aria-label="Previous day">‹</button>
      <div class="datenav-mid">
        <div class="eyebrow">${isToday ? 'Today' : esc(fmt(date, { weekday: 'long' }))}</div>
        <h1>${dn >= 1 ? `Day ${dn}` : 'Before start'}</h1>
        <div class="sub">${dn >= 1 ? `${weekLabel(wn)} · ` : ''}${esc(fmt(date, { month: 'long', day: 'numeric' }))}</div>
      </div>
      <button class="icon-btn" data-act="next" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
    </header>`));

  if (isToday) v.appendChild(photoCard());
  else {
    const ph = store.photosOnDate(date);
    v.appendChild(el(`<div class="backfill-note">Editing a past day${ph.length ? ` · ${ph.length} photo${ph.length > 1 ? 's' : ''} taken` : ''}. <button class="link" data-act="today">Back to today</button></div>`));
  }

  const doses = el(`<section class="doses">${store.DOSES.map((d) => {
    const t = rec[d.key];
    const sameDay = t && toKey(new Date(t)) === date;
    return `
      <button class="dose ${t ? 'done' : ''}" data-dose="${d.key}">
        <span class="dose-icon">${d.icon}</span>
        <span class="dose-text">
          <span class="dose-title">${esc(d.label)}</span>
          <span class="dose-sub">${t ? (sameDay ? `Logged ${fmtTime(t)}` : 'Logged later') : esc(d.hint)}</span>
        </span>
        <span class="dose-check"><svg viewBox="0 0 24 24"><path d="M6 12.5l4 4L18 8"/></svg></span>
      </button>`;
  }).join('')}</section>`);
  v.appendChild(doses);

  const allDone = store.doseCount(date) === 3;
  v.appendChild(el(`
    <section class="stats">
      <div class="stat ${st.all.current ? 'hot' : ''}"><b>${st.all.current}</b><span>day streak${st.all.current ? ' 🔥' : ''}</span></div>
      <div class="stat"><b>${st.all.best}</b><span>best streak</span></div>
      <div class="stat"><b>${store.pct([wk.fin[0] + wk.min[0], wk.fin[1] + wk.min[1]]) ?? '–'}${store.pct([wk.fin[0] + wk.min[0], wk.fin[1] + wk.min[1]]) === null ? '' : '%'}</b><span>this week</span></div>
    </section>`));
  if (isToday && allDone) v.appendChild(el('<p class="all-done">All done for today ✓</p>'));

  v.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'prev') go('today', { date: addDays(date, -1) });
    if (act === 'next') go('today', { date: addDays(date, 1) >= today ? null : addDays(date, 1) });
    if (act === 'today') go('today', { date: null });
    if (act === 'shoot') startPhotoSession({ angles: b.dataset.angles ? b.dataset.angles.split(',') : undefined, onDone: render });
    if (act === 'import') importPhotos({ onDone: render });
    if (act === 'compare') go('progress');
    if (b.dataset.dose) {
      const key = b.dataset.dose;
      const d = store.DOSES.find((x) => x.key === key);
      if (rec[key]) {
        if (!(await confirmDialog(`Un-log ${d.label} for ${isToday ? 'today' : fmt(date)}?`, { ok: 'Un-log', danger: true }))) return;
        await store.setDose(date, key, null);
      } else {
        await store.setDose(date, key, new Date().toISOString());
        if (store.doseCount(date) === 3) toast(isToday ? 'All 3 done today 🔥' : 'Day complete');
      }
      render();
    }
  };
}

function photoCard() {
  const ps = store.photoStatus();
  const angles = store.state.settings.angles;
  if (ps.status === 'before') {
    return el(`<section class="card slim"><div class="milestone-next">🗓️ <span>Treatment starts ${esc(fmt(ps.day))}</span></div></section>`);
  }
  if (ps.status === 'upcoming') {
    return el(`<section class="card slim photo-next"><div class="milestone-next">📸 <span>Next photos: <b>${esc(fmt(ps.day))}</b> · ${angles.map((a) => esc(ANGLES[a].short)).join(' + ')}</span></div></section>`);
  }
  if (ps.status === 'done') {
    return el(`
      <section class="card slim photo-done">
        <div class="milestone-next">✅ <span>${weekLabel(ps.week)} photos done</span></div>
        <button class="btn small ghost" data-act="compare">Compare</button>
      </section>`);
  }
  const isPhotoDay = ps.day === todayKey();
  return el(`
    <section class="card photo-due">
      <div class="photo-due-head">
        <span class="photo-due-icon">📸</span>
        <div>
          <div class="eyebrow">${isPhotoDay ? 'Photo day' : `Photo day was ${esc(fmt(ps.day))}`}</div>
          <h2>${weekLabel(ps.week)} photos</h2>
          <p class="muted">Still needed: ${ps.missing.map((a) => esc(ANGLES[a].label)).join(', ')}</p>
        </div>
      </div>
      <div class="row-actions">
        <button class="btn primary" data-act="shoot" data-angles="${ps.missing.join(',')}">Take photos</button>
        <button class="btn ghost" data-act="import">Import</button>
      </div>
    </section>`);
}

// =====================================================================
// CALENDAR
// =====================================================================
function renderCalendar(v) {
  const s = store.state.settings;
  const today = todayKey();
  if (!nav.calMonth) nav.calMonth = `${today.slice(0, 7)}-01`;
  const first = fromKey(nav.calMonth);
  const monthName = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const lead = first.getDay();
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const photoDates = new Set(store.state.photos.map((p) => p.date));
  const st = store.streaks();
  const all = store.adherence();

  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<span class="cal-cell blank"></span>';
  for (let d = 1; d <= daysInMonth; d++) {
    const k = toKey(new Date(first.getFullYear(), first.getMonth(), d));
    const n = store.doseCount(k);
    let cls = 'future';
    if (k <= today && k >= s.startDate) cls = n === 3 ? 'full' : n > 0 ? 'partial' : k === today ? 'pending' : 'miss';
    else if (k < s.startDate) cls = 'before';
    if (k === today) cls += ' today';
    const clickable = k <= today;
    cells += `<button class="cal-cell ${cls}" ${clickable ? `data-day="${k}"` : 'disabled'}>
      <span>${d}</span>${photoDates.has(k) ? '<i class="cal-photo"></i>' : ''}
    </button>`;
  }

  v.innerHTML = '';
  v.appendChild(el(`
    <header class="top"><div>
      <div class="eyebrow">Calendar</div>
      <h1>Consistency</h1>
      <div class="sub">Since ${esc(fmt(s.startDate, { month: 'long', day: 'numeric' }))}</div>
    </div></header>`));
  v.appendChild(el(`
    <section class="stats four">
      <div class="stat ${st.all.current ? 'hot' : ''}"><b>${st.all.current}</b><span>streak</span></div>
      <div class="stat"><b>${st.all.best}</b><span>best</span></div>
      <div class="stat"><b>${store.pct(all.fin) ?? '–'}${store.pct(all.fin) === null ? '' : '%'}</b><span>fin</span></div>
      <div class="stat"><b>${store.pct(all.min) ?? '–'}${store.pct(all.min) === null ? '' : '%'}</b><span>min</span></div>
    </section>`));
  v.appendChild(el(`
    <section class="card cal">
      <div class="cal-head">
        <button class="icon-btn" data-act="prev" aria-label="Previous month">‹</button>
        <h2>${esc(monthName)}</h2>
        <button class="icon-btn" data-act="next" aria-label="Next month" ${nav.calMonth >= `${today.slice(0, 7)}-01` ? 'disabled' : ''}>›</button>
      </div>
      <div class="cal-grid">
        ${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<span class="cal-dow">${d}</span>`).join('')}
        ${cells}
      </div>
      <div class="legend">
        <span><i class="sw full"></i>All 3</span>
        <span><i class="sw partial"></i>Some</span>
        <span><i class="sw miss"></i>Missed</span>
        <span><i class="cal-photo inline"></i>Photos</span>
      </div>
    </section>`));
  v.appendChild(el(`
    <section class="card">
      <div class="streak-rows">
        <div><span>💊 Finasteride streak</span><b>${st.fin.current} <em>best ${st.fin.best}</em></b></div>
        <div><span>💧 Minoxidil (AM + PM) streak</span><b>${st.min.current} <em>best ${st.min.best}</em></b></div>
        <div><span>Fin doses taken</span><b>${all.fin[0]} / ${all.fin[1]}</b></div>
        <div><span>Min applications</span><b>${all.min[0]} / ${all.min[1]}</b></div>
      </div>
      <p class="muted small">Tap any day to log or fix it.</p>
    </section>`));

  v.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const shift = (n) => { const d = fromKey(nav.calMonth); d.setMonth(d.getMonth() + n); nav.calMonth = toKey(d); render(); };
    if (b.dataset.act === 'prev') shift(-1);
    if (b.dataset.act === 'next') shift(1);
    if (b.dataset.day) go('today', { date: b.dataset.day === today ? null : b.dataset.day, top: true });
  };
}

// =====================================================================
// SETTINGS
// =====================================================================
async function renderSettings(v) {
  const s = store.state.settings;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  v.innerHTML = '';
  v.onclick = null;
  v.appendChild(el(`<header class="top"><div><div class="eyebrow">Settings</div><h1>Setup</h1></div></header>`));

  if (!standalone) {
    v.appendChild(el(`
      <section class="card install">
        <h2>Install on your iPhone</h2>
        <ol>
          <li>Open this page in <b>Safari</b></li>
          <li>Tap the <b>Share</b> button <span class="share-ico">⬆︎</span></li>
          <li>Choose <b>Add to Home Screen</b></li>
        </ol>
        <p class="muted small">Then always open Hairline from its home-screen icon. Your data lives inside that installed app.</p>
      </section>`));
  }

  const form = el(`
    <section class="card form">
      <h2>Treatment</h2>
      <label class="field"><span>Start date (Day 1)</span><input type="date" data-k="startDate" value="${s.startDate}" max="${todayKey()}"></label>
      <label class="field"><span>Photo day</span>
        <select data-k="photoWeekday">${WEEKDAYS.map((d, i) => `<option value="${i}" ${i === s.photoWeekday ? 'selected' : ''}>${d}</option>`).join('')}</select>
      </label>
      <div class="field"><span>Photo angles</span>
        <div class="checks">${Object.entries(ANGLES).map(([k, a]) => `<label class="check-row"><input type="checkbox" data-angle="${k}" ${s.angles.includes(k) ? 'checked' : ''}> ${esc(a.label)}</label>`).join('')}</div>
      </div>
    </section>`);
  form.addEventListener('change', async (e) => {
    const t = e.target;
    if (t.dataset.k === 'startDate') {
      if (!t.value) { t.value = s.startDate; return; }
      if (!(await confirmDialog(`Change Day 1 to ${fmt(t.value)}? Week numbers will shift, and impressions stay attached to their week number.`, { ok: 'Change' }))) { t.value = store.state.settings.startDate; return; }
      await store.updateSettings({ startDate: t.value });
    }
    if (t.dataset.k === 'photoWeekday') await store.updateSettings({ photoWeekday: Number(t.value) });
    if (t.dataset.angle) {
      const angles = [...form.querySelectorAll('[data-angle]')].filter((x) => x.checked).map((x) => x.dataset.angle);
      if (!angles.length) { t.checked = true; return toast('Keep at least one angle'); }
      await store.updateSettings({ angles: Object.keys(ANGLES).filter((a) => angles.includes(a)) });
    }
    toast('Saved');
  });
  v.appendChild(form);

  v.appendChild(el(`
    <section class="card">
      <h2>Reminders</h2>
      <p class="muted">Home-screen web apps can’t schedule their own alarms, so use the iPhone <b>Reminders</b> app (it’s reliable and works offline):</p>
      <ul class="reminder-list">
        <li><b>Fin + Min AM</b> · every day, morning</li>
        <li><b>Min PM</b> · every day, evening</li>
        <li><b>Hairline photos</b> · every ${WEEKDAYS[s.photoWeekday]}</li>
      </ul>
      <p class="muted small">In Reminders, tap a reminder ⓘ → Date + Time → Repeat: Daily/Weekly.</p>
    </section>`));

  const data = el(`
    <section class="card">
      <h2>Your data</h2>
      <p class="muted">Everything is stored only on this phone: <b class="data-count"></b>. Nothing is uploaded. Export a backup now and then (e.g. to iCloud Drive). If the app is deleted, its data goes with it.</p>
      <p class="muted small storage-line"></p>
      <div class="row-actions wrap">
        <button class="btn primary" data-act="export">Export backup</button>
        <button class="btn ghost" data-act="restore">Restore backup</button>
        <button class="btn ghost" data-act="import">Import photos</button>
        <button class="btn ghost" data-act="to-photos">Save all photos to Photos app</button>
      </div>
    </section>`);
  data.querySelector('.data-count').textContent =
    `${store.state.photos.length} photos, ${store.state.doses.size} days logged, ${store.state.impressions.size} impressions`;
  data.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'export') {
      toast('Building backup…');
      const blob = await store.exportBackup();
      await shareOrDownload(blob, `hairline-backup-${todayKey()}.json`);
    }
    if (act === 'restore') {
      const [file] = await pickFiles({ accept: 'application/json,.json' });
      if (!file) return;
      try {
        const json = JSON.parse(await file.text());
        const n = (json.photos || []).length;
        if (!(await confirmDialog(`Restore ${n} photos and ${(json.doses || []).length} days from this backup? Matching entries here will be overwritten.`, { ok: 'Restore' }))) return;
        await store.importBackup(json);
        toast('Backup restored');
        render();
      } catch (err) { toast(err.message || 'Could not read that file'); }
    }
    if (act === 'import') importPhotos({ onDone: render });
    if (act === 'to-photos') {
      if (!store.state.photos.length) return toast('No photos yet');
      await shareFiles(store.state.photos.map((p) => new File([p.blob], `hairline-${p.date}-${p.angle}.jpg`, { type: 'image/jpeg' })));
    }
  });
  v.appendChild(data);

  const danger = el(`
    <section class="card">
      <h2>Danger zone</h2>
      <button class="btn danger" data-act="erase">Erase all data</button>
    </section>`);
  danger.addEventListener('click', async (e) => {
    if (!e.target.closest('[data-act=erase]')) return;
    if (!(await confirmDialog('Erase every photo, log and impression on this phone? Export a backup first if you might want them.', { ok: 'Continue', danger: true }))) return;
    if (!(await confirmDialog('This really can’t be undone. Erase everything?', { ok: 'Erase everything', danger: true }))) return;
    await store.eraseAll();
    toast('All data erased');
    go('today');
  });
  v.appendChild(danger);
  v.appendChild(el(`<p class="footer muted small">Hairline ${VERSION} · data stays on this device</p>`));

  // storage info (async)
  if (navigator.storage?.estimate) {
    const line = data.querySelector('.storage-line');
    const [est, persisted] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted?.() ?? false]);
    const mb = (est.usage / 1048576).toFixed(1);
    line.textContent = `Using ${mb} MB.${persisted ? ' Protected from automatic cleanup.' : ''}`;
  }
}

// =====================================================================
// boot
// =====================================================================
document.getElementById('tabbar').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) go(t.dataset.tab, { date: null });
});

// Re-render when the app comes back to the foreground (e.g. the next morning).
let lastDay = todayKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && todayKey() !== lastDay) { lastDay = todayKey(); render(); }
});

(async function boot() {
  try {
    await store.load();
  } catch (err) {
    view.innerHTML = `<div class="card"><h2>Couldn’t open storage</h2><p class="muted">${esc(err.message)}</p></div>`;
    return;
  }
  const initial = location.hash.slice(1);
  nav.tab = ['today', 'calendar', 'progress', 'settings'].includes(initial) ? initial : 'today';
  render();
  // Ask iOS to keep our data (granted automatically for installed home-screen apps).
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
