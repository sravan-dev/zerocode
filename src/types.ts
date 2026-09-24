export type ProviderType = 'openrouter' | 'groq' | 'gemini' | 'github' | 'antigravity' | 'opencode' | 'custom';

export const PROVIDER_TYPES: ProviderType[] = ['openrouter', 'groq', 'gemini', 'github', 'antigravity', 'opencode', 'custom'];

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
