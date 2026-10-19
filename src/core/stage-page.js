// The stage script, run by fdc in the page the operator is looking at (through Open Claude in
// Chrome, src/core/stage.ts). Installs window.__fdcStage once: a screen-reader-style structure
// controller (sections, headings, paragraphs, items, figures), the page's own annotations
// (data-fdc) and controller (window.fdcController), merged into one list of commands.
(() => {
  const VERSION = 1;
  if (window.__fdcStage?.version === VERSION) return;
  const UNITS = {
    heading: 'h1, h2, h3, h4',
    paragraph: 'p, li, blockquote, pre, dd',
    item: 'li, tr, dt',
    figure: 'figure, img, svg, canvas, video, table',
  };
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
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
    const label = h.previousElementSibling && text(h.previousElementSibling).length < 40 ? text(h.previousElementSibling).replace(/^\d+\s*[·.:-]\s*/, '') : '';
    return [/^[a-z][\w-]{2,30}$/i.test(id) && !/^h\d|^section\d/i.test(id) ? id.replace(/[-_]/g, ' ') : '', label.toLowerCase()].filter(Boolean)[0] ?? '';
  };
  // The id a command lands on (its element's, or the nearest enclosing one): for checking where a command goes.
  const anchorOf = el => el.id || el.closest('[id]')?.id || null;
  const base = () => {
    const commands = [];
    for (const [kind, label] of [['section', 'section'], ['heading', 'heading'], ['paragraph', 'paragraph'], ['item', 'list item or row'], ['figure', 'figure, image or table']]) {
      commands.push({ id: `next_${kind}`, say: `Go to the next ${label}`, run: () => go(step(kind, 1), kind === 'section' || kind === 'heading' ? 'start' : 'center') });
      commands.push({ id: `previous_${kind}`, say: `Go to the previous ${label}`, run: () => go(step(kind, -1), kind === 'section' || kind === 'heading' ? 'start' : 'center') });
    }
    commands.push({ id: 'back', say: 'Go back to wherever the viewer was just before the last move (only when they say go back without naming a part)', run: async () => { const el = stage.history.pop(); if (!el) return null; stage.at = el; stage.ringOn = true; reveal(el, 'center'); await settle(); return describe(el); } });
    commands.push({ id: 'top', say: 'Go to the top of the page', run: () => go(units('heading')[0] ?? document.body, 'start') });
    commands.push({ id: 'highlight_here', say: 'Highlight what is on screen now', run: async () => { const el = current('paragraph'); stage.at = el; stage.ringOn = true; place(); return describe(el); } });
    commands.push({ id: 'clear_highlight', say: 'Remove the highlight', run: async () => { stage.ringOn = false; place(); return 'The highlight is off.'; } });
    const used = new Set(commands.map(c => c.id));
    const unique = id => { let out = id, n = 2; while (used.has(out)) out = `${id}_${n++}`; used.add(out); return out; };
    const seen = {};
    for (const h of units('heading')) seen[text(h).toLowerCase()] = (seen[text(h).toLowerCase()] ?? 0) + 1;
    for (const h of units('heading')) {
      const title = text(h).slice(0, 90), name = short(h), top = level(h) <= sectionLevel();
      if (!name && seen[title.toLowerCase()] > 1) continue;
      commands.push({ id: unique(`goto_${slug(name || title)}`), say: name ? `Go to the ${top ? 'section' : 'part'} "${name}" (headed "${title}")` : `Go to the ${top ? 'section' : 'heading'} "${title}"`, anchor: anchorOf(h), name: name || (title.length <= 40 ? title : ''), top, run: () => go(h, 'start') });
    }
    // An annotation the page's own controller already offers isn't offered twice: a near-duplicate splits the choice.
    const offered = page().map(c => c.say.toLowerCase()).join('\n');
<<<<<<< HEAD
    for (const el of document.querySelectorAll('[data-fdc]')) if (!offered.includes(el.dataset.fdc.toLowerCase())) commands.push({ id: unique(`show_${slug(el.dataset.fdc)}`), say: `Show and highlight: ${el.dataset.fdc}`, anchor: anchorOf(el), name: el.dataset.fdc, run: () => go(el) });
=======
    // Only what is shown: an annotation on a hidden slide or tab is the page's own controller's to show.
    for (const el of document.querySelectorAll('[data-fdc]')) if (visible(el) && !offered.includes(el.dataset.fdc.toLowerCase())) commands.push({ id: unique(`show_${slug(el.dataset.fdc)}`), say: `Show and highlight: ${el.dataset.fdc}`, anchor: anchorOf(el), run: () => go(el) });
>>>>>>> presenter/controller
    return commands;
  };
  // What the page holds, section by section, for the voice to present from: each section's name and its opening words.
  const outline = () => units('heading').filter(h => level(h) <= sectionLevel()).slice(0, 24).map(h => {
    let next = h.nextElementSibling; while (next && !text(next)) next = next.nextElementSibling;
    const name = short(h) || text(h).slice(0, 40);
    return `${name} — ${text(h).slice(0, 100)}: ${next ? text(next).slice(0, 180) : ''}`;
  }).join('\n');
  const page = () => {
    const c = window.fdcController;
    if (!c?.commands) return [];
    // A command's name is what people call its target: given, or the quoted title in what it says ('Go to slide 3: "Margins"').
    const quoted = say => [...String(say ?? '').matchAll(/["“]([^"”]{2,60})["”]/g)].at(-1)?.[1];
    return c.commands().map(cmd => ({ id: `page_${slug(cmd.id)}`, say: cmd.say, name: cmd.name ?? quoted(cmd.say), run: async () => { const out = await c.run(cmd.id); return typeof out === 'string' ? out : describe(stage.at); } }));
  };
  const stage = window.__fdcStage = {
    version: VERSION, history: [], at: null, ringOn: false,
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
    async run(id) {
      const command = stage.commands().find(c => c.id === id);
      if (!command) throw new Error(`No command "${id}" on this page`);
      const out = await command.run();
      return out ?? `Nothing to do for "${id}" here; still at ${describe(current('paragraph'))}`;
    },
  };
})();
