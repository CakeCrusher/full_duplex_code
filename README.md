# Full-Duplex Code

Talk to Claude Code, or Codex, while it works. A voice companion powered by GPT Live 1 listens, speaks, and follows your coding session. Keep using the normal terminal, including typing directly into it.

![Full-Duplex Code: talk to the voice companion while Claude Code keeps working](assets/full-duplex-code.gif)

Ask for a change, ask what just happened, or change direction while Claude is working. The companion follows Claude’s messages, file edits, commands, and tool results automatically. It answers from that context and passes requests to Claude when more work is needed.

You don't have to stay at your desk. Hand off a task, go do something else, and keep talking to Claude from wherever you are: check in, change your mind, and hear when it's done.

![Full-Duplex Code: hand off a game change, take a bath, check in and redirect by voice, then come back to the finished game](assets/full-duplex-hand-off.gif)

## Quick start

You'll need Node.js 22.18+, Claude Code or Codex (0.155 or newer) installed and signed in, Chrome, a microphone, and an OpenAI API key with GPT Live 1 access. Tested on macOS.

```sh
git clone https://github.com/CakeCrusher/full_duplex_code.git
cd full_duplex_code
npm ci
npm link
```

`npm link` puts the `fdc` command on your PATH.

Create a `.env` file in this folder with your key:

```dotenv
OPENAI_API_KEY=your-key-here
```

In your project's folder, put `fdc` in front of the command you normally run:

```sh
cd /path/to/your/project
fdc claude
```

Claude Code's own flags go after `claude`, unchanged. To skip its tool permission prompts:

```sh
fdc claude --dangerously-skip-permissions
```

Codex works the same way: `fdc codex`, followed by Codex's own options. Requests you speak steer its running turn.

1. Open the companion link printed in the terminal in Chrome, then press Enter in the terminal to start Claude. Claude fills the terminal, which hides the link until you exit.
2. Accept Claude's development-channel notice and any workspace trust prompt, then click **Start voice** in the companion and allow microphone access.
3. Start talking: “Ask Claude to add a dark mode.” You can also type into Claude and ask, “What did I just tell Claude?”

**End voice** stops the voice connection and its billing. Claude stays open. **Mute microphone** keeps the paid voice connection running.

To stop everything, type `/exit` in the Claude terminal and press Enter.

For setup details, resuming a session, costs, and troubleshooting, read the [user guide](USAGE.md). Run `fdc doctor` to check your setup, or `fdc usage` to check spending.
