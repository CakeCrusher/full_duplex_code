// The presenter: fdc showing the operator the page the coding agent made, in step with GPT Live, while the agent goes
// on producing. GPT Live's own words move the page ("let's look at" a part, speech-cues.ts) and the ring follows its
// sentences; the gate's page requests are carried out here too: the page's commands, or a one-off action when none
// fits (fast-action.ts). The page itself, and how fdc reaches it, is the stage (stage.ts).
import type { Harness } from './bridge.ts';
import { CueMatcher, unglue } from './speech-cues.ts';
import { Stage, StageError, StageNothing, type StageView } from './stage.ts';
import { FastAction, type PageAction } from './fast-action.ts';
import { PAGE_ONLY, PAGE_OTHER, PAGE_UNHAPPY, PAGE_WALK, PAGE_WORK, WALK_WORK, type PageJudgment } from './delegation-audit.ts';
import type { Gated } from './mediator.ts';
import { stepTaken, controllerNote, cueHandled, cueMovedNote, cueShown, improvisedFailedNote, lookingNote, oneOffDone, oneOffNote, pageAlongside, pageDoneNote, pageFailed, pageFailedNote, pageHandled, pageNothing, pageNothingNote, walkNext, walkStarted } from './prompts.ts';

// The operator asking only for a step: every word a filler or part of "next", "continue", "move on", "go back".
const FILLER = new Set('okay ok alright all right so and yes yeah sure um uh great cool good then now please wait no hey lets let us go move on to the a one slide step part section page please'.split(' '));
const FORWARD = /\b(next|continue|keep going|go on|carry on|move on|ahead|forward)\b/, BACK = /\b(back|previous)\b/;
export function stepAsked(said: string): 'next' | 'back' | undefined {
  const words = said.toLowerCase().replace(/[’']/g, '').replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 10) return;
  const text = words.join(' '), back = BACK.test(text), forward = FORWARD.test(text);
  if (back === forward || !words.every(w => FILLER.has(w) || ['next', 'continue', 'keep', 'going', 'carry', 'ahead', 'forward', 'back', 'previous'].includes(w))) return;
  return forward ? 'next' : 'back';
}

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
  /** When fdc last took a step the operator asked for: the voice's own move words in that answer are not taken too. */
  steppedAt = 0;
  constructor(bridge: Harness, apiKey?: string) { this.bridge = bridge; if (apiKey && apiKey !== 'unused') this.fastAction = new FastAction({ apiKey }); }
  /** GPT Live said more: a cue in it moves the page now, and GPT Live quietly hears what is on screen. */
  heard(delta: string) {
    const bridge = this.bridge;
    // The voice starts answering: the operator has finished, and if all they said was a step ("next", "let's continue",
    // "go back"), fdc takes it now, whatever the voice says or passes on (it named the wrong slide, or none).
    if (Date.now() - this.spokeAt > 1500) this.operatorStep();
    this.spokeAt = Date.now();
    if (Date.now() - this.steppedAt < 8000) { this.sentence = (this.sentence + delta).slice(-600); return; }
    this.sentence = (this.sentence + delta).slice(-600);
    for (const cue of this.speechCues.hear(delta)) {
      this.presentedAt = Date.now(); this.sentence = ''; this.cuedInSentence = true;
      // Answering the operator by moving the page: their words still go to the gate and, unless the move was all they
      // asked, to the agent, noted, so neither moves it again.
      const history = bridge.mediator?.history;
      if (history && Date.now() - history.lastInputAt < 15000) history.cueLatest(cueMovedNote);
      const started = Date.now();
      if (bridge.mediator) bridge.mediator.cueAt = started;
      bridge.stage.run([cue.run]).then(({ onScreen }) => {
        bridge.log({ type: 'stage.cue', run: cue.run, label: cue.label, ms: Date.now() - started });
        bridge.publish({ type: 'stage', done: [cue.label], onScreen, cue: true });
        bridge.mediator?.context.add('thinking', cueShown(onScreen), null);
      }).catch(error => bridge.log({ type: 'stage.cue_failed', run: cue.run, label: cue.label, message: (error as Error).message }));
    }
    // At the end of each sentence: "let's look at" something that is no part's name means the voice meant to move the
    // page, so Jev finds the command; otherwise, while presenting, the ring follows what the sentence was about.
    if (/[.!?]["”’)]?\s*$/.test(delta)) {
      const sentence = unglue(this.sentence.trim()), cued = this.cuedInSentence; this.sentence = ''; this.cuedInSentence = false;
      const meant = cued ? undefined : /\blet(?:'|’)?s\s+(?:look at|go to|go back to|turn to|head to|move to|jump to|look)\s+(.{3,80}?)\s*[.,;:!?]/i.exec(sentence)?.[1];
      if (meant) void this.judgedMove(meant);
      else if (Date.now() - this.presentedAt < 60000) bridge.stage.follow(sentence).then(on => { if (on) bridge.log({ type: 'stage.followed', sentence: sentence.slice(-160), ...on }); }).catch(() => {});
    }
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
      bridge.mediator?.context.add('thinking', cueShown(onScreen), null);
    } catch (error) { bridge.log({ type: 'stage.cue_failed', label: meant, message: (error as Error).message }); }
    finally { this.judging = false; }
  }
  /**
   * A request the gate found asking something of the page: its commands run (none again for words the voice already
   * moved the page for), or a one-off action when no command does it. Undefined when the page has nothing to do.
   * With work in the request too, it still goes to the agent, noting the page part is done.
   */
  async request(page: PageJudgment, said: string, needsAgent: number | null, cued?: boolean): Promise<Gated | undefined> {
    if ((page.walk ?? 0) >= PAGE_WALK && (page.work ?? 1) < WALK_WORK) return this.walk(page, needsAgent, cued);
    if (page.steps.length) return cued ? this.cued(page, needsAgent) : this.present(page, needsAgent);
    if ((page.other ?? 0) >= PAGE_OTHER && this.fastAction) return cued ? this.cued(page, needsAgent) : this.improvise(said, needsAgent, !(page.only >= PAGE_ONLY && (page.work ?? 1) < PAGE_WORK));
  }
  /**
   * The operator's latest words, when they are only a step forward or back: fdc takes it and tells the voice what is on
   * screen. Decided at once, before the voice's answer or a request for the same words can move the page again.
   */
  operatorStep() {
    const bridge = this.bridge, history = bridge.mediator?.history, said = history?.latestOperator() ?? '', direction = stepAsked(said);
    const view = direction && bridge.stage.tabId ? bridge.stage.view : undefined;
    const step = view && Stage.cues(view).find(c => c.step && c.label.startsWith(direction === 'next' ? 'next' : 'previous'))?.run;
    if (!history || !step) return;
    this.steppedAt = this.presentedAt = Date.now();
    history.cueLatest(cueMovedNote);
    if (this.walking) this.walking.movedAt = Date.now();
    void bridge.stage.run([step]).then(({ onScreen }) => {
      bridge.log({ type: 'stage.step', run: step, said });
      bridge.publish({ type: 'stage', done: [direction === 'next' ? 'The next part' : 'The previous part'], onScreen });
      bridge.mediator?.context.add('commentary', stepTaken(onScreen));
    }, error => bridge.log({ type: 'stage.step_failed', run: step, message: (error as Error).message }));
  }
  /** A walkthrough asked for: its first part shows (unless the voice already moved there), and fdc paces the rest. */
  async walk({ steps }: PageJudgment, needsAgent: number | null, cued?: boolean): Promise<Gated> {
    const bridge = this.bridge;
    let onScreen = '';
    if (steps.length && !cued) onScreen = await bridge.stage.run(steps.slice(0, 1)).then(ran => ran.onScreen, () => '');
    onScreen ||= (await bridge.stage.describe(0).catch(() => undefined))?.where ?? '';
    this.stopWalking();
    const now = Date.now(), timer = setInterval(() => void this.pace(), 500);
    timer.unref?.();
    this.walking = { startedAt: now, movedAt: now, parts: 0, timer };
    this.presentedAt = now;
    bridge.log({ type: 'stage.walk', state: 'started' });
    return { needsAgent, handled: walkStarted(bridge.agent, onScreen), page: true };
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
      const view = await bridge.stage.describe(0), next = view && Stage.cues(view).find(c => c.step && c.label.startsWith('next'))?.run;
      if (!view || !next) return this.stopWalking('no next part');
      const { onScreen } = await bridge.stage.run([next]);
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
