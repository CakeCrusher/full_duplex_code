// The presenter: fdc showing the operator the page the coding agent made, in step with GPT Live, while the agent goes
// on producing. The operator never has to know how the page is moved:
// - What they ask of the page is done from their own words: when they finish speaking, Jev reads their turn once (turn.ts)
//   and the page moves at once, one command at a time until Jev wants no more; or a walkthrough starts; or a one-off
//   action does what no command does (fast-action.ts). GPT Live is told what is on screen and talks about it.
// - A walkthrough is paced here: GPT Live presents the part on screen, and when it has finished, the page moves on.
// - GPT Live can point as it talks ("let's look at" a part, speech-cues.ts), and the ring follows its sentences.
// The page itself, and how fdc reaches it, is the stage (stage.ts).
import type { Harness } from './bridge.ts';
import { CueMatcher, unglue, type SpeechCue } from './speech-cues.ts';
import { Stage, StageError, StageNothing, STEP_DWELL_MS, type StageCommand, type StageRun, type StageView } from './stage.ts';
import { FastAction, type PageAction } from './fast-action.ts';
import { PAGE_ONLY, PAGE_OTHER, PAGE_RELATIVE_ONLY, PAGE_WALK, type PageJudgment, type Reading } from './jev.ts';
import type { Spoken } from './voice-history.ts';
import { cueMovedNote, cueShown, improvisedFailedNote, oneOffDone, oneOffNote, operatorMoved, pageAtEnd, pageMoving, pageNow, pageDoneNote, pageFailed, pageFailedNote, pageNothing, walkNext, walkStarted } from './prompts.ts';

/** A step forward or back: relative to where the page is. */
const RELATIVE = /(^|_)(next|previous|prev|back|forward)(_|$)/;
/** The command Jev chose, if it is taken: a step forward or back only when the words are about moving the page. */
const taken = (page: PageJudgment) => page.command && (!RELATIVE.test(page.command) || page.only >= PAGE_RELATIVE_ONLY) ? page.command : undefined;
/** Whether the operator asks to be walked through the page (work asked alongside goes to the agent by the job delegation). */
const walked = (page: PageJudgment) => page.walk >= PAGE_WALK;
// The most commands run for one request ("forward three sections" is three): Jev is asked again after each one.
const MOST_STEPS = 5;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
/** What the page did for the operator's turn (act): whether it moved, whether moving it was all they asked, what the agent is told with their words, and whether they go to it because the page failed or fell short. */
export interface PagePart { moved: boolean; only: boolean; note?: string; escalated?: boolean }
/** fdc's own step over the page's sections, for a page's own step forward or back that had nothing to do. */
const sectionStep = (id: string) => /_section$/.test(id) ? undefined : /(^|_)(next|forward)(_|$)/.test(id) ? 'next_section' : /(^|_)(previous|prev|back)(_|$)/.test(id) ? 'previous_section' : undefined;

export class Presenter {
  bridge: Harness;
  /** GPT Live's own words that move the page (speech-cues.ts). */
  speechCues = new CueMatcher();
  /** GPT Live's sentence so far, and when the page last moved by its words or the gate: then it is presenting. */
  sentence = ''; presentedAt = 0;
  /** A cue fired in the current sentence; a judged move is in flight. */
  cuedInSentence = false; judging = false;
  /** One-off actions on the stage when no page command fits. */
  fastAction?: FastAction;
  /**
   * A walkthrough the operator asked for, paced by fdc: GPT Live presents one part per turn and stops (it rarely goes on by
   * itself), and when it has finished and been quiet a moment, the page moves on and it is told to present the next part.
   * It ends when the operator speaks, at the last part, or when voice ends.
   */
  walking?: { startedAt: number; movedAt: number; parts: number; timer: ReturnType<typeof setInterval> };
  pacing = false; spokeAt = 0; walkQuietMs = 2500;
  /** When the page last moved for the operator's words: GPT Live's own move words in that answer are not taken too. */
  movedForOperatorAt = 0;
  /** How long each step of a request shows before the next. */
  stepDwellMs = STEP_DWELL_MS;
  constructor(bridge: Harness, apiKey?: string) { this.bridge = bridge; if (apiKey && apiKey !== 'unused') this.fastAction = new FastAction({ apiKey }); }
  /** GPT Live said more: a cue in it moves the page now, and GPT Live quietly hears what is on screen. */
  heard(delta: string) {
    const bridge = this.bridge;
    // After a pause, a new answer.
    if (Date.now() - this.spokeAt > 1500) { this.sentence = ''; this.cuedInSentence = false; }
    this.spokeAt = Date.now();
    this.sentence = (this.sentence + delta).slice(-600);
    const ends = /[.!?]["”’)]?\s*$/.test(delta);
    // Answering the operator's own move, its words move nothing; a sentence it ends then is over all the same (kept, a
    // "let's look at" from it moved the page 50 s later, at the end of another sentence).
    if (Date.now() - this.movedForOperatorAt < 8000) { if (ends) { this.sentence = ''; this.cuedInSentence = false; } return; }
    for (const cue of this.speechCues.hear(delta)) {
      this.presentedAt = Date.now(); this.sentence = ''; this.cuedInSentence = true;
      void this.unlessOperatorMoved(() => this.cue(cue));
    }
    // At the end of each sentence: "let's look at" something that is no part's name means the voice meant to move the
    // page, so Jev finds the command; otherwise, while presenting, the ring follows what the sentence was about.
    if (ends) {
      const sentence = unglue(this.sentence.trim()), cued = this.cuedInSentence; this.sentence = ''; this.cuedInSentence = false;
      const meant = cued ? undefined : /\blet(?:'|’)?s\s+(?:look at|go to|go back to|turn to|head to|move to|jump to|look)\s+(.{3,80}?)\s*[.,;:!?]/i.exec(sentence)?.[1];
      if (meant) void this.unlessOperatorMoved(() => this.judgedMove(meant, sentence));
      else if (Date.now() - this.presentedAt < 60000) bridge.stage.follow(sentence).then(on => { if (on) bridge.log({ type: 'stage.followed', sentence: sentence.slice(-160), ...on }); }).catch(() => {});
    }
  }
  /** GPT Live answering the operator moves the page by its own words only if their words moved nothing ("let's take a look at the core idea", said as it answered "take me to section three"). */
  async unlessOperatorMoved(move: () => unknown) {
    const turn = this.bridge.mediator?.turn;
    if (turn && Date.now() - turn.at < 10000 && (await turn.done)?.moved) return;
    if (Date.now() - this.movedForOperatorAt < 8000) return;
    move();
  }
  /** GPT Live said a part's name after a turning phrase: the page goes there now, and GPT Live quietly hears what is on screen. */
  cue(cue: SpeechCue) {
    const bridge = this.bridge, history = bridge.mediator?.history, started = Date.now();
    // Answering the operator by moving the page: their words still go to the gate and, unless the move was all they
    // asked, to the agent, noted, so neither moves it again.
    if (history && Date.now() - history.lastInputAt < 15000) history.cueLatest(cueMovedNote);
    if (bridge.mediator) bridge.mediator.cueAt = started;
    bridge.stage.run([cue.run]).then(({ onScreen }) => {
      bridge.log({ type: 'stage.cue', run: cue.run, label: cue.label, ms: Date.now() - started });
      bridge.publish({ type: 'stage', done: [cue.label], onScreen, cue: true });
      bridge.mediator?.context.now('thinking', cueShown(onScreen));
    }).catch(error => bridge.log({ type: 'stage.cue_failed', run: cue.run, label: cue.label, message: (error as Error).message }));
  }
  /** The voice said "let's look at" a part by another name ("the repeat visit"): the page goes there if Jev is sure which. */
  async judgedMove(meant: string, sentence = `Let's look at ${meant}.`) {
    const bridge = this.bridge;
    if (this.judging || !bridge.jev) return;
    this.judging = true;
    const started = Date.now();
    try {
      const view = await bridge.stage.describe();
      if (!view) return;
      const spoken: Spoken[] = [...bridge.mediator?.history.spoken() ?? [], { role: 'intermediary', text: sentence, at: Date.now() }];
      const command = (await bridge.read({ trigger: 'cue', spoken, page: view })).page?.command;
      if (!command) { bridge.log({ type: 'stage.cue_missed', meant }); return; }
      const { onScreen } = await bridge.stage.run([command]);
      this.presentedAt = Date.now();
      bridge.log({ type: 'stage.cue', run: command, label: meant, judged: true, ms: Date.now() - started });
      bridge.publish({ type: 'stage', done: [meant], onScreen, cue: true });
      bridge.mediator?.context.now('thinking', cueShown(onScreen));
    } catch (error) { bridge.log({ type: 'stage.cue_failed', label: meant, message: (error as Error).message }); }
    finally { this.judging = false; }
  }
  /**
   * What the operator's turn asks of the page, done at once (turn.ts): a walkthrough starts, the commands Jev chose run one
   * at a time, or a one-off action does what no command does. GPT Live hears what is on screen. Undefined when they ask
   * nothing of the page. Controls that fail send their words to the agent to fix them; a complaint about the page, or a
   * request no command does, reaches it by the job delegation, which knows the page's commands.
   */
  async act(reading: Reading, said: string, spoken: Spoken[], view: StageView): Promise<PagePart | undefined> {
    const bridge = this.bridge, page = reading.page!, command = taken(page), only = page.only >= PAGE_ONLY;
    bridge.log({ type: 'stage.turn', said: said.slice(-200), command, walk: page.walk, only: page.only, other: page.other });
    if (walked(page)) {
      this.movedForOperatorAt = Date.now();
      bridge.mediator?.context.add('commentary', walkStarted(bridge.agent, await this.startWalk(command)));
      return { moved: true, only: true };
    }
    if (command) return this.run(command, spoken, view, only);
    if (page.other >= PAGE_OTHER && this.fastAction) return this.improvise(said, only);
  }
  /** Runs the command Jev chose, and the next ones it wants (steps), each shown a moment; GPT Live hears what is on screen. */
  async run(command: string, spoken: Spoken[], view: StageView, only: boolean): Promise<PagePart> {
    const bridge = this.bridge, context = bridge.mediator?.context, moving = this.movedForOperatorAt = Date.now();
    context?.now('thinking', pageMoving([view.commands.find(c => c.id === command) ?? { say: command }]));
    let ran: StageRun | undefined;
    try { ran = await this.steps(command, spoken); }
    catch (error) {
      // The page's controls failed: their words go to the agent with the error, to fix them, and GPT Live hears how far it got.
      if (!(error instanceof StageNothing)) {
        const message = (error as Error).message, done = error instanceof StageError ? error.done : [], failed = error instanceof StageError ? [error.failed] : [view.commands.find(c => c.id === command) ?? { id: command, say: command }];
        this.movedForOperatorAt = 0;
        if (done.length) bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen: (error as StageError).onScreen });
        bridge.log({ type: 'stage.escalated', error: message });
        context?.now('thinking', pageFailed(bridge.agent, message, done));
        return { moved: false, only: false, note: pageFailedNote(failed, message, view), escalated: true };
      }
      // The page's own step had nothing to do ("Already on the last step" of a part's steps): the operator wants to go
      // on, so fdc's step over the sections does; at the very end the voice says so, and it never claims a move.
      const over = error.done.length ? undefined : sectionStep(error.failed.id);
      ran = error.done.length ? { done: error.done, onScreen: error.onScreen } : over ? await bridge.stage.run([over]).catch(() => undefined) : undefined;
      if (!ran) { this.movedForOperatorAt = 0; context?.now('thinking', pageAtEnd(error.message)); return { moved: false, only }; }
    }
    const { done, onScreen } = ran;
    this.presentedAt = Date.now();
    bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen });
    // Already answering before the page moved, GPT Live can't have known what it shows: it hears it to say (only what is
    // on screen: commentary is paraphrased aloud, instructions and all).
    if (this.spokeAt >= moving) context?.add('commentary', pageNow(onScreen), null);
    else context?.now('thinking', operatorMoved(onScreen));
    return { moved: true, only, note: only ? undefined : pageDoneNote(done) };
  }
  /**
   * Runs the command Jev chose, then asks Jev, with the page as it is now and what ran, whether another should run, until it
   * wants none: "forward three sections" is three steps, "go to the options and highlight the recommendation" two. Each
   * step shows for a moment before the next.
   */
  async steps(first: string, spoken: Spoken[]): Promise<StageRun> {
    const bridge = this.bridge, done: StageCommand[] = [];
    let next: string | undefined = first, onScreen = '';
    for (let n = 0; next && n < MOST_STEPS; n++) {
      const ran = await bridge.stage.run([next]).catch(error => { throw error instanceof StageError ? new (error.constructor as typeof StageError)(error.message, [...done, ...error.done], error.onScreen, error.failed) : error; });
      done.push(...ran.done); onScreen = ran.onScreen;
      if (n + 1 === MOST_STEPS) break;
      const shown = Date.now(), view = await bridge.stage.describe(0).catch(() => undefined);
      next = view && await bridge.read({ trigger: 'step', spoken, page: view, done: [...done] }).then(reading => reading.page?.command, () => undefined);
      // Only a step forward or back repeats: a part reached again is no further on (two tabs taken in turns, five times, on
      // the synthetic set).
      if (next && !RELATIVE.test(next) && done.some(c => c.id === next)) next = undefined;
      if (next) await pause(this.stepDwellMs - (Date.now() - shown));
    }
    return { done, onScreen };
  }
  /** Its first part shows, and fdc paces the rest: resolves to what is on screen. */
  async startWalk(command?: string): Promise<string> {
    const bridge = this.bridge;
    // It starts where the operator is: a part they named shows first, never the next one ("walk me through it" on part
    // five went on to six, and again each time they asked to stay on five).
    let onScreen = command && !RELATIVE.test(command) ? await bridge.stage.run([command]).then(ran => ran.onScreen, () => '') : '';
    onScreen ||= (await bridge.stage.describe(0).catch(() => undefined))?.where ?? '';
    this.stopWalking();
    const now = Date.now(), timer = setInterval(() => void this.pace(), 500);
    timer.unref?.();
    this.walking = { startedAt: now, movedAt: now, parts: 0, timer };
    this.presentedAt = now;
    bridge.log({ type: 'stage.walk', state: 'started' });
    return onScreen;
  }
  /** While walking: once the voice has presented the part on screen and gone quiet, the next part, unless the operator spoke. */
  async pace(now = Date.now()) {
    const walking = this.walking, bridge = this.bridge;
    if (!walking || this.pacing) return;
    const history = bridge.mediator?.history;
    // Their own words just after asking are the request itself; anything later is the operator leading again.
    if (!bridge.mediator || (history?.lastInputAt ?? 0) > Math.max(walking.movedAt, walking.startedAt + 4000) || walking.parts >= 40) return this.stopWalking('the operator spoke');
    const spoke = Math.max(this.spokeAt, bridge.voiceSessions?.liveSpeechAt ?? 0);
    if (spoke <= walking.movedAt || now - spoke < this.walkQuietMs) return;
    this.pacing = true;
    try {
      const view = await bridge.stage.describe(0), next = view && Stage.next(view);
      if (!view || !next) return this.stopWalking('no next part');
      // A part's own steps ended ("Already on the last step"): the walk goes on to the next section.
      const { onScreen } = await bridge.stage.run([next]).catch(error => { const over = error instanceof StageNothing ? sectionStep(next) : undefined; if (!over) throw error; return bridge.stage.run([over]); });
      // A step that went nowhere ("Already on the last slide") ends it.
      if ((await bridge.stage.describe(0))?.where === view.where) return this.stopWalking('the last part');
      walking.movedAt = this.presentedAt = Date.now(); walking.parts++;
      bridge.log({ type: 'stage.walk', state: 'next', run: next });
      bridge.publish({ type: 'stage', done: ['The next part'], onScreen });
      bridge.mediator?.context.add('commentary', walkNext(onScreen));
    } catch (error) { this.stopWalking(error instanceof StageNothing ? 'the last part' : (error as Error).message); }
    finally { this.pacing = false; }
  }
  stopWalking(reason?: string) {
    if (!this.walking) return;
    clearInterval(this.walking.timer); this.walking = undefined;
    if (reason) this.bridge.log({ type: 'stage.walk', state: 'stopped', reason });
  }
  /** No command fits: a fast model writes a one-off action for the page, which runs at once; the agent hears of it, to add a command. */
  async improvise(said: string, only: boolean): Promise<PagePart> {
    const bridge = this.bridge, { agent } = bridge, context = bridge.mediator?.context, started = Date.now();
    let steps: PageAction[] = [];
    try {
      const { actions } = await this.fastAction!.write(said, await bridge.stage.digest());
      steps = actions;
      // What the stage reads on screen afterwards, not the fast model's account of what it meant to do.
      const onScreen = await bridge.stage.act(actions);
      const done = [{ id: 'one_off', say: `A one-off action for "${said.slice(0, 80)}"` }];
      this.movedForOperatorAt = this.presentedAt = Date.now();
      bridge.log({ type: 'stage.improvised', said, actions, ms: Date.now() - started });
      bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen });
      context?.now('thinking', oneOffDone(agent, onScreen));
      // Done at once, and the agent hears of it too: no command could do it, so the page's controller is what fell short.
      return { moved: true, only: false, note: `${only ? '' : `${pageDoneNote(done)} `}${oneOffNote(said, onScreen)}`, escalated: true };
    } catch (error) {
      const message = (error as Error).message;
      bridge.log({ type: 'stage.improvise_failed', said, actions: steps, message, ms: Date.now() - started });
      context?.now('thinking', pageNothing(agent, { say: `a one-off action (${message.slice(0, 120)})` }));
      return { moved: false, only: false, note: improvisedFailedNote(message), escalated: true };
    }
  }
}
