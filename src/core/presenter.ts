// The presenter: fdc showing the operator the page the coding agent made, moved by what GPT Live says as it talks, while
// the agent goes on producing. The operator never has to know how the page is moved; they talk, and the voice presents:
// - A part's name after a turning phrase ("let's look at" the results, speech-cues.ts) moves the page at once.
// - Every other sentence it says, bare acknowledgments aside, asks Jev which of the page's commands shows what it is
//   talking about, if any, and whether another must follow it. The first sentence of its reply to the operator is asked
//   about even when it only acknowledges them: "On it." to "show likes per post there" is the voice taking it on. A
//   part's own controls (its rows, columns, toggles, steps) are offered only once that part is on screen
//   (stage-page.js), so the page moves one command at a time, read again after each, until Jev wants no more. Sentences
//   said meanwhile are judged together once that is done.
// - While it presents, a ring follows what its sentences are about.
// GPT Live is told what is on screen after each move. The page itself, and how fdc reaches it, is the stage (stage.ts).
// Before Oct 31 only turning words were judged: the voice said "getting you there" or "switching over now" and the page
// never moved (video-editing, Oct 31: ten misses in ten minutes, then the voice taught the operator the phrase).
import type { Harness } from './bridge.ts';
import { CueMatcher, unglue, type SpeechCue } from './speech-cues.ts';
import { StageError, StageNothing, type StageCommand, type StageRun, type StageView } from './stage.ts';
import { chosenCommand, PAGE_MORE, type Reading } from './jev.ts';
import type { Spoken } from './voice-history.ts';
import { cueFailedNote, cueMovedNote, cueShown, pageAnswered, pageMissed } from './prompts.ts';

/** The most commands run for one stretch of the voice's words: a section, a part's own control in it, a highlight there. */
export const MOST_STEPS = 4;
/** How soon after the operator's words the voice's first sentence is their reply (read even if it only acknowledges them). */
const REPLY_MS = 8000;
// For a while after the agent puts a page in front, the voice's words don't switch to another tab: remarking on the change
// ("I see Outreach Report again, not the map reference") switched straight back to the page it replaced (Oct 31, live run).
export const AGENT_SHOWN_MS = 20000;
// Words that only acknowledge or hold the floor ("Okay.", "Sure, one sec.", "Got it."): a sentence of nothing else shows nothing.
const ACK = new Set('okay ok sure yeah yes yep yup right alright all got it thanks thank you hmm hm mm mhm uh um oh ah so one sec second moment hold on go ahead great good perfect cool nice absolutely of course i see well just a no problem thing totally exactly indeed will do let me me'.split(' '));
/** Whether a sentence says more than an acknowledgment. */
export const saysSomething = (sentence: string) => (sentence.toLowerCase().match(/[a-z']+/g) ?? []).some(word => !ACK.has(word.replace(/'/g, '')));
// The voice saying it turns to something ("let's look at the error bars"): when no command shows it, it hears so.
const TURNING = /\blet(?:'|’)?s\s+(?:look at|go to|go on to|go back to|turn to|head to|move to|move on to|jump to|look)\s+(.{3,80}?)\s*[.,;:!?]/i;
// Only a step (next, previous, back, scrolling) runs twice for the same words: a part reached again is no further on.
const RELATIVE = /(^|_)(next|previous|prev|back|forward|scroll_up|scroll_down)(_|$)/;

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
  /** The operator's words (when they last spoke) whose reply's first sentence was read. */
  repliedTo = 0;
  constructor(bridge: Harness) { this.bridge = bridge; }
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
    const spoke = bridge.mediator?.history.lastInputAt ?? 0, replying = spoke > this.repliedTo && Date.now() - spoke < REPLY_MS;
    if (replying) this.repliedTo = spoke;
    if (cued) return;
    if (bridge.jev && bridge.stage.tabId && (saysSomething(sentence) || replying)) { this.queued.push(sentence); void this.judge(); }
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
    bridge.stage.run([cue.run]).then(run => {
      bridge.log({ type: 'stage.cue', run: cue.run, label: cue.label, ms: Date.now() - started });
      this.shown(run, run.done.length ? run.done : [{ id: cue.run, say: cue.label, name: cue.label }]);
    }).catch(error => this.failed(cue.label, error as Error));
  }
  /** Reads the sentences waiting, one stretch at a time. */
  async judge() {
    if (this.judging) return;
    this.judging = true;
    try { while (this.queued.length) await this.show(this.queued.splice(0).join(' ')); }
    finally { this.judging = false; }
  }
  /**
   * The page shows what the voice is talking about (`said`): Jev chooses a command for its words, if any; while it finds
   * another needed, the page is read again and it chooses the next, up to MOST_STEPS. Steps on the way only land; the last
   * one settles. GPT Live hears what is on screen at the end.
   */
  async show(said: string) {
    const bridge = this.bridge, started = Date.now();
    let view = await bridge.stage.describe().catch(error => { bridge.log({ type: 'stage.error', message: (error as Error).message }); return undefined; });
    if (!view) return;
    const spoken: Spoken[] = [...bridge.mediator?.history.spoken() ?? [], { role: 'intermediary', text: said, at: Date.now() }];
    const done: StageCommand[] = [];
    let last: StageRun | undefined;
    try {
      for (let step = 0; step < MOST_STEPS && view; step++) {
        const reading = await bridge.read({ trigger: step ? 'step' : 'cue', spoken, page: view, done: [...done] }).catch(error => { bridge.log({ type: 'jev.error', message: (error as Error).message }); return undefined; });
        if (!reading) break;
        let command = reading.page?.command;
        if (command && !RELATIVE.test(command) && done.some(c => c.id === command)) command = undefined;
        if (command?.startsWith('tab_') && Date.now() - bridge.stage.shownAt < AGENT_SHOWN_MS) { bridge.log({ type: 'stage.kept_page', instead: command }); command = undefined; }
        const more = (reading.page?.more ?? 0) >= PAGE_MORE && step + 1 < MOST_STEPS;
        if (!command) { bridge.jevAudit?.decided(reading.id, { command: null, step }, true); break; }
        let ran: { run: StageRun; command: string; instead?: string };
        try { ran = await this.run(command, view, reading, more); }
        catch (error) { bridge.jevAudit?.decided(reading.id, { command, step, error: (error as Error).message }, true); throw error; }
        bridge.jevAudit?.decided(reading.id, { command: ran.command, step, more, ...ran.instead && { instead: ran.instead } }, true);
        last = ran.run; done.push(...ran.run.done);
        if (!more) break;
        view = await bridge.stage.describe(0).catch(() => undefined);
      }
    } catch (error) {
      if (last) this.moved(said, done, last, started);
      this.failed(said, error as Error);
      return;
    }
    if (last) return this.moved(said, done, last, started);
    bridge.log({ type: 'stage.judged_none', said: said.slice(-160) });
    // It said it was turning there: it hears the page has nothing for it, rather than talk about what isn't shown.
    const meant = TURNING.exec(said)?.[1];
    if (meant) bridge.mediator?.context.now('thinking', pageMissed(meant));
    else this.follow(said);
  }
  /** Runs the command Jev chose; one that has nothing to do (no earlier place to go back to) gives way to the next likeliest. */
  async run(command: string, view: StageView, reading: Reading, fast: boolean): Promise<{ run: StageRun; command: string; instead?: string }> {
    try { return { run: await this.bridge.stage.run([command], { fast }), command }; }
    catch (error) {
      const next = error instanceof StageNothing && reading.page?.likely ? chosenCommand({ probabilities: reading.page.likely }, view, [command]) : undefined;
      if (!next) throw error;
      this.bridge.log({ type: 'stage.cue_instead', tried: command, answer: error instanceof StageNothing ? error.message : '', next });
      return { run: await this.bridge.stage.run([next], { fast }), command: next, instead: command };
    }
  }
  /** The voice's words moved the page: GPT Live hears what is on screen, once, after the last step. */
  moved(said: string, done: StageCommand[], run: StageRun, started: number) {
    const bridge = this.bridge;
    this.answered();
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
    const view = await bridge.stage.describe(0).catch(() => undefined);
    const controls = view?.commands.filter(c => c.part).map(c => c.say.replace(/\s*\([^()]*\)\s*$/, '').replace(/\.$/, '')).slice(0, 8) ?? [];
    bridge.mediator?.context.now('thinking', cueShown(run.onScreen, run.here?.focus, controls));
  }
  /**
   * The page didn't go where the voice turned: a limit is the page's answer ("Already on the last slide"), which the voice
   * hears; a failure is the controller's, and the operator's latest words carry the error to the agent, which fixes it.
   */
  failed(label: string, error: Error) {
    const bridge = this.bridge, view = bridge.stage.view;
    if (error instanceof StageNothing) { bridge.log({ type: 'stage.cue_nothing', label: label.slice(-120), answer: error.message }); bridge.mediator?.context.now('thinking', pageAnswered(error.message)); return; }
    bridge.log({ type: 'stage.cue_failed', label: label.slice(-120), message: error.message });
    bridge.mediator?.history.cueLatest(cueFailedNote(error instanceof StageError ? error.failed.say : label, error.message, view));
  }
}
