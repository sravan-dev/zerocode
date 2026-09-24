export type ProviderType = 'openrouter' | 'groq' | 'github' | 'opencode' | 'custom';

export const PROVIDER_TYPES: ProviderType[] = ['openrouter', 'groq', 'github', 'opencode', 'custom'];

// Provider types that were removed; configs containing them are dropped on load.
export const REMOVED_PROVIDER_TYPES = ['gemini', 'antigravity'];

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
