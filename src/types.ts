export type ProviderType = 'openrouter' | 'groq' | 'github' | 'opencode' | 'aihubmix' | 'antigravity' | 'custom';

export const PROVIDER_TYPES: ProviderType[] = ['openrouter', 'groq', 'github', 'opencode', 'aihubmix', 'antigravity', 'custom'];

// Gemini's API-key connector was removed; Antigravity is an OAuth-backed connector.
export const REMOVED_PROVIDER_TYPES = ['gemini'];

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}

export interface RouteCandidate {
  provider: string;
  model: string;
  /** false = kept on the route but skipped by auto routing and hidden from /v1/models. Absent means enabled. */
  enabled?: boolean;
}

export type Strategy = 'failover' | 'round-robin';

export interface AppConfig {
  port: number;
  host: string;
  proxyKey: string | null;
  strategy: Strategy;
  cooldownMs: number;
  requestTimeoutMs: number;
  routeName: string;
  route: RouteCandidate[];
  providers: ProviderConfig[];
}
