// In-memory copy of everything in IndexedDB, plus the calculations the screens need.
import * as db from './db.js';
import { addDays, todayKey, weekNumber, weekStart, weekEnd, photoDayOfWeek, weekday } from './dates.js';
import { forgetPhotoUrls, ANGLES } from './ui.js';

export const DOSES = [
  { key: 'fin', label: 'Finasteride', icon: '💊', hint: 'Took my pill' },
  { key: 'minAM', label: 'Minoxidil · AM', icon: '💧', hint: 'Morning application' },
  { key: 'minPM', label: 'Minoxidil · PM', icon: '🌙', hint: 'Evening application' },
];

export const state = {
  settings: null,
  doses: new Map(), // date -> { date, fin, minAM, minPM } (ISO time or null)
  photos: [], // sorted by date, then createdAt
  impressions: new Map(), // week -> { week, rating, text, updatedAt }
};

const byDate = (a, b) => (a.date === b.date ? a.createdAt.localeCompare(b.createdAt) : a.date.localeCompare(b.date));

export async function load() {
  state.settings = await db.getSettings();
  await migrateSettings();
  state.doses = new Map((await db.getAll('doses')).map((d) => [d.date, d]));
  state.photos = (await db.getAll('photos')).sort(byDate);
  state.impressions = new Map((await db.getAll('impressions')).map((i) => [i.week, i]));
}

// Saved settings from before front-left/front-right existed: swap 'front' for the two new angles.
async function migrateSettings() {
  const s = state.settings;
  let angles = s.angles.filter((a) => ANGLES[a]);
  if (!s.splitFront) {
    angles = angles.flatMap((a) => (a === 'front' ? ['frontLeft', 'frontRight'] : [a]));
  }
  angles = Object.keys(ANGLES).filter((a) => angles.includes(a));
  if (!angles.length) angles = ['frontLeft', 'frontRight', 'crown'];
  if (!s.splitFront || angles.join() !== s.angles.join()) {
    state.settings = { ...s, angles, splitFront: true };
    await db.saveSettings(state.settings);
  }
}

/** Angles to show in Progress: the ones being tracked plus any older ones that have photos. */
export function shownAngles() {
  const have = new Set(state.photos.map((p) => p.angle));
  return Object.keys(ANGLES).filter((a) => state.settings.angles.includes(a) || have.has(a));
}
/** Angles for one week in the timeline: tracked ones plus any that have a photo that week. */
export function anglesForWeek(w) {
  const have = new Set(state.photos.filter((p) => photoWeek(p) === w).map((p) => p.angle));
  return Object.keys(ANGLES).filter((a) => state.settings.angles.includes(a) || have.has(a));
}

// ---------- settings ----------
export async function updateSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  await db.saveSettings(state.settings);
}
export const start = () => state.settings.startDate;
export const currentWeek = () => weekNumber(start(), todayKey());

// ---------- doses ----------
export const doseRecord = (date) => state.doses.get(date) || { date, fin: null, minAM: null, minPM: null };

export async function setDose(date, key, value) {
  const rec = { ...doseRecord(date), [key]: value };
  state.doses.set(date, rec);
  await db.put('doses', rec);
}

/** 0..3 doses logged on a date */
export function doseCount(date) {
  const r = state.doses.get(date);
  return r ? DOSES.filter((d) => r[d.key]).length : 0;
}

function streakFor(test) {
  const s = start();
  const today = todayKey();
  let best = 0;
  let run = 0;
  for (let d = s; d <= today; d = addDays(d, 1)) {
    if (test(d)) { run++; best = Math.max(best, run); }
    else if (d !== today) run = 0; // today isn't over yet, so it can't break a streak
  }
  return { current: run, best };
}

export function streaks() {
  return {
    all: streakFor((d) => doseCount(d) === 3),
    fin: streakFor((d) => !!doseRecord(d).fin),
    min: streakFor((d) => { const r = doseRecord(d); return !!(r.minAM && r.minPM); }),
  };
}

/** Doses taken vs possible between two dates (clipped to start..today). Today only counts what's logged. */
export function adherence(from = start(), to = todayKey()) {
  const today = todayKey();
  const a = from < start() ? start() : from;
  const b = to > today ? today : to;
  const out = { fin: [0, 0], min: [0, 0] };
  for (let d = a; d <= b; d = addDays(d, 1)) {
    const r = doseRecord(d);
    const past = d < today;
    if (r.fin) out.fin[0]++;
    if (r.fin || past) out.fin[1]++;
    for (const k of ['minAM', 'minPM']) {
      if (r[k]) out.min[0]++;
      if (r[k] || past) out.min[1]++;
    }
  }
  return out;
}
export const weekAdherence = (w) => adherence(weekStart(start(), w), weekEnd(start(), w));
export const pct = ([taken, possible]) => (possible ? Math.round((taken / possible) * 100) : null);

// ---------- photos ----------
export const photoWeek = (p) => weekNumber(start(), p.date);

/** Map week -> latest photo of that angle in the week. */
export function photosByWeek(angle) {
  const m = new Map();
  for (const p of state.photos) if (p.angle === angle) m.set(photoWeek(p), p);
  return m;
}
export const latestPhoto = (angle) => [...state.photos].reverse().find((p) => p.angle === angle) || null;
export const photosOnDate = (date) => state.photos.filter((p) => p.date === date);

export async function addPhoto(rec) {
  await db.put('photos', rec);
  state.photos.push(rec);
  state.photos.sort(byDate);
}
export async function deletePhoto(id) {
  await db.del('photos', id);
  state.photos = state.photos.filter((p) => p.id !== id);
  forgetPhotoUrls(id);
}

/** Most recent photo day on or before a date. */
export function lastPhotoDay(date = todayKey()) {
  let d = date;
  while (weekday(d) !== state.settings.photoWeekday) d = addDays(d, -1);
  return d;
}

/**
 * What the Today screen should say about photos this week:
 * { status: 'before' } | { status: 'upcoming', day } | { status: 'due', week, day, missing } | { status: 'done', week, day }
 */
export function photoStatus(date = todayKey()) {
  const w = weekNumber(start(), date);
  if (w < 1) return { status: 'before', day: start() };
  const day = photoDayOfWeek(start(), w, state.settings.photoWeekday);
  const missing = state.settings.angles.filter((a) => !state.photos.some((p) => p.angle === a && photoWeek(p) === w));
  if (!missing.length) return { status: 'done', week: w, day };
  if (date < day) return { status: 'upcoming', week: w, day };
  return { status: 'due', week: w, day, missing };
}

// ---------- impressions ----------
export async function setImpression(week, rating, text) {
  const rec = { week, rating, text: text.trim(), updatedAt: new Date().toISOString() };
  state.impressions.set(week, rec);
  await db.put('impressions', rec);
}
export async function deleteImpression(week) {
  state.impressions.delete(week);
  await db.del('impressions', week);
}

// ---------- backup ----------
const blobToDataUrl = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
const dataUrlToBlob = async (u) => (await fetch(u)).blob();

export async function exportBackup() {
  const photos = [];
  for (const p of state.photos) {
    photos.push({ id: p.id, date: p.date, angle: p.angle, createdAt: p.createdAt, blob: await blobToDataUrl(p.blob), thumb: await blobToDataUrl(p.thumb) });
  }
  const data = {
    app: 'hairline-tracker',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    doses: [...state.doses.values()],
    impressions: [...state.impressions.values()],
    photos,
  };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export async function importBackup(data) {
  if (data.app !== 'hairline-tracker') throw new Error("That file isn't a Hairline backup");
  if (data.settings) await updateSettings(data.settings);
  for (const d of data.doses || []) await db.put('doses', d);
  for (const i of data.impressions || []) await db.put('impressions', i);
  for (const p of data.photos || []) {
    await db.put('photos', { ...p, blob: await dataUrlToBlob(p.blob), thumb: await dataUrlToBlob(p.thumb) });
  }
  await load();
}

export async function eraseAll() {
  for (const s of ['doses', 'photos', 'impressions', 'kv']) await db.clear(s);
  state.photos.forEach((p) => forgetPhotoUrls(p.id));
  await load();
}
