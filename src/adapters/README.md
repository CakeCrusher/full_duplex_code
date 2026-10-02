# Adapters

An adapter connects one coding agent to the companion. Everything specific to that agent lives in its folder here. The core never names an agent; it reaches it only through the contract in [`src/core/adapter.ts`](../core/adapter.ts).

Start from the adapter closer to yours:

| | [Claude Code](claude/) | [Codex](codex/) |
| --- | --- | --- |
| Requests reach it through | an MCP channel ([`channel-server.ts`](claude/channel-server.ts)) | its app server ([`app-server.ts`](codex/app-server.ts)) |
| Observed through | hooks, or its transcript | hooks and its transcript |

## What an adapter does

1. **Launch** the agent's own command unchanged, adding only what the companion needs: hooks that run the [relay](../core/hook-relay.ts) ([`hook-command.ts`](../core/hook-command.ts)), and a way in for requests (`launch.ts`). Refuse arguments that would hide the agent from the companion (`arguments.ts`).
2. **Observe** every event, from a hook or the transcript, as an `Observation`: a shared kind, the agent's own name for the event, the whole event as JSON, and the turn state after it. Refuse another session's events (`observer.ts`, built on [`agent-observer.ts`](../core/agent-observer.ts); [`transcript-tail.ts`](../core/transcript-tail.ts) follows a transcript file).
3. **Filter** what reaches GPT Live with one table of rows (`context.ts`). A row removes an event or keys, or truncates keys to a number of characters, cut from the middle. The core already omits base64 data and the echo of a voice request, and notes any record still over about 1,200 tokens: that note shows where a row is missing.
4. **Deliver** a spoken request into the running agent, mid-turn when it can, and report whether it was sent. Never resend (`delivery.ts`). Recognize the request when the agent shows it back as a prompt (`receivedRequest`).
5. **Describe** the agent for prompts and the page: its names, the event that ends a turn, whether a running turn can take a request (`profile.ts`).
6. **Register** the `AgentDefinition`, with `doctor` and help text, in `index.ts`, and add it to [`src/adapters/index.ts`](index.ts). `fdc <agent>`, `fdc doctor`, `fdc --help`, the voice prompts and the page pick it up from there.

Then copy the adapter's tests and use the agent through `fdc` for real: see [CONTRIBUTING.md](../../CONTRIBUTING.md#test-it). The design rules behind all this are in [PRINCIPLES.md](../../PRINCIPLES.md).
