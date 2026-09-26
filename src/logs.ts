export interface LogEntry {
  id: number;
  ts: number;
  requested: string;
  /** Email of the signed-in user, when the request came from the web app. */
  user?: string;
  servedBy?: string;
  candidate?: string;
  provider?: string;
  strategy: string;
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  ttftMs?: number;
  stream: boolean;
  tokensIn?: number;
  tokensOut?: number;
  attempts?: number;
  error?: string;
}

export interface StatBucket {
  label: string;
  requests: number;
  ok: number;
  failed: number;
  latencySum: number;
  tokensIn: number;
  tokensOut: number;
  lastError?: string;
  lastUsedAt?: number;
}

interface Totals {
  requests: number;
  ok: number;
  failed: number;
  latencySum: number;
  tokensIn: number;
  tokensOut: number;
}

function emptyBucket(label: string): StatBucket {
  return { label, requests: 0, ok: 0, failed: 0, latencySum: 0, tokensIn: 0, tokensOut: 0 };
}

function bump(b: StatBucket, e: LogEntry): void {
  b.requests++;
  if (e.ok) b.ok++;
  else b.failed++;
  b.latencySum += e.latencyMs || 0;
  b.tokensIn += e.tokensIn || 0;
  b.tokensOut += e.tokensOut || 0;
  if (!e.ok && e.error) b.lastError = e.error;
  b.lastUsedAt = e.ts;
}

export class LogStore {
  private entries: LogEntry[] = [];
  private nextId = 1;
  private readonly max = 500;
  private totals: Totals = { requests: 0, ok: 0, failed: 0, latencySum: 0, tokensIn: 0, tokensOut: 0 };
  private perCandidate = new Map<string, StatBucket>();
  private perModel = new Map<string, StatBucket>();

  add(e: Omit<LogEntry, 'id'>): void {
    const entry: LogEntry = { ...e, id: this.nextId++ };
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.totals.requests++;
    if (entry.ok) this.totals.ok++;
    else this.totals.failed++;
    this.totals.latencySum += entry.latencyMs || 0;
    this.totals.tokensIn += entry.tokensIn || 0;
    this.totals.tokensOut += entry.tokensOut || 0;
    if (entry.candidate) {
      const k = entry.candidate;
      let b = this.perCandidate.get(k);
      if (!b) {
        b = emptyBucket(entry.servedBy || k);
        this.perCandidate.set(k, b);
      }
      b.label = entry.servedBy || b.label;
      bump(b, entry);
    }
    if (entry.requested) {
      let b = this.perModel.get(entry.requested);
      if (!b) {
        b = emptyBucket(entry.requested);
        this.perModel.set(entry.requested, b);
      }
      bump(b, entry);
    }
  }

  recent(limit = 100): LogEntry[] {
    return this.entries.slice(-Math.min(limit, this.max)).reverse();
  }

  clear(): void {
    this.entries = [];
    this.totals = { requests: 0, ok: 0, failed: 0, latencySum: 0, tokensIn: 0, tokensOut: 0 };
    this.perCandidate.clear();
    this.perModel.clear();
  }

  stats() {
    const t = this.totals;
    const fmt = (b: StatBucket) => ({
      label: b.label,
      requests: b.requests,
      ok: b.ok,
      failed: b.failed,
      avgLatencyMs: b.requests ? Math.round(b.latencySum / b.requests) : 0,
      tokensIn: b.tokensIn,
      tokensOut: b.tokensOut,
      lastError: b.lastError,
      lastUsedAt: b.lastUsedAt
    });
    return {
      totals: {
        requests: t.requests,
        ok: t.ok,
        failed: t.failed,
        avgLatencyMs: t.requests ? Math.round(t.latencySum / t.requests) : 0,
        tokensIn: t.tokensIn,
        tokensOut: t.tokensOut
      },
      candidates: Array.from(this.perCandidate.values()).map(fmt),
      models: Array.from(this.perModel.values()).map(fmt)
    };
  }
}
