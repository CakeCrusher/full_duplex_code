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
    if (stage.at && stage.at !== el) stage.history.push(stage.at);
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
  // A deck's slides: sibling sections with ids, only one shown at a time.
  const deckSlides = () => {
    const groups = new Map();
    for (const el of document.querySelectorAll('section[id], article[id], [data-slide][id], .slide[id]')) { const list = groups.get(el.parentElement) ?? []; list.push(el); groups.set(el.parentElement, list); }
    return [...groups.values()].find(list => list.length >= 3 && list.some(visible) && list.some(el => !visible(el))) ?? [];
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
    // Back: to the named place shown before the last one (a slide, a section, a part), else the element before.
    commands.push({ id: 'back', say: 'Go back to wherever the viewer was just before the last move (only when they say go back without naming a part)', run: async () => {
      if (stage.trail.length >= 2) { stage.trail.pop(); return stage.run(stage.trail.at(-1), { again: true }); }
      const el = stage.history.pop(); if (!el) return null; stage.at = el; stage.ringOn = true; reveal(el, 'center'); await settle(); return describe(el);
    } });
    const scroll = async direction => { scrollBy({ top: direction * innerHeight * 0.6, behavior: 'smooth' }); await new Promise(r => setTimeout(r, 450)); stage.at = null; return describe(current('paragraph')); };
    commands.push({ id: 'scroll_down', say: 'Scroll down a bit, when they name no unit (not paragraphs, sections or items)', run: () => scroll(1) });
    commands.push({ id: 'scroll_up', say: 'Scroll up a bit, when they name no unit (not paragraphs, sections or items)', run: () => scroll(-1) });
    commands.push({ id: 'top', say: 'Go to the top of the page', run: () => go(units('heading')[0] ?? document.body, 'start') });
    commands.push({ id: 'highlight_here', say: 'Highlight the paragraph in view, only when the operator says "highlight this" without naming what', run: async () => { const el = current('paragraph'); stage.at = el; stage.ringOn = true; place(); return describe(el); } });
    commands.push({ id: 'clear_highlight', say: 'Remove the highlight', run: async () => { stage.ringOn = false; place(); return 'The highlight is off.'; } });
    const used = new Set(commands.map(c => c.id));
    const unique = id => { let out = id, n = 2; while (used.has(out)) out = `${id}_${n++}`; used.add(out); return out; };
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
      commands.push({ id: unique(`goto_${slug(name || title)}`), say: (name ? `Go to the ${top ? 'section' : 'part'} "${name}" (headed "${title}")` : `Go to the ${top ? 'section' : 'heading'} "${title}"`) + also, anchor: anchorOf(h), name: name || (title.length <= 40 ? title : ''), top, run: () => go(h, 'start') });
    }
    // A deck without a controller: sibling sections with ids, only one shown at a time. Each slide is
    // offered by its title and shown through its address (#id), as such decks do.
    if (!window.fdcController) {
      const slides = deckSlides();
      const showSlide = async el => { location.hash = el.id; await new Promise(r => setTimeout(r, 250)); if (!visible(el)) throw new Error(`Slide #${el.id} didn't show through its address`); stage.at = el; stage.ringOn = false; place(); return describe(el.querySelector(UNITS.heading) ?? el); };
      const at = () => slides.findIndex(visible);
      if (slides.length) {
        // On a deck, "next" means the next slide: section and heading moves stay within the slide shown.
        for (const c of commands) if (/^(next|previous)_(section|heading)$/.test(c.id)) c.say += ' (within the slide shown, not the next slide)';
        commands.push({ id: 'next_slide', say: 'Go to the next slide ("next", "next one", "keep going")', run: async () => slides[at() + 1] ? showSlide(slides[at() + 1]) : null });
        commands.push({ id: 'previous_slide', say: 'Go to the previous slide ("previous", "back one")', run: async () => at() > 0 ? showSlide(slides[at() - 1]) : null });
        // A slide's gist (its first words after the title) lets people name it by what it says.
        slides.forEach((el, i) => { const heading = el.querySelector(UNITS.heading), title = text(heading ?? el).slice(0, 80), gist = ([...el.querySelectorAll('p, li, figcaption, td')].map(x => (x.textContent || '').replace(/\s+/g, ' ').trim()).find(t => t.length > 20) ?? '').slice(0, 80); commands.push({ id: unique(`slide_${i + 1}`), say: `Go to slide ${i + 1}: "${title}"${gist ? ` (${gist}…)` : ''}`, anchor: el.id, name: title, run: () => showSlide(el) }); });
      }
    }
    // An annotation the page's own controller already offers isn't offered twice: a near-duplicate splits the choice.
    const offered = page().map(c => c.say.toLowerCase()).join('\n');
    // Only what is shown: an annotation on a hidden slide or tab is the page's own controller's to show.
    for (const el of [...document.querySelectorAll('[data-fdc]')].slice(0, 30)) if (visible(el) && !offered.includes(el.dataset.fdc.toLowerCase())) commands.push({ id: unique(`show_${slug(el.dataset.fdc)}`), say: `Show and highlight: ${el.dataset.fdc}`, anchor: anchorOf(el), name: el.dataset.fdc, run: () => go(el) });
    return commands;
  };
  // What the page holds, section by section, for the voice to present from: each section's name and its opening words.
  const outline = () => (!window.fdcController && deckSlides().length) ? deckSlides().slice(0, 30).map(el => {
    const heading = el.querySelector(UNITS.heading), body = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return `${text(heading ?? el).slice(0, 80)} — ${body.slice(0, 200)}`;
  }).join('\n') : units('heading').filter(h => level(h) <= sectionLevel()).slice(0, 24).map(h => {
    let next = h.nextElementSibling; while (next && !text(next)) next = next.nextElementSibling;
    const name = short(h) || text(h).slice(0, 40);
    return `${name} — ${text(h).slice(0, 100)}: ${next ? text(next).slice(0, 180) : ''}`;
  }).join('\n');
  const page = () => {
    const c = window.fdcController;
    if (!c?.commands) return [];
    // A command's name is what people call its target: given, or the quoted title in what it says ('Go to slide 3: "Margins"').
    const quoted = say => [...String(say ?? '').matchAll(/["“]([^"”]{2,60})["”]/g)].at(-1)?.[1];
    return c.commands().slice(0, 80).map(cmd => ({ id: `page_${slug(cmd.id)}`, say: cmd.say, name: cmd.name ?? quoted(cmd.say), run: async () => { const out = await c.run(cmd.id); return typeof out === 'string' ? out : describe(stage.at); } }));
  };
  // Following speech: the paragraph, item or row on screen that shares the most words with GPT Live's latest sentence.
  const STOP = new Set('the and for with that this you are was its from they their what when which into about there here have has not but all can will one our your let lets look now just then than also each more most very like some any out who how why where were been being these those them his her she him had would could should does did done get got make made over only both such same other'.split(' '));
  const stem = w => w.replace(/['’]s$/, '').replace(/(ings|ing|ed|es|s)$/, '');
  const words = s => new Set((String(s).toLowerCase().match(/[a-z0-9][a-z0-9'’-]{2,}/g) ?? []).filter(w => !STOP.has(w)).map(stem));
  const inView = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const followSpeech = sentence => {
    // A highlight the viewer asked off stays off while GPT Live talks on; their next move brings it back.
    if (stage.quiet) return null;
    const said = words(sentence);
    if (said.size < 2) return null;
    let best = null, bestScore = 0;
    for (const el of document.querySelectorAll('p, li, tr, dd, blockquote, figcaption, h2, h3, h4')) {
      if (!visible(el) || !inView(el) || el.closest('#__fdc_ring')) continue;
      const own = words(text(el)); if (own.size < 2) continue;
      let shared = 0; for (const w of said) if (own.has(w)) shared++;
      const score = shared / Math.min(said.size, own.size);
      if (shared >= 2 && score > bestScore) { best = el; bestScore = score; }
    }
    if (!best || bestScore < 0.3) return null;
    if (best !== stage.at) { stage.at = best; stage.ringOn = true; best.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); place(); }
    return { on: text(best).slice(0, 100), score: Math.round(bestScore * 100) / 100 };
  };
  const stage = window.__fdcStage = {
    version: VERSION, history: [], trail: [], at: null, ringOn: false, quiet: false, follow: followSpeech,
    commands: () => [...page(), ...base()],
    describe() {
      const c = window.fdcController;
      return {
        title: document.title, url: location.href,
        about: c?.about ?? null,
        where: c?.where?.() ?? describe(current('paragraph')),
        commands: stage.commands().map(({ id, say, anchor, name, top }) => ({ id, say, ...anchor ? { anchor } : {}, ...name ? { name } : {}, ...top ? { top } : {} })),
        cues: c?.cues?.() ?? [],
        outline: c?.outline?.() ?? outline(),
      };
    },
    async run(id, { again = false } = {}) {
      const command = stage.commands().find(c => c.id === id);
      if (!command) throw new Error(`No command "${id}" on this page`);
      stage.quiet = id === 'clear_highlight';
      // Nothing to do (no earlier place to go back to, no next item): null, and fdc sends the request on.
      const out = (await command.run()) ?? null;
      // A move to a named place joins the trail that back follows; relative moves (next, scroll) don't.
      if (out !== null && !again && !/(^|_)(next|previous|prev|back|scroll|top|bottom|clear|here)(_|$)/.test(id) && stage.trail.at(-1) !== id) stage.trail.push(id);
      return out;
    },
  };
})();
