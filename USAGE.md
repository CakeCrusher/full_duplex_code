# Using Full-Duplex Code

Full-Duplex Code adds a voice companion to your normal Claude Code terminal. GPT Live 1 handles the conversation with you; Claude Code remains the coding agent that reads files, runs commands, and makes changes.

You can talk while Claude works, ask about its progress, and give corrections. You can also type directly into Claude. The companion receives hook observations from that same session: submitted prompts, assistant messages, tool arguments and results, file edits, errors, and lifecycle updates.

## Before you start

You need:

- Node.js 22 or newer and npm.
- Claude Code installed and signed in. Confirm that running `claude` in a terminal works.
- An OpenAI API key with access to `gpt-live-1`.
- Chrome and a microphone. Headphones can help keep speaker audio out of your microphone.

The tested setup is macOS with Chrome. Other operating systems have not been validated. Claude Code must support channels and the hooks used by this application; organization policies may restrict channel access.

## Install and configure

```sh
git clone https://github.com/CakeCrusher/full_duplex_code.git
cd full_duplex_code
npm ci
```

Create `.env` in the cloned repository and add your OpenAI key:

```dotenv
OPENAI_API_KEY=your-key-here
```

If `.env` already exists, edit it instead of replacing it. You can alternatively set `OPENAI_API_KEY` in your environment. This file is ignored by Git. The key stays on the local server; it is not sent to the browser or the Claude subprocess.

Check the setup without starting a paid voice session:

```sh
npm run doctor
```

The output reports whether Claude is installed and signed in, whether the key is present, and the local spending budget. It checks key presence, not whether OpenAI will accept it or grant model access.

## Start a coding session

Run the launcher from the Full-Duplex Code repository. Replace the example path with an existing project folder:

```sh
npm start -- --cwd /path/to/your/project
```

To work in the Full-Duplex Code repository itself, use `npm start`.

Claude opens in the same terminal. Accept its development-channel notice and any workspace trust prompt. Chrome opens the companion page. Once the channel connects, click **Start voice**, allow microphone access, and wait for the greeting.

If the browser does not open automatically, use the companion URL printed in the terminal. That link grants access to your local companion, so keep it private. Use one companion tab per running session.

A Claude process that was already running must be restarted through this launcher to attach the companion. Use the resume command below to keep an existing conversation.

## Talk and type

| What you want | Example |
| --- | --- |
| New work | “Ask Claude to add a settings page.” |
| A progress update | “What is Claude working on?” |
| An explanation | “Why did it choose that approach?” |
| A correction | “Use SQLite for this version.” |
| Recall of terminal input | Type a request into Claude, then ask, “What did I just tell Claude?” |

The companion can answer from the conversation and agent updates it already has. If it needs Claude to investigate or change something, it sends a request into the same Claude session. Claude handles queued requests at its normal processing opportunities.

You do not need to wait for Claude to finish before speaking. Interrupting the companion's speech does not interrupt Claude's work. New spoken instructions do not press Escape or cancel an active Claude operation.

## Read the live timeline

The browser shows five tracks on one clock:

| Track | What it shows |
| --- | --- |
| Operator audio | Microphone activity estimated from the incoming audio level. Silence and mute leave gaps. |
| Live speech | Audio actually rendered by the browser, including overlap with your microphone. |
| Transcript | Your words and the companion's words on separate rows, aligned to the voice session's audio timestamps. |
| Claude batches | A thin marker whenever a displayed text batch arrives from Claude. |
| Requests to Claude | Spoken request delivery and prompts submitted directly in the terminal. |

Hover over an item to see its text and timing. Click or tap to pin the full details below the chart; keyboard focus works too. Use **Window** to zoom, the arrow buttons or history slider to look back, and **Follow live** to return to the current moment. Inspecting or reviewing the chart does not pause the microphone, the companion, or Claude.

Bars represent durations; thin markers represent instant events. Request durations describe delivery, not how long Claude spends executing a task. Transcript timing may differ from playback because text and audio travel separately. Microphone activity is a level estimate, not a guarantee that every sound is speech.

Click a voice request to see the **full channel message**, including any earlier conversation attached for reference. **Copy message** copies that text. Expand **Channel notification JSON** for the content and metadata sent by the channel. Once Claude's `UserPromptSubmit` hook arrives, the inspector shows the captured prompt and checks that its contents match the sent message. Until then, delivery is not presented as verified receipt. A mismatch is shown explicitly.

The channel uses the latest speech group as the request, with a two-second pause separating groups. Earlier speech remains reference context. The bridge does not rewrite transcription mistakes; the inspector shows what was actually sent.

The timeline remains available across page reloads while the launcher is running. It starts fresh with a new launcher. Full tool payloads still go to the companion in the background; the chart is a visual view of the five tracks, not the entire context feed.

## What the companion follows

Claude's hooks are the main observation path. Each hook payload is forwarded with its fields intact, including tool inputs, completed results, edit patches, metadata, and errors. Known connection credentials and recognizable API keys are redacted. All raw hooks, including assistant messages from `MessageDisplay`, go to GPT Live as quiet background context. The companion answers your questions from that context. For proactive updates, the bridge keeps one replaceable cue about the latest state, waits for a quiet moment, and sends at most one cue every 15 seconds. Live is asked to mention only a meaningful new outcome, blocker, question, or important change in one short sentence. Routine steps and superseded updates should stay quiet; exact spoken behavior still depends on the model.

Claude responds normally in its terminal. The channel has no acknowledgment or reply tools; its only job is to deliver spoken requests into the conversation. A request marked **Delivered to channel** has been sent; **Received by Claude** means its prompt hook was observed. Neither status means Claude completed the work. Follow Claude's observed activity and results for progress.

The bridge does not trim hook fields or discard older observations to save context. A bounded prefix of saved history is supplied at session startup, before audio begins; remaining history and new events use quiet appends. It splits text into small appends for the Live API's per-append limit and keeps the observations for a voice restart. An append failure ends voice with an error so reconnecting can replay the saved observations. A single local hook request has a 32 MiB transport limit; oversized events are reported instead of silently truncated. The model's own context capacity still applies.

The launcher registers passive lifecycle hooks, including tool batches, subagent activity, permission events, and compaction. `WorktreeCreate` is excluded because registering it replaces Claude's own worktree creation. `FileChanged` forwards events for files configured in Claude's watch list; it does not automatically watch every file. Tool hooks already describe changes made through Edit and Write, plus the commands and results of Bash. See the [Claude hooks reference](https://code.claude.com/docs/en/hooks) for watch-path configuration and event availability. Use a current Claude Code release; this flow was tested on 2.1.270.

Hooks report tool operations at their boundaries. A running command's stdout normally arrives with its result, not as a continuous byte stream. Unsent terminal drafts and private thinking are not part of this feed.

## Approvals and attention

By default, approve tools and respond to Claude's permission prompts in the terminal. The companion can tell you that attention is needed, but it does not approve tools for you. To launch Claude with tool permission checks disabled, pass `--dangerously-skip-permissions` as shown below.

If Claude asks a question, you can answer by voice or in the terminal. Keep the terminal visible so you can inspect changes, commands, and any prompts that require direct interaction.

## Pause or stop

- **Mute microphone** stops sharing your microphone input. Voice stays connected and billable. Click **Unmute microphone** to speak again.
- **End voice** closes the paid voice connection. Claude stays open and can continue working.
- **Start voice** opens a new connection and replays the observations retained by this launcher, including tool results and work performed while voice was off. Historical assistant messages are restored quietly.
- Exit Claude in the terminal to stop the whole application.

Closing the companion tab also closes its voice connection. A disconnected voice session does not erase Claude's conversation.

## Resume a conversation

Use the same project path and the Claude session ID:

```sh
npm start -- --cwd /path/to/your/project --resume CLAUDE_SESSION_ID
```

For a session launched by Full-Duplex Code, the terminal prints a **Local run** folder at startup. Open `connection.json` in that folder and copy its `sessionId` value. Use the complete ID; do not use the short suffix of the folder name. Keep the rest of that file private because it also contains connection credentials.

Accept the channel notice, open the new companion link, and click **Start voice**. The companion restores saved prompts, assistant text, tool calls, and tool results from that Claude session's transcript. Transcript records supply the history; newly arriving hooks supply live observations. Private thinking is not imported. Old voice conversations are not restored independently of Claude's saved history, and the voice model has a finite context capacity.

## Useful launch options

Add options after `npm start --`:

| Option | Purpose |
| --- | --- |
| `--cwd /path/to/project` | Choose the folder Claude works in. |
| `--resume SESSION_ID` | Continue a specific Claude conversation. |
| `--session-id UUID` | Choose the full UUID for a new conversation. Use either this or `--resume`. |
| `--no-open` | Print the companion link without opening the browser. |
| `--max-minutes 10` | Limit this voice connection to ten minutes. Default: 30. |
| `--observe transcript` | Add saved-text/tool fallback observation if display hooks are unavailable. |
| `--port 8123` | Use a fixed local port. The default chooses an available port. |

For example:

```sh
npm start -- --cwd /path/to/project --no-open --max-minutes 10
```

Run `npm start -- --help` to see all options. Transcript observation depends on when Claude saves messages, so updates can arrive later than in the default mode.

### Pass arguments to Claude Code

The launcher handles the companion options listed above, plus `--voice` and `--help`. It forwards every other argument to Claude Code, in the order you supplied it, after the generated Claude options. Claude applies its normal override and merge rules; for example, you can choose its model or permission mode. Quoted prompts and option values are passed as arguments, without shell evaluation.

Start with Claude's permission checks disabled:

```sh
npm start -- --dangerously-skip-permissions
```

Or combine Claude flags with a project path and an existing conversation:

```sh
npm start -- --cwd /path/to/project --resume CLAUDE_SESSION_ID --dangerously-skip-permissions --model opus
```

You can also pass an initial prompt:

```sh
npm start -- --model opus "Explain this project"
```

The first `--` tells npm to pass the arguments to the launcher. An additional `--` stops the launcher's option parsing and sends the remaining arguments directly to Claude. For example, `npm start -- -- --help` displays Claude's help instead of the companion's help. Put companion options and `--resume` / `--session-id` before this additional separator so the companion tracks the selected session. To pass a value that itself matches a companion flag, use this separator or Claude's `--option=value` form.

These options are passed to the normal terminal process. Options that replace Claude's hooks or channel configuration also replace the companion connections they provide. See the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) for flag behavior.

## Costs

OpenAI bills the connected voice session, including time spent listening or muted. Claude usage remains on your existing Claude account. Use **End voice** when you are done.

```sh
npm run usage
```

The application estimates voice cost at $0.05 per minute and enforces a local $25 cumulative budget across runs. Each connection defaults to a 30-minute limit. Check [OpenAI's model page](https://developers.openai.com/api/docs/models/gpt-live-1) for current service pricing and availability.

Before connecting, the application reserves enough of the local budget for the maximum session duration plus a shutdown margin. When final usage arrives, it releases the unused reservation. A session whose final usage could not be confirmed retains its reservation, so the displayed total can be higher than completed usage alone.

The ledger lives in `.runs/budget.json`. Do not delete it to clear an error or bypass the spending limit. This is a local spending guard, not an account-wide limit for other applications using your API key. A shorter `--max-minutes` value reduces the reservation needed for a new connection.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| The launcher won't start | Run it in an interactive terminal and run `npm run doctor`. Check Node, Claude sign-in, and `.env`. |
| Start voice stays disabled | Accept any pending channel notice or trust prompt in the Claude terminal. Check whether your organization permits channels. |
| The browser didn't open | Open the companion URL printed by the launcher in Chrome. |
| The companion can't hear you | Allow microphone access in Chrome and macOS. Check the selected microphone and whether it is muted. |
| OpenAI rejects the connection | Check the key, API account billing, and access to `gpt-live-1`. A successful doctor check alone does not verify these. |
| Claude is waiting | Look for a tool approval or clarification in the terminal. |
| The companion misses terminal text | Confirm Claude was started through this launcher. If hooks are unavailable, restart the same session with `--resume SESSION_ID --observe transcript`. |
| A second companion tab cannot connect | Close the first tab, then open the link again. Only one audio client can connect to each launcher. |
| Voice disconnected | Keep Claude open, reopen the companion link, and click Start voice. Resolve any terminal/channel issue first. |
| The budget refuses a session | Run `npm run usage`. Check completed usage and retained reservations; do not delete the ledger. |

Voice closes automatically if microphone streaming stops or the Claude channel remains disconnected. This avoids leaving a paid connection running without a usable companion.

## Local records and sharing

`.runs/` contains connection details, event logs, conversation text, and the budget ledger. `.env`, `.runs/`, `.cache/`, `.scratch/`, and `docs/` are ignored by Git. Normal use does not save raw microphone recordings, but the integration tests save audio evidence locally.

Treat logs and companion links as private. When reporting a problem, share the error and reproduction steps after removing keys, connection tokens, and private project content.

## Checking an installation

`npm test` runs offline checks without OpenAI spending. `npm run test:ui` checks the live timeline, hover details, navigation, reload, and real browser audio capture/playback with a virtual microphone and no paid API connection. `npm run test:hooks` uses synthesized speech to check recall of file/tool details and new work through the one-way channel; it starts a paid voice session. `npm run test:updates` checks a rapid seven-step Claude task, selective speech cues, and status recall with real voice.

The other integration commands in `package.json` start real Claude and OpenAI voice sessions. They require macOS `say`, `ffmpeg`, and the relevant browser setup; they consume API credits. Ordinary use does not require these test tools.

## License

Full-Duplex Code is available under [PolyForm Noncommercial 1.0.0](LICENSE). Preserve the license and required attribution when sharing permitted copies. Commercial use is not granted by this license.
