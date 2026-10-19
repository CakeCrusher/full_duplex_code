// The stage script, run by fdc in the page the operator is looking at (through Open Claude in
// Chrome, src/core/stage.ts). Installs window.__fdcStage once: a screen-reader-style structure
// controller (sections, headings, paragraphs, items, figures), the page's own annotations
// (data-fdc) and controller (window.fdcController), merged into one list of commands.
(() => {
  // Stamped by fdc from the script's content (stage.ts): a changed script installs itself again.
  const VERSION = '__FDC_STAGE_VERSION__';
  if (window.__fdcStage?.version === VERSION) return;
  const UNITS = {
    heading: 'h1, h2, h3, h4',
    paragraph: 'p, li, blockquote, pre, dd',
    item: 'li, tr, dt',
    figure: 'figure, img, svg, canvas, video, table',
  };
  // Shown: laid out, and neither it nor anything around it transparent or hidden (decks often keep other slides
  // laid out at opacity 0).
  const visible = el => {
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) { const st = getComputedStyle(a); if (st.visibility === 'hidden' || Number(st.opacity) < 0.05) return false; }
    return true;
  };
  const text = el => (el.getAttribute?.('aria-label') || el.innerText || el.textContent || el.getAttribute?.('alt') || '').replace(/\s+/g, ' ').trim();
  const slug = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'x';
  const units = kind => [...document.querySelectorAll(UNITS[kind])].filter(el => visible(el) && !el.closest('#__fdc_ring') && (kind !== 'paragraph' || text(el).length > 20) && !(kind === 'figure' && el.closest('figure') && el.tagName !== 'FIGURE'));
  const level = el => Number(el.tagName[1]) || 9;
  // The section level: the commonest heading level below the title.
  const sectionLevel = () => {
    const counts = {};
    for (const h of units('heading')) counts[level(h)] = (counts[level(h)] ?? 0) + 1;
    const levels = Object.keys(counts).map(Number).sort();
    return levels.find(l => l > 1 && counts[l] > 1) ?? levels[0] ?? 2;
  };
  const before = (a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
  const sectionOf = el => {
    const top = sectionLevel();
    let found = null;
    for (const h of units('heading')) { if (level(h) <= top && (h === el || before(h, el))) found = h; }
    return found;
  };

  // A ring around the current element, kept in place while the page scrolls.
  document.getElementById('__fdc_ring')?.remove();
  const ring = document.createElement('div');
  ring.id = '__fdc_ring';
  Object.assign(ring.style, { position: 'fixed', pointerEvents: 'none', zIndex: 2147483646, borderRadius: '10px', boxShadow: '0 0 0 3px rgba(255,170,0,.95), 0 0 0 9px rgba(255,170,0,.25)', transition: 'all .25s ease', opacity: '0' });
  document.documentElement.appendChild(ring);
  const place = () => {
    const el = stage.at;
    if (!el || !el.isConnected) { ring.style.opacity = '0'; return; }
    const r = el.getBoundingClientRect(), pad = 6;
    Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px`, opacity: stage.ringOn ? '1' : '0' });
  };
  let frame = 0;
  const follow = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(place); };
  addEventListener('scroll', follow, { passive: true, capture: true }); addEventListener('resize', follow);

  const settle = () => new Promise(resolve => {
    // Scrolling ends when the element stops moving in the view.
    let last = NaN, still = 0;
    const tick = () => { const y = stage.at?.getBoundingClientRect().top ?? 0; if (Math.abs(y - last) < 1) still++; else still = 0; last = y; place(); if (still > 4) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick); setTimeout(resolve, 1200);
  });
  // Near: glide, so the eye follows. Far: jump, then pulse the ring so the eye finds it.
  const reveal = (el, block) => {
    const r = el.getBoundingClientRect(), far = r.bottom < -innerHeight * 1.5 || r.top > innerHeight * 2.5;
    el.scrollIntoView({ behavior: far ? 'instant' : 'smooth', block });
    if (far) ring.animate([{ transform: 'scale(1.04)', opacity: 0.2 }, { transform: 'scale(1)', opacity: 1 }], { duration: 450, easing: 'ease-out' });
  };
  const describe = el => {
    if (!el) return 'Nothing is selected.';
    const section = sectionOf(el), kind = el.matches(UNITS.heading) ? 'heading' : el.matches('figure, img, svg, canvas, video') ? 'figure' : el.matches('table') ? 'table' : el.matches('li, tr, dt') ? 'item' : 'paragraph';
    const body = el.matches(UNITS.heading) ? text(el) + (el.nextElementSibling ? ' — ' + text(el.nextElementSibling) : '') : text(el);
    return `${kind} ${section && section !== el ? `in "${text(section).slice(0, 80)}"` : ''}: ${body.slice(0, 600)}`.replace(/\s+/g, ' ');
  };
  const go = async (el, block = 'center') => {
    if (!el) return null;
    // Where the viewer was, even before any move (the paragraph at the top of the view): back returns there.
    const from = current('paragraph');
    if (from && from !== el) stage.history.push(from);
    stage.at = el; stage.ringOn = true;
    reveal(el, block);
    await settle();
    return describe(el);
  };
  // The element the viewer is looking at: the first unit near the top of the view.
  const current = kind => stage.at?.isConnected ? stage.at : units(kind).find(el => el.getBoundingClientRect().bottom > innerHeight * 0.15) ?? null;
  const step = (kind, direction) => {
    const list = kind === 'section' ? units('heading').filter(h => level(h) <= sectionLevel()) : units(kind);
    const from = current(kind === 'section' ? 'heading' : kind);
    if (!from) return direction > 0 ? list[0] : null;
    if (direction > 0) return list.find(el => el !== from && before(from, el) && !from.contains(el)) ?? null;
    return [...list].reverse().find(el => el !== from && before(el, from) && !el.contains(from)) ?? null;
  };

  // What a section shows besides its words (captions, diagram and table titles), for matching "the sequence diagrams".
  const shows = h => {
    const box = h.closest('section, article');
    if (!box || box.querySelector(UNITS.heading) !== h) return [];
    // Annotations have commands of their own: naming them here too would split Jev's choice between two.
    const found = [...box.querySelectorAll('figcaption, svg > title, table > caption, img[alt]')].map(el => (el.getAttribute('alt') || text(el)).slice(0, 60)).filter(Boolean);
    return [...new Set(found)].slice(0, 3);
  };
  // The id a command lands on (its element's, or the nearest enclosing one): for checking where a command goes.
  const anchorOf = el => el.id || el.closest('[id]')?.id || null;
  const base = () => {
    const commands = [];
    for (const [kind, label] of [['section', 'section'], ['heading', 'heading'], ['paragraph', 'paragraph'], ['item', 'list item or row'], ['figure', 'figure, image or table']]) {
      commands.push({ id: `next_${kind}`, say: `Go to the next ${label}`, run: () => go(step(kind, 1), kind === 'section' || kind === 'heading' ? 'start' : 'center') });
      commands.push({ id: `previous_${kind}`, say: `Go to the previous ${label}`, run: () => go(step(kind, -1), kind === 'section' || kind === 'heading' ? 'start' : 'center') });
    }
    // Back: undoes the last move. After a step through paragraphs or items, the element before; after a page's own
    // step ("previous slide"), the named place it left; after a move to a named place (a slide, a section), the one before.
    commands.push({ id: 'back', say: 'Go back to wherever the viewer was just before the last move (only when they say go back without naming a part)', run: async () => {
      const { relative, stepped } = stage.last;
      if (relative && !stepped && stage.trail.length) { stage.last = {}; return stage.run(stage.trail.at(-1), { again: true }); }
      if (!relative && stage.trail.length >= 2) { stage.trail.pop(); return stage.run(stage.trail.at(-1), { again: true }); }
      const el = stage.history.pop(); if (!el) return null; stage.at = el; stage.ringOn = true; reveal(el, 'center'); await settle(); return describe(el);
    } });
    // Where the viewer was is remembered, so back returns there after a scroll.
    const scroll = async direction => { const from = current('paragraph'), y = scrollY; if (from) stage.history.push(from); scrollBy({ top: direction * innerHeight * 0.6, behavior: 'smooth' }); await new Promise(r => setTimeout(r, 450)); if (from && scrollY === y) stage.history.pop(); stage.at = null; return describe(current('paragraph')); };
    commands.push({ id: 'scroll_down', say: 'Scroll down a bit, when they name no unit (not paragraphs, sections or items)', run: () => scroll(1) });
    commands.push({ id: 'scroll_up', say: 'Scroll up a bit, when they name no unit (not paragraphs, sections or items)', run: () => scroll(-1) });
    commands.push({ id: 'top', say: 'Go to the top of the page', run: () => go(units('heading')[0] ?? document.body, 'start') });
    commands.push({ id: 'highlight_here', say: 'Highlight the paragraph in view, only when the operator says "highlight this" without naming what', run: async () => { const el = current('paragraph'); stage.at = el; stage.ringOn = true; place(); return describe(el); } });
    commands.push({ id: 'clear_highlight', say: 'Remove the highlight', run: async () => { stage.ringOn = false; place(); return 'The highlight is off.'; } });
    const used = new Set(commands.map(c => c.id));
    const unique = id => { let out = id, n = 2; while (used.has(out)) out = `${id}_${n++}`; used.add(out); return out; };
    // A section's own short name (its id, or a short label above the heading) comes first: it is what
    // people call it. Headings that repeat ("Landed" in several sections) are left to next/previous.
    const short = h => {
      const section = h.closest('section[id], article[id]'), id = h.id || (section?.querySelector(UNITS.heading) === h ? section.id : '');
      // A short label above the heading names it, unless it is only a counter ("1 / 15").
      const above = h.previousElementSibling && text(h.previousElementSibling).length < 40 ? text(h.previousElementSibling).replace(/^\d+\s*[·.:-]\s*/, '') : '';
      // A label several headings share ("changed" over four of them) is a category, not a name.
      const shared = above && units('heading').filter(x => x !== h && x.previousElementSibling && text(x.previousElementSibling).replace(/^\d+\s*[·.:-]\s*/, '') === above).length > 0;
      const label = (above.match(/[a-z]/gi) ?? []).length >= 3 && !shared ? above : '';
      return [/^[a-z][\w-]{2,30}$/i.test(id) && !/^h\d|^section\d/i.test(id) ? id.replace(/[-_]/g, ' ') : '', label.toLowerCase()].filter(Boolean)[0] ?? '';
    };
    const seen = {};
    for (const h of units('heading')) seen[text(h).toLowerCase()] = (seen[text(h).toLowerCase()] ?? 0) + 1;
    // A long page offers its sections first and sub-headings while there's room: every command is part of each
    // of Jev's step questions, so the list stays around 70 (the rest is reached by next and previous).
    const all = units('heading'), sections = all.filter(h => level(h) <= sectionLevel()).slice(0, 40);
    let room = Math.max(0, 50 - sections.length);
    const headings = all.filter(h => sections.includes(h) || (level(h) > sectionLevel() && room-- > 0));
    for (const h of headings) {
      const title = text(h).slice(0, 90), name = short(h), top = level(h) <= sectionLevel();
      if (!name && seen[title.toLowerCase()] > 1) continue;
      const what = shows(h), also = what.length ? `; it shows ${what.join('; ')}` : '';
      commands.push({ id: unique(`goto_${slug(name || title)}`), say: (name ? `Go to the ${top ? 'section' : 'part'} "${name}" (headed "${title}")` : `Go to the ${top ? 'section' : 'heading'} "${title}"`) + also, anchor: anchorOf(h), run: () => go(h, 'start') });
    }
    // A deck without a controller: sibling sections with ids, only one shown at a time. Each slide is
    // offered by its title and shown through its address (#id), as such decks do.
    if (!window.fdcController) {
      const groups = new Map();
      for (const el of document.querySelectorAll('section[id], article[id], [data-slide][id], .slide[id]')) { const list = groups.get(el.parentElement) ?? []; list.push(el); groups.set(el.parentElement, list); }
      const slides = [...groups.values()].find(list => list.length >= 3 && list.some(visible) && list.some(el => !visible(el))) ?? [];
      const showSlide = async el => { location.hash = el.id; await new Promise(r => setTimeout(r, 250)); if (!visible(el)) throw new Error(`Slide #${el.id} didn't show through its address`); stage.at = el; stage.ringOn = false; place(); return describe(el.querySelector(UNITS.heading) ?? el); };
      const at = () => slides.findIndex(visible);
      if (slides.length) {
        // On a deck, "next" means the next slide: section and heading moves stay within the slide shown.
        for (const c of commands) if (/^(next|previous)_(section|heading)$/.test(c.id)) c.say += ' (within the slide shown, not the next slide)';
        // A step says which slide it left and where it landed, by the slides' own commands, for back.
        const step = async to => { if (!slides[to]) return null; stage.leftFrom = `slide_${at() + 1}`; stage.landedAt = `slide_${to + 1}`; return showSlide(slides[to]); };
        commands.push({ id: 'next_slide', say: 'Go to the next slide ("next", "next one", "keep going")', run: () => step(at() + 1) });
        commands.push({ id: 'previous_slide', say: 'Go to the previous slide ("previous", "back one")', run: async () => at() > 0 ? step(at() - 1) : null });
        // A slide's gist (its first words after the title) lets people name it by what it says.
        slides.forEach((el, i) => { const heading = el.querySelector(UNITS.heading), title = text(heading ?? el).slice(0, 80), gist = ([...el.querySelectorAll('p, li, figcaption, td')].map(x => (x.textContent || '').replace(/\s+/g, ' ').trim()).find(t => t.length > 20) ?? '').slice(0, 80); commands.push({ id: unique(`slide_${i + 1}`), say: `Go to slide ${i + 1}: "${title}"${gist ? ` (${gist}…)` : ''}`, anchor: el.id, name: title, run: () => { stage.leftFrom = `slide_${at() + 1}`; return showSlide(el); } }); });
      }
    }
    // An annotation the page's own controller already offers isn't offered twice: a near-duplicate splits the choice.
    const offered = page().map(c => c.say.toLowerCase()).join('\n');
    // Only what is shown: an annotation on a hidden slide or tab is the page's own controller's to show.
    for (const el of [...document.querySelectorAll('[data-fdc]')].slice(0, 30)) if (visible(el) && !offered.includes(el.dataset.fdc.toLowerCase())) commands.push({ id: unique(`show_${slug(el.dataset.fdc)}`), say: `Show and highlight: ${el.dataset.fdc}`, anchor: anchorOf(el), run: () => go(el) });
    return commands;
  };
  // What a limit says, at its start ("Already on the first slide", "You can't go back", "This is the last slide"), or
  // "the deck has 6" ("No slide 7; the deck has 6"). Not a fault, which goes to the agent to fix, even one mentioning a
  // first slide or an end ("Cannot find the first slide element", "Unexpected token at the end of input").
  const LIMIT_ANSWER = /^(you('re| are) |we('re| are) |it('s| is) |this is |that('s| is) )?(already\b|no (more|next|previous|earlier|later|further)\b|nothing (more|left|before|after)\b|can['’]?t go\b|cannot go\b|(the )?(first|last|only) (slide|section|page|item|step|one)\b)/i;
  const LIMIT = { test: text => LIMIT_ANSWER.test(text) || /\b(the|this) (deck|page) (only )?has \d/i.test(text) };
  const page = () => {
    const c = window.fdcController;
    if (!c?.commands) return [];
    // A command's name is what people call its target: given, or the quoted title in what it says ('Go to slide 3: "Margins"').
    const quoted = say => [...String(say ?? '').matchAll(/["“]([^"”]{2,60})["”]/g)].at(-1)?.[1];
    // camelCase ids read as words ("nextSlide" is next_slide), so a relative move is known as one.
    return c.commands().slice(0, 80).map(cmd => ({ id: `page_${slug(String(cmd.id).replace(/([a-z0-9])([A-Z])/g, '$1_$2'))}`, say: cmd.say, name: cmd.name ?? quoted(cmd.say), run: async () => {
      let out;
      // A limit thrown ("Already on the first slide") is an answer, as the guide asks controllers to return it; not a broken control.
      try { out = await c.run(cmd.id); } catch (error) { if (!LIMIT.test(String(error?.message ?? ''))) throw error; stage.limited = true; return String(error.message); }
      return typeof out === 'string' ? out : describe(stage.at);
    } }));
  };
  // For a one-off action (fdc's fallback when no command fits): what the viewer can act on, numbered,
  // and what is on screen. Action code reaches element [n] as el(n).
  const ACTABLE = 'button, a[href], input, select, textarea, summary, [role=tab], [role=button], [role=menuitem], [role=checkbox], [role=switch], [role=option], [onclick], [tabindex]:not([tabindex="-1"])';
  const digest = () => {
    const els = [...document.querySelectorAll(ACTABLE)].filter(el => visible(el) && !el.closest('#__fdc_ring')).slice(0, 80);
    stage.indexed = els;
    const state = el => [el.getAttribute('aria-selected') === 'true' && 'selected', el.getAttribute('aria-expanded') === 'true' && 'expanded', el.checked && 'checked', el.disabled && 'disabled', 'value' in el && el.value && el.tagName !== 'BUTTON' && `value "${String(el.value).slice(0, 30)}"`].filter(Boolean).join(', ');
    const lines = els.map((el, i) => `[${i + 1}] ${el.getAttribute('role') || el.tagName.toLowerCase()}${el.type && el.tagName === 'INPUT' ? `(${el.type})` : ''} "${(text(el) || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('href') || '').slice(0, 60)}"${state(el) ? ` (${state(el)})` : ''}`);
    const headings = units('heading').slice(0, 30).map(h => `${'#'.repeat(level(h))} ${text(h).slice(0, 80)}`);
    const seen = [...document.querySelectorAll('p, li, td, figcaption, h1, h2, h3')].filter(el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && visible(el); }).map(text).join(' ').slice(0, 1500);
    return `Page "${document.title}" (${location.href}), scrolled ${Math.round(scrollY)} of ${Math.max(0, document.documentElement.scrollHeight - innerHeight)} px.\nWhere: ${window.fdcController?.where?.() ?? describe(current('paragraph'))}\nHeadings:\n${headings.join('\n')}\nInteractive elements:\n${lines.join('\n')}\nOn screen now: ${seen}`;
  };
  // Relative moves and non-moves by their ids: the page's own commands and fdc's, never ids made from a heading's or
  // slide's name ("Clear wins", "Back end").
  const OWN = id => !/^(goto|slide|show)_/.test(id);
  const RELATIVE = { test: id => OWN(id) && /(^|_)(next|previous|prev|back|forward|scroll|top|bottom)(_|$)/.test(id) }, NOT_A_MOVE = { test: id => OWN(id) && /(^|_)(clear|here)(_|$)/.test(id) };
  // The named place a page's answer is about: 'Slide 2 of 6: "Margins"' is where the command named "Margins" goes.
  const landed = text => { const title = /["“]([^"”]{2,80})["”]/.exec(String(text ?? ''))?.[1]; return title ? stage.commands().find(c => c.name === title && !RELATIVE.test(c.id))?.id : undefined; };
  const stage = window.__fdcStage = {
    version: VERSION, history: [], trail: [], last: {}, at: null, ringOn: false, indexed: [], digest,
    /** For action code: element [n] of the last digest, showing an element (scroll and ring), waiting. */
    el: n => { const el = stage.indexed[n - 1]; if (!el) throw new Error(`No element [${n}]`); return el; },
    show: async el => { if (!el) throw new Error('Nothing to show'); return go(el); },
    wait: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 3000))),
    now: () => describe(stage.at?.isConnected ? stage.at : current('paragraph')),
    /** A one-off's steps (fast-action.ts), carried out here: only these, and never a link to another site. */
    async perform(actions) {
      for (const a of actions) {
        if (a.do === 'click') {
          const el = stage.el(a.n), link = el.closest('a[href]');
          const away = url => new URL(url, location.href).origin !== location.origin;
          if (link && away(link.href)) throw new Error(`Won't follow a link to another site (${new URL(link.href, location.href).host})`);
          // A control that submits sends its form to its own address or the form's: never to another site.
          // (Attributes, not formAction or action: those fall back to this page's address when unset.)
          const submitter = el.closest('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]');
          if (submitter?.form && away(submitter.getAttribute('formaction') || submitter.form.getAttribute('action') || location.href)) throw new Error("Won't send a form to another site");
          // SVG controls have no click(): a click event does it.
          if (typeof el.click === 'function') el.click(); else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await new Promise(r => setTimeout(r, 120));
        } else if (a.do === 'show') await go(stage.el(a.n));
        else if (a.do === 'find') {
          // Every word, anywhere in it: "Q4 42%" is a row whose cells say Q4 and 42%. The exact phrase first.
          const want = String(a.text).toLowerCase().replace(/\s+/g, ' ').trim(), words = want.split(' ').filter(Boolean);
          const flat = el => (el.textContent || '').toLowerCase().replace(/\s+/g, ' ');
          const candidates = [...document.querySelectorAll('body *')].filter(el => !el.closest('#__fdc_ring'));
          // Every ancestor of a match matches too: keep the ones with no matching child (one pass, not pairs). The exact
          // phrase is looked for on its own, so a child with every word ("gpt-live-1") doesn't hide its cell ("GPT Live").
          // Words scattered over a whole section don't count: nothing far longer than what was asked for.
          const short = el => flat(el).length <= Math.max(400, want.length * 20);
          const smallest = says => { const all = candidates.filter(el => says(flat(el))), matched = new Set(all); return all.filter(el => ![...el.children].some(c => matched.has(c)) && visible(el) && short(el)); };
          let hits = smallest(t => t.includes(want));
          if (!hits.length) hits = smallest(t => words.every(w => t.includes(w)));
          if (!hits.length) throw new Error(`Nothing on the page says "${a.text}"`);
          // The kind of thing the operator named ("the Gemini row"), when one says it, over the first mention.
          const kind = { row: 'tr, [role=row]', item: 'li, [role=listitem]', cell: 'td, th, [role=cell]', heading: 'h1, h2, h3, h4, h5, h6, [role=heading]', paragraph: 'p, dd, blockquote, figcaption' }[a.in];
          // Near where the viewer is first: "now the GPT Live row", after the Gemini row, is in the same table.
          const box = stage.at?.isConnected ? stage.at.closest('table, ul, ol, section, article') : null;
          const near = list => box ? [...list.filter(el => box.contains(el)), ...list.filter(el => !box.contains(el))] : list;
          const named = kind ? near(hits.map(el => el.closest(kind)).filter(Boolean)) : [], first = near(hits)[0];
          await go(named[0] ?? first.closest('tr, li, p, td, dd, figcaption, h1, h2, h3, h4, button') ?? first);
        } else if (a.do === 'scroll') {
          if (a.to === 'top' || a.to === 'bottom') scrollTo({ top: a.to === 'top' ? 0 : document.documentElement.scrollHeight, behavior: 'smooth' });
          else scrollBy({ top: (a.to === 'down' ? 1 : -1) * innerHeight * 0.6, behavior: 'smooth' });
          await new Promise(r => setTimeout(r, 450));
        } else if (a.do === 'wait') await new Promise(r => setTimeout(r, Math.min(3000, Number(a.ms) || 0)));
        else throw new Error(`Unknown page step ${a.do}`);
      }
      return stage.now();
    },
    commands: () => [...page(), ...base()],
    describe() {
      const c = window.fdcController;
      return {
        title: document.title, url: location.href,
        about: c?.about ?? null,
        where: c?.where?.() ?? describe(current('paragraph')),
        commands: stage.commands().map(({ id, say, anchor }) => ({ id, say, ...anchor ? { anchor } : {} })),
        cues: c?.cues?.() ?? [],
      };
    },
    async run(id, { again = false } = {}) {
      const command = stage.commands().find(c => c.id === id);
      if (!command) throw new Error(`No command "${id}" on this page`);
      // Where the viewer starts, when the page names it, is the first place back can return to.
      if (!stage.trail.length && id !== 'back') { let start; try { start = landed(window.fdcController?.where?.()); } catch {} if (start) stage.trail.push(start); }
      // Nothing to do (no earlier place to go back to, no next item): null, and fdc sends the request on.
      stage.limited = false; stage.leftFrom = stage.landedAt = undefined;
      const steps = stage.history.length, out = (await command.run()) ?? null;
      // A move to a named place joins the trail that back follows, and so does a relative move ("next slide") that
      // lands on one the page names; any other relative move is only remembered as the last move, with whether it
      // stepped from an element back can return to.
      // A limit ("Already on the first slide") moved nothing.
      // Highlighting what's there or clearing it moves nothing; only the page's own answers name where a step landed
      // (fdc's own answers quote the section they're in).
      if (out !== null && !again && id !== 'back' && !NOT_A_MOVE.test(id) && !stage.limited && !LIMIT_ANSWER.test(String(out))) {
        const place = RELATIVE.test(id) ? (stage.landedAt ?? (id.startsWith('page_') ? landed(out) : undefined)) : id;
        if (place && !stage.trail.length && stage.leftFrom) stage.trail.push(stage.leftFrom);
        if (place) { stage.last = {}; if (stage.trail.at(-1) !== place) stage.trail.push(place); }
        else stage.last = { relative: true, stepped: stage.history.length > steps };
      }
      return out;
    },
  };
})();
