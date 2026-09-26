import { AppConfig, RouteCandidate, Strategy } from './types';
import { isAuthenticated } from './google-auth';

interface HealthEntry {
  until: number;
  lastError: string;
}

export interface CandidateHealth {
  provider: string;
  model: string;
  key: string;
  state: 'healthy' | 'cooldown' | 'no-key';
  /** false when the model is switched off on the route; state still reflects its real health. */
  enabled: boolean;
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
    return c.enabled !== false && this.providerReady(c, cfg);
  }

  /** Provider exists, is on, and has a key (custom endpoints may run without one). */
  providerReady(c: RouteCandidate, cfg: AppConfig): boolean {
    const p = cfg.providers.find((x) => x.id === c.provider);
    if (!p || !p.enabled) return false;
    if (p.type === 'antigravity' || p.id === 'antigravity') return isAuthenticated();
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

  /**
   * Candidates to try, in order. A pinned model goes first, followed by the rest of the
   * route so a cooling or failing pin still lands on a healthy model. `strict` keeps only
   * the pin, for health tests that must not be answered by another model.
   */
  resolve(model: string, cfg: AppConfig, strict = false): { candidates: RouteCandidate[]; pinned?: RouteCandidate } {
    const chain = cfg.route;
    const m = (model || '').trim();
    let pinned: RouteCandidate | undefined;
    if (m && m !== 'auto' && m !== 'default' && m !== 'zerocode' && m !== cfg.routeName) {
      const slash = m.indexOf('/');
      const pid = slash > 0 ? m.slice(0, slash) : '';
      if (pid && cfg.providers.some((p) => p.id === pid)) {
        // A provider-qualified id bypasses the route's on/off switch.
        pinned = { provider: pid, model: m.slice(slash + 1) };
      } else {
        pinned = chain.find((c) => c.model === m);
      }
    }
    if (!pinned) return { candidates: this.ordered(chain, cfg.strategy) };
    if (strict) return { candidates: [pinned], pinned };
    const pinKey = this.key(pinned);
    return { candidates: [pinned, ...this.ordered(chain.filter((c) => this.key(c) !== pinKey), cfg.strategy)], pinned };
  }

  healthView(cfg: AppConfig): CandidateHealth[] {
    return cfg.route.map((c) => {
      const key = this.key(c);
      const enabled = c.enabled !== false;
      if (!this.providerReady(c, cfg)) {
        return { provider: c.provider, model: c.model, key, enabled, state: 'no-key' as const };
      }
      const h = this.health.get(key);
      if (h && h.until > Date.now()) {
        return { provider: c.provider, model: c.model, key, enabled, state: 'cooldown' as const, remainingMs: h.until - Date.now(), lastError: h.lastError };
      }
      return { provider: c.provider, model: c.model, key, enabled, state: 'healthy' as const, lastError: h?.lastError };
    });
  }
}
