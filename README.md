# pi-acp

pi in your editor. Your providers, your skills, your extensions — everything stays exactly where you configured it; you just get a better seat.

`pi-acp` is an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/overview/introduction) adapter: it lets ACP clients like [Zed](https://zed.dev) drive your local [pi](https://github.com/earendil-works/pi). You get streaming replies and thinking, live tool calls with diffs, images, and clickable file references — and since every ACP session is a plain `pi` session underneath, you can list, load, resume, or delete it later from anywhere. Pick models and thinking levels from your client's usual session controls; Bun, if you have it, gets used automatically.

The adapter is a translator with no opinions: it doesn't rewrite your system prompt, doesn't hold your credentials, and doesn't ship anything anywhere. Features are negotiated per client, so it works beyond Zed — standard ACP content is the fallback.

## Quick start

### 1. Install and configure pi

You need **Node.js 22.19.0 or newer** and **pi 1.2.0 or newer** on your `PATH`. Bun is optional.

```bash
npm install -g @earendil-works/pi-coding-agent
pi
```

Log in and configure providers in pi before connecting your editor.

### 2. Build and link the adapter

```bash
git clone https://github.com/regadas/pi-acp.git
cd pi-acp
npm ci
npm run build
npm link
```

> **From this repository, for now.** This fork isn't on npm or in the ACP Registry; the unscoped `pi-acp` package installs the upstream project. Future releases will use `@regadas/pi-acp`.

### 3. Connect your editor

In [Zed's settings](https://zed.dev/docs/agents/external-agents/), add a custom agent:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Open the agent panel, pick **pi**, and talk to it. Other ACP clients: run `pi-acp` as a stdio agent (or skip `npm link` and point `node` at `dist/index.js`).

## Everyday commands

Pi advertises its own skills, prompt templates, and extension commands when it has them. The adapter adds a few:

| Command                        | What it does                                                |
| ------------------------------ | ----------------------------------------------------------- |
| `/compact [instructions...]`   | Compact the conversation, optionally with your instructions |
| `/autocompact on\|off\|toggle` | Control automatic compaction                                |
| `/export`                      | Save the session as HTML in the project directory           |
| `/session`                     | Show messages, tokens, cost, and the session file           |
| `/name <name>`                 | Give the session a recognizable name                        |
| `/steering` and `/follow-up`   | Get or set pi's queue delivery modes                        |

`/model` and `/thinking` point you at your client's session controls. `/clear` isn't a thing here — start a new session instead.

## Configuration

Credentials and pi settings stay in pi (`~/.pi/agent`); adapter state lives in `~/.pi/pi-acp`. The knobs:

| Environment variable          | Purpose                                                                     |
| ----------------------------- | --------------------------------------------------------------------------- |
| `PI_ACP_DIR`                  | Override the adapter's state directory                                      |
| `PI_CODING_AGENT_DIR`         | Override pi's settings, sessions, prompts, extensions, and skills directory |
| `PI_CODING_AGENT_SESSION_DIR` | Choose a custom pi session directory                                        |
| `PI_ACP_PI_COMMAND`           | Use an explicit pi command instead of automatic executable resolution       |

Clients that can host a terminal can walk you through `pi login` interactively; or do it yourself:

```bash
pi-acp --terminal-login
```

Path resolution, auth negotiation, and runtime details: [adapter reference](docs/adapter-reference.md).

## The fine print

Boring but true:

- **Local, not sandboxed.** pi reads files and runs commands on your machine, like always. The adapter doesn't add filesystem or terminal delegation.
- **Extra workspace roots are for instructions, not access.** Each additional root contributes its `AGENTS.md`-family instruction file (first match, pi's precedence) as a labeled system-prompt section — nothing else. No filesystem grants, no settings or extensions from those roots, and changing the root list restarts pi (cancelling any running turn).
- **No client-mounted MCP.** ACP `mcpServers` requests are rejected; servers configured inside pi work as usual. This gap means the adapter is **not fully ACP v1 conformant** — see the [compatibility audit](docs/acp-compatibility-audit.md).
- **One writer per session.** Don't drive the same session from two clients at once.
- **Delegated runs stay in the conversation.** Required subagent runs hold the turn open until they deliver (plus one more model cycle); `acp_detach` opts out for fire-and-forget work.

## Development

```bash
npm ci
npm run dev          # run from source
npm run validate     # formatting, types, lint, tests, and build
npm run smoke        # isolated stdio lifecycle check; no provider traffic
npm run eval:acp     # real pi with a deterministic local provider
```

ACP protocol handling lives in `src/acp/`; the pi subprocess side lives in `src/pi-rpc/` (one `pi --mode rpc` per session). Manual probes and their credential requirements are in the [reference](docs/adapter-reference.md#auxiliary-manual-probes).

## License and origin

[MIT](LICENSE). An independently maintained fork of [svkozak/pi-acp](https://github.com/svkozak/pi-acp), keeping the original history, copyright, and license.
