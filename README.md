# pi-acp

**Bring pi to your editor. Keep your tools, models, and workflow.**

`pi-acp` connects the [pi coding agent](https://github.com/earendil-works/pi) to [Agent Client Protocol (ACP)](https://agentclientprotocol.com/overview/introduction) clients such as [Zed](https://zed.dev). Chat, follow tool activity, and pick up previous sessions without leaving your editor—while pi continues to run locally with your existing configuration.

## Why pi-acp?

- **See the work as it happens.** Stream assistant replies and thinking, follow tool calls, view images, and jump to referenced files. Edits include structured diffs when a pre-edit snapshot is available; compatible clients get terminal-style bash output.
- **Pick up where you left off.** List, load, resume, close, and delete pi sessions. Loading replays the active branch, including history from before compaction.
- **Use your pi setup.** Keep your providers, skills, prompt templates, and extensions. Pi owns project trust and resource loading; the adapter leaves your system prompt unchanged (multi-root sessions add one clearly-labeled workspace-instructions section).
- **Choose how pi thinks.** Switch models and thinking levels through standard ACP session controls. Pi-provided commands appear alongside handy adapter commands.
- **Keep delegated work in the conversation.** Supported async subagent runs launched or revived for a request hold it open through completion delivery and a subsequent model cycle. Explicit background work can opt out via `acp_detach`.
- **Use Bun when available.** The adapter and supported default JavaScript pi installs automatically use Bun, with no extra configuration. Node remains supported.

Client features are capability-negotiated, not Zed-specific. Standard ACP content is the fallback when optional display extensions are unavailable.

## Quick start

### 1. Install and configure pi

You need **Node.js 22.19.0 or newer** and **pi 1.2.0 or newer** on your `PATH`. Bun is optional.

```bash
npm install -g @earendil-works/pi-coding-agent
pi
```

Use pi to configure your model providers and log in before connecting your editor.

### 2. Build and link the adapter

```bash
git clone https://github.com/regadas/pi-acp.git
cd pi-acp
npm ci
npm run build
npm link
```

> **Install from this repository.** This fork is not yet published on npm or in the ACP Registry. The unscoped `pi-acp` package and current Registry entry install the upstream project, not this version. The package name for future releases is `@regadas/pi-acp`.

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

Open the agent panel, select **pi**, and start a conversation.

For other ACP clients, configure `pi-acp` as a stdio agent. To skip `npm link`, use `node` as the command and the absolute path to `dist/index.js` as its argument.

## Everyday commands

Pi's skills, prompt templates, and extension commands are advertised when pi includes them in its command list. The adapter also provides:

| Command                        | What it does                                                |
| ------------------------------ | ----------------------------------------------------------- |
| `/compact [instructions...]`   | Compact the conversation, optionally with your instructions |
| `/autocompact on\|off\|toggle` | Control automatic compaction                                |
| `/export`                      | Save the session as HTML in the project directory           |
| `/session`                     | Show messages, tokens, cost, and the session file           |
| `/name <name>`                 | Give the session a recognizable name                        |
| `/steering` and `/follow-up`   | Get or set pi's queue delivery modes                        |

Use your client's session controls to select a model or thinking level. `/model` and `/thinking` point to those controls; `/clear` is not implemented—start a new session instead.

## Configuration

Provider credentials and pi settings stay in pi. The adapter normally keeps its own state in `~/.pi/pi-acp` and uses pi's agent directory at `~/.pi/agent`.

| Environment variable          | Purpose                                                                     |
| ----------------------------- | --------------------------------------------------------------------------- |
| `PI_ACP_DIR`                  | Override the adapter's state directory                                      |
| `PI_CODING_AGENT_DIR`         | Override pi's settings, sessions, prompts, extensions, and skills directory |
| `PI_CODING_AGENT_SESSION_DIR` | Choose a custom pi session directory                                        |
| `PI_ACP_PI_COMMAND`           | Use an explicit pi command instead of automatic executable resolution       |

Clients that support terminal authentication can offer interactive pi login. You can also launch it yourself:

```bash
pi-acp --terminal-login
```

See the [adapter reference](docs/adapter-reference.md) for path resolution, authentication negotiation, and runtime details.

## Know before you use it

- **Local execution, not a sandbox.** Pi reads files and runs commands locally; ACP filesystem and terminal delegation are not implemented. Additional workspace roots are model/workspace context, not filesystem access control.
- **Multi-root workspaces: instruction files only.** Additional workspace directories are accepted on `session/new`, `session/load`, and `session/resume` (a full replacement list each time; omitted or empty means none). The session's `cwd` stays the primary root with pi's native settings, extensions, and ancestor context walk unchanged. Each additional root contributes only its own instruction file (`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` — first match, pi's native precedence, no ancestor walk), exposed as a root-scoped system-prompt section. Extra roots never load their own pi settings or extensions. Changing roots restarts the session's pi subprocess: an active turn is cancelled and queued work behind it is discarded.
- **No client-provided MCP servers.** Non-empty ACP `mcpServers` lists are rejected. MCP servers configured in pi itself (native `mcp.json` or a pi MCP extension) still provide tools; the adapter does not bridge ACP `mcpServers` requests automatically.
- **One active writer per persisted session.** Do not operate on the same session concurrently from multiple pi or adapter processes.
- **Async completion has a tested compatibility boundary.** The adapter requires pi >= 1.2.0 (prompt-section delivery on extension-triggered runs); the real-pi ACP eval bridge, including its async-completion flows, passes on pi 1.2.0 and 1.3.0. The stock pi-subagents integration was tested with pi 1.1.0 and the pi-subagents revision pinned in the [reference](docs/adapter-reference.md#prerequisites) — a historical receipt predating the 1.2.0 floor. Required runs can keep the request—and queued prompts—busy. Detached runs may outlive session close or disconnect, and have no separate notification service.

The adapter implements the stable ACP v1 prompt and session lifecycle, but the MCP gap means it is **not fully ACP v1 conformant**. Client support varies, and minor breaking changes are still possible. See [detailed limitations](docs/adapter-reference.md#limitations) and the [compatibility audit](docs/acp-compatibility-audit.md) for evidence and boundaries.

## Development

```bash
npm ci
npm run dev          # run from source
npm run validate     # formatting, types, lint, tests, and build
npm run smoke        # isolated stdio lifecycle check; no provider traffic
npm run eval:acp     # real pi with a deterministic local provider
npm run eval:subagents:completion  # manual probe; pinned pi-subagents checkout (see reference)
npm run eval:subagents:cancel     # manual probe; pinned pi-subagents checkout (see reference)
```

ACP handling lives in `src/acp/`; pi subprocess communication lives in `src/pi-rpc/`. Each ACP session gets its own `pi --mode rpc` subprocess.

The compatibility harness does not exercise a live editor UI. Other manual probes and their credential requirements are documented in the [reference](docs/adapter-reference.md#auxiliary-manual-probes).

## License and origin

[MIT](LICENSE). Independently maintained fork of [svkozak/pi-acp](https://github.com/svkozak/pi-acp), retaining the original Git history, copyright, and license attribution.
