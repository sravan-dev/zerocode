import { AppConfig } from './types';
import { applyPartial, configPath, loadConfig, saveConfig, VERSION } from './config';
import { Router } from './router';
import { LogStore } from './logs';
import { createApp } from './server';
import { closeDb, connectDb, dbEnabled } from './db';

function loadDotEnv() {
  const loader = (process as any).loadEnvFile;
  if (typeof loader !== 'function') return;
  try {
    loader.call(process, '.env');
  } catch {
    // no .env file - rely on real environment variables
  }
}

/** MongoDB may still be starting (docker compose), so retry for about a minute. */
async function connectWithRetry(): Promise<void> {
  if (!dbEnabled()) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await connectDb();
      console.log('  Database  : connected (accounts enabled)');
      return;
    } catch (e: any) {
      if (attempt >= 30) throw e;
      console.log(`  Database  : not ready (${String(e?.message || e).slice(0, 80)}), retrying…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const major = Number((process.versions.node.split('.')[0] || '0'));
  if (!Number.isFinite(major) || major < 18) {
    console.error('ZeroCode requires Node.js 18 or newer.');
    process.exit(1);
  }
  loadDotEnv();
  await connectWithRetry();

  const liveCfg: AppConfig = loadConfig();
  saveConfig(liveCfg);

  const logs = new LogStore();
  const router = new Router();
  const startedAt = Date.now();

  function updateConfig(partial: any): { restartRequired: boolean } {
    const result = applyPartial(liveCfg, partial);
    saveConfig(liveCfg);
    return result;
  }

  const app = createApp({ getConfig: () => liveCfg, updateConfig, router, logs, startedAt });

  const server = app.listen(liveCfg.port, liveCfg.host, () => {
    const anyKey = liveCfg.providers.some((p) => p.apiKey);
    const line = '\u2500'.repeat(52);
    console.log('');
    console.log(line);
    console.log(`  ZEROCODE v${VERSION}  -  local AI gateway`);
    console.log(line);
    console.log(`  Dashboard : http://${liveCfg.host}:${liveCfg.port}`);
    console.log(`  API base  : http://${liveCfg.host}:${liveCfg.port}/v1   (OpenAI-compatible)`);
    console.log(`  Config    : ${configPath()}`);
    console.log(line);
    if (!anyKey) {
      console.log('  No provider keys configured yet.');
      console.log('  Open the dashboard -> Providers, paste a free API key');
      console.log('  (Groq / OpenRouter / OpenCode).');
      console.log(line);
    }
    console.log('  Model "auto" (or your route alias) routes through the chain.');
    console.log('');
  });

  const shutdown = () => {
    server.close(() => { closeDb().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('ZeroCode failed to start:', e);
  process.exit(1);
});
