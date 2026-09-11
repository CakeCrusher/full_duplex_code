# Using Full-Duplex Code

Full-Duplex Code adds a voice companion to your normal Claude Code terminal. GPT Live 1 handles the conversation with you; Claude Code remains the coding agent that reads files, runs commands, and makes changes.

You can talk while Claude works, ask about its progress, and give corrections. You can also type directly into Claude. The companion receives submitted prompts and Claude's displayed replies from that same session.

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

The browser shows voice captions and agent activity. Terminal prompts appear under **Input to Claude Code**; Claude's displayed replies appear alongside them. Reply updates arrive in batches, so a short reply may appear only once it finishes.

## Approvals and attention

Approve tools and respond to Claude's permission prompts in the terminal. The companion can tell you that attention is needed, but it does not approve tools for you.

If Claude asks a question, you can answer by voice or in the terminal. Keep the terminal visible so you can inspect changes, commands, and any prompts that require direct interaction.

## Pause or stop

- **Mute microphone** stops sharing your microphone input. Voice stays connected and billable. Click **Unmute microphone** to speak again.
- **End voice** closes the paid voice connection. Claude stays open and can continue working.
- **Start voice** opens a new connection with recent Claude context, including prompts and replies entered while voice was off.
- Exit Claude in the terminal to stop the whole application.

Closing the companion tab also closes its voice connection. A disconnected voice session does not erase Claude's conversation.

## Resume a conversation

Use the same project path and the Claude session ID:

```sh
npm start -- --cwd /path/to/your/project --resume CLAUDE_SESSION_ID
```

For a session launched by Full-Duplex Code, the terminal prints a **Local run** folder at startup. Open `connection.json` in that folder and copy its `sessionId` value. Use the complete ID; do not use the short suffix of the folder name. Keep the rest of that file private because it also contains connection credentials.

Accept the channel notice, open the new companion link, and click **Start voice**. The companion restores recent prompts and replies from that Claude session's transcript. It does not restore an unlimited archive of past voice conversations: recent agent context is retained, and older details can fall out of context.

## Useful launch options

Add options after `npm start --`:

| Option | Purpose |
| --- | --- |
| `--cwd /path/to/project` | Choose the folder Claude works in. |
| `--resume SESSION_ID` | Continue a specific Claude conversation. |
| `--no-open` | Print the companion link without opening the browser. |
| `--max-minutes 10` | Limit this voice connection to ten minutes. Default: 30. |
| `--observe transcript` | Observe saved conversation text if display hooks are unavailable. |
| `--port 8123` | Use a fixed local port. The default chooses an available port. |

For example:

```sh
npm start -- --cwd /path/to/project --no-open --max-minutes 10
```

Run `npm start -- --help` to see all options. Transcript observation depends on when Claude saves messages, so updates can arrive later than in the default mode.

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

`npm test` runs offline checks without OpenAI spending. `npm run test:ui` checks the browser activity panel in Chrome without a voice connection.

The other integration commands in `package.json` start real Claude and OpenAI voice sessions. They require macOS `say`, `ffmpeg`, and the relevant browser setup; they consume API credits. Ordinary use does not require these test tools.

## License

Full-Duplex Code is available under [PolyForm Noncommercial 1.0.0](LICENSE). Preserve the license and required attribution when sharing permitted copies. Commercial use is not granted by this license.
