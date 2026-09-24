# Token Route

Self-hosted, OpenAI-compatible AI gateway. Point any OpenAI client at it and it routes each request through a chain of free and cheap model providers, with automatic failover and cooldown when a provider fails or rate-limits.

- **Providers:** OpenRouter, Groq, OpenCode Zen, OpenCode Go, and any custom OpenAI-compatible endpoint (Ollama, LM Studio, Together, ...)
- **Routing:** `failover` (in order) or `round-robin`; failed candidates cool down and are skipped
- **Dashboard:** manage keys, browse and add models, reorder the route, request log, and a playground

## Run locally

Requires Node.js 18 or newer.

```bash
npm install
npm run dev        # http://127.0.0.1:3777
```

Clients use base URL `http://127.0.0.1:3777/v1` with model `auto` (walks the route) or `provider/model` (pins one model).

## Deploy with Docker (VPS / Coolify)

```bash
docker build -t token-route .
docker run -d --name token-route -p 3777:3777 \
  -v token-route-data:/data \
  -e TOKEN_ROUTE_PROXY_KEY='change-me-long-random-string' \
  --restart unless-stopped token-route
```

On **Coolify**: create a resource from this repo, choose the **Dockerfile** build pack, set port `3777`, add a persistent volume at `/data`, and set the `TOKEN_ROUTE_PROXY_KEY` environment variable.

**Always set `TOKEN_ROUTE_PROXY_KEY` on a public server.** Without it, anyone who finds the URL can spend your provider credits and change your settings. Clients send it as `Authorization: Bearer <key>` or `x-api-key: <key>`, and the dashboard asks for it on first load.

### Environment variables

| Variable | Default (Docker) | Purpose |
|---|---|---|
| `TOKEN_ROUTE_PROXY_KEY` | unset | Required API key for clients and the dashboard (applied if none is saved yet) |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `3777` | Listen port |
| `TOKEN_ROUTE_HOME` | `/data` | Where `config.json` is stored; mount a volume here |

Locally, you can put these in a `.env` file in the project root (see `.env.example`); it is loaded at startup and excluded from git and the Docker image.

## Data and security

Provider API keys are stored only in `TOKEN_ROUTE_HOME` (`data/` locally), which is excluded from git and from the Docker image.
