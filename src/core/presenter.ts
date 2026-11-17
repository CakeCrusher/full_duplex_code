// The presenter: fdc working the page the coding agent made, for the operator, while the agent goes on producing. The
// operator never has to know how the page is worked; they talk, and it is done:
// - What the operator asks for that a command of the page does (choose this, set that, add it, place it, show me the
//   other one), the voice tool does as their turn ends, from the turn's request (turn.ts): one command, then the page
//   is read again and the next, until Jev wants no more (requests of their own, only about the page's commands). GPT
//   Live is told what was done.
// - A part's name after a turning phrase GPT Live says ("let's look at" the results, speech-cues.ts) moves the page at once.
// - Every other sentence it says, bare acknowledgments aside, asks Jev which of the page's commands shows what it is
//   talking about, if any, and whether another must follow it. A part's own controls (its rows, columns, toggles, steps)
//   are offered only once that part is on screen (stage-page.js), so the page moves one command at a time, read again
//   after each. Sentences said meanwhile are judged together once that is done.
// - While it presents, a ring follows what its sentences are about.
// GPT Live is told what is on screen after each move. The page itself, and how fdc reaches it, is the stage (stage.ts).
// Before Oct 31 only turning words were judged: the voice said "getting you there" or "switching over now" and the page
// never moved (video-editing, Oct 31: ten misses in ten minutes, then the voice taught the operator the phrase). From
// then until Nov 17 the operator's request reached the page only through the first sentence of the voice's reply, read
// even when it only acknowledged them; "Sure." and "Got it." to an order of two or five settings ran nothing, and the
// agent made the changes itself (jev.ts, pageQuestions).
import type { Harness } from './bridge.ts';
import { CueMatcher, unglue, type SpeechCue } from './speech-cues.ts';
import { StageError, StageNothing, type StageCommand, type StageRun, type StageView } from './stage.ts';
import type { PageActor, PageCause } from './page-audit.ts';
import { chosenCommand, GAVE_UP, PAGE_MORE, type Reading } from './jev.ts';
import type { Spoken } from './voice-history.ts';
import { askedDoneNote, cueFailedNote, cueMovedNote, cueShown, cueStep, pageAnswered, pageDid, pageMissed } from './prompts.ts';

/** The most commands run for one stretch of the voice's words: a section, a part's own control in it, a highlight there. */
export const MOST_STEPS = 4;
/** The most commands run for one request of the operator's: a drink, its size, its milk, its sweetness, and into the order. */
export const MOST_ASKED = 8;
/** How long after a command ran for the operator's request the voice's own words about it don't run it again ("Adding a mocha" after the mocha was added). */
const JUST_DONE_MS = 15000;
// For a while after the agent puts a page in front, the voice's words don't switch to another tab: remarking on the change
// ("I see Outreach Report again, not the map reference") switched straight back to the page it replaced (Oct 31, live run).
export const AGENT_SHOWN_MS = 20000;
// Words that only acknowledge or hold the floor ("Okay.", "Sure, one sec.", "Got it."): a sentence of nothing else shows nothing.
const ACK = new Set('okay ok sure yeah yes yep yup right alright all got it thanks thank you hmm hm mm mhm uh um oh ah so one sec second moment hold on go ahead great good perfect cool nice absolutely of course i see well just a no problem thing totally exactly indeed will do let me me'.split(' '));
/** Whether a sentence says more than an acknowledgment. */
export const saysSomething = (sentence: string) => (sentence.toLowerCase().match(/[a-z']+/g) ?? []).some(word => !ACK.has(word.replace(/'/g, '')));
// The voice saying it turns to something ("let's look at the error bars"): when no command shows it, it hears so.
const TURNING = /\blet(?:'|’)?s\s+(?:look at|go to|go on to|go back to|turn to|head to|move to|move on to|jump to|look)\s+(.{3,80}?)\s*[.,;:!?]/i;
/** How long after the voice last spoke of the place the page is on, the command that goes there, chosen again, is not run again. */
const SAME_PLACE_MS = 30000;

export class Presenter {
  bridge: Harness;
  /** GPT Live's own words that move the page (speech-cues.ts). */
  speechCues = new CueMatcher();
  /** GPT Live's sentence so far, when it last spoke, and when its words last moved the page: then it is presenting. */
  sentence = ''; spokeAt = 0; presentedAt = 0;
  /** A cue fired in the current sentence. */
  cuedInSentence = false;
  /** The voice's sentences waiting for Jev's reading (said while one was under way), and whether one is. */
  queued: string[] = []; judging = false;
  /** The page is worked one stretch of words at a time, the operator's requests and the voice's sentences in the order they came. */
  busy: Promise<unknown> = Promise.resolve();
  /** The commands last run for a request of the operator's, and when. */
  asked?: { at: number; ids: string[] };
  /** The command that last put the page where it is: when, on which page, and when the voice last spoke of that place. */
  landed?: { id: string; at: number; seen: number; page: string };
  constructor(bridge: Harness) { this.bridge = bridge; }
  land(id: string, url = '') { const now = Date.now(); this.landed = { id, at: now, seen: now, page: url.split('#')[0] }; }
  /**
   * The page is on the place this command goes to: the voice's next sentence about it doesn't move it there again, or tell
   * the voice again what it says (the same command ran for three sentences in a row, Nov 13). Only a place with a name:
   * a control that does something each time it runs (a toggle, a step, a replay) runs each time. Not once the viewer has
   * moved the page, the page is another, or the voice has left the place alone for SAME_PLACE_MS.
   */
  there(command: string, view: StageView) {
    const landed = this.landed;
    return Boolean(landed && landed.id === command && view.commands.find(c => c.id === command)?.name && landed.page === view.url.split('#')[0]
      && Date.now() - landed.seen < SAME_PLACE_MS && (view.viewerAt ?? 0) < landed.at);
  }
  /** GPT Live said more: a cue in it moves the page now; each sentence it ends is read for the page. */
  heard(delta: string) {
    const bridge = this.bridge;
    // After a pause, a new answer.
    if (Date.now() - this.spokeAt > 1500) { this.sentence = ''; this.cuedInSentence = false; }
    this.spokeAt = Date.now();
    this.sentence = (this.sentence + delta).slice(-600);
    const ends = /[.!?]["”’)]?\s*$/.test(delta);
    for (const cue of this.speechCues.hear(delta)) {
      this.presentedAt = Date.now(); this.sentence = ''; this.cuedInSentence = true;
      this.cue(cue);
    }
    if (!ends) return;
    const sentence = unglue(this.sentence.trim()), cued = this.cuedInSentence;
    this.sentence = ''; this.cuedInSentence = false;
    if (cued) return;
    if (bridge.jev && bridge.stage.tabId && saysSomething(sentence)) { this.queued.push(sentence); void this.judge(); }
    else this.follow(sentence);
  }
  /** While presenting, the ring moves to what the sentence is about, among what is on screen. */
  follow(sentence: string) {
    const bridge = this.bridge;
    if (Date.now() - this.presentedAt < 60000) bridge.stage.follow(sentence).then(on => { if (on) bridge.log({ type: 'stage.followed', sentence: sentence.slice(-160), ...on }); }).catch(() => {});
  }
  /** GPT Live said a part's name after a turning phrase: the page goes there now, and GPT Live quietly hears what is on screen. */
  cue(cue: SpeechCue) {
    const bridge = this.bridge, started = Date.now();
    this.answered();
    bridge.stage.run([cue.run], { by: 'phrase', because: { said: cue.label } }).then(run => {
      this.land(cue.run, run.here?.url);
      bridge.log({ type: 'stage.cue', run: cue.run, label: cue.label, ms: Date.now() - started });
      this.shown(run, run.done.length ? run.done : [{ id: cue.run, say: cue.label, name: cue.label }]);
    }).catch(error => this.failed(cue.label, error as Error));
  }
  /** Reads the sentences waiting, one stretch at a time, after any request of the operator's under way. */
  async judge() {
    if (this.judging) return;
    this.judging = true;
    const drained = this.busy.then(async () => { while (this.queued.length) await this.show(this.queued.splice(0).join(' ')); }).finally(() => { this.judging = false; })
      .catch(error => { this.bridge.log({ type: 'stage.error', message: (error as Error).message }); });
    this.busy = drained;
    return drained;
  }
  /**
   * The page shows what the voice is talking about (`said`): Jev chooses a command for its words, if any, and the steps
   * that follow it. GPT Live hears what is on screen at the end.
   */
  async show(said: string) {
    const bridge = this.bridge, started = Date.now();
    const view = await bridge.stage.describe().catch(error => { bridge.log({ type: 'stage.error', message: (error as Error).message }); return undefined; });
    if (!view) return;
    const spoken: Spoken[] = [...bridge.mediator?.history.spoken() ?? [], { role: 'intermediary', text: said, at: Date.now() }];
    const first = await bridge.read({ trigger: 'cue', spoken, page: view }).catch(error => { bridge.log({ type: 'jev.error', message: (error as Error).message }); return undefined; });
    if (!first) return;
    // The voice says it can't answer or find what the operator asked: their words that stayed with it are read again,
    // with what it has said since, and go to the agent if they need it (mediator.ts).
    if ((first.page?.gaveUp ?? 0) >= GAVE_UP) { bridge.log({ type: 'voice.gave_up', said: said.slice(-160), p: first.page!.gaveUp }); bridge.mediator?.reconsider(); }
    // What the voice tool has just done for the operator's request, the voice's words about it don't do again.
    const justDone = this.asked && Date.now() - this.asked.at < JUST_DONE_MS ? this.asked.ids : [];
    const { done, last, error, there } = await this.steps(spoken, view, first, { said, most: MOST_STEPS, without: justDone });
    if (there) return this.follow(said);
    if (last) this.moved(said, done, last, started);
    if (error) return this.failed(said, error);
    if (last) return;
    bridge.log({ type: 'stage.judged_none', said: said.slice(-160) });
    // It said it was turning there: it hears the page has nothing for it, rather than talk about what isn't shown.
    const meant = TURNING.exec(said)?.[1];
    if (meant) this.tell(pageMissed(meant));
    else this.follow(said);
  }
  /**
   * The operator asked for something a command of the page does (`first`, the voice tool's reading of their turn, chose
   * it; turn.ts): it runs, and the steps that follow it. Resolves to the commands that ran, with what the page answered,
   * and what GPT Live is to be told of it, once; or to nothing when no command ran (it had nothing to do, or the page's
   * controller failed: the agent hears of that with their words).
   */
  carryOut(first: Reading, view: StageView, spoken: Spoken[]): Promise<{ told: string; done: (StageCommand & { shown?: string })[] } | undefined> {
    const said = spoken.at(-1)?.text ?? '';
    const run = this.busy.then(async () => {
      const bridge = this.bridge, started = Date.now();
      // Read again if a sentence of the voice's moved the page meanwhile.
      const now = await bridge.stage.describe().catch(() => undefined) ?? view;
      const { done, last, error } = await this.steps(spoken, now, first, { said, most: MOST_ASKED, asked: true });
      if (error) this.failed(said, error);
      // Nothing ran, or a control is broken: their words go by the usual rules, and the agent hears of the failure with them.
      if (!last || (error && !(error instanceof StageNothing))) return undefined;
      this.asked = { at: Date.now(), ids: done.map(c => c.id) };
      this.land(done.at(-1)!.id, last.here?.url);
      // The agent hears of it with their words, should they still go to it, and doesn't do it again.
      const history = bridge.mediator?.history;
      if (history && Date.now() - history.lastInputAt < 15000) history.cueLatest(askedDoneNote(done.map(c => c.say)));
      if (bridge.mediator) bridge.mediator.cueAt = Date.now();
      bridge.log({ type: 'stage.asked', run: done.at(-1)?.id, steps: done.map(c => c.id), said: said.slice(-120), ms: Date.now() - started });
      bridge.publish({ type: 'stage', done: done.map(c => c.name ?? c.say), onScreen: last.onScreen, asked: true });
      bridge.voiceSessions.shown(last.here, done);
      const told = pageDid(done.map(c => c.say), last.onScreen, last.here?.focus, await this.newControls());
      bridge.pageAudit.told(told, last.action);
      return { told, done };
    });
    this.busy = run.catch(() => {});
    return run.catch(error => { this.bridge.log({ type: 'stage.error', message: (error as Error).message }); return undefined; });
  }
  /**
   * Runs page commands for some words, one at a time: the first as `first` chose it, then, while Jev finds another needed,
   * the page is read again and it chooses the next, up to `most`. Steps on the way only land; the last one settles.
   * Resolves to the commands that ran with what the page answered, the last run, and the error that stopped them, if any.
   */
  async steps(spoken: Spoken[], view: StageView | undefined, first: Reading, { said, most, asked = false, without = [] }: { said: string; most: number; asked?: boolean; without?: string[] }) {
    const bridge = this.bridge;
    // Each command run for these words, with what the page answered: Jev reads it before choosing the next (page_done).
    const done: (StageCommand & { shown?: string })[] = [];
    let last: StageRun | undefined;
    try {
      for (let step = 0; step < most && view; step++) {
        const reading: Reading | undefined = step ? await bridge.read({ trigger: 'step', spoken, page: view, done: [...done] }).catch(error => { bridge.log({ type: 'jev.error', message: (error as Error).message }); return undefined; }) : first;
        if (!reading) break;
        let command = reading.page?.command;
        // One command runs once for the same words, a step included: "Next is the X" ran "next term" four times, Jev finding
        // another move needed after each, and landed three terms past (Nov 4, twice in five minutes; the operator's
        // instruction "move the page only one step at a time" didn't stop it, since the voice doesn't decide this).
        if (command && (done.some(c => c.id === command) || without.includes(command))) command = undefined;
        if (command && !step && this.there(command, view)) {
          bridge.log({ type: 'stage.already_there', command, said: said.slice(-120) });
          bridge.jevAudit?.decided(reading.id, { command: null, step, already: command }, !asked);
          this.landed!.seen = Date.now();
          return { done, last, there: true };
        }
        if (command?.startsWith('tab_') && Date.now() - bridge.stage.shownAt < AGENT_SHOWN_MS) { bridge.log({ type: 'stage.kept_page', instead: command }); command = undefined; }
        const more = (reading.page?.more ?? 0) >= PAGE_MORE && step + 1 < most;
        // The turn's request (the first reading, for what the operator asked) is completed where it was made (turn.ts).
        const settles = !asked || step > 0;
        if (!command) { bridge.jevAudit?.decided(reading.id, { command: null, step }, settles); break; }
        let ran: { run: StageRun; command: string; instead?: string };
        try { ran = await this.run(command, view, reading, more, { said, jevCall: reading.id, step }, asked ? 'asked' : 'jev'); }
        catch (error) { bridge.jevAudit?.decided(reading.id, { command, step, error: (error as Error).message }, settles); throw error; }
        bridge.jevAudit?.decided(reading.id, { command: ran.command, step, more, ...ran.instead && { instead: ran.instead } }, settles);
        last = ran.run; done.push(...ran.run.done.map(c => ({ ...c, shown: ran.run.onScreen })));
        if (!more) break;
        // A step on the way: the voice hears where the page has got to, as Jev does with its next reading. Not for a
        // request: it hears once what was done.
        if (!asked) this.tell(cueStep(ran.run.onScreen), ran.run.action);
        view = await bridge.stage.describe(0).catch(() => undefined);
      }
    } catch (error) { return { done, last, error: error as Error }; }
    return { done, last };
  }
  /** Runs the command Jev chose; one that has nothing to do (no earlier place to go back to) gives way to the next likeliest. */
  async run(command: string, view: StageView, reading: Reading, fast: boolean, because: PageCause, by: PageActor = 'jev'): Promise<{ run: StageRun; command: string; instead?: string }> {
    try { return { run: await this.bridge.stage.run([command], { fast, by, because }), command }; }
    catch (error) {
      const next = error instanceof StageNothing && reading.page?.likely ? chosenCommand({ probabilities: reading.page.likely }, view, [command]) : undefined;
      if (!next) throw error;
      this.bridge.log({ type: 'stage.cue_instead', tried: command, answer: error instanceof StageNothing ? error.message : '', next });
      return { run: await this.bridge.stage.run([next], { fast, by, because }), command: next, instead: command };
    }
  }
  /** The voice's words moved the page: GPT Live hears what is on screen, once, after the last step. */
  moved(said: string, done: StageCommand[], run: StageRun, started: number) {
    const bridge = this.bridge;
    this.answered();
    if (done.length) this.land(done.at(-1)!.id, run.here?.url); else this.landed = undefined;
    bridge.log({ type: 'stage.cue', run: done.at(-1)?.id, steps: done.map(c => c.id), label: said.slice(-120), judged: true, ms: Date.now() - started });
    this.shown(run, done);
  }
  /** Moving the page answers the operator's latest words: the agent hears of it with them, and doesn't move it again. */
  answered() {
    const bridge = this.bridge, history = bridge.mediator?.history;
    this.presentedAt = Date.now();
    if (history && Date.now() - history.lastInputAt < 15000) history.cueLatest(cueMovedNote);
    if (bridge.mediator) bridge.mediator.cueAt = Date.now();
  }
  /**
   * What is on screen after a move: for the page, for GPT Live (with the controls of the part now on screen, which it
   * wasn't told of: a part's own are offered only while it is on screen), and for the operator's goal.
   */
  async shown(run: StageRun, done: StageCommand[]) {
    const bridge = this.bridge;
    bridge.publish({ type: 'stage', done: done.map(c => c.name ?? c.say), onScreen: run.onScreen, cue: true });
    bridge.voiceSessions.shown(run.here, done);
    this.tell(cueShown(run.onScreen, run.here?.focus, await this.newControls()), run.action);
  }
  /** The page's controls GPT Live hasn't been told of yet (those of the part now on screen, or that the last command brought), as it is now. */
  async newControls() {
    const view = await this.bridge.stage.describe(0).catch(() => undefined);
    return view ? this.bridge.voiceSessions.newControls(view) : [];
  }
  /** What GPT Live hears about the page at once, recorded as it is sent, with the action it is about (page-audit.ts). */
  tell(text: string, action?: string) {
    this.bridge.mediator?.context.now('thinking', text);
    this.bridge.pageAudit.told(text, action);
  }
  /**
   * The page didn't go where the voice turned: a limit is the page's answer ("Already on the last slide"), which the voice
   * hears; a failure is the controller's, and the operator's latest words carry the error to the agent, which fixes it.
   */
  failed(label: string, error: Error) {
    const bridge = this.bridge, view = bridge.stage.view;
    if (error instanceof StageNothing) { bridge.log({ type: 'stage.cue_nothing', label: label.slice(-120), answer: error.message }); this.tell(pageAnswered(error.message), error.action); return; }
    bridge.log({ type: 'stage.cue_failed', label: label.slice(-120), message: error.message });
    bridge.mediator?.history.cueLatest(cueFailedNote(error instanceof StageError ? error.failed.say : label, error.message, view));
  }
}
