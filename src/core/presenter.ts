// The presenter: fdc showing the operator the page the coding agent made, moved by what GPT Live says as it talks, while
// the agent goes on producing. The operator never has to know how the page is moved; they talk, and the voice presents:
// - A part's name after a turning phrase ("let's look at" the results, speech-cues.ts) moves the page at once.
// - A turning phrase with words that name no part ("let's look at the error bars") asks Jev which of the page's commands
//   shows what the voice meant.
// - While it presents, a ring follows what its sentences are about.
// GPT Live is told what is on screen after each move. The page itself, and how fdc reaches it, is the stage (stage.ts).
import type { Harness } from './bridge.ts';
import { CueMatcher, unglue, type SpeechCue } from './speech-cues.ts';
import { StageNothing } from './stage.ts';
import type { Spoken } from './voice-history.ts';
import { cueFailedNote, cueMovedNote, cueShown, pageAnswered, pageMissed } from './prompts.ts';

export class Presenter {
  bridge: Harness;
  /** GPT Live's own words that move the page (speech-cues.ts). */
  speechCues = new CueMatcher();
  /** GPT Live's sentence so far, when it last spoke, and when its words last moved the page: then it is presenting. */
  sentence = ''; spokeAt = 0; presentedAt = 0;
  /** A cue fired in the current sentence; a judged move is in flight. */
  cuedInSentence = false; judging = false;
  constructor(bridge: Harness) { this.bridge = bridge; }
  /** GPT Live said more: a cue in it moves the page now, and GPT Live quietly hears what is on screen. */
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
    // At the end of each sentence: "let's look at" something that is no part's name means the voice meant to move the
    // page, so Jev finds the command; otherwise, while presenting, the ring follows what the sentence was about.
    if (ends) {
      const sentence = unglue(this.sentence.trim()), cued = this.cuedInSentence; this.sentence = ''; this.cuedInSentence = false;
      const meant = cued ? undefined : /\blet(?:'|’)?s\s+(?:look at|go to|go on to|go back to|turn to|head to|move to|move on to|jump to|look)\s+(.{3,80}?)\s*[.,;:!?]/i.exec(sentence)?.[1];
      if (meant) void this.judgedMove(meant, sentence);
      else if (Date.now() - this.presentedAt < 60000) bridge.stage.follow(sentence).then(on => { if (on) bridge.log({ type: 'stage.followed', sentence: sentence.slice(-160), ...on }); }).catch(() => {});
    }
  }
  /** GPT Live said a part's name after a turning phrase: the page goes there now, and GPT Live quietly hears what is on screen. */
  cue(cue: SpeechCue) {
    const bridge = this.bridge, history = bridge.mediator?.history, started = Date.now();
    // Answering the operator by moving the page: the agent hears of it with their words, and doesn't move it again.
    if (history && Date.now() - history.lastInputAt < 15000) history.cueLatest(cueMovedNote);
    if (bridge.mediator) bridge.mediator.cueAt = started;
    bridge.stage.run([cue.run]).then(({ onScreen }) => {
      bridge.log({ type: 'stage.cue', run: cue.run, label: cue.label, ms: Date.now() - started });
      bridge.publish({ type: 'stage', done: [cue.label], onScreen, cue: true });
      bridge.mediator?.context.now('thinking', cueShown(onScreen));
    }).catch(error => this.failed(cue.label, error as Error));
  }
  /** The voice said "let's look at" something by other words ("the repeat visit"): the page goes there if Jev is sure which. */
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
      if (!command) { bridge.log({ type: 'stage.cue_missed', meant }); bridge.mediator?.context.now('thinking', pageMissed(meant)); return; }
      const { onScreen } = await bridge.stage.run([command]);
      this.presentedAt = Date.now();
      bridge.log({ type: 'stage.cue', run: command, label: meant, judged: true, ms: Date.now() - started });
      bridge.publish({ type: 'stage', done: [meant], onScreen, cue: true });
      bridge.mediator?.context.now('thinking', cueShown(onScreen));
    } catch (error) { this.failed(meant, error as Error); }
    finally { this.judging = false; }
  }
  /**
   * The page didn't go where the voice turned: a limit is the page's answer ("Already on the last slide"), which the voice
   * hears; a failure is the controller's, and the operator's latest words carry the error to the agent, which fixes it.
   */
  failed(label: string, error: Error) {
    const bridge = this.bridge, view = bridge.stage.view;
    if (error instanceof StageNothing) { bridge.log({ type: 'stage.cue_nothing', label, answer: error.message }); bridge.mediator?.context.now('thinking', pageAnswered(error.message)); return; }
    bridge.log({ type: 'stage.cue_failed', label, message: error.message });
    bridge.mediator?.history.cueLatest(cueFailedNote(label, error.message, view));
  }
}
