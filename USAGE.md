# Using Full-Duplex Code

Full-Duplex Code adds a voice companion to your normal Claude Code terminal, or to Codex (see [Use Codex](#use-codex)). This guide describes Claude Code first. GPT Live 1 handles the conversation with you; Claude Code remains the coding agent that reads files, runs commands, and makes changes.

You can talk while Claude works, ask about its progress, and give corrections. You can also type directly into Claude. The companion receives hook observations from that same session: submitted prompts, assistant messages, tool arguments and results, file edits, errors, and lifecycle updates.

## Before you start

You need:

- Node.js 22.18 or newer and npm. Node runs the TypeScript sources directly; there is no build step.
- Claude Code installed and signed in. Confirm that running `claude` in a terminal works.
- An OpenAI API key with access to `gpt-live-1`.
- Chrome and a microphone. Headphones can help keep speaker audio out of your microphone.

The tested setup is macOS with Chrome. Other operating systems have not been validated. Claude Code must support channels and the hooks used by this application; organization policies may restrict channel access.

## Install and configure

```sh
git clone https://github.com/CakeCrusher/full_duplex_code.git
cd full_duplex_code
npm ci
npm link
```

`npm link` puts the `fdc` command on your PATH. Without it, run `npm --prefix /path/to/full_duplex_code start -- <agent> …` from your project's folder instead of `fdc <agent> …`.

Create `.env` in the cloned repository and add your OpenAI key:

```dotenv
OPENAI_API_KEY=your-key-here
```

If `.env` already exists, edit it instead of replacing it. You can alternatively set `OPENAI_API_KEY` in your environment. This file is ignored by Git. The key stays on the local server; it is not sent to the browser or the Claude subprocess.

Check the setup without starting a paid voice session:

```sh
fdc doctor
```

The output reports whether Claude is installed and signed in, whether the key is present, and recorded local usage. It checks key presence, not whether OpenAI will accept it or grant model access.

## Start a coding session

In your project's folder, put `fdc` in front of the command you normally use to start Claude Code:

```sh
cd /path/to/your/project
fdc claude
```

Claude works in the folder you run `fdc` from. Everything after `claude` is Claude's own command line, passed through unchanged; see [Pass arguments to Claude Code](#pass-arguments-to-claude-code).

The launcher prints the companion link and waits. Open the link in Chrome, then press Enter to start Claude, or Ctrl-C to quit. Claude fills the terminal once it starts, which hides the link until you exit. Accept Claude's development-channel notice and any workspace trust prompt. Once the channel connects, click **Start voice**, allow microphone access, and wait for the greeting.

The launcher does not open a browser for you. That link grants access to your local companion, so keep it private. Use one companion tab per running session.

A Claude process that was already running must be restarted through this launcher to attach the companion. Use the resume command below to keep an existing conversation.

## Talk and type

| What you want | Example |
| --- | --- |
| New work | “Ask Claude to add a settings page.” |
| A progress update | “What is Claude working on?” |
| An explanation | “Why did it choose that approach?” |
| A correction | “Use SQLite for this version.” |
| Recall of terminal input | Type a request into Claude, then ask, “What did I just tell Claude?” |

After the channel confirms a spoken request was sent, the companion is prompted to say so briefly. This receipt does not mean Claude has started or completed it.

The companion can answer from the conversation and agent updates it already has. If it needs Claude to investigate or change something, it sends a request into the same Claude session. Claude handles queued requests at its normal processing opportunities.

You do not need to wait for Claude to finish before speaking. Interrupting the companion's speech does not interrupt Claude's work. New spoken instructions do not press Escape or cancel an active Claude operation.

## Read the live timeline

The browser shows six tracks on one clock:

| Track | What it shows |
| --- | --- |
| Operator audio | Microphone activity after the noise gate and mute, including quiet word endings. Filtered background noise leaves gaps. |
| Live speech | Audio actually rendered by the browser, including overlap with your microphone. |
| API transcript | Input ASR and Live’s output transcript on separate rows. Input text can be inaccurate even during silence; it is not proof you spoke. |
| Claude hooks | Every raw observation, including tool calls/results, file changes, displayed text, and lifecycle hooks, at bridge receipt time. The bounded Live view goes to thinking; originals remain here. |
| Context to Live | Every actual thinking append and commentary append, from send to acknowledgment. Click for the exact JSON. Acknowledgment does not mean the model has finished using the content. |
| Requests to Claude | Spoken request delivery and prompts submitted directly in the terminal. |

Hover over an item to see its text and timing. Click or tap to pin the full details below the chart; keyboard focus works too. Use **Window** to zoom, the arrow buttons or history slider to look back, and **Follow live** to return to the current moment. Inspecting or reviewing the chart does not pause the microphone, the companion, or Claude.

Bars represent durations; thin markers represent instant events. Request durations describe delivery, not how long Claude spends executing a task. Transcript timing may differ from playback because text and audio travel separately. Microphone activity is a level estimate, not a guarantee that every sound is speech.

Output captions can also omit words that were spoken, or include words absent from the audio. A sentence ending in the transcript is therefore not proof of an audible cutoff. Compare the saved API output and browser playback recordings when investigating missing speech.

Runs also save `audio.transport` events once per second with the browser receiver’s packet and audio-repair counters. These help distinguish native model pauses from degraded delivery. A final lost-packet count of zero does not rule out earlier damage: late packets may arrive after the browser already substituted sound. The counters are diagnostics; they do not alter playback.

Where supported, the browser requests a 200 ms target for WebRTC’s existing network jitter buffer to help recover late packets. Actual delay is chosen by the browser and varies with the connection. Incoming and outgoing audio continue simultaneously; the app does not hold whole sentences, filter speech, or replace Live’s voice. This cannot correct unwanted narration or words that Live never generated.

Click a voice request to see the **full channel message**, including any earlier conversation attached for reference. **Copy message** copies that text. Expand **Channel notification JSON** for the content and metadata sent by the channel. Once Claude's `UserPromptSubmit` hook arrives, the inspector shows the captured prompt and checks that its contents match the sent message. Until then, delivery is not presented as verified receipt. A mismatch is shown explicitly.

The channel uses the latest speech group as the request, with a two-second pause separating groups. Earlier speech remains reference context. The bridge does not rewrite transcription mistakes; the inspector shows what was actually sent.

The timeline remains available across page reloads while the launcher is running. It starts fresh with a new launcher. All hooks remain visible. The Context to Live row shows actual sends and acknowledgments separately from hook receipt, so delivery delays are visible.

## Adjusting the conversation

The **Configurations** slider changes the speaking preference for the current conversation:

- **Quiet:** speak only when you address Live or continue that conversation. Observe Claude silently, including blockers and completion; no unsolicited greeting.
- **Milestones (default):** listen during routine work; speak when Claude needs your decision or finishes its response with a useful outcome. Explain what is ready, how to use it, and an important limitation when relevant. Finishing a response does not by itself prove the task succeeded.

All levels receive the same context. Your spoken requests take priority over the selected default: asking a question, changing topic, or asking Live to stop discussing something should lead the conversation. Claude’s observations are background reference material. Live decides whether an unsolicited update is useful; the bridge does not schedule speech cues or promote progress into commentary. The prompt asks Live to finish its current thought despite new observations, while yielding to you. Quiet also skips the opening greeting. These are model instructions, not a guarantee of exact spoken behavior. The bounded feed and lifecycle-aware prompt are tested together; exact spoken wording remains model-driven. Input ASR can still produce spurious text during silence, so recorded input audio is the source of truth when diagnosing interruptions.

The status beneath Configurations shows **Applying** until Live acknowledges that change, then **Live acknowledged**. **Active from session start** means the preference was included when that connection opened. **Not confirmed** reports a failed update; select the mode again to retry. **Next session** means voice is disconnected and the preference will be used at the next start. Acknowledgment confirms delivery, not exactly when the model’s speech will reflect it. Changing a preference does not discard audio already generated.

Open **GPT Live prompt** beneath the sliders to read the startup instructions. Before connecting, it previews the next session. During or after a connection, it preserves that session’s startup text and shows the selected speaking preference separately. The base prompt is `basePrompt` in `src/core/prompts.ts`, worded from the agent adapter's profile; `src/core/voice-policy.ts` provides the speaking preferences. Workspace/history, the one-time welcome, and later context appends are supplied separately. The browser page is the **voice companion dashboard**, and its Gantt chart is the **live session timeline**.

**Microphone** chooses the input device. **Chrome default** follows Chrome's own microphone setting. Device names appear after Chrome first grants microphone access. The choice is remembered in this browser and applies the next time you click **Start voice**; it is locked while voice is connected, so use **End voice** before switching. If the saved device is unplugged, the list shows Chrome default until it returns.

**Mic threshold** gates the actual microphone samples before they reach Live. The default is 0.8% RMS amplitude; zero disables it. Whisper below the threshold and, once any earlier word tail ends, Live receives digital silence and the operator-audio track stays empty. Lower the threshold and the same whisper passes through and appears on that track. The connection keeps sending silent frames while the gate is closed to keep Live’s clock running.

After speech crosses the threshold, a **300 ms hold** captures quieter word endings. Those quieter samples are sent and shown on the Gantt. Changing the threshold resets the previous hold; mute remains immediate. Chrome is requested to disable automatic gain adjustment so it does not automatically boost a whisper above the gate. The meter shows captured sound before the gate, and the label beneath Mic threshold says **Passing audio to Live** or **Gate closed · sending silence**. Mute silences both recorded microphone tracks.

Quiet speech that already passed the gate is boosted by up to four times before it reaches Live. Loud peaks reduce that boost immediately to avoid clipping; it then recovers gradually. This happens after the gate decision, so below-threshold noise still sends silence. The operator track measures the boosted signal, while the microphone recording preserves the original level.

Chrome carries microphone and speaker audio through **WebRTC**. Its native receiver handles decoding, network jitter and continuous playback; the companion does not schedule or splice speech chunks. The noise gate runs before the outgoing microphone track. The playback timeline and recording measure the decoded speaker track, including receiver delay. This cannot reconstruct words missing from the incoming audio. End voice stops playback immediately.

**Input ASR** is Live’s own transcription output. We do not run an extra recognizer or send this text back to Live. The bridge uses it to assemble a request only when Live delegates. It can contain spurious text even with silent input, so inspect the audio recordings when auditing it.

## What the companion follows

Claude's hooks are the main observation path. Hook text, tool inputs, completed results, edit patches, metadata, and errors are forwarded. Encoded image/audio/document attachments are represented by their metadata and an explicit notice: the text-only context cannot view binary attachments. The complete original payload stays in the local hook log and Claude-hooks inspector. Known connection credentials and recognizable API keys are redacted. All hook types, including assistant messages from `MessageDisplay`, go to GPT Live as quiet background context; binary bytes are not treated as text. The companion answers your questions from that context. Live chooses what to say from that context under the conversation prompt. There is no progress timer, speech-cue queue, or commentary generated from Claude hooks. The bridge also sends commentary for the one-time welcome outside Quiet mode and a brief confirmation after a voice request is successfully sent through Claude’s channel. This confirmation bypasses the hook backlog, applies in every configuration, and is sent once per request. It confirms delivery, not that Claude has started or finished the work. Acknowledgment from the API does not guarantee that the confirmation was audible.

Claude responds normally in its terminal. The channel has no acknowledgment or reply tools; its only job is to deliver spoken requests into the conversation. A request marked **Delivered to channel** has been sent; **Received by Claude** means its prompt hook was observed. Neither status means Claude completed the work. Follow Claude's observed activity and results for progress.

The bridge saves every original observation locally. Assistant text from `MessageDisplay` and `Stop`, submitted prompts, and restored user/assistant transcript text are sent in full. A final answer is never truncated just because some of its displayed paragraphs also appeared in a Stop hook. Every forwarded observation keeps its hook name and Claude's turn state. `Stop` means Claude finished its response, not that its program was verified.

Tool details have a 1,200-token representation allowance per observation. Small results keep their fields; larger code bodies and logs become labeled excerpts. Identical repeated bodies refer back to the earlier hook, explicitly stating whether that earlier view was complete or only an excerpt. Connection bookkeeping is omitted, while fields inside tool results retain their original meaning. Exceptionally wide tool objects keep a partial view with identifying fields and the outcome. Exact original code and logs remain available in the raw hook inspector.

Ordinary observations collect for up to 250 milliseconds; requests, completion, errors and permission events flush immediately. The bridge preserves observation order and does not drop whole events or hold new hooks behind pending acknowledgments. `events.jsonl` retains the originals; `context.prepared` records the derived text, source hashes and receipt times. Large tool details are reduced before delivery, while assistant prose remains complete. This improves measured latency but does not guarantee a five-second API deadline for arbitrary bursts, very long prose, restored history or service delays.

Appends respect the API's 500-token limit and preserve send order. Individual fragments do not wait for individual acknowledgments; actual socket backpressure can delay writes. The dashboard shows locally waiting hooks, pending appends, and estimated backlog separately. That estimate is informational, not a delivery gate or an API guarantee. API acknowledgments estimate context injection, not comprehension. Audio never pauses hook collection. Configuration changes and delivery confirmations bypass the background feed. On a voice restart, saved history is restored through the same path after the initial history prefix. An append failure ends voice with an error rather than silently continuing with stale context. Local hook requests have a 32 MiB transport limit; oversized events are reported.

The launcher registers passive lifecycle hooks, including tool batches, subagent activity, permission events, and compaction. `WorktreeCreate` is excluded because registering it replaces Claude's own worktree creation. `FileChanged` forwards events for files configured in Claude's watch list; it does not automatically watch every file. Tool hooks already describe changes made through Edit and Write, plus the commands and results of Bash. See the [Claude hooks reference](https://code.claude.com/docs/en/hooks) for watch-path configuration and event availability. Use a current Claude Code release; this flow was tested on 2.1.270.

Hooks report tool operations at their boundaries. A running command's stdout normally arrives with its result, not as a continuous byte stream. Unsent terminal drafts and private thinking are not part of this feed.

## Approvals and attention

By default, approve tools and respond to Claude's permission prompts in the terminal. The companion can tell you that attention is needed, but it does not approve tools for you. To launch Claude with tool permission checks disabled, pass `--dangerously-skip-permissions` as shown below.

If Claude asks a question, you can answer by voice or in the terminal. Keep the terminal visible so you can inspect changes, commands, and any prompts that require direct interaction.

## Pause or stop

- **Mute microphone** stops sharing your microphone input. Voice stays connected and billable. Click **Unmute microphone** to speak again.
- **End voice** closes the paid voice connection. Claude stays open and can continue working.
- **Start voice** opens a new connection. Its startup context holds the most recent observations retained by this launcher, including work performed while voice was off, within a fixed size limit. Longer records are shortened to their start and end. Earlier history is not re-sent; it stays in the local log. Only observations that arrive after the connection opens are sent as they happen.
- Exit Claude in the terminal to stop the whole application.

Closing the companion tab also closes its voice connection. A disconnected voice session does not erase Claude's conversation.

## Resume a conversation

Use Claude's own resume options, in the same project folder:

```sh
fdc claude --resume CLAUDE_SESSION_ID
```

`fdc claude --continue` and `fdc claude --resume` (Claude's picker) work too; the companion learns the session's ID from Claude's first hook. For a session launched by Full-Duplex Code, the terminal prints a **Local run** folder at startup. Open `connection.json` in that folder and copy its `sessionId` value. Use the complete ID; do not use the short suffix of the folder name. Keep the rest of that file private because it also contains connection credentials.

Accept the channel notice, open the new companion link, and click **Start voice**. The companion reads saved prompts, assistant text, tool calls, and tool results from that Claude session's transcript. Like any new voice connection, it starts with only the most recent of these; the rest stays in the transcript. Transcript records supply the history; newly arriving hooks supply live observations. Private thinking is not imported. Old voice conversations are not restored independently of Claude's saved history, and the voice model has a finite context capacity.

## Add instructions to Live

Open **GPT Live prompt** in the companion, enter a short instruction under **Append a system instruction**, and click **Append instruction**. This adds guidance without replacing the base prompt or sending a request to Claude. The exact text appears below with **Applying…**, **Live acknowledged**, or **Not confirmed**. An acknowledgment confirms that the API accepted it; it does not prove the model followed it.

Instructions added before voice starts are marked **Saved for next voice session**. They also carry into later voice connections in the same running companion. A new launcher starts fresh. The Configurations slider continues to control unsolicited Claude updates; spoken operator requests take priority at every level.

## Useful launch options

The companion's own options go between `fdc` and the agent's name: `fdc [options] <agent> [the agent's own arguments]`. An option the launcher does not know stops it before anything starts.

| Option | Purpose |
| --- | --- |
| `--voice marin` | Choose the GPT Live voice. |
| `--observe transcript` | Add saved-text/tool fallback observation if display hooks are unavailable. |
| `--port 8123` | Choose the local port. The default is 8123, so the companion address and Chrome's microphone permission stay the same between launches. If 8123 is busy, for example with a second companion, the launcher uses a free port and says so. `--port 0` always chooses a free port. |
| `--public` | Also reach the companion from a phone, through a temporary Cloudflare tunnel the launcher starts and stops. See [Use it from your phone](#use-it-from-your-phone). |

For example:

```sh
fdc --voice marin claude
```

Run `fdc --help` to see all options. Transcript observation depends on when Claude saves messages, so updates can arrive later than in the default mode.

### Pass arguments to Claude Code

Everything after `claude` is Claude Code's own command line. The launcher passes it unchanged, in the order you gave it, after the options it adds for the companion (its MCP configuration, the voice channel, its hook settings and, for a new conversation, a session ID). Claude applies its normal override and merge rules; for example, you can choose its model or permission mode. Quoted prompts and option values are passed as arguments, without shell evaluation.

Start with Claude's permission checks disabled:

```sh
fdc claude --dangerously-skip-permissions
```

Or combine Claude flags with an existing conversation:

```sh
fdc claude --resume CLAUDE_SESSION_ID --dangerously-skip-permissions --model opus
```

You can also pass an initial prompt:

```sh
fdc claude --model opus "Explain this project"
```

`fdc claude --help`, `fdc claude --version` and Claude's subcommands, such as `fdc claude mcp list`, run Claude directly, without the companion.

The launcher refuses Claude options that would hide Claude from the companion, and says why: `--settings` (Claude keeps only the last one, so yours would replace the companion's hooks; put those settings in `.claude/settings.local.json` or `~/.claude/settings.json` instead), `--bare` and `--safe-mode` (they turn off hooks), `-p` / `--print` (Claude answers once and exits), `--bg`, `--cloud` and `--environment` (the session runs elsewhere), `--tmux`, and an `--mcp-config` that defines a server named `voice`. Your own MCP servers and channels load beside the companion's. See the [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) for flag behavior.

## Use Codex

Put `fdc` in front of your usual Codex command, in your project's folder. Codex's own options and its `resume` and `fork` subcommands work as usual:

```sh
fdc codex
fdc codex --model gpt-5.5 --search
fdc --public codex resume SESSION_ID
```

You need Codex 0.155 or newer, signed in with `codex login`. The companion does not pass its OpenAI key to Codex, so a Codex that relies on `OPENAI_API_KEY` in the environment should sign in with `codex login --with-api-key` instead.

How it connects:

- The launcher starts its own Codex app server on this computer, protected by a random token, and runs your Codex command attached to it (`--remote`). Nothing is written to your project or to `~/.codex`: the companion's hooks are given to that app server as command-line settings.
- Codex runs a hook only once you have trusted it, and the companion's hooks are new to it. The launcher asks Codex for the name and hash of each of them and trusts exactly those, for this run only, as command-line settings too (`hooks.state`). Your own hooks keep the review status you gave them, and Codex asks about any you have not reviewed, as usual. If Codex would not run all of the companion's hooks, for example because hooks are turned off in your Codex configuration, the launcher stops and says so.
- The companion takes the terminal's thread as soon as Codex loads it, so you can click **Start voice** before you type anything, and a request can be the session's first message. That is a new session's thread as the terminal starts, a forked thread, or the one you resume. A resumed conversation is context for GPT Live from the start; a fork's earlier messages are not, because Codex keeps them with the original session. Codex 0.155 creates a new session's thread only with its first message, so there voice can start once you have sent one.
- With `resume` and `fork`, Codex refuses permission options such as `-a` and `-s` when it runs attached to an app server ("Permission overrides are not supported when resuming a remote task"). The resumed session may not keep the permissions it had: in a check, a session started with `-s workspace-write` resumed as `read-only`. Change them inside Codex with `/permissions`.
- A spoken request steers Codex's running turn (`turn/steer`); when Codex is idle, or the turn ends first, it starts a new turn. Codex sees the request labeled `[Voice request …]`. Approval prompts still appear in the Codex terminal.
- The companion observes Codex's hooks (prompts, tools, approvals, turn ends) and follows its transcript for assistant messages and steered requests. The final message of a turn is observed once.

Refused, with the reason: `codex exec` and `codex review` (no interactive terminal), `--remote` (the companion attaches Codex to its own app server), and turning hooks off. `fdc codex --help` and subcommands such as `fdc codex login` run Codex directly.

To resume a Codex session, use Codex's own `resume` in the same project folder: `fdc codex resume SESSION_ID`, `fdc codex resume --last`, or `fdc codex resume` for Codex's picker. The session ID is in `connection.json` in the run folder, as for Claude, and in Codex's own session list.

When many events arrive while you speak, GPT Live sometimes answers without passing the request on: in a check, it delegated 3 of 5 requests while context arrived every 1.5 seconds, and 4 of 4 without. This affects Claude Code the same way. If a request does not show up in the timeline, say it again.

## Use it from your phone

You can talk to Claude from your phone while it keeps running on your computer. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) once (for example `brew install cloudflared`), then add `--public`:

```sh
fdc --public claude
```

The launcher starts a temporary Cloudflare tunnel, waits until the link actually opens the page, and prints a **From your phone** link with a QR code. (Cloudflare names a new tunnel a few seconds before the name resolves; a device that tried it in that window could be told it does not exist for up to a minute, so the launcher checks with Cloudflare's own nameservers first.) Scan it with your phone's camera, open it in Chrome or another Chromium browser, and click **Start voice**. Then press Enter in the terminal to start Claude. When Claude ends for any reason, including Ctrl-C at the prompt or closing the terminal, the launcher closes the voice session and stops the tunnel. Without `--public`, nothing is reachable from outside this computer.

You can open the page on your computer and on your phone at the same time, in any order, before or after Claude starts. Every open page follows the session, and voice runs in one of them. On another page, **Start voice** becomes **Move voice here**, which ends voice where it was and starts it on that page. A page whose connection drops, for example when the phone sleeps, reconnects by itself; voice on that page ends, and you can start it again. Each start of `fdc` makes new links, so a page opened from an earlier start's link says so.

The tunnel gives the page the `https://` address a phone needs for its microphone. Voice audio does not use it: it goes directly between the phone and OpenAI, as it does from a desktop browser. Only the page and its voice connection are accepted through the tunnel; Claude's hooks and channel connection are refused unless they come from this computer directly.

**Keep the link private.** The tunnel's address is new and random each run, but it is public, and the secret in the link is the only lock. Anyone with the link can direct Claude on your computer; with `--dangerously-skip-permissions`, that includes running any command.

Keep the companion page in the foreground on your phone: locking the screen or switching apps can pause the microphone, and voice ends after 5 seconds without microphone audio. Your computer must stay awake while the launcher runs.

## Costs

OpenAI bills the connected voice session, including time spent listening or muted. Claude usage remains on your existing Claude account. Use **End voice** when you are done.

```sh
fdc usage
```

The application estimates voice cost at $0.05 per minute and tracks cumulative usage without a local spending cap. Voice stays connected until you end it, close the companion, or the connection ends; there is no local duration limit. Check [OpenAI's model page](https://developers.openai.com/api/docs/models/gpt-live-1) for current service pricing and availability.

While connected, the application saves usage reported by the API. Final usage confirms the cost when the session ends. If the connection is lost before final usage arrives, the last reported amount is retained and may be incomplete. Older unfinished sessions may retain their original cost estimates.

Usage history stays in `.runs/budget.json`. Existing history is preserved; old spending limits no longer block new sessions. Use **End voice** to stop the voice connection and its billing; Claude stays open.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| The launcher won't start | Run it in an interactive terminal and run `fdc doctor`. Check Node, Claude sign-in, and `.env`. |
| The agent exits right after it starts | The launcher repeats the agent's own error output (stderr), unchanged, after a red `fdc:` line once the agent has exited, and saves it in the run folder's `events.jsonl` (`agent.exit`). An agent that shows its error on screen instead, as Claude does, leaves it just above that line. |
| A resumed conversation isn't found | Start `fdc` from a normal terminal, not from inside another Claude Code session: there, Claude starts as that session's child and does not save its conversation. |
| Start voice stays disabled | Accept any pending channel notice or trust prompt in the Claude terminal. Check whether your organization permits channels. |
| The companion can't hear you | Allow microphone access in Chrome and macOS. Check the **Microphone** selection beside the voice buttons and whether it is muted. |
| OpenAI rejects the connection | Check the key, API account billing, and access to `gpt-live-1`. A successful doctor check alone does not verify these. |
| Claude hooks | Every raw observation, including tool calls/results, file changes, displayed text, and lifecycle hooks, at bridge receipt time. The bounded Live view goes to thinking; originals remain here. |
| Context to Live | Every actual thinking append and commentary append, from send to acknowledgment. Click for the exact JSON. Acknowledgment does not mean the model has finished using the content. |
| The companion misses terminal text | Confirm Claude was started through this launcher. If hooks are unavailable, restart the same session with `--resume SESSION_ID --observe transcript`. |
| The page says its link is from an earlier start | Each start of `fdc` makes a new link. Open the link it printed this time. |
| Voice is on in another tab or device | Voice runs in one page at a time. Click **Move voice here** to bring it to this page. |
| Voice disconnected | The page reconnects by itself; click Start voice again. Resolve any terminal or channel issue first. |
| An old launcher still reports a budget limit | Exit Claude with `/exit`, restart the launcher, and use the newly opened companion tab. |

Voice closes automatically if microphone streaming stops or the Claude channel remains disconnected. This avoids leaving a paid connection running without a usable companion.

## Local records and sharing

`.runs/` contains connection details, event logs, conversation text, and the usage ledger. `.env`, `.runs/`, `.cache/`, `.scratch/`, and `docs/` are ignored by Git. Each voice connection saves private 24 kHz mono WAV files under `.runs/<run>/audio/<voice-id>/`: `microphone.wav` (microphone before the noise gate, respecting mute), `input.wav` (microphone audio received by Live and reflected over its control connection; WebRTC encoding may alter the samples), `output.wav` (Live audio received, in order), and `playback.wav` (browser-rendered audio, including silent playback gaps). These are local recordings, not OpenAI stored sessions. They use about 11.5 MB per minute combined. `events.jsonl` includes sample offsets, audio levels, playback backlog, hook events, exact context appends and acknowledgments. `timeline.json` preserves the Gantt when voice ends, the browser disconnects, or the launcher exits. Browser crashes may lose their last in-flight playback packets; audit gaps and failures are logged. Old runs without these files cannot recover audio retrospectively. Delete a run’s directory to delete its recordings.

Treat logs and companion links as private. When reporting a problem, share the error and reproduction steps after removing keys, connection tokens, and private project content.

## How the code is organized

The TypeScript sources run directly under Node; the bridge strips the page modules' types when it serves them. `npm run typecheck` checks everything with `tsc`.

- `src/core/` is the part shared by every coding agent: the bridge and its endpoints, the open pages, voice sessions, the mediator, the observation feed, the context queue, the delivery outbox, status and the event log, the timeline, the audio audit, the usage ledger and the command-hook relay.
- `src/adapters/claude/` is everything specific to Claude Code: its hooks and launch flags (`launch.ts`), how its hooks become observations and turn state (`observer.ts`), the voice channel it is reached through (`delivery.ts`, `channel-server.ts`) and its wording (`profile.ts`).
- `src/adapters/codex/` is the same for Codex: its app server and hooks (`app-server.ts`), its command (`launch.ts`), hooks and transcript as observations (`observer.ts`), and delivery by `turn/steer` or a new turn (`delivery.ts`). Both adapters read their agent's own arguments (`arguments.ts`).
- `src/launcher/` holds the launcher's option parsing, Enter prompt and tunnel; `src/cli.ts` runs them.
- `web/` is the page: audio I/O, page UI, bridge client, WebRTC peer, timeline view, sound cues and the audio worklet.

The core reaches an agent only through the adapter contract in `src/core/adapter.ts`: a `profile` (names, the event that ends a turn, whether assistant text streams during the turn and whether a request can reach a running turn), `launch()`, `observations` in one shared format (kind, text, raw event, time, turn state), `deliver()`, which reports how far a request got, and `history()`. Prompts, context labels, the speaking preferences, the page and the timeline take the agent's names from its profile.

To support another coding agent, start from [CONTRIBUTING.md](CONTRIBUTING.md).

## Checking an installation

`npm test` runs offline checks without OpenAI spending. `npm run test:pages` opens companion pages in real Chrome in the orders people use: before the agent is ready, on two devices at once, moving voice between them, after a dropped connection, from an earlier start's link and after the companion stops; `npm run test:pages -- --public` does the same with the second device on a real Cloudflare tunnel. Neither spends API credits. `npm run test:ui` checks the live timeline, hover details, navigation, reload, and real browser audio capture/playback between two local WebRTC peers, with a virtual microphone and no paid API connection. `npm run test:hooks` uses synthesized speech to check recall of file/tool details and new work through the one-way channel; it starts a paid voice session. `npm run test:updates` checks a rapid seven-step Claude task, complete thinking delivery without progress speech cues, and status recall with real voice.

`npm run test:codex` runs one real Codex session with real voice: a spoken request steers Codex's running turn, and Codex acts on it in that turn. `npm run test:codex-start` starts real Codex without a first message, then resumes and forks that session; each time a request delivered before anything is typed becomes the session's first message. It uses a little Codex usage and no voice. The other integration commands in `package.json` start real Claude and OpenAI voice sessions. They require macOS `say`, `ffmpeg`, and the relevant browser setup; they consume API credits. Ordinary use does not require these test tools.

## License

Full-Duplex Code is available under [PolyForm Noncommercial 1.0.0](LICENSE). Preserve the license and required attribution when sharing permitted copies. Commercial use is not granted by this license.
