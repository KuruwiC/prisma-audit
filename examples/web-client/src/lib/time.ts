const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });
const absolute = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'medium' });

export const timeAgo = (iso: string, now = Date.now()) => {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return Math.abs(seconds) < 10 ? 'just now' : relative.format(seconds, 'second');
};

export const fullTime = (iso: string) => absolute.format(new Date(iso));

export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
