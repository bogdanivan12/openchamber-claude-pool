# Claude Pool plugin (fork of opencode-claude)

> This folder is the Claude Pool fork of opencode-claude, bundled into the extension; see the root README. The sign-in integration and the `configDirs` option were removed in the fork; providers are `claude-pool*`.

Upstream: [openchamber/opencode-claude](https://github.com/openchamber/opencode-claude) (MIT). Every request runs through the official [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) on top of the `claude` CLI installed on your machine. The plugin makes no calls to Anthropic itself and never writes or refreshes your Claude credentials.

This is an independent community project. It isn't affiliated with, endorsed by, or supported by Anthropic. Claude and Claude Code are trademarks of Anthropic. Read "Use at your own risk" in the root README.

## How it works

```text
OpenCode / OpenChamber
  │  OpenAI-style chat request
  ▼
opencode-claude  (local proxy on 127.0.0.1)
  │  Claude Agent SDK query()
  ▼
claude CLI  (your login, your plan)
  │
  ▼
Anthropic
```

OpenCode sends the plugin an ordinary chat request. The plugin turns it into an Agent SDK call. Claude Code runs the turn with its own system prompt, and the plugin streams the answer, thinking and tool calls back to OpenCode.

Tools stay OpenCode's. Claude Code's built-in tools (its own Bash, Edit and so on) are switched off. OpenCode's tools are handed to Claude instead, so every file edit and shell command goes through OpenCode and its permissions. When Claude asks for several read-only tools at once, like reads, greps or subagents, they run in parallel.

Each OpenCode chat maps to one Claude Code session and resumes it on every message. That keeps Anthropic's prompt cache warm, which is what makes long sessions affordable on a plan.

## Notes

Model-specific notes inherited from upstream (for example fast variants and effort levels) describe the underlying Claude Code CLI behaviour and were not re-verified for the pool providers.

**Fast mode.** Models your CLI runs in [fast mode](https://code.claude.com/docs/en/fast-mode) get a second entry, like "Opus 5.5 Fast". Fast turns draw your plan limits faster. If your account can't use fast mode, the turn runs at normal speed and the log says why.

**Effort.** Pick an effort variant (low, medium, high, xhigh, max) where the model supports it. While Claude thinks, a summary of its reasoning streams into the reasoning block.

**Plan mode.** OpenCode's Plan agent works as usual: Claude is told it's in plan mode, and OpenCode blocks file edits.

**Project instructions.** Claude Code reads `CLAUDE.md` itself, and a project's `AGENTS.md` where there is no `CLAUDE.md` (its `instructionFiles` setting). OpenCode-only instruction files, like `~/.config/opencode/AGENTS.md` or files in `instructions`, are passed on unless Claude Code already reads the same text.

**Skills and agents.** OpenCode's skills (from `.claude`, `.agents` and `.opencode`) are listed for Claude and load through OpenCode's skill tool. A custom agent's own prompt, like a `writer` subagent's, is passed on as that agent's role.

**Titles and summaries.** Session titles run as small one-off requests on Haiku, so they barely touch your limits. Compaction summaries are written by the chat's own model from its Claude session, so they cover the whole conversation with full tool results; most of it comes from the prompt cache. The session itself isn't changed.

## Settings

Most people won't need these. Set them in the environment of the OpenCode server.

| Variable | What it does |
| --- | --- |
| `OPENCODE_CLAUDE_DEBUG=1` | Turn on the plugin debug log |
| `OPENCODE_CLAUDE_PROXY_PORT` | Fixed port for the local proxy (default: any free port) |
| `OPENCODE_CLAUDE_CWD` | Working directory for Claude Code, if you need to override the project folder |
| `OPENCODE_CLAUDE_HISTORY_MAX_CHARS` | How much history to replay when a Claude session can't be resumed (default 400000, `0` turns it off) |
| `OPENCODE_CLAUDE_TURN_STALL_MS` | End a turn when Claude Code goes silent this long (default 10 minutes) |
| `OPENCODE_CLAUDE_PARKED_TURN_TTL_MS` | Close a turn waiting on tool results after this long (default 1 hour, `0` never) |
| `OPENCODE_CLAUDE_RATE_LIMIT_FAST_FAIL=0` | Always send turns to Claude, even when a limit is known to be active |
| `OPENCODE_CLAUDE_DYNAMIC_SECTIONS=keep` | Keep the working directory, memory path and git status in Claude Code's system prompt. By default they go in the first message instead, so every session shares the prompt and a new one reads it from the cache |

## License

[MIT](LICENSE)
