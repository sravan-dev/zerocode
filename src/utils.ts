export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 10) return '\u2022\u2022\u2022\u2022';
  return key.slice(0, 5) + '\u2026' + key.slice(-4);
}

export function retryAfterMs(res: any): number {
  const ra = res.headers?.get?.('retry-after');
  if (!ra) return 0;
  const s = Number(ra);
  if (!Number.isNaN(s) && s >= 0) return s * 1000;
  const d = Date.parse(ra);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return 0;
}
