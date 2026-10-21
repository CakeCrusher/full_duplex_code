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

How the voice tool uses it, so you can write it to be used well:

- When the user stops speaking, a judge reads what they said beside every command's `say`, the
  page's `about` and where the user is (`where()`), and picks the one command that does what they
  asked. It sees nothing else of your controller: a command it can't tell apart from another by its
  `say` is a command it can't choose.
- After that command runs, it reads `where()` again and decides whether the user asked for more
  ("forward two slides", "open the options and highlight the recommendation"), one command at a time.
- What `run()` returns is what the voice is told is now on screen, and what it says about it.
- A command's `name` is a phrase the voice itself can say ("let's look at Margins") to move the page
  as it talks.

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
      // A part's own controls name the part's element: offered only while it is on screen.
      { id: 'next_quarter', say: 'Show the next quarter in the revenue chart', part: 'revenue' },
    ];
  },
  // Do it, and resolve once the view has settled. Throw only if the controller is broken.
  async run(id) {
    // …
    return 'Slide 4 of 12: "Margins". Gross margin is 41%, up 3 points.';
  },
  // Where the user is now, in words, in the terms your commands use (only where: not what to say or do next).
  // Without it, the voice tool describes the element in view, which can't tell which slide, step or tab is showing.
  where() { return `Slide ${current + 1} of 12: "${slides[current].title}"`; },
};
```

The controller only moves the page. What the voice knows of the page comes from the page's own text, hidden slides and
tabs included: each part in short, and what is on screen whenever the page moves. To let it explain something, put it on
the page, never in the controller.

Rules that make it work well:

- **Whole commands.** List one command per target (one per slide, tab, place or filter value)
  instead of a command with a parameter. Ids use lowercase letters, digits and underscores;
  keep it under about 60 commands.
- **`say` is how it is chosen.** Write what the command does in plain words, naming its target
  the way the user would, including how the page labels it on screen ("Tonight · 1 of 7", "Step 3"). Give a command that goes to a named place (a slide, a tab, a view) a
  `name`, the words people use for it: the voice says "let's look at" and that name to go there,
  as it talks. Only commands with a `name` can be reached that way; keep names short and distinct.
- **Next and previous.** If the page steps (slides, stages, steps), give it commands whose ids say
  so (`next_slide`, `previous_slide`): the voice says "let's go to the next one" or "let's go back
  one" and the page takes your step.
- **A part's own controls go with the part.** Steps inside one part (a step-through box, a demo's
  buttons, a chart's views) get `part`: the id of that part's element. They are offered only while it
  is on screen, so the list stays short and "next" there is the part's next step. When its steps run
  out, return a limit ("Already on the last step"): the voice tool goes on to the next section.
- **Show what you do.** Your commands show their own result (the slide, a lit stage, a highlighted
  row): the voice tool's ring steps aside when one of your commands runs, so one highlight shows.
- **Hidden things are yours to show.** Annotations on slides or tabs that aren't on screen can't be
  reached by structure alone: give them commands that show their slide or tab first.
- **Sequences belong in one command.** If showing something takes several steps (open a tab,
  wait for it, scroll to a row, highlight it), make it one command and `await` each step in
  `run()`. The voice tool can also run several commands in a row when the user asks for them, one at a time, reading the page again after each (`where()` helps it see how far it got).
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
