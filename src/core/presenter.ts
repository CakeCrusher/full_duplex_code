// The presenter: fdc showing the operator the page the coding agent made, in step with GPT Live, while the agent goes
// on producing. The operator never has to know how the page is moved:
// - What they ask of the page is done from their own words: when they finish speaking, their latest words are judged
//   once (Jev) and the page moves at once, or a walkthrough starts, whatever GPT Live says or passes on. GPT Live is
//   told what is on screen and talks about it.
// - A walkthrough is paced here: GPT Live presents the part on screen, and when it has finished, the page moves on.
// - GPT Live can point as it talks ("let's look at" a part, speech-cues.ts), and the ring follows its sentences.
// - Requests GPT Live passes on reach the gate (sessions.ts), which routes them; their page part is carried out here,
//   unless it already was, or with a one-off action when no command does it (fast-action.ts).
// The page itself, and how fdc reaches it, is the stage (stage.ts).
import type { Harness } from './bridge.ts';
import { CueMatcher, unglue, type SpeechCue } from './speech-cues.ts';
import { Stage, StageError, StageNothing, type StageRun, type StageView } from './stage.ts';
import { FastAction, type PageAction } from './fast-action.ts';
import { PAGE_ONLY, PAGE_OTHER, PAGE_RELATIVE_ONLY, PAGE_UNHAPPY, PAGE_WALK, PAGE_WORK, WALK_WORK, type PageJudgment } from './delegation-audit.ts';
import type { Gated } from './mediator.ts';
import { controllerNote, cueHandled, cueMovedNote, cueShown, improvisedFailedNote, lookingNote, oneOffDone, oneOffNote, operatorMoved, pageAlongside, pageAtEnd, pageMoving, pageNow, pageDoneNote, pageFailed, pageFailedNote, pageHandled, pageNothing, pageNothingNote, unhappySent, walkNext, walkStarted } from './prompts.ts';

/** The same words, however much of them each side caught. */
const same = (a: string, b: string) => { const x = a.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), y = b.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return !!x && !!y && (x.includes(y) || y.includes(x)); };
// What GPT Live says while the operator only pauses ("Mm-hmm", "Go on"): no answer, so not the end of their turn.
const BACKCHANNEL = new Set(['mm', 'mmm', 'mhm', 'hm', 'hmm', 'uh', 'huh', 'um', 'ah', 'oh', 'okay', 'ok', 'yeah', 'yes', 'yep', 'right', 'sure', 'alright', 'go', 'on', 'ahead', 'i', 'see', 'got', 'it', 'so']);
/** Whether GPT Live's words so far answer anything: a whole word beyond a backchannel. */
const answers = (said: string) => (said.toLowerCase().match(/[a-z']+(?=[^a-z'])/g) ?? []).some(word => !BACKCHANNEL.has(word));
/** A step forward or back: relative to where the page is. */
const RELATIVE = /(^|_)(next|previous|prev|back|forward)(_|$)/;
/** The steps Jev chose that are taken: a step forward or back only when the words are about moving the page. */
const taken = (page: PageJudgment) => page.steps.filter(id => !RELATIVE.test(id) || page.only >= PAGE_RELATIVE_ONLY);
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
   * The operator's latest words the presenter judged, and whether the page moved for them; the wait for them to finish.
   * GPT Live answering is the end of the operator's turn; quiet alone counts only after a while (a pause mid-sentence
   * isn't one: "Take me to … tonight" was judged as "Take me to").
   */
  turn?: { said: string; moved: Promise<boolean>; at: number }; listening?: ReturnType<typeof setTimeout>; operatorQuietMs = 2500;
  /** When the page last moved for the operator's words: GPT Live's own move words in that answer are not taken too. */
  movedForOperatorAt = 0;
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
      if (meant) void this.unlessOperatorMoved(() => this.judgedMove(meant));
      else if (Date.now() - this.presentedAt < 60000) bridge.stage.follow(sentence).then(on => { if (on) bridge.log({ type: 'stage.followed', sentence: sentence.slice(-160), ...on }); }).catch(() => {});
    }
  }
  /** GPT Live answering the operator moves the page by its own words only if their words moved nothing ("let's take a look at the core idea", said as it answered "take me to section three"). */
  async unlessOperatorMoved(move: () => unknown) {
    const turn = this.turn;
    if (turn && Date.now() - turn.at < 10000 && await turn.moved) return;
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
  async judgedMove(meant: string) {
    const bridge = this.bridge;
    if (this.judging || !bridge.handOffAudit) return;
    this.judging = true;
    const started = Date.now();
    try {
      const view = await bridge.stage.describe();
      if (!view) return;
      const page = (await bridge.handOffAudit.judge(`Show me ${meant}`, undefined, 3000, view)).page;
      if (!page?.steps.length || page.only < PAGE_ONLY) { bridge.log({ type: 'stage.cue_missed', meant, steps: page?.steps ?? [] }); return; }
      const { onScreen } = await bridge.stage.run(page.steps.slice(0, 1));
      this.presentedAt = Date.now();
      bridge.log({ type: 'stage.cue', run: page.steps[0], label: meant, judged: true, ms: Date.now() - started });
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
  async request(judged: PageJudgment, said: string, needsAgent: number | null, cued?: boolean): Promise<Gated | undefined> {
    const page = { ...judged, steps: taken(judged) };
    if ((page.walk ?? 0) >= PAGE_WALK && (page.work ?? 1) < WALK_WORK) return this.walk(page, needsAgent, cued);
    if (page.steps.length) return cued ? this.cued(page, needsAgent) : this.present(page, needsAgent);
    if ((page.other ?? 0) >= PAGE_OTHER && this.fastAction) return cued ? this.cued(page, needsAgent) : this.improvise(said, needsAgent, !(page.only >= PAGE_ONLY && (page.work ?? 1) < PAGE_WORK));
  }
  /** The operator said more: once they have been quiet a moment, their words are judged. */
  heardOperator() {
    clearTimeout(this.listening);
    this.listening = setTimeout(() => void this.operatorTurn(), this.operatorQuietMs);
    this.listening.unref?.();
  }
  /**
   * The operator has finished (a moment's quiet, GPT Live answering, or a request for their words reaching the gate):
   * their latest words are judged once, and what they ask of the page is done at once. Resolves to whether it moved.
   */
  operatorTurn(): Promise<boolean> {
    clearTimeout(this.listening);
    const bridge = this.bridge, history = bridge.mediator?.history, said = history?.latestOperator() ?? '';
    if (!said || !history || !bridge.handOffAudit || !bridge.stage.tabId) return Promise.resolve(false);
    if (this.turn && this.turn.said === said) return this.turn.moved;
    const moved = this.judgeTurn(said, history, this.voiceSaid);
    this.turn = { said, moved, at: Date.now() };
    return moved;
  }
  /** For the gate: whether the page already moved for these words (then it moves nothing again). */
  async movedFor(said: string) { const turn = this.turn; return !!turn && same(turn.said, said) && await turn.moved; }
  async judgeTurn(said: string, history: NonNullable<Harness['mediator']>['history'], voiceSaid: string): Promise<boolean> {
    const bridge = this.bridge, started = Date.now(), context = bridge.mediator?.context;
    try {
      const view = await bridge.stage.describe();
      const judged = view && (await bridge.handOffAudit!.judge(said, undefined, 3000, view, undefined, voiceSaid || undefined)).page;
      if (!judged) return false;
      const page = { ...judged, steps: taken(judged) };
      bridge.log({ type: 'stage.turn', said: said.slice(-200), steps: page.steps, walk: page.walk, only: page.only, work: page.work, unhappy: page.unhappy, ms: Date.now() - started });
      const walk = (page.walk ?? 0) >= PAGE_WALK && (page.work ?? 1) < WALK_WORK;
      if (!walk && !page.steps.length) {
        // Unhappy with the page, and nothing on it does what they mean: their words go to the agent to fix how it responds,
        // whether or not GPT Live passes them on (a complaint about the page is the strongest sign its controls fall short).
        if ((page.unhappy ?? 0) >= PAGE_UNHAPPY && view && bridge.mediator?.escalate(controllerNote(view))) {
          bridge.log({ type: 'stage.escalated', said: said.slice(-200), unhappy: page.unhappy });
          context?.now('thinking', unhappySent(bridge.agent));
        }
        return false;
      }
      this.movedForOperatorAt = Date.now();
      if (walk) { history.cueLatest(cueMovedNote); context?.add('commentary', walkStarted(bridge.agent, await this.startWalk(page.steps))); return true; }
      const moving = Date.now();
      context?.now('thinking', pageMoving(page.steps.map(id => view?.commands.find(c => c.id === id) ?? { say: id })));
      let ran: StageRun | undefined;
      try { ran = await bridge.stage.run(page.steps); }
      catch (error) {
        // The page's controls failed: their words go to the agent with the error, to fix them, and GPT Live hears so.
        if (!(error instanceof StageNothing)) {
          const message = (error as Error).message, failed = error instanceof StageError ? [error.failed] : page.steps.map(id => view?.commands.find(c => c.id === id) ?? { id, say: id });
          this.movedForOperatorAt = 0;
          if (bridge.mediator?.escalate(pageFailedNote(failed, message, view))) bridge.log({ type: 'stage.escalated', said: said.slice(-200), error: message });
          context?.now('thinking', pageFailed(bridge.agent, message, error instanceof StageError ? error.done : []));
          return false;
        }
        // The page's own step had nothing to do ("Already on the last step" of a part's steps): the operator wants to go
        // on, so fdc's step over the sections does; at the very end the voice says so, and it never claims a move.
        const over = sectionStep(error.failed.id);
        ran = over ? await bridge.stage.run([over]).catch(() => undefined) : undefined;
        if (!ran) { this.movedForOperatorAt = 0; context?.now('thinking', pageAtEnd(error.message)); return false; }
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
      return true;
    } catch (error) { bridge.log({ type: 'stage.turn_failed', said: said.slice(-200), message: (error as Error).message }); return false; }
  }
  /** A walkthrough the gate found asked for (unless the operator's words already started it): fdc paces it. */
  async walk({ steps }: PageJudgment, needsAgent: number | null, cued?: boolean): Promise<Gated> {
    if (cued) return { needsAgent, handled: cueHandled(this.bridge.agent), page: true };
    return { needsAgent, handled: walkStarted(this.bridge.agent, await this.startWalk(steps)), page: true };
  }
  /** Its first part shows, and fdc paces the rest: resolves to what is on screen. */
  async startWalk(steps: string[]): Promise<string> {
    const bridge = this.bridge;
    // It starts where the operator is: a part they named shows first, never the next one ("walk me through it" on part
    // five went on to six, and again each time they asked to stay on five).
    const named = steps.slice(0, 1).filter(id => !RELATIVE.test(id));
    let onScreen = named.length ? await bridge.stage.run(named).then(ran => ran.onScreen, () => '') : '';
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
  cued({ only, work = 0 }: PageJudgment, needsAgent: number | null): Gated {
    if (only >= PAGE_ONLY && work < PAGE_WORK) return { needsAgent, handled: cueHandled(this.bridge.agent), page: true };
    return { needsAgent };
  }

  /**
   * The page commands Jev picked run on the stage at once. Only page commands: fdc handled it.
   * With more in it: the request goes on, noting the page part is done. If the page's controls
   * fail, the request goes to the harness with the error, to fix them.
   */
  async present({ steps, only, work = 0 }: PageJudgment, needsAgent: number | null): Promise<Gated> {
    const bridge = this.bridge, { agent } = bridge;
    try {
      const { done, onScreen } = await bridge.stage.run(steps);
      this.presentedAt = Date.now();
      bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen });
      if (only >= PAGE_ONLY && work < PAGE_WORK) return { needsAgent, handled: pageHandled(agent, done, onScreen), page: true };
      return { needsAgent, note: pageDoneNote(done), told: pageAlongside(agent, done, onScreen) };
    } catch (error) {
      // Nothing to do there: not the page's fault, but not done either, so the request goes on.
      if (error instanceof StageNothing) return { needsAgent, note: pageNothingNote(error.failed), told: pageNothing(agent, error.failed) };
      // The agent gets the request with the error, to fix its page; GPT Live hears how far it got.
      const message = (error as Error).message, failed = error instanceof StageError ? [error.failed] : steps.map(id => bridge.stage.view?.commands.find(c => c.id === id) ?? { id, say: id });
      const done = error instanceof StageError ? error.done : [];
      if (done.length) bridge.publish({ type: 'stage', done: done.map(d => d.say), onScreen: (error as StageError).onScreen });
      return { needsAgent, note: pageFailedNote(failed, message, bridge.stage.view), told: pageFailed(agent, message, done) };
    }
  }

  /** No command fits: a fast model writes a one-off action for the page, which runs at once; the agent hears of it, to add a command. */
  async improvise(said: string, needsAgent: number | null, alongside = false): Promise<Gated> {
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
      if (alongside) return { needsAgent, note: `${pageDoneNote(done)} ${oneOffNote(said, onScreen)}`, told: pageAlongside(agent, done, onScreen) };
      return { needsAgent, note: oneOffNote(said, onScreen), told: oneOffDone(agent, onScreen) };
    } catch (error) {
      const message = (error as Error).message;
      bridge.log({ type: 'stage.improvise_failed', said, actions: steps, message, ms: Date.now() - started });
      return { needsAgent, note: improvisedFailedNote(message), told: pageNothing(agent, { say: `a one-off action (${message.slice(0, 120)})` }) };
    }
  }
}
