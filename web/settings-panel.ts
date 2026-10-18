// Developer mode: every setting with its value, its default and who set it last (the default, FDC_TUNING, or Jev
// and when), what it does and what each of its levels costs and buys (exactly as Jev reads them), and every
// change in this run, newest first.
interface Knob { min: number; max: number; describe: string; levels: { value: number; consequence: string }[] }
interface Change { name: string; from: number; to: number }
interface Status { tuning?: Record<string, number>; tuningPinned?: string[]; tuningHistory?: { at: number; by: string; changes: Change[] }[]; jevTuning?: boolean }

const GROUPS: [title: string, names: string[]][] = [
  ['How agent updates reach GPT Live', ['holdFirstMs', 'holdPerUpdateMs', 'holdLongestMs', 'thinkMs', 'pauseMs', 'compactTokens']],
  ['Standby', ['standbyAfterMs', 'wakeThreshold']],
  ['Standby prices', ['speechPrice', 'liveSpeechPrice', 'toolPrice', 'promptPrice', 'messagePrice', 'turnEndPrice', 'failurePrice', 'approvalPrice', 'requestPrice']],
];
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const format = (name: string, value: number) => name.endsWith('Ms') ? `${value / 1000} s` : name === 'compactTokens' ? `${value.toLocaleString()} tokens` : name.endsWith('Price') || name === 'wakeThreshold' ? `${value} pts` : String(value);
const tag = <K extends keyof HTMLElementTagNameMap>(name: K, text?: string, className?: string) => {
  const node = document.createElement(name); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node;
};

export function mountSettings(section: HTMLElement, token: string | null) {
  const body = section.querySelector<HTMLElement>('#settings-body')!, history = section.querySelector<HTMLElement>('#settings-history')!, jev = section.querySelector<HTMLElement>('#settings-jev')!;
  let knobs: Record<string, Knob> | null = null, defaults: Record<string, number> = {}, last: Status | null = null, shown = '';
  // Which details are open survives a redraw.
  const open = new Set<string>();
  if (token) fetch('/api/settings', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(data => {
    if (!data) return; knobs = data.knobs; defaults = data.defaults; shown = ''; if (last) update(last);
  }).catch(() => {});

  function setBy(name: string, status: Status) {
    const entry = [...status.tuningHistory ?? []].reverse().find(item => item.changes.some(change => change.name === name));
    if (entry) { const change = entry.changes.find(c => c.name === name)!; return `${entry.by} at ${clock(entry.at)}, from ${format(name, change.from)}`; }
    return status.tuningPinned?.includes(name) ? 'FDC_TUNING' : 'default';
  }
  // The bridge's status event, sent every second.
  function update(event: Record<string, any>) {
    const status = event as Status;
    last = status;
    if (!knobs || !status.tuning) return;
    const key = JSON.stringify([status.tuning, status.tuningPinned, status.tuningHistory?.length, status.jevTuning]);
    if (key === shown) return; shown = key;
    jev.textContent = status.jevTuning ? 'Jev tuning is on: Jev picks the levels from your instructions and words; settings set with FDC_TUNING are left to you.' : 'Jev tuning is off (FDC_TUNING=1 with TYPESAFE_API_KEY turns it on): the settings are the defaults and FDC_TUNING.';
    body.replaceChildren(...GROUPS.map(([title, names]) => {
      const group = tag('div', undefined, 'settings-group');
      group.append(tag('h3', title));
      const table = tag('table'); const head = tag('tr');
      for (const label of ['Setting', 'Value', 'Default', 'Set by', 'What it does']) head.append(tag('th', label));
      table.append(head);
      for (const name of names) {
        const knob = knobs![name]; if (!knob) continue;
        const value = status.tuning![name], row = tag('tr');
        if (value !== defaults[name]) row.className = 'changed';
        const details = tag('details'); details.open = open.has(name);
        details.ontoggle = () => { if (details.open) open.add(name); else open.delete(name); };
        details.append(tag('summary', knob.describe.split(/(?<=\.)\s/)[0]), tag('p', knob.describe));
        if (knob.levels.length) {
          const levels = tag('ul');
          for (const level of knob.levels) {
            const item = tag('li', undefined, level.value === value ? 'current' : undefined);
            item.append(tag('b', format(name, level.value)), ` ${level.consequence}`);
            levels.append(item);
          }
          details.append(levels);
        }
        const cell = tag('td'); cell.append(details);
        row.append(tag('td', name, 'mono'), tag('td', format(name, value), 'mono'), tag('td', format(name, defaults[name]), 'mono'), tag('td', setBy(name, status)), cell);
        table.append(row);
      }
      group.append(table);
      return group;
    }));
    const changes = [...status.tuningHistory ?? []].reverse();
    history.replaceChildren(...(changes.length ? changes.map(entry => {
      const item = tag('li');
      item.append(tag('time', clock(entry.at)), tag('b', entry.by), ` ${entry.changes.map(c => `${c.name} ${format(c.name, c.from)} → ${format(c.name, c.to)}`).join(', ')}`);
      return item;
    }) : [tag('li', 'No changes in this run: the settings are as they started.')]));
  }
  return { update };
}
