// The presenter: fdc showing the operator the page the coding agent made, in step with GPT Live, while the agent goes
// on producing. The operator never has to know how the page is moved:
// - What they ask of the page is done from their own words: when they finish speaking, Jev reads the conversation once
//   (jev.ts) and the page moves at once, one command at a time until Jev wants no more, or a walkthrough starts, whatever
//   GPT Live says or passes on. GPT Live is told what is on screen and talks about it.
// - A walkthrough is paced here: GPT Live presents the part on screen, and when it has finished, the page moves on.
// - GPT Live can point as it talks ("let's look at" a part, speech-cues.ts), and the ring follows its sentences.
// - Requests GPT Live passes on reach the gate (sessions.ts), which routes them; their page part is carried out here,
//   unless it already was, or with a one-off action when no command does it (fast-action.ts).
// The page itself, and how fdc reaches it, is the stage (stage.ts).
import type { Harness } from './bridge.ts';
import { CueMatcher, unglue, type SpeechCue } from './speech-cues.ts';
import { Stage, StageError, StageNothing, STEP_DWELL_MS, type StageCommand, type StageRun, type StageView } from './stage.ts';
import { FastAction, type PageAction } from './fast-action.ts';
import { PAGE_ONLY, PAGE_OTHER, PAGE_RELATIVE_ONLY, PAGE_UNHAPPY, PAGE_WALK, PAGE_WORK, WALK_WORK, type Line, type PageJudgment, type Reading } from './jev.ts';
import type { Gated } from './mediator.ts';
import { controllerNote, cueHandled, cueMovedNote, cueShown, improvisedFailedNote, lookingNote, oneOffDone, oneOffNote, operatorMoved, pageAlongside, pageAtEnd, pageMoving, pageNow, pageDoneNote, pageFailed, pageFailedNote, pageHandled, pageNothing, pageNothingNote, unhappySent, walkNext, walkStarted } from './prompts.ts';

/** The same words, however much of them each side caught. */
export const same = (a: string, b: string) => { const x = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), y = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return !!x && !!y && (x.includes(y) || y.includes(x)); };
// What GPT Live says while the operator only pauses ("Mm-hmm", "Go on"): no answer, so not the end of their turn.
const BACKCHANNEL = new Set(['mm', 'mmm', 'mhm', 'hm', 'hmm', 'uh', 'huh', 'um', 'ah', 'oh', 'okay', 'ok', 'yeah', 'yes', 'yep', 'right', 'sure', 'alright', 'go', 'on', 'ahead', 'i', 'see', 'got', 'it', 'so']);
/** Whether GPT Live's words so far answer anything: a whole word beyond a backchannel. */
const answers = (said: string) => (said.toLowerCase().match(/[a-z']+(?=[^a-z'])/g) ?? []).some(word => !BACKCHANNEL.has(word));
/** A step forward or back: relative to where the page is. */
const RELATIVE = /(^|_)(next|previous|prev|back|forward)(_|$)/;
/** The command Jev chose, if it is taken: a step forward or back only when the words are about moving the page. */
const taken = (page: PageJudgment) => page.command && (!RELATIVE.test(page.command) || page.only >= PAGE_RELATIVE_ONLY) ? page.command : undefined;
/** Whether the operator asks to be walked through the page, and nothing else. */
const walked = (page: PageJudgment) => page.walk >= PAGE_WALK && page.work < WALK_WORK;
// The most commands run for one request ("forward three sections" is three): Jev is asked again after each one.
const MOST_STEPS = 5;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
/** The operator's latest words the presenter read: Jev's reading of them, and whether the page moved for them. */
export interface TurnRead { said: string; reading?: Reading; moved: boolean }
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
  /** GPT Live's latest words, for Jev to read a short reply against ("continue" after it presented a part); whether they answer yet. */
  voiceSaid = ''; answering = false;
  /**
   * The operator's latest words the presenter read, and what came of them; the wait for them to finish. GPT Live answering
   * is the end of the operator's turn; quiet alone counts only after a while (a pause mid-sentence isn't one: "Take me
   * to … tonight" was judged as "Take me to").
   */
  turn?: { said: string; read: Promise<TurnRead>; at: number }; listening?: ReturnType<typeof setTimeout>; operatorQuietMs = 2500;
  /** When the page last moved for the operator's words: GPT Live's own move words in that answer are not taken too. */
  movedForOperatorAt = 0;
  /** How long each step of a request shows before the next. */
  stepDwellMs = STEP_DWELL_MS;
  constructor(bridge: Harness, apiKey?: string) { this.bridge = bridge; if (apiKey && apiKey !== 'unused') this.fastAction = new FastAction({ apiKey }); }
  /** GPT Live said more: a cue in it moves the page now, and GPT Live quietly hears what is on screen. */
  heard(delta: string) {
    const bridge = this.bridge;
    // GPT Live starting to answer means the operator has finished; a backchannel while they pause doesn't ("Mm-hmm" cut
    // "Let's go back to" off "… Claire, step two, and walk me through it").
    if (Date.now() - this.spokeAt > 1500) { this.voiceSaid = ''; this.answering = false; this.sentence = ''; this.cuedInSentence = false; }
    this.spokeAt = Date.now();
    this.voiceSaid = (this.voiceSaid + delta).slice(-300);
    if (!this.answering && answers(this.voiceSaid)) { this.answering = true; void this.operatorTurn(); }
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
    const turn = this.turn;
    if (turn && Date.now() - turn.at < 10000 && (await turn.read).moved) return;
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
      const lines: Line[] = [...bridge.mediator?.history.lines() ?? [], { role: 'intermediary', text: sentence }];
      const command = (await bridge.read({ trigger: 'cue', lines, page: view })).page?.command;
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
   * A request the gate found asking something of the page: its commands run (none again for words the voice already
   * moved the page for), or a one-off action when no command does it. Undefined when the page has nothing to do.
   * With work in the request too, it still goes to the agent, noting the page part is done.
   */
  async request(reading: Reading, said: string, lines: Line[], cued?: boolean): Promise<Gated | undefined> {
    const page = reading.page!, command = taken(page);
    if (walked(page)) return this.walk(reading, command, cued);
    if (command) return cued ? this.cued(reading) : this.present(reading, command, lines);
    if (page.other >= PAGE_OTHER && this.fastAction) return cued ? this.cued(reading) : this.improvise(said, reading, !(page.only >= PAGE_ONLY && page.work < PAGE_WORK));
  }
  /**
   * Runs the command Jev chose, then asks Jev, with the page as it is now and what ran, whether another should run, until it
   * wants none: "forward three sections" is three steps, "go to the options and highlight the recommendation" two. Each
   * step shows for a moment before the next.
   */
  async steps(first: string, lines: Line[]): Promise<StageRun> {
    const bridge = this.bridge, done: StageCommand[] = [];
    let next: string | undefined = first, onScreen = '';
    for (let n = 0; next && n < MOST_STEPS; n++) {
      const ran = await bridge.stage.run([next]).catch(error => { throw error instanceof StageError ? new (error.constructor as typeof StageError)(error.message, [...done, ...error.done], error.onScreen, error.failed) : error; });
      done.push(...ran.done); onScreen = ran.onScreen;
      if (n + 1 === MOST_STEPS) break;
      const shown = Date.now(), view = await bridge.stage.describe(0).catch(() => undefined);
      next = view && await bridge.read({ trigger: 'step', lines, page: view, done: [...done] }).then(reading => reading.page?.command, () => undefined);
      // Only a step forward or back repeats: a part reached again is no further on (two tabs taken in turns, five times, on
      // the synthetic set).
      if (next && !RELATIVE.test(next) && done.some(c => c.id === next)) next = undefined;
      if (next) await pause(this.stepDwellMs - (Date.now() - shown));
    }
    return { done, onScreen };
  }
  /** The operator said more: once they have been quiet a moment, their words are judged. */
  heardOperator() {
    clearTimeout(this.listening);
    this.listening = setTimeout(() => void this.operatorTurn(), this.operatorQuietMs);
    this.listening.unref?.();
  }
  /**
   * The operator has finished (a moment's quiet, GPT Live answering, or a request for their words reaching the gate): Jev
   * reads their latest words once, and what they ask of the page is done at once. Resolves to the reading and whether
   * the page moved; undefined without a page on the stage.
   */
  operatorTurn(): Promise<TurnRead> | undefined {
    clearTimeout(this.listening);
    const bridge = this.bridge, history = bridge.mediator?.history, said = history?.latestOperator() ?? '';
    if (!said || !history || !bridge.jev || !bridge.stage.tabId) return;
    if (this.turn && this.turn.said === said) return this.turn.read;
    const read = this.judgeTurn(said, history);
    this.turn = { said, read, at: Date.now() };
    return read;
  }
  /** For the gate: what came of these words, if the presenter read them (then their page part is done once). */
  async turnFor(said: string): Promise<TurnRead | undefined> {
    await this.operatorTurn();
    const turn = this.turn;
    return turn && same(turn.said, said) ? turn.read : undefined;
  }
  async judgeTurn(said: string, history: NonNullable<Harness['mediator']>['history']): Promise<TurnRead> {
    const bridge = this.bridge, started = Date.now(), context = bridge.mediator?.context, lines = history.lines();
    let reading: Reading | undefined;
    try {
      const [view, sessions] = await Promise.all([bridge.stage.describe(), bridge.sessionSwitch.sessions(300)]);
      reading = view && await bridge.read({ trigger: 'turn', lines, sessions, page: view });
      if (!reading?.page) return { said, reading, moved: false };
      // A standing instruction or a setting in their words counts whatever happens to the page.
      bridge.consider(reading);
      const page = reading.page, command = taken(page), walk = walked(page);
      bridge.log({ type: 'stage.turn', said: said.slice(-200), command, walk: page.walk, only: page.only, work: page.work, unhappy: page.unhappy, ms: Date.now() - started });
      if (!walk && !command) {
        // Unhappy with the page, and nothing on it does what they mean: their words go to the agent to fix how it responds,
        // whether or not GPT Live passes them on (a complaint about the page is the strongest sign its controls fall short).
        if (page.unhappy >= PAGE_UNHAPPY && view && bridge.mediator?.escalate(controllerNote(view))) {
          bridge.log({ type: 'stage.escalated', said: said.slice(-200), unhappy: page.unhappy });
          context?.now('thinking', unhappySent(bridge.agent));
        }
        return { said, reading, moved: false };
      }
      this.movedForOperatorAt = Date.now();
      if (walk) { history.cueLatest(cueMovedNote); context?.add('commentary', walkStarted(bridge.agent, await this.startWalk(command))); return { said, reading, moved: true }; }
      const moving = Date.now();
      context?.now('thinking', pageMoving([view!.commands.find(c => c.id === command) ?? { say: command! }]));
      let ran: StageRun | undefined;
      try { ran = await this.steps(command!, lines); }
      catch (error) {
        // The page's controls failed: their words go to the agent with the error, to fix them, and GPT Live hears so.
        if (!(error instanceof StageNothing)) {
          const message = (error as Error).message, failed = error instanceof StageError ? [error.failed] : [view!.commands.find(c => c.id === command) ?? { id: command!, say: command! }];
          this.movedForOperatorAt = 0;
          if (bridge.mediator?.escalate(pageFailedNote(failed, message, view))) bridge.log({ type: 'stage.escalated', said: said.slice(-200), error: message });
          context?.now('thinking', pageFailed(bridge.agent, message, error instanceof StageError ? error.done : []));
          return { said, reading, moved: false };
        }
        // The page's own step had nothing to do ("Already on the last step" of a part's steps): the operator wants to go
        // on, so fdc's step over the sections does; at the very end the voice says so, and it never claims a move.
        const over = error.done.length ? undefined : sectionStep(error.failed.id);
        ran = error.done.length ? { done: error.done, onScreen: error.onScreen } : over ? await bridge.stage.run([over]).catch(() => undefined) : undefined;
        if (!ran) { this.movedForOperatorAt = 0; context?.now('thinking', pageAtEnd(error.message)); return { said, reading, moved: false }; }
      }
      const { done, onScreen } = ran;
      // A request for these words now moves nothing again, and GPT Live's own move words in its answer aren't taken.
      history.cueLatest(cueMovedNote);
      this.presentedAt = Date.now();
      bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen });
      // Already answering before the page moved, GPT Live can't have known what it shows: it hears it to say (only what is
      // on screen: commentary is paraphrased aloud, instructions and all).
      if (this.spokeAt >= moving) context?.add('commentary', pageNow(onScreen), null);
      else context?.now('thinking', operatorMoved(onScreen));
      return { said, reading, moved: true };
    } catch (error) { bridge.log({ type: 'stage.turn_failed', said: said.slice(-200), message: (error as Error).message }); return { said, reading, moved: false }; }
  }
  /** A walkthrough the gate found asked for (unless the operator's words already started it): fdc paces it. */
  async walk(reading: Reading, command: string | undefined, cued?: boolean): Promise<Gated> {
    if (cued) return { reading, handled: cueHandled(this.bridge.agent), page: true };
    return { reading, handled: walkStarted(this.bridge.agent, await this.startWalk(command)), page: true };
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
  /** For the agent, with a request the page didn't do: its controls fell short (the operator is unhappy with it), or where the user was looking. */
  noteFor(view: StageView, page?: PageJudgment) { return (page?.unhappy ?? 0) >= PAGE_UNHAPPY ? controllerNote(view) : lookingNote(view); }
  /** The voice moved the page as it answered: nothing moves again ("next slide" twice is two slides), and only the page asked for, nothing goes to the agent. */
  cued(reading: Reading): Gated {
    const { only, work } = reading.page!;
    if (only >= PAGE_ONLY && work < PAGE_WORK) return { reading, handled: cueHandled(this.bridge.agent), page: true };
    return { reading };
  }

  /**
   * The page commands Jev picks run on the stage at once. Only page commands: fdc handled it.
   * With more in it: the request goes on, noting the page part is done. If the page's controls
   * fail, the request goes to the harness with the error, to fix them.
   */
  async present(reading: Reading, command: string, lines: Line[]): Promise<Gated> {
    const bridge = this.bridge, { agent } = bridge, { only, work } = reading.page!;
    try {
      const { done, onScreen } = await this.steps(command, lines);
      this.presentedAt = Date.now();
      bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen });
      if (only >= PAGE_ONLY && work < PAGE_WORK) return { reading, handled: pageHandled(agent, done, onScreen), page: true };
      return { reading, note: pageDoneNote(done), told: pageAlongside(agent, done, onScreen) };
    } catch (error) {
      const done = error instanceof StageError ? error.done : [];
      if (done.length) bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen: (error as StageError).onScreen });
      // Nothing to do there: not the page's fault, but not done either, so the request goes on.
      if (error instanceof StageNothing) return { reading, note: pageNothingNote(error.failed), told: pageNothing(agent, error.failed) };
      // The agent gets the request with the error, to fix its page; GPT Live hears how far it got.
      const message = (error as Error).message, failed = error instanceof StageError ? [error.failed] : [bridge.stage.view?.commands.find(c => c.id === command) ?? { id: command, say: command }];
      return { reading, note: pageFailedNote(failed, message, bridge.stage.view), told: pageFailed(agent, message, done) };
    }
  }

  /** No command fits: a fast model writes a one-off action for the page, which runs at once; the agent hears of it, to add a command. */
  async improvise(said: string, reading: Reading, alongside = false): Promise<Gated> {
    const bridge = this.bridge, { agent } = bridge, started = Date.now();
    let steps: PageAction[] = [];
    try {
      const { actions } = await this.fastAction!.write(said, await bridge.stage.digest());
      steps = actions;
      // What the stage reads on screen afterwards, not the fast model's account of what it meant to do.
      const onScreen = await bridge.stage.act(actions);
      const done = [{ id: 'one_off', say: `A one-off action for "${said.slice(0, 80)}"` }];
      bridge.log({ type: 'stage.improvised', said, actions, ms: Date.now() - started });
      bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen });
      // Done at once, and the agent hears of it too: no command could do it, so the page's controller is what fell short.
      if (alongside) return { reading, note: `${pageDoneNote(done)} ${oneOffNote(said, onScreen)}`, told: pageAlongside(agent, done, onScreen) };
      return { reading, note: oneOffNote(said, onScreen), told: oneOffDone(agent, onScreen) };
    } catch (error) {
      const message = (error as Error).message;
      bridge.log({ type: 'stage.improvise_failed', said, actions: steps, message, ms: Date.now() - started });
      return { reading, note: improvisedFailedNote(message), told: pageNothing(agent, { say: `a one-off action (${message.slice(0, 120)})` }) };
    }
  }
}
