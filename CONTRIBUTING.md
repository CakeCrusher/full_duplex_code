# Contributing

Full-Duplex Code reaches each coding agent through an adapter. This page points at the code to learn from rather than describing it, so it stays true as that code changes. When this page and the code disagree, the code wins.

## Add support for another coding agent

Two adapters exist. Read them side by side and start from the one closer to your agent.

| | Claude Code | Codex |
| --- | --- | --- |
| Adapter | [`src/adapters/claude/`](src/adapters/claude/) | [`src/adapters/codex/`](src/adapters/codex/) |
| Requests reach the agent through | an MCP channel ([`channel-server.ts`](src/adapters/claude/channel-server.ts)) | its app server ([`app-server.ts`](src/adapters/codex/app-server.ts)) |
| Observed through | command hooks, or its transcript | command hooks and its transcript |

The contract is [`src/core/adapter.ts`](src/core/adapter.ts). An agent is an `AgentDefinition`, registered by command name in [`src/adapters/index.ts`](src/adapters/index.ts). From there `fdc <agent> …`, `fdc doctor`, `fdc --help`, the voice prompts and the page pick it up. Nothing in `src/core/` names an agent.

Each adapter folder uses the same file names for the same jobs; copy the layout:

| File | Job | Read |
| --- | --- | --- |
| `profile.ts` | Names and capabilities the core uses in prompts and on the page | [Claude](src/adapters/claude/profile.ts), [Codex](src/adapters/codex/profile.ts) |
| `arguments.ts` | Reads the agent's own command line: sessions, resume, options that would break the companion | [Claude](src/adapters/claude/arguments.ts), [Codex](src/adapters/codex/arguments.ts) |
| `launch.ts` | The agent's command, with the hooks and connection the companion needs | [Claude](src/adapters/claude/launch.ts), [Codex](src/adapters/codex/launch.ts) |
| `observer.ts` | The agent's events as shared observations, turn state and conversation | [Claude](src/adapters/claude/observer.ts), [Codex](src/adapters/codex/observer.ts) |
| `context.ts` | Which fields of its events the voice model does not need | [Claude](src/adapters/claude/context.ts), [Codex](src/adapters/codex/context.ts) |
| `delivery.ts` | Sends a spoken request and reports how far it got | [Claude](src/adapters/claude/delivery.ts), [Codex](src/adapters/codex/delivery.ts) |
| `index.ts` | The definition: puts the parts together, plus `doctor` and help text | [Claude](src/adapters/claude/index.ts), [Codex](src/adapters/codex/index.ts) |

Shared pieces an adapter builds on: [`agent-observer.ts`](src/core/agent-observer.ts), [`observation.ts`](src/core/observation.ts), [`transcript-tail.ts`](src/core/transcript-tail.ts), [`hook-command.ts`](src/core/hook-command.ts) and [`hook-relay.ts`](src/core/hook-relay.ts).

## Test it

Copy the tests of the adapter you started from:

- **Offline, with stand-ins for the agent:** [`claude-arguments`](test/claude-arguments.test.ts), [`claude-observer`](test/claude-observer.test.ts), [`claude-channel`](test/claude-channel.test.ts), [`codex-arguments`](test/codex-arguments.test.ts), [`codex-observer`](test/codex-observer.test.ts) and [`codex-delivery`](test/codex-delivery.test.ts), which fakes Codex's app server.
- **With the real agent in a real terminal:** the helpers in [`scripts/test-support.ts`](scripts/test-support.ts); [`test-codex-start.ts`](scripts/test-codex-start.ts) (no voice) and [`test-codex.ts`](scripts/test-codex.ts) (real voice) for Codex; [`test-integration.ts`](scripts/test-integration.ts) and the other headed scripts for Claude Code.

Before opening a pull request, run `npm run typecheck`, `npm test` and `npm run test:pages`, then use your agent through `fdc` for real: start it, talk to it, send a request mid-turn, resume a session. [USAGE.md](USAGE.md#checking-an-installation) lists every check and what it costs.

## How changes are reviewed

- **Adapter contributions**, meaning a new or changed `src/adapters/<agent>/` with its tests, get a light review. If it works with that agent and leaves the core alone, it goes in.
- **Core changes**, meaning anything in `src/core/`, `src/launcher/`, `src/cli.ts` or `web/`, get a rigorous review, because they affect every agent. Keep them in their own pull request, with tests, and say what behavior changes.

## License

Full-Duplex Code is available under [PolyForm Noncommercial 1.0.0](LICENSE).
