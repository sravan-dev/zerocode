# tkroll

A chat panel for VS Code that talks to your [ZeroCode](https://github.com/sravan-dev/token-route) gateway, or to any OpenAI-compatible API.

## Features

- **Model switcher** at the top of the panel, filled from the gateway's `/v1/models`. `auto` lets ZeroCode walk its route chain; `provider/model` pins one model. The choice is remembered per workspace.
- **Mentions:** type `@` to attach workspace files (fuzzy search, open tabs first), the **Current file**, or the editor **Selection**. File contents are sent with your message.
- **Images:** paste with Ctrl+V, drag in, or use the camera button. Images are sent as vision input. A **vision** badge marks models likely to accept images, and you get a warning when the selected model probably doesn't.
- **Streaming replies** with markdown, collapsible "thinking" for reasoning models, and **Copy** / **Insert** buttons on every code block (Insert replaces the current selection or inserts at the cursor).
- Shows which model actually served each reply (`via groq/...`) and its token usage.
- **Stop** a reply mid-stream; history is kept per workspace.
- Right-click a file in the Explorer and choose **Add File to Chat**, or select code and press **Ctrl+Shift+L** (**Cmd+Shift+L** on macOS).

## Setup

1. Run ZeroCode (`npm run dev` in the gateway repo, or your deployed URL).
2. Open the **tkroll** icon in the Activity Bar.
3. If the gateway uses a proxy key, click the key icon in the panel title (or run **tkroll: Set Gateway API Key**). It's stored in VS Code's encrypted secret storage.
4. For a remote gateway, set `tkroll.baseUrl`, for example `https://token.example.com/v1`.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `tkroll.baseUrl` | `http://127.0.0.1:3777/v1` | Gateway base URL |
| `tkroll.defaultModel` | `auto` | Model for new workspaces |
| `tkroll.maxTokens` | `2048` | Max output tokens per reply |
| `tkroll.systemPrompt` | coding assistant prompt | Sent with every chat |
| `tkroll.maxFileBytes` | `200000` | Mentioned files larger than this are truncated |

## Build

```bash
npm install
npm run compile
npm run package   # produces tkroll-<version>.vsix
code --install-extension tkroll-0.1.0.vsix
```
