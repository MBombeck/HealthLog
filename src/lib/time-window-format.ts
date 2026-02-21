export function formatTimeWindowPart(value: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return value;
  const hh = m[1].padStart(2, "0");
  const mm = m[2];
  return `${hh}:${mm}`;
}

export function formatTimeWindowRange(start: string, end: string): string {
  return `${formatTimeWindowPart(start)} bis ${formatTimeWindowPart(end)} Uhr`;
}
