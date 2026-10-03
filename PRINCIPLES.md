# Principles

Rules we settled on while building Full-Duplex Code and its adapters.

## The experience

- You care about the outcome, not the code. The companion tells you what happened, so you never have to watch the terminal.
- Talk any time, from the moment the agent starts. Interrupt the companion whenever you like; your requests reach the agent mid-turn.
- The companion relays what the agent did. It never makes it up.

## The architecture

- The core never names an agent. What is specific to one agent lives in its [adapter](src/adapters/README.md), behind one small contract.
- Run the agent's own command unchanged. Refuse anything that would break the companion, loudly, before starting.
- Leave the user's setup alone: the companion's hooks and settings exist only for that run.
- Watch the agent; only the operator's requests reach it. A request that may not have arrived is flagged, never resent.
- No setup to think about: sensible defaults, private unless `--public`, and everything started stops when the agent ends.

## What crosses over

- The agent gets everything said since the previous request, by both speakers, with a note on whose words are the request.
- GPT Live gets what it doesn't already have: no repeated events, no echo of its own requests, no bytes it can't read. A new voice session starts from recent work, not the whole history.
- The adapter decides what to trim, in one table, and the core runs it. Trim only rare bulky fields, keeping their start and end; never a command or an error.
- No hidden caps. Anything too big shows up, and the fix is a row in that table.

## How we build

- Try the simplest thing first. A simpler rule should mean fewer lines.
- Completeness first: miss nothing, then make it cheaper.
- No regressions. Check against the agent's own docs and a real run, and judge changes on replayed real sessions.
- Each adapter gets offline tests with stand-ins. Nothing ships without a real end-to-end run through `fdc` itself.
- Every restriction needs a source you can point to, never an opinion.
- Generalize; don't tune to one dataset.
- Docs point at the code rather than retelling it. Show rather than describe.
