# ZeroCode

Self-hosted, OpenAI-compatible AI gateway. Point any OpenAI client at it and it routes each request through a chain of free and cheap model providers, with automatic failover and cooldown when a provider fails or rate-limits.

- **Providers:** OpenRouter, Groq, OpenCode Zen/Go, Google Antigravity, and any custom OpenAI-compatible endpoint (Ollama, LM Studio, Together, ...)
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
docker build -t zerocode .
docker run -d --name zerocode -p 3777:3777 \
  -v zerocode-data:/data \
  -e ZEROCODE_PROXY_KEY='change-me-long-random-string' \
  --restart unless-stopped zerocode
```

On **Coolify**: create a resource from this repo, choose the **Dockerfile** build pack, set port `3777`, add a persistent volume at `/data`, and set the `ZEROCODE_PROXY_KEY` environment variable.

**Always set `ZEROCODE_PROXY_KEY` on a public server.** Without it, anyone who finds the URL can spend your provider credits and change your settings. Clients send it as `Authorization: Bearer <key>` or `x-api-key: <key>`, and the dashboard asks for it on first load.

### Environment variables

| Variable | Default (Docker) | Purpose |
|---|---|---|
| `ZEROCODE_PROXY_KEY` | unset | Required API key for clients and the dashboard (applied if none is saved yet) |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `3777` | Listen port |
| `ZEROCODE_HOME` | `/data` | Where `config.json` is stored; mount a volume here |
| `GOOGLE_OAUTH_CLIENT_ID` | unset | Optional Google OAuth client ID for Antigravity |
| `GOOGLE_OAUTH_CLIENT_SECRET` | unset | Optional Google OAuth client secret for Antigravity |
| `GOOGLE_CLOUD_PROJECT` | unset | Optional existing Cloud project for Code Assist accounts that require one |
| `MONGODB_URI` | unset | Turns on user accounts (sign-in page, per-user chat history, `/manage` admin portal), e.g. `mongodb://mongo:27017/zerocode`. Without it ZeroCode runs single-user. |
| `SUPER_ADMIN_EMAILS` | unset | Comma-separated emails that always get the admin role once the email is verified (first **Continue with Google** sign-in). Registering the email with a password alone does not grant admin. |
| `PUBLIC_URL` | unset | Public base URL for hosted deployments; Google sign-in redirects to `<PUBLIC_URL>/oauth2callback` instead of `http://localhost:<PORT>/oauth2callback` |

Locally, you can put these in a `.env` file in the project root (see `.env.example`); it is loaded at startup and excluded from git and the Docker image.

### User accounts

With `MONGODB_URI` set, ZeroCode becomes a multi-user app:

- `/login` offers email + password sign-in, registration, and **Continue with Google**. Google sign-in reuses the OAuth client saved for the Antigravity connector (scopes `openid email profile` only); add `<PUBLIC_URL>/auth/google/callback` as an authorized redirect URI on that client.
- Signed-in users get a minimal chat: model picker, chat and history. Their chats are stored in MongoDB, not the browser.
- Admins (anyone listed in `SUPER_ADMIN_EMAILS`, or promoted by an admin) also see Connectors, Models, Gateway, Projects and Templates, plus **Users** at `/manage`, where they can create, promote, disable, reset or delete accounts.
- `/v1` accepts either a signed-in session or the `ZEROCODE_PROXY_KEY`, so editors and scripts keep working with the key.

### Google Antigravity connector

Antigravity uses Google sign-in and Google's Code Assist API rather than a normal provider API key. In Zero Code, open **Connectors → Google Antigravity**, enter the OAuth client ID and secret, and choose **Save OAuth settings**. You can also set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the server environment. Its model list is discovered from the signed-in account, so it stays current with models available to that account. If Google Code Assist asks for an existing project, set `GOOGLE_CLOUD_PROJECT` and restart.

The OAuth callback is `http://localhost:<PORT>/oauth2callback` (default port `3777`). For a remote install, complete Google sign-in in your browser, copy the full callback URL from the address bar, and paste it into the connector's **Remote sign-in callback URL** field. OAuth client settings and refresh credentials are stored as separate JSON files in the ZeroCode data directory with owner-only file permissions.

## Data and security

Provider API keys and Google OAuth client/refresh credentials are stored only in `ZEROCODE_HOME` (`data/` locally), which is excluded from git and from the Docker image.
