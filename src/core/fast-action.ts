// fdc's fallback when no page command fits a page request: a fast model picks a short list of actions from
// a fixed set (click a numbered control, show one, find text, scroll, wait), which the stage carries out in
// the page itself. No code is written or run, so nothing on a page can steer the model into reaching
// outside it, and a link to another site is never followed (stage-page.js).

type Fetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** One step on the page. n is an element's number in the digest. */
export type PageAction = { do: 'click'; n: number } | { do: 'show'; n: number } | { do: 'find'; text: string } | { do: 'scroll'; to: 'up' | 'down' | 'top' | 'bottom' } | { do: 'wait'; ms: number };
export interface OneOff { actions: PageAction[]; say: string }

const INSTRUCTIONS = `You steer a web page for someone who asked for something by voice. Choose the steps that do it, from these only:
{"do":"click","n":N} clicks interactive element [N] of the digest (a tab, button, toggle, link on this site);
{"do":"show","n":N} scrolls element [N] into view and rings it;
{"do":"find","text":"..."} finds the smallest thing anywhere on the page, on screen or not, whose text contains these words (a row, a number, a phrase), scrolls to it and rings it: use the operator's own words for what to find ("Gemini", "Q3");
{"do":"scroll","to":"up"|"down"|"top"|"bottom"};
{"do":"wait","ms":M} waits up to 3000 ms (after a click that animates).
Use what the digest says is on screen to answer questions about it: point at the answer with find. Find already scrolls to and rings what it finds: don't add a show after it. Use show only with a number from the digest.
Reply with JSON only: {"actions":[...],"say":"one short sentence saying what is on screen now, with the answer if one was asked"}. At most 6 steps.`;

const VERBS = new Set(['click', 'show', 'find', 'scroll', 'wait']);
/** Only the fixed steps, with their arguments checked; anything else is refused. */
export function parseOneOff(text: string): OneOff {
  let body: any;
  try { body = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()); } catch { throw new Error(`The fast model did not answer with page steps: ${text.slice(0, 120)}`); }
  const actions = Array.isArray(body?.actions) ? body.actions.slice(0, 6) : [];
  if (!actions.length) throw new Error('The fast model chose no page steps');
  for (const a of actions) {
    if (!a || !VERBS.has(a.do)) throw new Error(`Refused a page step: ${JSON.stringify(a).slice(0, 80)}`);
    if ((a.do === 'click' || a.do === 'show') && !(Number.isInteger(a.n) && a.n > 0 && a.n <= 200)) throw new Error(`Refused a page step: ${JSON.stringify(a)}`);
    if (a.do === 'find' && !(typeof a.text === 'string' && a.text.trim() && a.text.length <= 120)) throw new Error(`Refused a page step: ${JSON.stringify(a).slice(0, 80)}`);
    if (a.do === 'scroll' && !['up', 'down', 'top', 'bottom'].includes(a.to)) throw new Error(`Refused a page step: ${JSON.stringify(a)}`);
    if (a.do === 'wait') a.ms = Math.max(0, Math.min(3000, Number(a.ms) || 0));
  }
  return { actions, say: typeof body.say === 'string' ? body.say.slice(0, 300) : '' };
}

export class FastAction {
  apiKey: string; model: string; fetch: Fetch;
  constructor({ apiKey, model = process.env.FDC_FAST_MODEL ?? 'gpt-5.4-mini', fetch = globalThis.fetch as unknown as Fetch }: { apiKey: string; model?: string; fetch?: Fetch }) {
    this.apiKey = apiKey; this.model = model; this.fetch = fetch;
  }
  /** The steps for what the operator said, given the page's digest. */
  async write(said: string, digest: string): Promise<OneOff> {
    const response = await this.fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, instructions: INSTRUCTIONS, input: `${digest.slice(0, 8000)}\n\nThe operator said: "${said.slice(-400)}"\nAnswer with the JSON.`, max_output_tokens: 400, reasoning: { effort: 'none' }, text: { format: { type: 'json_object' } } }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`The fast model returned HTTP ${response.status}: ${body?.error?.message ?? ''}`);
    // The answer can come in more than one part (the same JSON twice): the first that parses is it.
    const parts: string[] = typeof body.output_text === 'string' && body.output_text ? [body.output_text] : (body.output ?? []).flatMap((o: any) => o.content ?? []).map((c: any) => String(c.text ?? '')).filter(Boolean);
    let failure: Error | undefined;
    for (const part of parts) { try { return parseOneOff(part); } catch (error) { failure ??= error as Error; } }
    throw failure ?? new Error('The fast model wrote no page steps');
  }
}
