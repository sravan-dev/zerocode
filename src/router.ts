import { AppConfig, RouteCandidate, Strategy } from './types';

interface HealthEntry {
  until: number;
  lastError: string;
}

export interface CandidateHealth {
  provider: string;
  model: string;
  key: string;
  state: 'healthy' | 'cooldown' | 'no-key';
  remainingMs?: number;
  lastError?: string;
}

export class Router {
  private health = new Map<string, HealthEntry>();
  private rrIndex = 0;

  key(c: RouteCandidate): string {
    return c.provider + '::' + c.model;
  }

  isAvailable(c: RouteCandidate, cfg: AppConfig): boolean {
    const p = cfg.providers.find((x) => x.id === c.provider);
    if (!p || !p.enabled) return false;
    if (p.type === 'custom') return true;
    return !!p.apiKey;
  }

  cooling(key: string): boolean {
    const h = this.health.get(key);
    return !!h && h.until > Date.now();
  }

  markFailure(c: RouteCandidate, extraCooldownMs: number, lastError: string, cfg: AppConfig): void {
    const ms = Math.max(cfg.cooldownMs, extraCooldownMs || 0);
    this.health.set(this.key(c), { until: Date.now() + ms, lastError: lastError.slice(0, 300) });
  }

  markSuccess(c: RouteCandidate): void {
    this.health.delete(this.key(c));
  }

  ordered(candidates: RouteCandidate[], strategy: Strategy): RouteCandidate[] {
    if (strategy !== 'round-robin' || candidates.length < 2) return candidates;
    const start = ((this.rrIndex % candidates.length) + candidates.length) % candidates.length;
    this.rrIndex++;
    return candidates.map((_, i) => candidates[(start + i) % candidates.length]);
  }

  resolve(model: string, cfg: AppConfig): { candidates: RouteCandidate[]; direct: boolean } {
    const chain = cfg.route;
    const m = (model || '').trim();
    if (!m || m === 'auto' || m === 'default' || m === 'token-route' || m === cfg.routeName) {
      return { candidates: chain, direct: false };
    }
    const slash = m.indexOf('/');
    if (slash > 0) {
      const pid = m.slice(0, slash);
      if (cfg.providers.some((p) => p.id === pid)) {
        return { candidates: [{ provider: pid, model: m.slice(slash + 1) }], direct: true };
      }
    }
    const exact = chain.find((c) => c.model === m);
    if (exact) return { candidates: [exact], direct: true };
    return { candidates: chain, direct: false };
  }

  healthView(cfg: AppConfig): CandidateHealth[] {
    return cfg.route.map((c) => {
      const key = this.key(c);
      if (!this.isAvailable(c, cfg)) {
        return { provider: c.provider, model: c.model, key, state: 'no-key' as const };
      }
      const h = this.health.get(key);
      if (h && h.until > Date.now()) {
        return { provider: c.provider, model: c.model, key, state: 'cooldown' as const, remainingMs: h.until - Date.now(), lastError: h.lastError };
      }
      return { provider: c.provider, model: c.model, key, state: 'healthy' as const, lastError: h?.lastError };
    });
  }
}
