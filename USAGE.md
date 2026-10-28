# Using Full-Duplex Code

Full-Duplex Code adds a voice companion to your normal Claude Code terminal, or to Codex or Pi (see [Use Codex](#use-codex) and [Use Pi](#use-pi)). This guide describes Claude Code first. GPT Live 1 handles the conversation with you; Claude Code remains the coding agent that reads files, runs commands, and makes changes.

You can talk while Claude works, ask about its progress, and give corrections. You can also type directly into Claude. The companion receives hook observations from that same session: submitted prompts, assistant messages, tool arguments and results, file edits, errors, and lifecycle updates.

## Before you start

You need:

- Node.js 22.18 or newer and npm. Node runs the TypeScript sources directly; there is no build step.
- Claude Code installed and signed in. Confirm that running `claude` in a terminal works.
- An OpenAI API key with access to `gpt-live-1`.
- Chrome and a microphone. Headphones can help keep speaker audio out of your microphone.

The tested setup is macOS with Chrome. Other operating systems have not been validated. Claude Code must support channels and the hooks used by this application; organization policies may restrict channel access.

### Sign in with ChatGPT

Sign in with ChatGPT does not currently support GPT Live, so a ChatGPT plan cannot replace the API key. With a plan token, OpenAI allows only `GET /v1/models` and `POST /v1/responses`, and its preview limitations state that "Audio/video input… [is] not supported by this flow" ([OpenAI's docs](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)). GPT Live is `/v1/live/sessions` (the voice endpoint the bridge opens, in [`live-session.ts`](src/core/live-session.ts)). Tested on 2026-10-03 with a Pro plan: `POST /v1/live/sessions` (WebRTC) and its WebSocket both returned `401 rejected_by_access_enforcement` / `no_matching_rule`, while the same requests with an API key connected and talked.

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

A ChatGPT plan can't replace the key: Sign in with ChatGPT doesn't currently support GPT Live's voice endpoint (see [Sign in with ChatGPT](#sign-in-with-chatgpt)). If you'd like it, ask OpenAI to prioritize it on the [developer forum](https://community.openai.com/).

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

The launcher prints the companion link and waits. Open the link in Chrome, then press Enter to start Claude, or Ctrl-C to quit. Claude fills the terminal once it starts, which hides the link until you exit. Accept Claude's development-channel notice and any workspace trust prompt. The page asks for the microphone before anything else; choose **Allow while visiting the site** so Chrome remembers. Once the channel connects, click **Start voice** and wait for the greeting.

The launcher does not open a browser for you. That link grants access to your local companion, so keep it private. With several sessions running, one tab holds them all; see [Several sessions at once](#several-sessions-at-once).

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

The page shows the essentials: the voice controls, the live meters, and three tracks on one clock: the transcript, the agent's events and the requests passed on. **Developer mode** (top right, remembered in this browser) adds the other three tracks, the inspector's JSON, the GPT Live prompt, the microphone threshold and the delivery details.

**Live meters** show the current voice session over the last five minutes, each with a session total: tokens sent to GPT Live per minute, how full its context window is (as GPT Live reports it, about every 15 s), its words and yours per minute, and requests passed on to the agent.

With Developer mode, the browser shows six tracks:

| Track | What it shows |
| --- | --- |
| Operator audio | Microphone activity after the noise gate and mute, including quiet word endings. Filtered background noise leaves gaps. |
| Live speech | Audio actually rendered by the browser, including overlap with your microphone. |
| API transcript | Input ASR and Live’s output transcript on separate rows. Input text can be inaccurate even during silence; it is not proof you spoke. |
| Harness hooks | Every raw observation, including tool calls/results, file changes, displayed text, and lifecycle hooks, at bridge receipt time. The filtered Live view goes to thinking; originals remain here. |
| Context to Live | Every actual thinking append and commentary append, from send to acknowledgment. Click for the exact JSON. Acknowledgment does not mean the model has finished using the content. |
| Requests to harness | Spoken request delivery and prompts submitted directly in the terminal. |

Hover over an item to see its text and timing. Click or tap to pin the full details below the chart; keyboard focus works too. Use **Window** to zoom, the arrow buttons or history slider to look back, and **Follow live** to return to the current moment. Inspecting or reviewing the chart does not pause the microphone, the companion, or Claude.

Bars represent durations; thin markers represent instant events. Request durations describe delivery, not how long Claude spends executing a task. Transcript timing may differ from playback because text and audio travel separately. Microphone activity is a level estimate, not a guarantee that every sound is speech.

Output captions can also omit words that were spoken, or include words absent from the audio. A sentence ending in the transcript is therefore not proof of an audible cutoff. Compare the saved API output and browser playback recordings when investigating missing speech.

Runs also save `audio.transport` events once per second with the browser receiver’s packet and audio-repair counters. These help distinguish native model pauses from degraded delivery. A final lost-packet count of zero does not rule out earlier damage: late packets may arrive after the browser already substituted sound. The counters are diagnostics; they do not alter playback.

Where supported, the browser requests a 200 ms target for WebRTC’s existing network jitter buffer to help recover late packets. Actual delay is chosen by the browser and varies with the connection. Incoming and outgoing audio continue simultaneously; the app does not hold whole sentences, filter speech, or replace Live’s voice. This cannot correct unwanted narration or words that Live never generated.

Click a voice request to see the **full channel message**. **Copy message** copies that text. Expand **Channel notification JSON** for the content and metadata sent by the channel. Once Claude's `UserPromptSubmit` hook arrives, the inspector shows the captured prompt and checks that its contents match the sent message. Until then, delivery is not presented as verified receipt. A mismatch is shown explicitly.

In Developer mode, a request's details also list **Jev checks of these words**: each check Jev made of the request (the instruction check and the hand-off audit), with its time, scores, outcome and the words it judged. A request is outlined in purple when Jev learned an instruction from it or doubts it needed the agent (needsAgent below 0.4).

Each request carries the voice conversation since the previous request, one utterance per line (words GPT Live transcribed from stretches where it heard only silence are left out, and logged as `bridge.unheard_transcript`): yours marked `user:`, Live's marked `voice assistant:`. A one-sentence note at the top tells the agent that the request is in your lines and Live's lines are context. Speech from before the previous request went with it and is not sent again. The bridge does not rewrite transcription mistakes; the inspector shows what was actually sent.

The timeline remains available across page reloads while the launcher is running. It starts fresh with a new launcher. All hooks remain visible. The Context to Live row shows actual sends and acknowledgments separately from hook receipt, so delivery delays are visible.

## Adjusting the conversation

There is one speaking policy, at the end of the startup prompt: listen during routine work; speak when Claude needs your decision or finishes its response with a useful outcome. Explain what is ready, how to use it, and an important limitation when relevant. Finishing a response does not by itself prove the task succeeded. To change it, append an instruction (see [Add instructions to Live](#add-instructions-to-live)), for example “Speak only when I address you.”

Your spoken requests and added instructions take priority over the default: asking a question, changing topic, or asking Live to stop discussing something should lead the conversation. Claude’s observations are background reference material. Live decides whether an unsolicited update is useful; the bridge does not schedule speech cues or promote progress into commentary. The prompt asks Live to finish its current thought despite new observations, while yielding to you. These are model instructions, not a guarantee of exact spoken behavior. The bounded feed and lifecycle-aware prompt are tested together; exact spoken wording remains model-driven. Input ASR can still produce spurious text during silence, so recorded input audio is the source of truth when diagnosing interruptions.

**Learning your standing instructions (optional).** With `TYPESAFE_API_KEY` in `.env` or your environment, the companion asks Jev (TypeSafe's judgment API), in the one reading it makes of your words (when you finish speaking with a page open, when GPT Live passes them on, or when they reach the harness because voice ended): is it an instruction to the voice companion about how to behave toward you from now on, such as "don't read file paths out loud", rather than a task, a one-off "stop" or talk about the tool's design? When it likely is, a one-off run of the same harness (its non-interactive mode, no tools, no saved session) writes the instruction your words amount to, or finds none, or finds one in force that already says it; your own words stay in the log, and if the harness can't be run they are kept as the instruction. The instruction is added to this companion at once under an ID such as I3: the running voice session gets it right away and later voice sessions start with it. The page plays a short three-note sound and shows what was added, with a **Remove** button. Removing it tells the session it is in force in to disregard I3 (an instruction already given can only be countermanded): the running one, or the stored one Resume voice continues; later sessions leave it out. Any page of the companion lists them and can remove them. Every addition and removal is recorded in the run's log with Jev's scores. The instructions stay with this agent conversation: after restarting `fdc` on it they're listed again, and new IDs continue. A private log of learned instructions (`.runs/learned-instructions.jsonl`) is kept for Jev's tuning, when that is on. What you said goes to TypeSafe with each reading, with what happened just before it as context: the agent's recent events, filtered as GPT Live gets them, and the conversation, as far back as a new voice session starts from (about 0.2 s, fractions of a cent); without the key nothing is sent. Replayed on 869 recorded utterances, it added 20; against the 291 labeled by hand, it caught 14 of 24 lasting instructions and added nothing that wasn't an instruction.

**How agent updates reach Live (advanced).** Updates wait while you talk and for a moment after, gather into batches, and heavy tool work in a batch becomes one line. The settings and what each one costs and buys, measured on real sessions, are in `src/core/tuning.ts`; override them with `FDC_TUNING` as JSON, for example `FDC_TUNING='{"compactTokens":3000}' fdc claude`.

**Auditing GPT Live's hand-offs (with Jev).** With `TYPESAFE_API_KEY`, each request that reaches the harness is recorded with how it got there, passed on by GPT Live or sent only because voice ended (GPT Live had kept it), next to Jev's judgment of whether it needed the harness. It only records: deciding what reaches the harness stays GPT Live's job, and nothing is sent because of the audit. The record is `.runs/delegation-audit.jsonl` (owner-only, local), for learning where the two disagree in either direction. Jev's checks of each request are shown in Developer mode, in that request's details on the Requests track.

**Turning sessions on and off by voice (with Jev).** With `TYPESAFE_API_KEY`, before a request GPT Live passed on reaches the harness, Jev also reads it against the companions running now, each as the page's list of running companions shows it (folder, harness, session ID and state, and what hovering it shows), in the same check (about 0.2 s). "Switch to video-editing", "turn on video-editing too", "turn off the six two zero one" (a session ID's first characters) or "stop listening here" turn those companions' voices on or off: one turned on starts voice in its page (Resume when it has a conversation), and this one goes off only once another is on, so you're never left without a voice. Several can be on at once; each hears you and passes your requests to its own harness. A request that asks only for that never reaches the harness: GPT Live is told what was done instead. One that also asks for work still reaches it, and the sessions change too. A session you name that isn't running changes nothing; GPT Live is told which ones are. If Jev is slow or fails, the request reaches the harness as before. The companion to turn on needs its page open on this computer (the fdc tab loads every running session's), with the microphone allowed and the tab clicked since it opened (Chrome allows the microphone and sound only then). Each page reports both, so Jev and GPT Live know which sessions can be turned on, and a session that can't is reported at once with the reason; the companion list shows it on hover.

**Jev tuning those settings (optional).** With `TYPESAFE_API_KEY` and `FDC_JEV_TUNING=1`, whenever your instructions change (one Jev learned, one you added or removed), when you start voice, and in every reading of your words, Jev reads your instructions, with those it learned in your earlier sessions and what you just said, and picks a level for each setting from what that level costs and buys; with your words, it keeps the current levels unless they ask for a change, and a setting changes only when Jev clearly prefers another level (by .3: on 150 real turns, every other change it picked was a near coin toss). The running voice session takes the change at once, and the page shows what changed. Without it, nothing about the companion depends on Jev.

**Preferences about the companion itself (with Jev).** GPT Live passes on your preferences and frustrations about how it behaves ("stop waking up for every little thing", "don't pause so quickly"). When Jev's check is sure that's all a request is about (.85: on 226 real requests none of the work requests scored that high, while plain preferences scored .85 to .93), fdc handles it: it never reaches Claude, GPT Live is told so, and Jev's instruction learning and tuning take it from there. Anything else, or any doubt, reaches Claude as before.

Open **GPT Live prompt** beneath the sliders to read the startup instructions. Before connecting, it previews the next session. During or after a connection, it preserves that session’s startup text. The base prompt and the speaking policy are in `src/core/prompts.ts`, worded from the agent adapter's profile. Workspace/history, the one-time welcome, and later context appends are supplied separately. The browser page is the **voice companion dashboard**, and its Gantt chart is the **live session timeline**.

**Microphone** chooses the input device. **Chrome default** follows Chrome's own microphone setting. Device names appear after Chrome first grants microphone access. The choice is remembered in this browser and applies the next time you click **Start voice**; it is locked while voice is connected, so use **End voice** before switching. If the saved device is unplugged, the list shows Chrome default until it returns.

**Mic threshold** gates the actual microphone samples before they reach Live. The default is 0.8% RMS amplitude; zero disables it. Whisper below the threshold and, once any earlier word tail ends, Live receives digital silence and the operator-audio track stays empty. Lower the threshold and the same whisper passes through and appears on that track. The connection keeps sending silent frames while the gate is closed to keep Live’s clock running.

After speech crosses the threshold, a **300 ms hold** captures quieter word endings. Those quieter samples are sent and shown on the Gantt. Changing the threshold resets the previous hold; mute remains immediate. Chrome is requested to disable automatic gain adjustment so it does not automatically boost a whisper above the gate. The meter shows captured sound before the gate, and the label beneath Mic threshold says **Passing audio to Live** or **Gate closed · sending silence**. Mute silences both recorded microphone tracks.

Quiet speech that already passed the gate is boosted by up to four times before it reaches Live. Loud peaks reduce that boost immediately to avoid clipping; it then recovers gradually. This happens after the gate decision, so below-threshold noise still sends silence. The operator track measures the boosted signal, while the microphone recording preserves the original level.

Chrome carries microphone and speaker audio through **WebRTC**. Its native receiver handles decoding, network jitter and continuous playback; the companion does not schedule or splice speech chunks. The noise gate runs before the outgoing microphone track. The playback timeline and recording measure the decoded speaker track, including receiver delay. This cannot reconstruct words missing from the incoming audio. End voice stops playback immediately.

**Input ASR** is Live’s own transcription output. We do not run an extra recognizer or send this text back to Live. The bridge uses it to assemble a request only when Live delegates. It can contain spurious text even with silent input, so inspect the audio recordings when auditing it.

## What the companion follows

Claude's hooks are the main observation path. Hook text, tool inputs, completed results, edit patches and errors are forwarded, filtered as described below. Base64 data, such as images, PDFs and audio, is replaced by a note of its size, since the text-only context cannot view it. The complete original payload stays in the local hook log and Claude-hooks inspector. Known connection credentials and recognizable API keys are redacted. Hooks, including assistant messages from `MessageDisplay`, go to GPT Live as quiet background context. The companion answers your questions from that context. Live chooses what to say from that context under the conversation prompt. There is no progress timer, speech-cue queue, or commentary generated from Claude hooks. The bridge also sends commentary for the one-time welcome and a brief confirmation after a voice request is successfully sent through Claude’s channel. This confirmation is always on, bypasses the hook backlog and is sent once per request. It confirms delivery, not that Claude has started or finished the work. Acknowledgment from the API does not guarantee that the confirmation was audible.

Claude responds normally in its terminal. The channel has no acknowledgment or reply tools; its only job is to deliver spoken requests into the conversation. Claude treats channel messages as external input: in 34 real trials of a spoken request arriving mid-turn, it acted on 15 and questioned whether 24 were really yours ("that request came through the voice channel rather than from you in this chat"). So when Claude's prompt hook reports a voice request this companion delivered (matched by its message ID), the hook adds one note to Claude's context: the message is your own speech, transcribed by the voice companion you started with the session, to be treated as if typed. With the note, Claude acted on 28 of 30 (the other two accepted the request before the trial ended) and questioned none. Channel messages the companion did not send get no note, and the hook adds nothing to any other event. A request marked **Delivered to channel** has been sent; **Received by Claude** means its prompt hook was observed. Neither status means Claude completed the work. Follow Claude's observed activity and results for progress.

The bridge saves every original observation locally. Assistant text from `MessageDisplay`, typed prompts, and restored user/assistant transcript text are sent in full. `Stop` is not sent, because its text repeats what `MessageDisplay` already carried; the turn state on later observations shows that the turn finished, which does not mean its program was verified. A voice request that comes back as Claude's prompt is sent as a short frame, since GPT Live already has it. Every forwarded observation keeps its hook name and Claude's turn state.

One table in the adapter decides the rest ([Claude](src/adapters/claude/context.ts), [Codex](src/adapters/codex/context.ts), [Pi](src/adapters/pi/context.ts)). Each row removes an event or fields, or truncates fields to a number of characters, keeping their start and end. For Claude, whole files (Write's content, an overwrite's patch, the file before an edit), the text of a file read and Bash's stdout keep their first and last 600 characters; commands and stderr are always whole; PDF pages and connection bookkeeping are removed; `PostToolBatch`, which repeats each `PostToolUse`, is not sent. Anything the table does not name is sent whole. A tool record still over about 1,200 tokens arrives with the note "large result, shown untrimmed": that marks a gap in the table, and GPT Live may mention it. Identical repeated bodies refer back to the earlier hook. Exact original code and logs remain available in the raw hook inspector.

Observations go to GPT Live in batches. The first waits a second, each further one adds a second, and a batch never waits more than ten seconds. While you are talking, and for two seconds after you stop, the batch keeps waiting, still within the ten seconds; a batch already going in pauses the same way. That keeps bursts of agent work from landing while GPT Live listens and decides whether to pass your request on. Requests, completion, errors and permission events skip the wait for more updates, but not the wait for you. Your microphone level (after mute and the noise gate) tells the bridge you are talking; pages that send no levels fall back to GPT Live's transcript of your speech. When a batch's tool calls and results add up to more than about 900 tokens, they become one line saying what ran, such as "[Claude made 3 Bash calls, 1 Read call; their details are omitted]"; the agent's own messages, failures, prompts and turn ends always arrive whole. The bridge preserves observation order and does not drop whole events or hold new hooks behind pending acknowledgments. `events.jsonl` retains the originals; `context.prepared` records the derived text, each record's size and receipt time, and how many tool records a summary line replaced. Bulky tool fields are reduced before delivery, while assistant prose remains complete.

Appends respect the API's 500-token limit and preserve send order. Individual fragments do not wait for individual acknowledgments; actual socket backpressure can delay writes. The dashboard shows locally waiting hooks, pending appends, and estimated backlog separately. That estimate is informational, not a delivery gate or an API guarantee. API acknowledgments estimate context injection, not comprehension. Only your speech holds agent context, for at most ten seconds. Configuration changes and delivery confirmations bypass the background feed. On a voice restart, saved history is restored through the same path after the initial history prefix. An append failure ends voice with an error rather than silently continuing with stale context. Local hook requests have a 32 MiB transport limit; oversized events are reported.

The launcher registers passive lifecycle hooks, including tool batches, subagent activity, permission events, and compaction. `WorktreeCreate` is excluded because registering it replaces Claude's own worktree creation. `FileChanged` forwards events for files configured in Claude's watch list; it does not automatically watch every file. Tool hooks already describe changes made through Edit and Write, plus the commands and results of Bash. See the [Claude hooks reference](https://code.claude.com/docs/en/hooks) for watch-path configuration and event availability. Use a current Claude Code release; this flow was tested on 2.1.270.

Hooks report tool operations at their boundaries. A running command's stdout normally arrives with its result, not as a continuous byte stream. Unsent terminal drafts and private thinking are not part of this feed.

## Present a page

When Claude shows you a page in Chrome (a diagram, a deck, a report), fdc moves it while you talk, without waiting
for Claude. The voice presents, Claude produces, and fdc's voice tool sits between them:

- **The voice moves it as it speaks.** Ask for a part by name ("go to the secure handshake"), for the next or previous
  one, or for a walkthrough: the voice says "let's look at" and the part's name, or "let's go to the next one" or
  "let's go back one", and the page goes there as the words are said.
- **Walkthroughs are paced.** Ask to be walked through ("walk me through tonight's slides"): the voice presents the part on
  screen, and each time it finishes and goes quiet, fdc moves the page on and has it present the next one, until the
  last part or until you speak.
- **The voice tool moves it on request.** "Next", "go back", "the DNS lookup, then the response", "highlight the
  explanation under the DNS lookup", "go back to the diagram" (another page Claude opened): the voice tool runs the
  page's commands in about a second and tells the voice what is on screen. Only what the page can't do goes to Claude.
- **Changes go to Claude.** "Take me to the response and make its text shorter" moves the page at once and passes the
  rewrite on.
- **Complaints improve the page.** When the page doesn't do what you meant ("the page isn't moving"), the request
  reaches Claude with a note to improve the page's controls, so the voice can do it next time.

The page's controls come from its structure (headings, sections, slides, read like a screen reader would) and, for
anything interactive, from a small controller Claude writes beside the page following [STAGE.md](STAGE.md), in its own file
it grows as you ask for more. One highlight shows at a time: fdc's ring around a part it moved to, or the page's own
highlight after one of its commands. fdc's page
notes each move: "The page followed the voice" or "The voice tool moved the page". This needs
[Open Claude in Chrome](https://github.com/noemica-io/open-claude-in-chrome), the browser tools Claude uses: fdc reaches the page through the same
connection. Without it, page requests go to Claude like any other.

## Approvals and attention

By default, approve tools and respond to Claude's permission prompts in the terminal. The companion can tell you that attention is needed, but it does not approve tools for you. To launch Claude with tool permission checks disabled, pass `--dangerously-skip-permissions` as shown below.

If Claude asks a question, you can answer by voice or in the terminal. Keep the terminal visible so you can inspect changes, commands, and any prompts that require direct interaction.

## Pause or stop

- **Mute microphone** stops sharing your microphone input. Voice stays connected and billable. Click **Unmute microphone** to speak again.
- **End voice** closes the paid voice connection. Claude stays open and can continue working.
- **Resume voice** (shown once there is a conversation to continue) picks up where voice left off. When OpenAI stored the last voice session, voice continues it (a fork: GPT Live keeps the whole conversation, its instructions, and catches up on Claude's work it hadn't received). A session that dropped can be forked too, about 8 seconds after it ended, once OpenAI has stored it. Otherwise (storage off, a fork refused, or the automatic reconnect right after a drop) a new session starts with the spoken conversation's text: the newest operator and GPT Live turns that fit in GPT Live's startup limit (128 messages, 8,192 tokens), beside the usual startup context. This also works after restarting `fdc` on the same conversation (see [Resume a conversation](#resume-a-conversation)); stored sessions can be continued for 30 days.
- **Start fresh** (or **Start voice** when there is nothing to resume) opens a new connection without the earlier conversation. Its startup context holds the most recent observations retained by this launcher, including work performed while voice was off, within a fixed size limit. Longer records are shortened to their start and end. Earlier history is not re-sent; it stays in the local log. Only observations that arrive after the connection opens are sent as they happen.
- Exit Claude in the terminal to stop the whole application.

Closing the companion tab also closes its voice connection. A disconnected voice session does not erase Claude's conversation.

## Standby

When the conversation stays quiet, voice goes on **Standby**: GPT Live disconnects and its billing stops, but voice stays on. The page keeps your microphone open on this computer, sending nothing anywhere, and fdc keeps following Claude. Two soft falling notes mark it, the page says **Standby · speak to wake it**, and the timeline shows Standby as a gray band across every track.

- **What counts as quiet.** Everything in the conversation has a price in one currency, nothing privileged: each tenth of a second of your voice or of GPT Live's audio 20, Claude's events by kind (a tool call 1, each display batch of a message 10, a finished or failed turn 50, an approval request 100), and requests GPT Live passes on (100). Each counts for exactly the quiet window, 60 seconds; when everything from the last 60 seconds is worth less than 50, voice goes on Standby: it keeps drifting toward Standby, and only activity worth the threshold holds it off. A request still on its way to Claude keeps voice on.
- **What wakes it.** The same prices: about half a second of your voice (sound that repeats at a speaking pitch, for
  longer than a tenth of a second: chewing, typing or a knock on the table don't count), Claude finishing or failing a turn (Codex and Pi too: their reply comes as one message, which with a turn worth 30 didn't wake it), an approval request, or a request. As it wakes, the page plays the start sound's first note, then again softly while voice reconnects and your held words go in; then the whole start sound. **Wake now** wakes it at once.
- **Nothing you say is lost.** On Standby the page holds your microphone: when voice wakes, it keeps what you said from where you started talking (back to your last pause of a second and a half), and everything you say while voice reconnects, however long that takes. Once connected, that audio goes to GPT Live first and your live microphone follows behind it, catching up at your pauses, so GPT Live may answer a few seconds later than usual, about as long as voice took to reconnect. Claude's updates wait until GPT Live has heard you.
- **The conversation continues.** A wake resumes the paused session, as Resume voice does: a fork, so GPT Live keeps the whole conversation and everything it was told, catches up on Claude's work, and isn't greeted. What changed while voice was paused is told to it as conversation: the page on the stage as it is now, and any instruction learned since. GPT Live's own instructions hold only what never changes (fdc's and your learned instructions), since a fork keeps the instructions its first session started with. When GPT Live trims a full context (past 90% it keeps those first instructions and about 8,000 tokens of the rest), fdc tells it the page and your instructions again. A resume takes longer the fuller the context: 2 seconds at 15%, 7 at 55%, 8.5 at 75%, against about 1.7 for a new session; so past 60%, or after fdc itself was updated, a wake starts a new session instead, holding your instructions, the conversation's text and the page. If a resume doesn't start, a new session takes over on the same microphone, and wakes start afresh for the next 10 minutes. Either way, what Claude did meanwhile arrives as it would have live, and GPT Live reports what its speaking rules call for.
- **Ending it.** **End voice** works on Standby too; what you said that wasn't passed on goes to Claude, as when voice ends. Turning a session off by voice ends its Standby; turning it on wakes it.
- **Settings.** The window and the threshold are `standbyAfterMs` (60000; 0 never goes on Standby) and `wakeThreshold` (50); the prices are `speechPrice` (20), `liveSpeechPrice` (20), `toolPrice` (1), `promptPrice` (1), `messagePrice` (10), `turnEndPrice` (50), `failurePrice` (50), `approvalPrice` (100) and `requestPrice` (100). The defaults are the ones chosen in the Standby sandbox on recorded conversations, with the window raised from 15 to 60 seconds at the operator's request (Oct 28). With Jev's tuning on, Jev chooses each of them from your instructions and words, reading what each level was measured to cost and buy (`src/core/tuning.ts`); you can set any of them with `FDC_TUNING`, for example `FDC_TUNING='{"standbyAfterMs":30000,"speechPrice":10}'`, and Jev then leaves those alone. Replayed on 181 real voice sessions (59 hours): someone was speaking 46% of the time, so Standby can save at most about a quarter; with a 15-second window it saved 21% overall with about 18 wakes an hour (3 of them noise), and most of one session in which the operator stepped away; with the 60-second window, 8% with about 3 wakes an hour.
- **Developer mode** lists every setting with its value, its default, who set it last (the default, `FDC_TUNING`, or Jev and when) and what each of its levels does, and every change in this run.

When voice ends without anyone asking (the connection to GPT Live is lost, GPT Live closes it, or its audio stream stops while the page is still sending your microphone), the page reconnects by itself and resumes the conversation, at most twice in five minutes. Speech that had not been passed on to Claude goes with the next request instead of being sent when the connection drops. **End voice**, closing the tab, or moving voice to another page never reconnects. Below the voice buttons, the page shows whether it uses the local or the public link, and the last drop.

## Resume a conversation

Use Claude's own resume options, in the same project folder:

```sh
fdc claude --resume CLAUDE_SESSION_ID
```

`fdc claude --continue` and `fdc claude --resume` (Claude's picker) work too; the companion learns the session's ID from Claude's first hook. For a session launched by Full-Duplex Code, the terminal prints a **Local run** folder at startup. Open `connection.json` in that folder and copy its `sessionId` value. Use the complete ID; do not use the short suffix of the folder name. Keep the rest of that file private because it also contains connection credentials.

Accept the channel notice, open the new companion link, and click **Resume voice** to continue the earlier voice conversation, or **Start fresh**. The companion keeps each Claude session's last voice session and its spoken conversation in `.runs/voice-resume/`, readable only by you. The companion reads saved prompts, assistant text, tool calls, and tool results from that Claude session's transcript. Like any new voice connection, it starts with only the most recent of these; the rest stays in the transcript. Transcript records supply the history; newly arriving hooks supply live observations. Private thinking is not imported. The voice model has a finite context capacity.

## Add instructions to Live

Open **GPT Live prompt** in the companion, enter a short instruction under **Append a system instruction**, and click **Append instruction**. This adds guidance without replacing the base prompt or sending a request to Claude. While it is being applied, the exact text appears below with **Applying…**, or **Not confirmed** if it failed. Once Live acknowledges it, it appears at the end of the GPT Live prompt itself. An acknowledgment confirms that the API accepted it; it does not prove the model followed it.

Instructions added before voice starts appear in the prompt preview and are included when voice starts. They also carry into later voice connections in the same running companion. A new launcher starts fresh.

## Useful launch options

The companion's own options go between `fdc` and the agent's name: `fdc [options] <agent> [the agent's own arguments]`. An option the launcher does not know stops it before anything starts.

| Option | Purpose |
| --- | --- |
| `--voice marin` | Choose the GPT Live voice. |
| `--observe transcript` | Add saved-text/tool fallback observation if display hooks are unavailable. |
| `--port 8123` | Choose the local port. The default is 8123, so the companion address and Chrome's microphone permission stay the same between launches. If 8123 is busy, for example with a second companion, the launcher uses a free port and says so. `--port 0` always chooses a free port. |
| `--public` | Also reach the companion from a phone, through a temporary Cloudflare tunnel the launcher starts and stops. See [Use it from your phone](#use-it-from-your-phone). |
| `--no-store` | Don't ask OpenAI to store voice sessions. By default each voice session is created with `store: true`, so that **Resume voice** can continue it exactly. OpenAI keeps stored session recordings (audio and conversation) for 30 days and offers no public way to delete them earlier; projects with Zero Data Retention, or without storage enabled, can't store them. With `--no-store`, or when OpenAI refuses storage, **Resume voice** starts a new session with the conversation's text instead. |

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
- The companion observes Codex's hooks (prompts, tools, approvals, turn ends) and follows its transcript for assistant messages and steered requests. The final message of a turn is observed once. What reaches GPT Live follows the same rules as for Claude, with Codex's own table: patches, command output and web results keep their first and last 600 characters.

Refused, with the reason: `codex exec` and `codex review` (no interactive terminal), `--remote` (the companion attaches Codex to its own app server), and turning hooks off. `fdc codex --help` and subcommands such as `fdc codex login` run Codex directly.

To resume a Codex session, use Codex's own `resume` in the same project folder: `fdc codex resume SESSION_ID`, `fdc codex resume --last`, or `fdc codex resume` for Codex's picker. The session ID is in `connection.json` in the run folder, as for Claude, and in Codex's own session list.

When context lands while you finish speaking, GPT Live sometimes answers without passing the request on: in a check, it delegated 3 of 5 requests while context arrived every 1.5 seconds, and 4 of 4 without. Agent updates therefore wait while you talk and for two seconds after (see the context section). If a request does not show up in the timeline, say it again.

When a voice session ends for any reason (you end it, the microphone stream stops, the connection drops), whatever you said since the last request GPT Live passed on goes to the agent anyway. It is marked as sent because the session ended, with the reason, so the agent knows it may be unfinished or not a request at all. Nothing is sent if everything you said had already been passed on.

## Use Pi

Put `fdc` in front of your usual Pi command, in your project's folder. Pi's own options work as usual:

```sh
fdc pi
fdc pi --model sonnet:high
fdc pi --continue
```

You need Pi 1.0, signed in once with `/login` inside Pi; `fdc doctor pi` checks both. Pi can be installed or run from a checkout through a shell alias, such as `alias pi=~/pi/pi-test.sh`.

How it connects:

- Pi has no hooks, channel or app server. Its extensions are its way in, so the launcher loads the companion's extension ([`extension.ts`](src/adapters/pi/extension.ts)) for this run only, with `-e`, ahead of your own arguments. Nothing is installed in Pi, and `--no-extensions` still loads it. Your own extensions and MCP servers load beside it.
- The extension forwards Pi's events to the bridge, as a command hook does: your input, each finished message, each tool's start and end, questions waiting in the terminal, compaction, and the end of the run (`agent_settled`, after which Pi will not continue by itself). It leaves out each token of a message and partial tool output, whose end events carry them whole, and events that repeat the whole context. Its handlers return nothing, so it never changes what Pi does.
- A spoken request reaches Pi through the same extension, labeled `[Voice request …]`, as a steer: while Pi works, it lands after the current tool calls and before the next model call; while Pi is idle, it starts a turn. Pi reports it as input from the extension, which the timeline shows as received.
- The extension reports Pi's session as Pi starts, so you can click **Start voice** before typing anything. With `--continue`, `--resume`, `--session` or `--fork`, the session's saved messages are context for GPT Live from the start, read from Pi's session file. `/new`, `/resume` and `/fork` inside Pi move the companion to the new session.
- What reaches GPT Live follows the same rules as for Claude, with Pi's own table: the assistant's text stays whole, the provider's bookkeeping and the signatures of its reasoning are removed, finished messages that repeat an input or a tool result are not sent, and file content, command output and script output keep their first and last 600 characters.

Refused, with the reason: `-p` / `--print` and `--mode json` or `rpc` (no interactive session). `fdc pi --help`, `--version` and subcommands such as `fdc pi mcp list` run Pi directly. Pi Durable's coding agent loads no extensions, so the companion cannot reach it.

The launcher finds every agent's command as your shell does: on your PATH, or else as an alias in your interactive shell, which it reads once and runs directly. A shell function is not followed.

## Several sessions at once

With more than one `fdc` running from this installation, one tab holds them all. A strip at the top of the page lists them: folder, agent and session, whether voice is on, ready (the microphone allowed and the page clicked), the agent not connected, or unreachable, and which are public. The tab loads every running session's page; click one to show it in place of the current one. A session you don't see keeps running: if its voice is on, it keeps listening and talking, so several sessions can talk in one tab at once (on speakers, each also hears the others; headphones avoid that). Allowing the microphone once for the tab covers every session in it. The tab belongs to the session you opened it from: if that `fdc` stops, open another's link. A page opened through `--public` lists only companions that are public too, and never another's local link.

## Use it from your phone

You can talk to Claude from your phone while it keeps running on your computer. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) once (for example `brew install cloudflared`), then add `--public`:

```sh
fdc --public claude
```

The launcher starts a temporary Cloudflare tunnel, waits until the link actually opens the page, and prints a **From your phone** link with a QR code. (Cloudflare names a new tunnel a few seconds before the name resolves; a device that tried it in that window could be told it does not exist for up to a minute, so the launcher checks with Cloudflare's own nameservers first.) Scan it with your phone's camera, open it in Chrome or another Chromium browser, and click **Start voice**. Then press Enter in the terminal to start Claude. When Claude ends for any reason, including Ctrl-C at the prompt or closing the terminal, the launcher closes the voice session and stops the tunnel. Without `--public`, nothing is reachable from outside this computer.

You can open the page on your computer and on your phone at the same time, in any order, before or after Claude starts. Every open page follows the session, and voice runs in one of them. On another page, **Start voice** becomes **Move voice here**, which ends voice where it was and starts it on that page. A page whose connection drops, for example when the phone sleeps, reconnects by itself; voice on that page ends, and you can start it again. Each start of `fdc` makes new links, so a page opened from an earlier start's link says so.

The tunnel gives the page the `https://` address a phone needs for its microphone. Voice audio does not use it: it goes directly between the phone and OpenAI, as it does from a desktop browser. The page's local audio audit copy does travel through it (about 1.3 Mbit/s); when the phone's uplink falls behind, the page drops audit audio until it catches up, and the audit records the gap. It never ends voice. Only the page and its voice connection are accepted through the tunnel; Claude's hooks and channel connection are refused unless they come from this computer directly.

**Keep the link private.** The tunnel's address is new and random each run, but it is public, and the secret in the link is the only lock. Anyone with the link can direct Claude on your computer; with `--dangerously-skip-permissions`, that includes running any command.

Keep the companion page in the foreground on your phone: locking the screen or switching apps can pause the microphone, and voice ends after 5 seconds without microphone audio. Click **Resume voice** to continue. Your computer must stay awake while the launcher runs.

## Costs

OpenAI bills the connected voice session, including time spent listening or muted. Claude usage remains on your existing Claude account. Use **End voice** when you are done.

```sh
fdc usage
```

The application estimates voice cost at $0.05 per minute and tracks cumulative usage without a local spending cap. GPT Live bills by the second, but at least 15 seconds for each session the page connects (WebRTC): twelve 5-second sessions billed 3 minutes, $0.15 (Oct 21). Standby's quiet window (60 seconds) already keeps every session that long, so a wake costs nothing extra. Voice stays connected until you end it, close the companion, or the connection ends, except on [Standby](#standby), which disconnects it while the conversation is quiet; there is no local duration limit. Check [OpenAI's model page](https://developers.openai.com/api/docs/models/gpt-live-1) for current service pricing and availability.

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
| Claude hooks | Every raw observation, including tool calls/results, file changes, displayed text, and lifecycle hooks, at bridge receipt time. The filtered Live view goes to thinking; originals remain here. |
| Context to Live | Every actual thinking append and commentary append, from send to acknowledgment. Click for the exact JSON. Acknowledgment does not mean the model has finished using the content. |
| The companion misses terminal text | Confirm Claude was started through this launcher. If hooks are unavailable, restart the same session with `--resume SESSION_ID --observe transcript`. |
| The page says its link is from an earlier start | Each start of `fdc` makes a new link. Open the link it printed this time. |
| Voice is on in another tab or device | Voice runs in one page at a time. Click **Move voice here** to bring it to this page. |
| Voice disconnected | The page reconnects by itself and resumes voice, up to twice in five minutes; after that, click **Resume voice**. Resolve any terminal or channel issue first. |
| An old launcher still reports a budget limit | Exit Claude with `/exit`, restart the launcher, and use the newly opened companion tab. |

Voice closes automatically if microphone streaming stops (or GPT Live stops receiving it; the 5 seconds start counting once GPT Live's audio has started) or the Claude channel remains disconnected. This avoids leaving a paid connection running without a usable companion.

## Local records and sharing

`.runs/` contains connection details, event logs, conversation text, and the usage ledger. `.env`, `.runs/`, `.cache/`, `.scratch/`, and `docs/` are ignored by Git. Each voice connection saves private 24 kHz mono WAV files under `.runs/<run>/audio/<voice-id>/`: `microphone.wav` (microphone before the noise gate, respecting mute), `input.wav` (microphone audio received by Live and reflected over its control connection; WebRTC encoding may alter the samples), `output.wav` (Live audio received, in order), and `playback.wav` (browser-rendered audio, including silent playback gaps). These are local recordings; OpenAI's stored sessions (see `--no-store`) are separate. They use about 11.5 MB per minute combined. `events.jsonl` includes sample offsets, audio levels, playback backlog, hook events, exact context appends and acknowledgments. `timeline.json` preserves the Gantt when voice ends, the browser disconnects, or the launcher exits. Browser crashes may lose their last in-flight playback packets; audit gaps and failures are logged. Old runs without these files cannot recover audio retrospectively. Delete a run’s directory to delete its recordings.

Treat logs and companion links as private. When reporting a problem, share the error and reproduction steps after removing keys, connection tokens, and private project content.

## How the code is organized

The TypeScript sources run directly under Node; the bridge strips the page modules' types when it serves them. `npm run typecheck` checks everything with `tsc`.

- `src/core/` is the part shared by every coding agent: the bridge and its endpoints, the open pages, voice sessions, the mediator, the observation feed, the context queue, the delivery outbox, status and the event log, the timeline, the audio audit, the usage ledger and the command-hook relay.
- `src/adapters/claude/` is everything specific to Claude Code: its hooks and launch flags (`launch.ts`), how its hooks become observations and turn state (`observer.ts`), what of them reaches GPT Live (`context.ts`), the voice channel it is reached through (`delivery.ts`, `channel-server.ts`) and its wording (`profile.ts`).
- `src/adapters/codex/` is the same for Codex: its app server and hooks (`app-server.ts`), its command (`launch.ts`), hooks and transcript as observations (`observer.ts`), and delivery by `turn/steer` or a new turn (`delivery.ts`).
- `src/adapters/pi/` is the same for Pi: the extension Pi loads (`extension.ts`), its command (`launch.ts`), its events and session file as observations (`observer.ts`), and delivery through the extension (`delivery.ts`).
- Every adapter reads its agent's own arguments (`arguments.ts`).
- `src/launcher/` holds the launcher's option parsing, Enter prompt and tunnel; `src/cli.ts` runs them.
- Presenting a page lives in `src/core/presenter.ts` (the voice's words moving the page, the gate's page requests), `src/core/stage.ts` with `stage-page.js` (the page in the browser, reached through Open Claude in Chrome), `speech-cues.ts` and `fast-action.ts` (one-off steps when no page command fits); the gate itself is in `sessions.ts`. Jev reads the conversation once per moment (`jev.ts`): the gate, the page, the learner and the tuner share that reading; `delegation-audit.ts` records each hand-off with it.
- `web/` is the page: audio I/O, page UI, bridge client, WebRTC peer, timeline view, sound cues and the audio worklet.

The core reaches an agent only through the adapter contract in `src/core/adapter.ts`: a `profile` (names, the event that ends a turn, whether assistant text streams during the turn and whether a request can reach a running turn), `launch()`, `observations` in one shared format (kind, text, raw event, time, turn state), `deliver()`, which reports how far a request got, and `history()`. Prompts, context labels, the page and the timeline take the agent's names from its profile.

To support another coding agent, start from [CONTRIBUTING.md](CONTRIBUTING.md).

## Checking an installation

`npm test` runs offline checks without OpenAI spending. `npm run test:pages` opens companion pages in real Chrome in the orders people use: before the agent is ready, on two devices at once, moving voice between them, after a dropped connection, from an earlier start's link and after the companion stops; `npm run test:pages -- --public` does the same with the second device on a real Cloudflare tunnel. Neither spends API credits. `npm run test:standby` checks Standby in real Chrome with a stand-in GPT Live: quiet goes on Standby, speaking wakes it by resuming the paused session (a slow one too), the far end hears the speech from before and while it reconnected, and a resume that never starts gives way to a new session on the same microphone; no API credits. `npm run test:standby-voice` does it with real Claude and real GPT Live (about a minute of billed voice): Claude finishing a slow task wakes voice and GPT Live reports it without a greeting, then speaking wakes it and GPT Live answers from the conversation. `npm run test:ui` checks the live timeline, hover details, navigation, reload, and real browser audio capture/playback between two local WebRTC peers, with a virtual microphone and no paid API connection. `npm run test:hooks` uses synthesized speech to check recall of file/tool details and new work through the one-way channel; it starts a paid voice session. `npm run test:updates` checks a rapid seven-step Claude task, complete thinking delivery without progress speech cues, and status recall with real voice.

`npm run test:codex` runs one real Codex session with real voice: a spoken request steers Codex's running turn, and Codex acts on it in that turn. `npm run test:codex-start` starts real Codex without a first message, then resumes and forks that session; each time a request delivered before anything is typed becomes the session's first message. It uses a little Codex usage and no voice. `npm run test:pi` does the same for real Pi: a request as the first turn, a second one steered into a running command, then the session continued. It uses a little of the model usage Pi is signed in to, and no voice; set `PI_BIN` to a checkout's `pi-test.sh` when no `pi` is on the PATH. `npm run test:pi-voice` adds real voice: a spoken request steered into work typed in Pi's terminal, then a spoken question GPT Live answers from Pi's events. The other integration commands in `package.json` start real Claude and OpenAI voice sessions. They require macOS `say`, `ffmpeg`, and the relevant browser setup; they consume API credits. Ordinary use does not require these test tools.

## License

Full-Duplex Code is available under [PolyForm Noncommercial 1.0.0](LICENSE). Preserve the license and required attribution when sharing permitted copies. Commercial use is not granted by this license.
