/** Dates as the store sees them: a calendar day is 'YYYY-MM-DD' in the device's time zone. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => n.toString().padStart(2, '0');

export function localDay(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const d = parseDay(day);
  return localDay(d) === day;
}

/** Midnight at the start of the day, local time. */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map((part) => parseInt(part, 10));
  return new Date(y, m - 1, d);
}

export function addDays(day: string, days: number): string {
  const d = parseDay(day);
  d.setDate(d.getDate() + days);
  return localDay(d);
}

/** Every day from `from` to `to`, both included. */
export function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

/** "Oct 12" */
export function formatDay(day: string): string {
  const d = parseDay(day);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** "Oct 12, 2026 3:45 PM" in the device's time zone. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const hours = d.getHours() % 12 || 12;
  const suffix = d.getHours() < 12 ? 'AM' : 'PM';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${hours}:${pad(d.getMinutes())} ${suffix}`;
}

/** "3:45 PM" */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  const hours = d.getHours() % 12 || 12;
  return `${hours}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
