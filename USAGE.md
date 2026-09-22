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

The output reports whether Claude is installed and signed in, whether the key is present, and recorded local usage. It checks key presence, not whether OpenAI will accept it or grant model access.

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

Click a voice request to see the **full channel message**, including any earlier conversation attached for reference. **Copy message** copies that text. Expand **Channel notification JSON** for the content and metadata sent by the channel. Once Claude's `UserPromptSubmit` hook arrives, the inspector shows the captured prompt and checks that its contents match the sent message. Until then, delivery is not presented as verified receipt. A mismatch is shown explicitly.

The channel uses the latest speech group as the request, with a two-second pause separating groups. Earlier speech remains reference context. The bridge does not rewrite transcription mistakes; the inspector shows what was actually sent.

The timeline remains available across page reloads while the launcher is running. It starts fresh with a new launcher. All hooks remain visible. The Context to Live row shows actual sends and acknowledgments separately from hook receipt, so delivery delays are visible.

## Adjusting the conversation

The **Configurations** slider changes the speaking preference for the current conversation:

- **Quiet:** speak only when you address Live or continue that conversation. Observe Claude silently, including blockers and completion; no unsolicited greeting.
- **Milestones (default):** listen during routine work; speak when Claude needs your decision or finishes its response with a useful outcome. Explain what is ready, how to use it, and an important limitation when relevant. Finishing a response does not by itself prove the task succeeded.

All levels receive the same context. Your spoken requests take priority over the selected default: asking a question, changing topic, or asking Live to stop discussing something should lead the conversation. Claude’s observations are background reference material. Live decides whether an unsolicited update is useful; the bridge does not schedule speech cues or promote progress into commentary. The prompt asks Live to finish its current thought despite new observations, while yielding to you. Quiet also skips the opening greeting. These are model instructions, not a guarantee of exact spoken behavior. The bounded feed and lifecycle-aware prompt are tested together; exact spoken wording remains model-driven. Input ASR can still produce spurious text during silence, so recorded input audio is the source of truth when diagnosing interruptions.

The status beneath Configurations shows **Applying** until Live acknowledges that change, then **Live acknowledged**. **Active from session start** means the preference was included when that connection opened. **Not confirmed** reports a failed update; select the mode again to retry. **Next session** means voice is disconnected and the preference will be used at the next start. Acknowledgment confirms delivery, not exactly when the model’s speech will reflect it. Changing a preference does not discard audio already generated.

Open **GPT Live prompt** beneath the sliders to read the startup instructions. Before connecting, it previews the next session. During or after a connection, it preserves that session’s startup text and shows the selected speaking preference separately. The base prompt is `BASE_PROMPT` in `src/live.js`; `src/voice-policy.js` provides the speaking preferences. Workspace/history, the one-time welcome, and later context appends are supplied separately. The browser page is the **voice companion dashboard**, and its Gantt chart is the **live session timeline**.

**Mic threshold** gates the actual microphone samples before they reach Live. The default is 0.8% RMS amplitude; zero disables it. Whisper below the threshold and, once any earlier word tail ends, Live receives digital silence and the operator-audio track stays empty. Lower the threshold and the same whisper passes through and appears on that track. The connection keeps sending silent frames while the gate is closed to keep Live’s clock running.

After speech crosses the threshold, a **300 ms hold** captures quieter word endings. Those quieter samples are sent and shown on the Gantt. Changing the threshold resets the previous hold; mute remains immediate. Chrome is requested to disable automatic gain adjustment so it does not automatically boost a whisper above the gate. The meter shows captured sound before the gate, and the label beneath Mic threshold says **Passing audio to Live** or **Gate closed · sending silence**. Mute silences both recorded microphone tracks.

Quiet speech that already passed the gate is boosted by up to four times before it reaches Live. Loud peaks reduce that boost immediately to avoid clipping; it then recovers gradually. This happens after the gate decision, so below-threshold noise still sends silence. The operator track measures the boosted signal, while the microphone recording preserves the original level.

Chrome carries microphone and speaker audio through **WebRTC**. Its native receiver handles decoding, network jitter and continuous playback; the companion does not schedule or splice speech chunks. The noise gate runs before the outgoing microphone track. The playback timeline and recording measure the decoded speaker track, including receiver delay. This cannot reconstruct words missing from the incoming audio. End voice stops playback immediately.

**Input ASR** is Live’s own transcription output. We do not run an extra recognizer or send this text back to Live. The bridge uses it to assemble a request only when Live delegates. It can contain spurious text even with silent input, so inspect the audio recordings when auditing it.

## What the companion follows

Claude's hooks are the main observation path. Hook text, tool inputs, completed results, edit patches, metadata, and errors are forwarded. Encoded image/audio/document attachments are represented by their metadata and an explicit notice: the text-only context cannot view binary attachments. The complete original payload stays in the local hook log and Claude-hooks inspector. Known connection credentials and recognizable API keys are redacted. All hook types, including assistant messages from `MessageDisplay`, go to GPT Live as quiet background context; binary bytes are not treated as text. The companion answers your questions from that context. Live chooses what to say from that context under the conversation prompt. There is no progress timer, speech-cue queue, or commentary generated from Claude hooks. The bridge also sends commentary for the one-time welcome outside Quiet mode and a brief confirmation after a voice request is successfully sent through Claude’s channel. This confirmation bypasses the hook backlog, applies in every configuration, and is sent once per request. It confirms delivery, not that Claude has started or finished the work. Acknowledgment from the API does not guarantee that the confirmation was audible.

Claude responds normally in its terminal. The channel has no acknowledgment or reply tools; its only job is to deliver spoken requests into the conversation. A request marked **Delivered to channel** has been sent; **Received by Claude** means its prompt hook was observed. Neither status means Claude completed the work. Follow Claude's observed activity and results for progress.

The bridge saves every original observation locally and sends a bounded view to Live. Small hooks keep their ordinary fields. Long code and logs become labeled excerpts, repeated bodies become references, and transport metadata is omitted. If pending display paragraphs also appear verbatim in the same agent’s final Stop, the bridge uses the final-answer view instead of sending those paragraphs twice. Tool errors, operator requests, and completion get priority. Each view keeps its hook name and Claude's turn state. `Stop` means Claude finished its response, not that its program was verified.

Ordinary observations collect for up to four seconds; important events flush that collection immediately when capacity allows. The feed estimates pending work from unacknowledged tokens and observed injection timing. Under load it combines older low-priority observations and tightens the payload allowance before dispatch, instead of sending a minute of queued text. The complete raw events remain in `events.jsonl`; `context.prepared` records exact derived text and source hashes, and `context.coalesced` records combined observations. Excerpts can omit detail: use Claude's terminal or the raw hook inspector when exact code matters.

Appends still respect the API's 500-token limit and preserve send order. Individual fragments do not wait for individual acknowledgments; only the bounded feed and actual socket backpressure limit new work. The dashboard shows locally waiting hooks, pending appends, and estimated backlog separately. The estimate is a heuristic, not an API guarantee. API acknowledgments estimate context injection, not comprehension. Audio never pauses hook collection. Configuration changes and delivery confirmations bypass the background feed. On a voice restart, saved history is restored through the same bounded path after the initial history prefix. An append failure ends voice with an error rather than silently continuing with stale context. Local hook requests have a 32 MiB transport limit; oversized events are reported.

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

## Add instructions to Live

Open **GPT Live prompt** in the companion, enter a short instruction under **Append a system instruction**, and click **Append instruction**. This adds guidance without replacing the base prompt or sending a request to Claude. The exact text appears below with **Applying…**, **Live acknowledged**, or **Not confirmed**. An acknowledgment confirms that the API accepted it; it does not prove the model followed it.

Instructions added before voice starts are marked **Saved for next voice session**. They also carry into later voice connections in the same running companion. A new launcher starts fresh. The Configurations slider continues to control unsolicited Claude updates; spoken operator requests take priority at every level.

## Useful launch options

Add options after `npm start --`:

| Option | Purpose |
| --- | --- |
| `--cwd /path/to/project` | Choose the folder Claude works in. |
| `--resume SESSION_ID` | Continue a specific Claude conversation. |
| `--session-id UUID` | Choose the full UUID for a new conversation. Use either this or `--resume`. |
| `--no-open` | Print the companion link without opening the browser. |
| `--observe transcript` | Add saved-text/tool fallback observation if display hooks are unavailable. |
| `--port 8123` | Use a fixed local port. The default chooses an available port. |

For example:

```sh
npm start -- --cwd /path/to/project --no-open
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

The application estimates voice cost at $0.05 per minute and tracks cumulative usage without a local spending cap. Voice stays connected until you end it, close the companion, or the connection ends; there is no local duration limit. Check [OpenAI's model page](https://developers.openai.com/api/docs/models/gpt-live-1) for current service pricing and availability.

While connected, the application saves usage reported by the API. Final usage confirms the cost when the session ends. If the connection is lost before final usage arrives, the last reported amount is retained and may be incomplete. Older unfinished sessions may retain their original cost estimates.

Usage history stays in `.runs/budget.json`. Existing history is preserved; old spending limits no longer block new sessions. Use **End voice** to stop the voice connection and its billing; Claude stays open.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| The launcher won't start | Run it in an interactive terminal and run `npm run doctor`. Check Node, Claude sign-in, and `.env`. |
| Start voice stays disabled | Accept any pending channel notice or trust prompt in the Claude terminal. Check whether your organization permits channels. |
| The browser didn't open | Open the companion URL printed by the launcher in Chrome. |
| The companion can't hear you | Allow microphone access in Chrome and macOS. Check the selected microphone and whether it is muted. |
| OpenAI rejects the connection | Check the key, API account billing, and access to `gpt-live-1`. A successful doctor check alone does not verify these. |
| Claude hooks | Every raw observation, including tool calls/results, file changes, displayed text, and lifecycle hooks, at bridge receipt time. The bounded Live view goes to thinking; originals remain here. |
| Context to Live | Every actual thinking append and commentary append, from send to acknowledgment. Click for the exact JSON. Acknowledgment does not mean the model has finished using the content. |
| The companion misses terminal text | Confirm Claude was started through this launcher. If hooks are unavailable, restart the same session with `--resume SESSION_ID --observe transcript`. |
| A second companion tab cannot connect | Close the first tab, then open the link again. Only one audio client can connect to each launcher. |
| Voice disconnected | Keep Claude open, reopen the companion link, and click Start voice. Resolve any terminal/channel issue first. |
| An old launcher still reports a budget limit | Exit Claude with `/exit`, restart the launcher, and use the newly opened companion tab. |

Voice closes automatically if microphone streaming stops or the Claude channel remains disconnected. This avoids leaving a paid connection running without a usable companion.

## Local records and sharing

`.runs/` contains connection details, event logs, conversation text, and the usage ledger. `.env`, `.runs/`, `.cache/`, `.scratch/`, and `docs/` are ignored by Git. Each voice connection saves private 24 kHz mono WAV files under `.runs/<run>/audio/<voice-id>/`: `microphone.wav` (microphone before the noise gate, respecting mute), `input.wav` (microphone audio received by Live and reflected over its control connection; WebRTC encoding may alter the samples), `output.wav` (Live audio received, in order), and `playback.wav` (browser-rendered audio, including silent playback gaps). These are local recordings, not OpenAI stored sessions. They use about 11.5 MB per minute combined. `events.jsonl` includes sample offsets, audio levels, playback backlog, hook events, exact context appends and acknowledgments. `timeline.json` preserves the Gantt when voice ends, the browser disconnects, or the launcher exits. Browser crashes may lose their last in-flight playback packets; audit gaps and failures are logged. Old runs without these files cannot recover audio retrospectively. Delete a run’s directory to delete its recordings.

Treat logs and companion links as private. When reporting a problem, share the error and reproduction steps after removing keys, connection tokens, and private project content.

## Checking an installation

`npm test` runs offline checks without OpenAI spending. `npm run test:ui` checks the live timeline, hover details, navigation, reload, and real browser audio capture/playback between two local WebRTC peers, with a virtual microphone and no paid API connection. `npm run test:hooks` uses synthesized speech to check recall of file/tool details and new work through the one-way channel; it starts a paid voice session. `npm run test:updates` checks a rapid seven-step Claude task, complete thinking delivery without progress speech cues, and status recall with real voice.

The other integration commands in `package.json` start real Claude and OpenAI voice sessions. They require macOS `say`, `ffmpeg`, and the relevant browser setup; they consume API credits. Ordinary use does not require these test tools.

## License

Full-Duplex Code is available under [PolyForm Noncommercial 1.0.0](LICENSE). Preserve the license and required attribution when sharing permitted copies. Commercial use is not granted by this license.
