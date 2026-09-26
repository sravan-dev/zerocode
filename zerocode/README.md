# zerocode

A zero-code coding agent for your terminal that talks to a [Token Route](../README.md) gateway (or any OpenAI-compatible `/v1` API). It reads and edits files, runs shell commands, and streams replies — all from the command line. No build step, no dependencies, just Node 18+.

## Install

Nothing to compile. From the gateway repo:

```bash
cd zerocode
npm link          # puts `zerocode` on your PATH
```

Or run it directly without installing:

```bash
node zerocode/cli.js
```

## Use

Start the gateway first (`npm run dev` in the Token Route repo), then:

```bash
zerocode                              # interactive session against http://127.0.0.1:3777/v1
zerocode "add a --json flag to main.py"   # one-shot task, then drops into the session
zerocode --model groq/openai/gpt-oss-120b --yolo
```

The agent uses tools to do real work — reading files, listing directories, writing/editing files, and running commands. File writes, edits, and shell commands ask for approval (`y` / `N` / `a`=always) unless you pass `--yolo`.

## Options

| Option | Default | Purpose |
|---|---|---|
| `--url <url>` | `http://127.0.0.1:3777/v1` | Gateway base URL |
| `--key <key>` | env `TOKEN_ROUTE_PROXY_KEY` | Proxy API key |
| `--model <id>` | `auto` | `auto` walks the route, or pin `provider/model` |
| `--max-tokens <n>` | `4096` | Max output tokens per reply |
| `--yolo` | off | Auto-approve every write and command |

## Session commands

| Command | Action |
|---|---|
| `/model [id]` | show or switch model |
| `/models` | list models from the gateway |
| `/clear` | reset the conversation |
| `/yolo` | toggle auto-approve |
| `/cwd [dir]` | show or change working directory |
| `/save` | write current settings to `~/.zerocode.json` |
| `/help` | help |
| `/exit` | quit (or Ctrl+C twice) |

## Config file

`~/.zerocode.json` (chmod 600) is read at startup and written by `/save`:

```json
{
  "baseUrl": "http://127.0.0.1:3777/v1",
  "apiKey": "",
  "model": "auto",
  "maxTokens": 4096,
  "yolo": false
}
```

## Notes

- Uses OpenAI-style function calling. The model your route serves must support tool calls; if it doesn't, zerocode still chats but can't act on files.
- Reads are auto-approved; writes/edits/commands are gated. `node_modules` and `.git*` are hidden from `list_dir`.
- Files over 200 KB are truncated when read.
