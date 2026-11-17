export function adjacentTabId(ids: string[], closing: string, active: string): string {
  if (closing !== active) return active;
  const at = ids.indexOf(closing), remaining = ids.filter(id => id !== closing);
  return remaining[Math.min(Math.max(at, 0), remaining.length - 1)] || '';
}
export function shortcutTabId(ids: string[], active: string, key: string, shift = false): string {
  if (!ids.length) return '';
  if (key === 'Tab') return ids[(Math.max(0, ids.indexOf(active)) + (shift ? ids.length - 1 : 1)) % ids.length];
  const index = Number(key); return index === 9 ? ids[ids.length - 1] : ids[index - 1] || active;
}
