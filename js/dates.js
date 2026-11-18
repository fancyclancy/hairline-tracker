// Dates are stored as local "YYYY-MM-DD" keys so a day never shifts with time zones.
const pad = (n) => String(n).padStart(2, '0');

export const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
export const todayKey = () => toKey(new Date());
export const addDays = (k, n) => { const d = fromKey(k); d.setDate(d.getDate() + n); return toKey(d); };
/** whole days from a to b (b - a) */
export const diffDays = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000);
export const weekday = (k) => fromKey(k).getDay();

/** Day 1 is the start date. */
export const dayNumber = (start, k) => diffDays(start, k) + 1;
/** Week 1 is the 7 days starting on the start date. Days before start are Week 0 or less. */
export const weekNumber = (start, k) => Math.floor(diffDays(start, k) / 7) + 1;
export const weekStart = (start, w) => addDays(start, (w - 1) * 7);
export const weekEnd = (start, w) => addDays(start, (w - 1) * 7 + 6);
/** The photo day (e.g. Sunday) that falls inside week w. */
export const photoDayOfWeek = (start, w, photoWeekday) => {
  const ws = weekStart(start, w);
  return addDays(ws, (photoWeekday - weekday(ws) + 7) % 7);
};

export const fmt = (k, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  fromKey(k).toLocaleDateString(undefined, opts);
export const fmtShort = (k) => fmt(k, { month: 'short', day: 'numeric' });
export const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const weekLabel = (w) => (w <= 0 ? 'Before start' : `Week ${w}`);

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
