// Weekly photo session (live camera with ghost overlay), camera-roll import, and the impression sheet.
import { ANGLES, RATINGS, el, esc, toast, openSheet, cropTo34, flipCanvas, loadImage, makePhotoRecord, photoUrl, pickFiles, shareFiles } from './ui.js';
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
  const saved = [];
  await runCamera(list, async (angle, canvas) => {
    const rec = await makePhotoRecord(canvas, date, angle);
    await store.addPhoto(rec); // saved right away, so closing mid-session never loses a photo
    saved.push(rec);
  });
  if (!saved.length) { onDone && onDone(); return; }
  toast(saved.length === 1 ? 'Photo saved' : `${saved.length} photos saved`);
  const week = weekNumber(store.start(), date);
  const next = () => {
    if (week >= 1 && !store.state.impressions.has(week)) openImpression(week, { prompt: true, onSave: onDone, onClose: onDone });
    else onDone && onDone();
  };
  offerSaveCopies(saved, next);
}

/** Photos live inside the app; offer to also keep copies in the iPhone Photos app. */
export function offerSaveCopies(photos, then) {
  let done = false;
  const finish = () => { if (!done) { done = true; then && then(); } };
  const sheet = openSheet(`
    <h2 class="sheet-title">Keep a copy in Photos?</h2>
    <p class="sheet-text">Hairline stores photos inside the app. A copy in your Photos app means you still have them if the app is ever deleted. Tap <b>Save ${photos.length > 1 ? `${photos.length} Images` : 'Image'}</b> on the next screen.</p>
    <div class="sheet-actions">
      <button class="btn ghost" data-act="skip">Not now</button>
      <button class="btn primary" data-act="save">Save to Photos</button>
    </div>`, { onClose: finish });
  sheet.el.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'skip') sheet.close();
    if (act === 'save') {
      await shareFiles(photos.map((p) => new File([p.blob], `hairline-${p.date}-${p.angle}.jpg`, { type: 'image/jpeg' })));
      sheet.close();
    }
  });
}

/**
 * Full-screen camera for a list of angles. One camera stream for the whole session.
 * The preview is drawn on a single canvas (camera frame + ghost blended in), so nothing
 * is stacked on top of the <video> element; iOS can black out covered/mirrored video.
 * Calls onCapture(angle, canvas) for each accepted photo. Resolves when finished or closed.
 */
function runCamera(list, onCapture) {
  return new Promise((resolve) => {
    let idx = 0;
    let angle = list[0];
    let ghost = null; // photo record
    let ghostImage = null; // loaded <img>
    let ghostOpacity = pref.get('ghostOpacity', 0.3);
    let ghostOn = false;
    let facing = null;
    let timer = 0;
    let stream = null;
    let captured = null; // canvas being reviewed
    let countdown = null;
    let noFrameTimer = null;
    let raf = 0;
    let closed = false;

    const root = el(`
      <div class="cam">
        <div class="cam-top">
          <button class="cam-btn" data-act="close" aria-label="Close">✕</button>
          <div class="cam-title"><b class="cam-angle"></b><span class="cam-step"></span></div>
          <button class="cam-btn" data-act="flip" aria-label="Switch camera">
            <svg viewBox="0 0 24 24"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><path d="M9.5 13.5a2.5 2.5 0 0 0 4.6 1.3M14.5 12.5a2.5 2.5 0 0 0-4.6-1.3"/></svg>
          </button>
        </div>
        <div class="cam-frame">
          <video class="cam-video" playsinline muted autoplay></video>
          <canvas class="cam-canvas"></canvas>
          <svg class="cam-guides" viewBox="0 0 300 400" preserveAspectRatio="none"></svg>
          <div class="cam-count"></div>
          <div class="cam-msg"></div>
        </div>
        <div class="cam-tip"></div>
        <div class="cam-ghost-ctl">
          <span>Ghost</span><input type="range" min="0" max="0.8" step="0.05" value="${ghostOpacity}">
        </div>
        <div class="cam-controls live">
          <button class="cam-pill" data-act="timer"></button>
          <button class="shutter" data-act="shoot" aria-label="Take photo"><span></span></button>
          <button class="cam-pill" data-act="ghost"></button>
        </div>
        <div class="cam-controls review">
          <div class="cam-review-row">
            <button class="cam-pill" data-act="retake">Retake</button>
            <button class="cam-pill" data-act="mirror">Mirror ⇋</button>
            <button class="cam-pill" data-act="ghost"></button>
          </div>
          <button class="btn primary cam-use" data-act="use"></button>
        </div>
        <button class="cam-native" data-act="native">Camera not showing? Use the iPhone camera</button>
      </div>`);
    document.getElementById('overlay-root').appendChild(root);
    document.body.classList.add('no-scroll');

    const video = root.querySelector('video');
    const canvas = root.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const frameEl = root.querySelector('.cam-frame');
    const guides = root.querySelector('.cam-guides');
    const countEl = root.querySelector('.cam-count');
    const msgEl = root.querySelector('.cam-msg');
    const slider = root.querySelector('.cam-ghost-ctl input');
    video.muted = true;
    video.setAttribute('playsinline', '');

    // ---------- drawing ----------
    function sizeCanvas() {
      const w = frameEl.clientWidth || 300;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round((w * dpr * 4) / 3);
    }
    function draw() {
      if (closed) return;
      raf = requestAnimationFrame(draw);
      const W = canvas.width;
      const H = canvas.height;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, W, H);
      if (captured) {
        ctx.drawImage(captured, 0, 0, W, H);
      } else if (vw && vh) {
        // same 3:4 center crop the saved photo uses, so the preview matches the result
        let sw, sh, sx, sy;
        if (vw / vh > 0.75) { sh = vh; sw = vh * 0.75; sx = (vw - sw) / 2; sy = 0; }
        else { sw = vw; sh = vw / 0.75; sx = 0; sy = (vh - sh) / 2; }
        ctx.save();
        if (facing === 'user') { ctx.translate(W, 0); ctx.scale(-1, 1); }
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
        ctx.restore();
      }
      if (ghostOn && ghostOpacity > 0 && ghostImage && ghostImage.naturalWidth) {
        ctx.globalAlpha = ghostOpacity;
        ctx.drawImage(ghostImage, 0, 0, W, H);
        ctx.globalAlpha = 1;
      }
    }

    // ---------- camera stream ----------
    async function startStream() {
      stopStream();
      clearTimeout(noFrameTimer);
      msgEl.innerHTML = '';
      if (!navigator.mediaDevices?.getUserMedia) return showMsg('This browser can’t open the camera directly.', 'native', 'Use iPhone camera');
      const want = facing;
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: want }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          });
        } catch (e) {
          if (e.name === 'NotAllowedError') throw e;
          try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: want } }); }
          catch (e2) {
            if (e2.name === 'NotAllowedError') throw e2;
            stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true }); // any camera at all
          }
        }
        if (closed || want !== facing) { stream.getTracks().forEach((t) => t.stop()); return; }
        stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => {
          if (!closed && !captured) showMsg('The camera stopped.', 'restart', 'Restart camera');
        }));
        video.srcObject = stream;
        try { await video.play(); }
        catch { showMsg('Tap to start the camera.', 'play', 'Start camera'); }
        noFrameTimer = setTimeout(() => {
          if (!closed && !captured && !video.videoWidth) showMsg('The camera isn’t showing a picture.', 'restart', 'Restart camera');
        }, 4000);
      } catch (e) {
        showMsg(e.name === 'NotAllowedError'
          ? 'Camera access is off for Hairline. Turn it on in the iPhone Settings app › Safari › Camera (Ask or Allow), then reopen Hairline. Or use the iPhone camera.'
          : `Couldn’t start the camera (${e.name || e.message}).`, 'native', 'Use iPhone camera');
      }
    }
    function stopStream() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      video.srcObject = null;
    }
    function showMsg(text, act, label) {
      msgEl.innerHTML = `<p>${esc(text)}</p><button class="btn primary" data-act="${act}">${esc(label)}</button>`;
    }

    // ---------- per-angle state ----------
    function setAngle(i) {
      idx = i;
      angle = list[i];
      const info = ANGLES[angle];
      ghost = store.latestPhoto(angle);
      ghostImage = null;
      if (ghost) { const g = new Image(); g.src = photoUrl(ghost, 'blob'); ghostImage = g; }
      ghostOn = !!ghost && ghostOpacity > 0;
      timer = pref.get(`timer:${angle}`, angle === 'crown' ? 10 : 0);
      captured = null;
      root.querySelector('.cam-angle').textContent = info.label;
      root.querySelector('.cam-step').textContent = list.length > 1 ? `${i + 1} of ${list.length}` : '';
      root.querySelector('.cam-tip').innerHTML = `${esc(info.tip)}${ghost ? `<br><span class="muted">Ghost: ${esc(fmt(ghost.date))}. Line yourself up with it.</span>` : ''}`;
      root.querySelector('.cam-use').textContent = i + 1 < list.length ? 'Next' : 'Use photo';
      guides.innerHTML = angle === 'crown'
        ? '<circle cx="150" cy="190" r="95" />'
        : '<line x1="30" y1="120" x2="270" y2="120" /><line class="dash" x1="30" y1="210" x2="270" y2="210" /><line x1="150" y1="40" x2="150" y2="360" class="faint" />';
      const wantFacing = pref.get(`facing:${angle}`, 'user');
      if (wantFacing !== facing || !stream) { facing = wantFacing; startStream(); }
      paint();
    }

    function paint() {
      root.querySelectorAll('[data-act=ghost]').forEach((b) => {
        b.textContent = ghostOn ? 'Ghost on' : 'Ghost off';
        b.disabled = !ghost;
      });
      root.querySelector('[data-act=timer]').textContent = timer ? `⏱ ${timer}s` : '⏱ Off';
      root.querySelector('.cam-ghost-ctl').hidden = !ghost || !!captured;
      slider.value = ghostOpacity;
      root.classList.toggle('reviewing', !!captured);
    }

    function review(c) {
      captured = c;
      ghostOn = false; // show the photo clean; tap Ghost to check alignment
      clearInterval(countdown); countdown = null; countEl.textContent = '';
      msgEl.innerHTML = '';
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

    function finish() {
      closed = true;
      cancelAnimationFrame(raf);
      clearInterval(countdown);
      clearTimeout(noFrameTimer);
      stopStream();
      window.removeEventListener('resize', sizeCanvas);
      document.removeEventListener('visibilitychange', onVisible);
      document.body.classList.remove('no-scroll');
      root.remove();
      resolve();
    }

    // iOS stops the camera when the app is backgrounded; restart it on return.
    function onVisible() {
      if (document.visibilityState !== 'visible' || closed || captured) return;
      const live = stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
      if (!live) startStream();
    }

    let busy = false;
    root.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act || busy) return;
      if (act === 'close') finish();
      if (act === 'flip') { facing = facing === 'user' ? 'environment' : 'user'; pref.set(`facing:${angle}`, facing); captured = null; paint(); startStream(); }
      if (act === 'timer') { timer = timer === 0 ? 3 : timer === 3 ? 10 : 0; pref.set(`timer:${angle}`, timer); paint(); }
      if (act === 'ghost') { if (ghostOpacity === 0) { ghostOpacity = 0.3; pref.set('ghostOpacity', 0.3); } ghostOn = !ghostOn; paint(); }
      if (act === 'shoot') timer ? startCountdown() : shoot();
      if (act === 'retake') { captured = null; ghostOn = !!ghost && ghostOpacity > 0; paint(); if (!stream) startStream(); }
      if (act === 'mirror') review(flipCanvas(captured));
      if (act === 'restart') startStream();
      if (act === 'play') { msgEl.innerHTML = ''; video.play().catch(() => startStream()); }
      if (act === 'use') {
        busy = true;
        const useBtn = root.querySelector('.cam-use');
        const label = useBtn.textContent;
        useBtn.textContent = 'Saving…';
        useBtn.disabled = true;
        try { await onCapture(angle, captured); }
        catch (err) { toast(`Couldn’t save: ${err.message}`); return; }
        finally { busy = false; useBtn.textContent = label; useBtn.disabled = false; }
        if (idx + 1 < list.length) setAngle(idx + 1);
        else finish();
      }
      if (act === 'native') {
        const [file] = await pickFiles({ capture: facing === 'environment' ? 'environment' : 'user' });
        if (!file) return;
        try { const img = await loadImage(file); review(cropTo34(img, img.naturalWidth, img.naturalHeight)); }
        catch (err) { toast(err.message); }
      }
    });
    slider.addEventListener('input', () => {
      ghostOpacity = Number(slider.value);
      ghostOn = ghostOpacity > 0;
      pref.set('ghostOpacity', ghostOpacity);
      paint();
    });
    window.addEventListener('resize', sizeCanvas);
    document.addEventListener('visibilitychange', onVisible);

    sizeCanvas();
    setAngle(0);
    draw();
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
