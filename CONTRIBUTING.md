# Contributing

Full-Duplex Code reaches each coding agent through an adapter. This page points at the code to learn from rather than describing it, so it stays true as that code changes. When this page and the code disagree, the code wins.

## Add support for another coding agent

Start with [`src/adapters/README.md`](src/adapters/README.md): what an adapter does, file by file, and the three that exist. The design rules behind them are in [PRINCIPLES.md](PRINCIPLES.md).

## Test it

Copy the tests of the adapter you started from:

- **Offline, with stand-ins for the agent:** [`claude-arguments`](test/claude-arguments.test.ts), [`claude-observer`](test/claude-observer.test.ts), [`claude-channel`](test/claude-channel.test.ts), [`codex-arguments`](test/codex-arguments.test.ts), [`codex-observer`](test/codex-observer.test.ts), [`codex-delivery`](test/codex-delivery.test.ts), which fakes Codex's app server, and [`pi-adapter`](test/pi-adapter.test.ts), which loads Pi's extension against a real bridge.
- **With the real agent in a real terminal:** the helpers in [`scripts/test-support.ts`](scripts/test-support.ts); [`test-codex-start.ts`](scripts/test-codex-start.ts) (no voice) and [`test-codex.ts`](scripts/test-codex.ts) (real voice) for Codex; [`test-pi.ts`](scripts/test-pi.ts) (no voice) and [`test-pi-voice.ts`](scripts/test-pi-voice.ts) (real voice) for Pi; [`test-integration.ts`](scripts/test-integration.ts) and the other headed scripts for Claude Code.

## Before anything ships

These are required, not optional, for every change:

1. `npm run typecheck`, `npm test` and `npm run test:pages` pass.
2. **An end-to-end run through the `fdc` command itself**, the one `npm link` installs, started the way a user starts it, with every agent the change touches (every agent, for a core change):
   - `fdc <agent>` in a project folder, press Enter, open the link, click **Start voice**;
   - ask for work by voice, and while the agent works, ask for more: it arrives mid-turn and the agent acts on it;
   - ask the companion what the agent did, and check the answer;
   - exit, then resume the same session with the agent's own option and check its history is there.

   The scripts in `scripts/` build the bridge directly and skip the launcher, so they do not replace this run. A launcher bug once passed every script: an agent installed as a shell alias failed with `spawn pi ENOENT`.
3. The pull request says which agents were run end to end, and what happened.

[USAGE.md](USAGE.md#checking-an-installation) lists every check and what it costs.

## How changes are reviewed

- **Adapter contributions**, meaning a new or changed `src/adapters/<agent>/` with its tests, get a light review. If it works with that agent and leaves the core alone, it goes in.
- **Core changes**, meaning anything in `src/core/`, `src/launcher/`, `src/cli.ts` or `web/`, get a rigorous review, because they affect every agent. Keep them in their own pull request, with tests, and say what behavior changes.

## License

Full-Duplex Code is available under [PolyForm Noncommercial 1.0.0](LICENSE).
