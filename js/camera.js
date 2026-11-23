// Weekly photo session (live camera with ghost overlay), camera-roll import, and the impression sheet.
import { ANGLES, RATINGS, el, esc, toast, openSheet, cropTo34, flipCanvas, loadImage, makePhotoRecord, photoUrl, pickFiles } from './ui.js';
import * as store from './store.js';
import { todayKey, weekNumber, weekLabel, fmt, fmtShort, weekStart, weekEnd } from './dates.js';

const pref = {
  get(k, d) { try { const v = localStorage.getItem(`ht:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`ht:${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

// =====================================================================
// Weekly photo session
// =====================================================================
export async function startPhotoSession({ angles, onDone } = {}) {
  const list = angles && angles.length ? angles : store.state.settings.angles;
  const date = todayKey();
  let saved = 0;
  for (let i = 0; i < list.length; i++) {
    const canvas = await captureAngle(list[i], i, list.length);
    if (!canvas) break; // closed
    await store.addPhoto(await makePhotoRecord(canvas, date, list[i]));
    saved++;
  }
  if (saved) {
    toast(saved === 1 ? 'Photo saved' : `${saved} photos saved`);
    const week = weekNumber(store.start(), date);
    if (week >= 1 && !store.state.impressions.has(week)) {
      openImpression(week, { prompt: true, onSave: onDone, onClose: onDone });
      return;
    }
  }
  onDone && onDone();
}

/** Opens the full-screen camera for one angle. Resolves with a canvas, or null if closed. */
function captureAngle(angle, index, total) {
  return new Promise((resolve) => {
    const info = ANGLES[angle];
    const ghost = store.latestPhoto(angle);
    let facing = pref.get(`facing:${angle}`, 'user');
    let timer = pref.get(`timer:${angle}`, angle === 'crown' ? 10 : 0);
    let ghostOpacity = pref.get('ghostOpacity', 0.3);
    let ghostOn = !!ghost;
    let stream = null;
    let countdown = null;
    let captured = null; // canvas in review
    let noFrameTimer = null;

    const root = el(`
      <div class="cam">
        <div class="cam-top">
          <button class="cam-btn" data-act="close" aria-label="Close">✕</button>
          <div class="cam-title">${esc(info.label)}<span>${total > 1 ? `${index + 1} of ${total}` : ''}</span></div>
          <button class="cam-btn" data-act="flip" aria-label="Switch camera">
            <svg viewBox="0 0 24 24"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><path d="M9.5 13.5a2.5 2.5 0 0 0 4.6 1.3M14.5 12.5a2.5 2.5 0 0 0-4.6-1.3"/></svg>
          </button>
        </div>
        <div class="cam-frame">
          <video playsinline muted autoplay></video>
          <img class="cam-ghost" alt="" ${ghost ? `src="${photoUrl(ghost, 'blob')}"` : ''}>
          <img class="cam-review" alt="">
          <svg class="cam-guides" viewBox="0 0 300 400" preserveAspectRatio="none">
            ${angle === 'crown'
              ? '<circle cx="150" cy="190" r="95" />'
              : '<line x1="30" y1="120" x2="270" y2="120" /><line class="dash" x1="30" y1="210" x2="270" y2="210" /><line x1="150" y1="40" x2="150" y2="360" class="faint" />'}
          </svg>
          <div class="cam-count"></div>
          <div class="cam-msg"></div>
        </div>
        <div class="cam-tip">${esc(info.tip)}${ghost ? `<br><span class="muted">Ghost: ${esc(fmt(ghost.date))}. Line yourself up with it.</span>` : ''}</div>
        <div class="cam-ghost-ctl" ${ghost ? '' : 'hidden'}>
          <span>Ghost</span><input type="range" min="0" max="0.8" step="0.05" value="${ghostOpacity}">
        </div>
        <div class="cam-controls live">
          <button class="cam-pill" data-act="timer"></button>
          <button class="shutter" data-act="shoot" aria-label="Take photo"><span></span></button>
          <button class="cam-pill" data-act="ghost" ${ghost ? '' : 'disabled'}></button>
        </div>
        <div class="cam-controls review">
          <button class="cam-pill" data-act="retake">Retake</button>
          <button class="cam-pill" data-act="mirror">Mirror ⇋</button>
          <button class="btn primary" data-act="use">${index + 1 < total ? 'Next' : 'Use photo'}</button>
        </div>
      </div>`);
    document.getElementById('overlay-root').appendChild(root);
    document.body.classList.add('no-scroll');

    const video = root.querySelector('video');
    const ghostImg = root.querySelector('.cam-ghost');
    const reviewImg = root.querySelector('.cam-review');
    const countEl = root.querySelector('.cam-count');
    const msgEl = root.querySelector('.cam-msg');
    const slider = root.querySelector('.cam-ghost-ctl input');

    const paint = () => {
      root.querySelector('[data-act=timer]').textContent = timer ? `⏱ ${timer}s` : '⏱ Off';
      root.querySelector('[data-act=ghost]').textContent = ghostOn ? 'Ghost on' : 'Ghost off';
      // When the ghost is off (or at 0%), remove the overlay entirely so the live camera is never covered.
      const showGhost = ghostOn && !captured && ghostOpacity > 0;
      ghostImg.hidden = !showGhost;
      ghostImg.style.opacity = ghostOpacity;
      video.classList.toggle('mirror', facing === 'user');
      root.classList.toggle('reviewing', !!captured);
    };

    async function startStream() {
      stopStream();
      msgEl.innerHTML = '';
      if (!navigator.mediaDevices?.getUserMedia) return showFallback('This browser can’t open the camera directly.');
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: facing }, width: { ideal: 1440 }, height: { ideal: 1920 } },
        });
        video.muted = true;
        video.srcObject = stream;
        await video.play().catch(() => {});
        // If no frames arrive, say so and offer a restart instead of showing a silent black screen.
        clearTimeout(noFrameTimer);
        noFrameTimer = setTimeout(() => {
          if (!captured && !video.videoWidth) {
            msgEl.innerHTML = '<p>The camera isn’t showing yet.</p><button class="btn primary" data-act="restart">Restart camera</button>';
          }
        }, 4000);
      } catch (e) {
        showFallback(e.name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow it in Settings › Safari › Camera, or use the iPhone camera instead.'
          : `Couldn’t start the camera (${e.name || e.message}).`);
      }
    }
    function stopStream() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    function showFallback(text) {
      msgEl.innerHTML = `<p>${esc(text)}</p><button class="btn primary" data-act="native">Use iPhone camera</button>`;
    }

    function finish(result) {
      clearInterval(countdown);
      stopStream();
      document.body.classList.remove('no-scroll');
      root.remove();
      resolve(result);
    }

    function review(canvas) {
      captured = canvas;
      reviewImg.src = canvas.toDataURL('image/jpeg', 0.9);
      paint();
    }

    function shoot() {
      if (!video.videoWidth) return toast('Camera is still starting…');
      review(cropTo34(video, video.videoWidth, video.videoHeight, { mirror: facing === 'user' }));
    }

    function startCountdown() {
      if (countdown) { clearInterval(countdown); countdown = null; countEl.textContent = ''; return; } // tap again cancels
      let n = timer;
      countEl.textContent = n;
      countdown = setInterval(() => {
        n--;
        if (n <= 0) { clearInterval(countdown); countdown = null; countEl.textContent = ''; shoot(); }
        else countEl.textContent = n;
      }, 1000);
    }

    root.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      if (act === 'close') finish(null);
      if (act === 'flip') { facing = facing === 'user' ? 'environment' : 'user'; pref.set(`facing:${angle}`, facing); paint(); startStream(); }
      if (act === 'timer') { timer = timer === 0 ? 3 : timer === 3 ? 10 : 0; pref.set(`timer:${angle}`, timer); paint(); }
      if (act === 'ghost') { ghostOn = !ghostOn; paint(); }
      if (act === 'shoot') timer ? startCountdown() : shoot();
      if (act === 'retake') { captured = null; reviewImg.removeAttribute('src'); paint(); }
      if (act === 'mirror') review(flipCanvas(captured));
      if (act === 'use') finish(captured);
      if (act === 'restart') startStream();
      if (act === 'native') {
        const [file] = await pickFiles({ capture: facing });
        if (!file) return;
        try { const img = await loadImage(file); review(cropTo34(img, img.naturalWidth, img.naturalHeight)); }
        catch (err) { toast(err.message); }
      }
    });
    slider.addEventListener('input', () => { ghostOpacity = Number(slider.value); ghostOn = ghostOpacity > 0; pref.set('ghostOpacity', ghostOpacity); paint(); });

    paint();
    startStream();
  });
}

// =====================================================================
// Import from camera roll
// =====================================================================
export async function importPhotos({ onDone } = {}) {
  const files = await pickFiles({ multiple: true });
  if (!files.length) return;
  const angles = store.state.settings.angles;
  const defaultDate = store.lastPhotoDay();
  const today = todayKey();
  const rows = files.map((f, i) => ({ file: f, url: URL.createObjectURL(f), angle: angles[i % angles.length], date: defaultDate, mirror: false }));

  const angleOptions = (sel) => Object.entries(ANGLES)
    .map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(v.label)}</option>`).join('');

  const sheet = openSheet(`
    <h2 class="sheet-title">Import ${files.length} photo${files.length > 1 ? 's' : ''}</h2>
    <p class="sheet-text">Set the date each was taken and which angle it shows. Photos are cropped to the same 3:4 frame as in-app photos.</p>
    <div class="import-list">
      ${rows.map((r, i) => `
        <div class="import-row" data-i="${i}">
          <img src="${r.url}" alt="">
          <div class="import-fields">
            <label>Angle<select data-f="angle">${angleOptions(r.angle)}</select></label>
            <label>Date<input type="date" data-f="date" value="${r.date}" max="${today}"></label>
            <label class="check-row"><input type="checkbox" data-f="mirror"> Mirror</label>
          </div>
        </div>`).join('')}
    </div>
    <div class="sheet-actions">
      <button class="btn ghost" data-act="cancel">Cancel</button>
      <button class="btn primary" data-act="go">Import</button>
    </div>`, { onClose: () => rows.forEach((r) => URL.revokeObjectURL(r.url)) });

  sheet.el.addEventListener('change', (e) => {
    const row = e.target.closest('.import-row');
    if (!row) return;
    const r = rows[Number(row.dataset.i)];
    const f = e.target.dataset.f;
    r[f] = f === 'mirror' ? e.target.checked : e.target.value;
    if (f === 'mirror') row.querySelector('img').classList.toggle('mirror', r.mirror);
  });
  sheet.el.querySelector('[data-act=cancel]').addEventListener('click', sheet.close);
  sheet.el.querySelector('[data-act=go]').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (rows.some((r) => !r.date)) return toast('Every photo needs a date');
    btn.disabled = true;
    let n = 0;
    for (const r of rows) {
      btn.textContent = `Importing ${++n}/${rows.length}…`;
      try {
        const img = await loadImage(r.file);
        let c = cropTo34(img, img.naturalWidth, img.naturalHeight);
        if (r.mirror) c = flipCanvas(c);
        await store.addPhoto(await makePhotoRecord(c, r.date, r.angle));
      } catch (err) {
        toast(`Skipped one: ${err.message}`);
      }
    }
    sheet.close();
    toast(`Imported ${rows.length} photo${rows.length > 1 ? 's' : ''}`);
    onDone && onDone();
  });
}

// =====================================================================
// Impression sheet (one per week)
// =====================================================================
export function openImpression(week, { prompt = false, onSave, onClose } = {}) {
  const existing = store.state.impressions.get(week);
  let rating = existing?.rating || null;
  let saved = false;
  const s = store.start();
  const sheet = openSheet(`
    <h2 class="sheet-title">${prompt ? 'How’s it looking?' : `${weekLabel(week)} impression`}</h2>
    <p class="sheet-text">${weekLabel(week)} · ${esc(fmtShort(weekStart(s, week)))} – ${esc(fmtShort(weekEnd(s, week)))}. A quick gut check, compared to how things looked before.</p>
    <div class="rating-grid">
      ${RATINGS.map((r) => `<button class="rating ${r.cls} ${rating === r.value ? 'on' : ''}" data-v="${r.value}">${esc(r.label)}</button>`).join('')}
    </div>
    <textarea class="input" rows="3" maxlength="400" placeholder="e.g. temples look a bit fuller, or no change yet">${esc(existing?.text || '')}</textarea>
    <div class="sheet-actions">
      ${existing ? '<button class="btn ghost danger-text" data-act="delete">Delete</button>' : `<button class="btn ghost" data-act="skip">${prompt ? 'Skip' : 'Cancel'}</button>`}
      <button class="btn primary" data-act="save">Save</button>
    </div>`, { onClose: () => { if (!saved && onClose) onClose(); } });

  sheet.el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v) {
      rating = Number(b.dataset.v);
      sheet.el.querySelectorAll('.rating').forEach((x) => x.classList.toggle('on', x === b));
    }
    if (b.dataset.act === 'skip') sheet.close();
    if (b.dataset.act === 'delete') {
      await store.deleteImpression(week);
      saved = true; sheet.close(); toast('Impression deleted'); onSave && onSave();
    }
    if (b.dataset.act === 'save') {
      const text = sheet.el.querySelector('textarea').value;
      if (!rating && !text.trim()) return toast('Pick a rating or write a note');
      await store.setImpression(week, rating, text);
      saved = true; sheet.close(); toast('Impression saved'); onSave && onSave();
    }
  });
}
