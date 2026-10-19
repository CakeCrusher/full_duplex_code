// fdc's fallback when no page command fits a page request: a fast model writes a one-off action for
// the page on the stage, from a numbered digest of what can be acted on, and the stage runs it. Only
// DOM work in the page itself: anything that reaches outside it is refused before it runs.

type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const INSTRUCTIONS = `You steer a web page for someone who asked for something by voice. Write the body of an async JavaScript function that does it in this page, with DOM APIs only.
Helpers: el(n) is interactive element [n] from the digest; await show(element) scrolls an element into view and rings it (use it to point at what you changed or found); await wait(ms) pauses (at most 3000).
Prefer clicking the page's own controls (el(n).click()) to changing its markup. To find text, search the DOM (document.querySelectorAll, textContent). Await anything that animates before the next step.
Return one short sentence saying what is on screen now. Never fetch, navigate away, open windows, or touch cookies or storage. Reply with code only, no fences.`;
/** Code that reaches outside the page (network, navigation, storage, other windows) is refused. */
const OUTSIDE = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|import\s*\(|window\.open|location\s*(\.href\s*)?=|location\.(assign|replace|reload)|document\.cookie|localStorage|sessionStorage|indexedDB|eval|Function\s*\()/;

export class FastAction {
  apiKey: string; model: string; fetch: Fetch;
  constructor({ apiKey, model = process.env.FDC_FAST_MODEL ?? 'gpt-5.4-mini', fetch = globalThis.fetch as unknown as Fetch }: { apiKey: string; model?: string; fetch?: Fetch }) {
    this.apiKey = apiKey; this.model = model; this.fetch = fetch;
  }
  /** The action for what the operator said, given the page's digest. */
  async write(said: string, digest: string): Promise<string> {
    const response = await this.fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, instructions: INSTRUCTIONS, input: `${digest.slice(0, 8000)}\n\nThe operator said: "${said.slice(-400)}"`, max_output_tokens: 600, reasoning: { effort: 'none' } }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`The fast model returned HTTP ${response.status}: ${body?.error?.message ?? ''}`);
    const text = String(body.output_text ?? (body.output ?? []).flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? '').join('')).trim();
    const code = text.replace(/^```(?:\w+)?\n?|\n?```$/g, '').trim();
    if (!code) throw new Error('The fast model wrote no action');
    if (OUTSIDE.test(code)) throw new Error(`Refused an action that reaches outside the page: ${OUTSIDE.exec(code)![0]}`);
    return code;
  }
}
