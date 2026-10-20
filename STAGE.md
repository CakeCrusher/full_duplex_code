# Making a page steerable by voice

fdc's voice tool can move the page the user is looking at without you. It reads the page's
structure and runs commands in it through the browser tools, in about a second, so the user can
say "go to the results", "next slide" or "highlight the total" without waiting for a turn of
yours. Everything below is optional and additive: the more of it a page has, the more it can do.

Show the page with the browser tools (navigate a tab, or open one): the tab you show is the one
the voice tool steers.

## 1. Structure (free)

Use real headings (`h1`–`h4`) for sections, and paragraphs, lists, figures and tables for the
rest. The voice tool already navigates by these like a screen reader: next or previous section,
heading, paragraph, list item or figure; go to any heading by name; back to where the user was;
top; highlight what is on screen.

## 2. Annotations (cheap)

Put `data-fdc="what this is"` on the elements worth pointing at that aren't headings: a key
number, the recommendation, a chart, a step, a warning.

```html
<p data-fdc="the recommendation">Keep GPT Live and build …</p>
<figure data-fdc="latency chart: request to view change">…</figure>
```

Each one becomes a command "Show and highlight: the recommendation".

## 3. A controller (for anything interactive)

For slides, tabs, maps, charts, filters, animations or an app, define `window.fdcController`.
Keep it in its own file beside the page (`diagram.controller.js` for `diagram.html`, loaded with
`<script src="diagram.controller.js"></script>` after the page's own script): it is a document you
maintain and grow, and it survives rewrites of the page.

```js
window.fdcController = {
  // One line: what this page is.
  about: 'Slide deck: Q3 review, 12 slides',
  // What the voice tool may run. Each command is whole: one id, no arguments.
  commands() {
    return [
      { id: 'next_slide', say: 'Go to the next slide' },
      { id: 'previous_slide', say: 'Go to the previous slide' },
      ...slides.map((s, i) => ({ id: `slide_${i + 1}`, say: `Go to slide ${i + 1}: "${s.title}"`, name: s.title })),
      { id: 'show_revenue_chart', say: 'Open the revenue chart full screen' },
    ];
  },
  // Do it, and resolve once the view has settled. Throw only if the controller is broken.
  async run(id) {
    // …
    return 'Slide 4 of 12: "Margins". Gross margin is 41%, up 3 points.';
  },
  // Optional: where the user is now, in words.
  where() { return `Slide ${current + 1} of 12: "${slides[current].title}"`; },
  // Optional: what the whole page says, part by part, starting each line with the part's name, so the
  // voice can present all of it (including slides or tabs not on screen) without asking you.
  outline() { return slides.map(s => `${s.title} — ${s.summary}`).join('\n'); },
};
```

Rules that make it work well:

- **Whole commands.** List one command per target (one per slide, tab, place or filter value)
  instead of a command with a parameter. Ids use lowercase letters, digits and underscores;
  keep it under about 60 commands.
- **`say` is how it is chosen.** Write what the command does in plain words, naming its target
  the way the user would. Give a command that goes to a named place (a slide, a tab, a view) a
  `name`, the words people use for it: the voice says "let's look at" and that name to go there,
  as it talks. Only commands with a `name` can be reached that way; keep names short and distinct.
- **Next and previous.** If the page steps (slides, stages, steps), give it commands whose ids say
  so (`next_slide`, `previous_slide`): the voice says "let's go to the next one" or "let's go back
  one" and the page takes your step.
- **Show what you do.** Your commands show their own result (the slide, a lit stage, a highlighted
  row): the voice tool's ring steps aside when one of your commands runs, so one highlight shows.
- **Hidden things are yours to show.** Annotations on slides or tabs that aren't on screen can't be
  reached by structure alone: give them commands that show their slide or tab first.
- **Sequences belong in one command.** If showing something takes several steps (open a tab,
  wait for it, scroll to a row, highlight it), make it one command and `await` each step in
  `run()`. The voice tool can also run up to three commands in a row when the user asks for them.
- **Return what is on screen.** A sentence or two about what the user now sees, not what comes next or how much
  else there is ("all 9 stages run" sent the voice through all nine): the voice talks about what you return.
- **Limits are answers, bugs are errors.** When a command can't apply right now (already on the last
  slide, nothing to go back to), return a sentence saying so: the voice tells the user. Throw only
  when the controller itself is broken (an element it expects is missing, a call fails): the voice
  tool then sends you the request with the error, so you can fix the controller.
- **Grow it.** When the voice tool tells you the user wanted something the controls couldn't do, add a command (or
  a name, an annotation) for it in the controller's file, so the voice can do it next time.
- **Change the page, change its controller.** Every edit that adds, removes, renames or reorders parts
  updates the controller's file in the same change: new parts get commands and names, removed ones lose
  theirs. A page whose controller lags behind it is the commonest reason the voice can't move it.
- **Keep it current.** `commands()` is read again before each use, so it can follow the page's
  state (for example, only the slides that exist).
