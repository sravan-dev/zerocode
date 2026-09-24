import { AppConfig } from './types';
import { applyPartial, configPath, loadConfig, saveConfig, VERSION } from './config';
import { Router } from './router';
import { LogStore } from './logs';
import { createApp } from './server';

function loadDotEnv() {
  const loader = (process as any).loadEnvFile;
  if (typeof loader !== 'function') return;
  try {
    loader.call(process, '.env');
  } catch {
    // no .env file - rely on real environment variables
  }
}

function main() {
  const major = Number((process.versions.node.split('.')[0] || '0'));
  if (!Number.isFinite(major) || major < 18) {
    console.error('Token Route requires Node.js 18 or newer.');
    process.exit(1);
  }
  loadDotEnv();

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
    console.log(`  TOKEN ROUTE v${VERSION}  -  local AI gateway`);
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
