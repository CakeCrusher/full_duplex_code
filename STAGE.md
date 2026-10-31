# Making a page the voice can present

fdc's voice companion presents the page the user is looking at, and the page follows what it says:
as it talks about something on the page, or says it will show it, fdc moves the page there and
opens or highlights what it means, in about a second, without you. The user just talks to it; they
never steer the page themselves, so never tell them what to say to move it, or that it has
commands. fdc reads the page's structure and runs commands in it through the browser tools.
Everything below is optional and additive: the more of it a page has, the more the voice can show.

Show the page with the browser tools (navigate a tab, or open one): the tab you show is the one
the voice presents. Once it is shown, where it is belongs to the voice: check your work in another
tab or a headless browser, not by scrolling or clicking through the tab the user is looking at.

## 1. Structure (free)

Use real headings (`h1`–`h4`) for sections, and paragraphs, lists, figures and tables for the
rest. fdc already moves through these like a screen reader: next or previous section, heading,
paragraph, list item or figure; any heading by name; back to where the user was; top; highlight
what is on screen. A `<table>` on screen also gets a highlight for each of its rows (by the first
cell) and columns (by the header).

## 2. Annotations (cheap)

Put `data-fdc="what this is"` on the elements worth pointing at that aren't headings: a key
number, the recommendation, a chart, a step, a warning.

```html
<p data-fdc="the recommendation">Keep GPT Live and build …</p>
<figure data-fdc="latency chart: request to view change">…</figure>
```

Each one becomes a command "Show and highlight: the recommendation".

## 3. A controller (for anything interactive)

For slides, tabs, maps, charts, grids, filters, toggles, animations or an app, define
`window.fdcController`. Keep it in its own file beside the page (`diagram.controller.js` for
`diagram.html`), loaded after the page's own script with a version in its address
(`<script src="diagram.controller.js?v=3"></script>`, raised with every change), so a reload
never runs a copy the browser kept: it is a document you maintain and grow, and it survives
rewrites of the page.

How fdc uses it, so you can write it to be used well:

- Each sentence the voice says is read beside every command's `say`, its `name`, the page's
  `about` and where the user is (`where()`), and the command that shows what the voice is talking
  about runs. Nothing else of your controller is read: a command that can't be told apart from
  another by its `say` is one that can't be chosen.
- After a command runs, the page is read again, and the next command can run straight away: the
  commands of a part (`part`, below) are offered once that part is on screen, so "the FDC row in
  the waves grid" is the section first, then the grid's own highlight. Up to four steps follow one
  sentence.
- What `run()` returns is what the voice is told is now on screen.

```js
window.fdcController = {
  // One line: what this page is.
  about: 'Slide deck: Q3 review, 12 slides',
  // What fdc may run. Each command is whole: one id, no arguments.
  commands() {
    return [
      { id: 'next_slide', say: 'Go to the next slide' },
      { id: 'previous_slide', say: 'Go to the previous slide' },
      ...slides.map((s, i) => ({ id: `slide_${i + 1}`, say: `Go to slide ${i + 1}: "${s.title}"`, name: s.title })),
      // A part's own controls name the part's element: offered only while it is on screen.
      { id: 'revenue_next_quarter', say: 'Show the next quarter in the revenue chart', part: 'revenue' },
      { id: 'revenue_split_regions', say: 'Split the revenue chart by region', part: 'revenue' },
      { id: 'revenue_highlight_emea', say: 'Highlight the EMEA bar in the revenue chart', part: 'revenue' },
    ];
  },
  // Do it, and resolve once the view has settled. Throw only if the controller is broken.
  async run(id) {
    // …
    return 'Slide 4 of 12: "Margins". Gross margin is 41%, up 3 points.';
  },
  // Where the user is now, in words and in structure (only where: not what to say or do next).
  where() {
    return { text: `Slide ${current + 1} of 12: "${slides[current].title}"`, path: ['Q3 review', slides[current].title], step: { index: current + 1, total: 12, of: 'slide' }, revision: 7 };
  },
};
```

`where()` (and `run()`, if you like) may return plain text or `{ text, path, step, revision }`:
`path` the parts from the outer one in (`['FDC waves', 'Wave 2']`), `step` where the user is in
the part they're in (`{ index: 2, total: 4, of: 'wave' }`), and `revision` your page's content
version. The voice and fdc's judge read these instead of guessing from your wording; without
them, "Stage 3 of 5" in your text still counts as a step. Without `where()`, fdc describes the
element in view, which can't tell which slide, step or tab is showing.

The controller only moves the page. What the voice knows of the page comes from the page's own text, hidden slides and
tabs included: each part in short, and what is on screen whenever the page moves. To let it explain something, put it on
the page, never in the controller.

Rules that make it work well:

- **Whole commands.** List one command per target (one per slide, tab, place, row, column, filter
  value or toggle) instead of a command with a parameter. Ids use lowercase letters, digits and
  underscores; keep it under about 60 commands at a time (a part's own count only while it is on
  screen).
- **`say` is how it is chosen.** Write what the command does in plain words, naming its target
  the way people would, including how the page labels it on screen ("Tonight · 1 of 7", "Step 3").
  Give a command that goes to a named place (a slide, a tab, a view) a `name`, the words people use
  for it. Keep names short and distinct.
- **Next and previous.** If the page steps (slides, stages, steps), give it commands whose ids say
  so (`next_slide`, `previous_slide`): when the voice moves on, the page takes your step.
- **A part's own controls go with the part.** Steps inside one part (a step-through box, a demo's
  buttons, a chart's views) get `part`: the id of that part's element. They are offered only while it
  is on screen, so the list stays short and "next" there is the part's next step. When its steps run
  out, return a limit ("Already on the last step"): the voice hears it.
- **Point at what a grid or chart holds.** For a grid, matrix or chart that isn't a plain `<table>`,
  give each row, column, series and notable point a highlight command with `part`, and each toggle
  or view switch its own command that says what it shows ("Split the FDC row into its campaigns",
  "Show likes per post"): the voice draws the user's eye to a row or a peak as it explains it, and
  flips a view as it talks about it.
- **Show what you do.** Your commands show their own result (the slide, a lit stage, a highlighted
  row): fdc's ring steps aside when one of your commands runs, so one highlight shows.
- **Hidden things are yours to show.** Annotations on slides or tabs that aren't on screen can't be
  reached by structure alone: give them commands that show their slide or tab first.
- **Return what is on screen.** A sentence or two about what the user now sees, not what comes next or how much
  else there is ("all 9 stages run" sent the voice through all nine): the voice talks about what you return.
- **Limits are answers, bugs are errors.** When a command can't apply right now (already on the last
  slide, nothing to go back to), return a sentence saying so: the voice hears it. Throw only when
  the controller itself is broken (an element it expects is missing, a call fails): the error comes
  to you with the user's next request, so you can fix the controller.
- **Keep the user's place.** Keep the view in the address (`#waves/2`) or `sessionStorage` and restore
  it on load, so a reload after your edit brings the page back where the user was, with any view or
  toggle they had on.
- **Grow it.** When a request shows the user wanted to see something the page has no command for, add one (or a
  name, an annotation) in the controller's file, so the voice can show it next time.
- **Change the page, change its controller.** Every edit that adds, removes, renames or reorders parts
  updates the controller's file in the same change, and raises its version in the page's script tag:
  new parts get commands and names, removed ones lose theirs. A page whose controller lags behind it is
  the commonest reason the voice can't show something.
- **Keep it current.** `commands()` is read again before each use, so it can follow the page's
  state (for example, only the slides that exist).
