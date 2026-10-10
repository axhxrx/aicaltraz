/** The edit-mode 3-way merge (src/web/edit/merge.ts): base = what the draft started from, mine = the draft, theirs = the host now. */
import { describe, expect, test } from 'bun:test';
import { Config, parseConfig, type Button, type ConfigInput, type Pad } from '../src/core/config.ts';
import { merge3, type Origins } from '../src/web/edit/merge.ts';

const BASE: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'main',
      name: 'Main',
      cols: 3,
      rows: 2,
      buttons: [
        { id: 'lamp', label: 'Lamp', x: 0, y: 0, action: { type: 'shell', script: 'echo lamp' } },
        { id: 'boom', label: 'Boom', x: 1, y: 0, action: { type: 'shell', script: 'echo boom' } },
        { id: 'fan', label: 'Fan', x: 2, y: 0, action: { type: 'shell', script: 'echo fan' } },
      ],
    },
    { id: 'other', name: 'Other', cols: 2, rows: 2, buttons: [{ id: 'solo', label: 'Solo', x: 0, y: 0, action: { type: 'shell', script: 'echo solo' } }] },
  ],
};

const base = () => Config.parse(BASE);
/** A copy of base changed by `fn` (structurally new objects where changed, like the editor does). */
function edit(fn: (c: Config) => void, from = base()): Config {
  const c = structuredClone(from);
  fn(c);
  return Config.parse(c);
}
const pad = (c: Config, id: string) => c.pads.find((p) => p.id === id)!;
const btn = (c: Config, padId: string, id: string): Button | undefined => pad(c, padId)?.buttons.find((b) => b.id === id);
const labels = (c: Config) => Object.fromEntries(c.pads.map((p) => [p.id, p.buttons.map((b) => b.label)]));
const valid = (c: Config) => {
  const r = parseConfig(c);
  if (!r.ok) throw new Error(r.errors.join('\n'));
};
const newButton = (id: string, x: number, y: number, label = id): Button =>
  Config.parse({ version: 1, pads: [{ id: 'p', name: 'p', cols: 9, rows: 9, buttons: [{ id, label, x, y, action: { type: 'shell', script: `echo ${id}` } }] }] }).pads[0]!.buttons[0]!;

describe('changes on one side only merge on their own', () => {
  test('different buttons on the same pad', () => {
    const b = base();
    const mine = edit((c) => (c.pads[0]!.buttons[0]!.label = 'Lamp (mine)'), b);
    const theirs = edit((c) => (c.pads[0]!.buttons[1]!.label = 'Boom (theirs)'), b);
    const r = merge3(b, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.taken).toBe(1);
    expect(labels(r.config)).toEqual({ main: ['Lamp (mine)', 'Boom (theirs)', 'Fan'], other: ['Solo'] });
    valid(r.config);
  });

  test('different pads; adds on both sides; deletes on one side', () => {
    const b = base();
    const mine = edit((c) => {
      c.pads[0]!.buttons.push(newButton('mine-new', 0, 1));
      c.pads[0]!.buttons.splice(2, 1); // fan
    }, b);
    const theirs = edit((c) => {
      c.pads[1]!.buttons[0]!.action = { type: 'shell', script: 'echo solo v2' };
      c.pads[0]!.buttons.push(newButton('theirs-new', 1, 1));
      c.pads[0]!.buttons.splice(1, 1); // boom
    }, b);
    const r = merge3(b, mine, theirs);
    expect(r.conflicts).toEqual([]);
    // Theirs: solo's action, theirs-new, boom deleted.
    expect(r.taken).toBe(3);
    expect(pad(r.config, 'main').buttons.map((x) => x.id)).toEqual(['lamp', 'mine-new', 'theirs-new']);
    expect(btn(r.config, 'other', 'solo')!.action).toEqual({ type: 'shell', script: 'echo solo v2' });
    valid(r.config);
  });

  test('the same change on both sides is no conflict', () => {
    const b = base();
    const both = (c: Config) => (c.pads[0]!.buttons[0]!.color = '#facc15');
    const r = merge3(b, edit(both, b), edit(both, b));
    expect(r.conflicts).toEqual([]);
    expect(r.taken).toBe(0);
    expect(btn(r.config, 'main', 'lamp')!.color).toBe('#facc15');
  });

  test('nothing changed on their side: the result is mine, objects and all', () => {
    const b = base();
    const mine = edit((c) => (c.pads[0]!.buttons[0]!.label = 'x'), b);
    const r = merge3(b, mine, base());
    expect(r.taken).toBe(0);
    expect(r.config.pads[0]).toBe(mine.pads[0]!);
    expect(r.config.pads[1]).toBe(mine.pads[1]!);
  });

  test('host settings (server, $schema) come along', () => {
    const b = base();
    const theirs = edit((c) => ((c.server.port = 9000), (c.$schema = 'x.json')), b);
    const r = merge3(b, edit((c) => (c.pads[0]!.name = 'Mine'), b), theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.config.server.port).toBe(9000);
    expect(r.config.$schema).toBe('x.json');
    expect(r.config.pads[0]!.name).toBe('Mine');
  });
});

describe('conflicts are listed; choices pick a side per item (default mine)', () => {
  test('the same button changed differently on both sides', () => {
    const b = base();
    const mine = edit((c) => (c.pads[0]!.buttons[0]!.label = 'Mine'), b);
    const theirs = edit((c) => (c.pads[0]!.buttons[0]!.action = { type: 'shell', script: 'echo theirs' }), b);
    const r = merge3(b, mine, theirs);
    expect(r.conflicts).toEqual([{ key: 'button:main/lamp', what: 'button', title: 'Main › “Mine”', mine: 'changed', theirs: 'changed', mineFields: ['label'], theirsFields: ['action'] }]);
    expect(btn(r.config, 'main', 'lamp')!.label).toBe('Mine');
    expect(btn(r.config, 'main', 'lamp')!.action).toEqual({ type: 'shell', script: 'echo lamp' });
    const t = merge3(b, mine, theirs, { choices: { 'button:main/lamp': 'theirs' } });
    expect(btn(t.config, 'main', 'lamp')).toEqual(btn(theirs, 'main', 'lamp'));
    expect(t.taken).toBe(1);
  });

  test('deleted on one side, changed on the other', () => {
    const b = base();
    const mineDeleted = edit((c) => c.pads[0]!.buttons.splice(0, 1), b);
    const theirsChanged = edit((c) => (c.pads[0]!.buttons[0]!.label = 'Lamp v2'), b);
    const r = merge3(b, mineDeleted, theirsChanged);
    expect(r.conflicts).toMatchObject([{ key: 'button:main/lamp', mine: 'deleted', theirs: 'changed', theirsFields: ['label'] }]);
    expect(btn(r.config, 'main', 'lamp')).toBeUndefined();
    expect(btn(merge3(b, mineDeleted, theirsChanged, { choices: { 'button:main/lamp': 'theirs' } }).config, 'main', 'lamp')!.label).toBe('Lamp v2');

    const mineChanged = edit((c) => (c.pads[0]!.buttons[0]!.label = 'Lamp mine'), b);
    const theirsDeleted = edit((c) => c.pads[0]!.buttons.splice(0, 1), b);
    const r2 = merge3(b, mineChanged, theirsDeleted);
    expect(r2.conflicts).toMatchObject([{ key: 'button:main/lamp', mine: 'changed', theirs: 'deleted', mineFields: ['label'] }]);
    expect(btn(r2.config, 'main', 'lamp')!.label).toBe('Lamp mine');
    expect(btn(merge3(b, mineChanged, theirsDeleted, { choices: { 'button:main/lamp': 'theirs' } }).config, 'main', 'lamp')).toBeUndefined();
  });

  test('deleted on one side, untouched on the other: just deleted', () => {
    const b = base();
    const del = (c: Config) => c.pads[0]!.buttons.splice(0, 1);
    expect(merge3(b, edit(del, b), b)).toMatchObject({ conflicts: [], taken: 0 });
    const r = merge3(b, b, edit(del, b));
    expect(r).toMatchObject({ conflicts: [], taken: 1 });
    expect(btn(r.config, 'main', 'lamp')).toBeUndefined();
  });

  test('both added a button with the same id, differently', () => {
    const b = base();
    const mine = edit((c) => c.pads[0]!.buttons.push(newButton('new', 0, 1, 'Mine')), b);
    const theirs = edit((c) => c.pads[0]!.buttons.push(newButton('new', 1, 1, 'Theirs')), b);
    const r = merge3(b, mine, theirs);
    expect(r.conflicts).toMatchObject([{ key: 'button+:main/new', mine: 'added', theirs: 'added' }]);
    expect(btn(r.config, 'main', 'new')!.label).toBe('Mine');
    expect(pad(r.config, 'main').buttons.filter((x) => x.id === 'new').length).toBe(1);
    expect(btn(merge3(b, mine, theirs, { choices: { 'button+:main/new': 'theirs' } }).config, 'main', 'new')!.label).toBe('Theirs');
  });

  test('pad settings changed on both sides (pad granularity)', () => {
    const b = base();
    const mine = edit((c) => (c.pads[0]!.name = 'Lights'), b);
    const theirs = edit((c) => (c.pads[0]!.rows = 3), b);
    const r = merge3(b, mine, theirs);
    expect(r.conflicts).toMatchObject([{ key: 'pad:main', what: 'pad', mine: 'changed', theirs: 'changed', mineFields: ['name'], theirsFields: ['rows'] }]);
    expect(pad(r.config, 'main')).toMatchObject({ name: 'Lights', rows: 2 });
    expect(pad(merge3(b, mine, theirs, { choices: { 'pad:main': 'theirs' } }).config, 'main')).toMatchObject({ name: 'Main', rows: 3 });
    // One side only: no conflict.
    expect(pad(merge3(b, b, theirs).config, 'main').rows).toBe(3);
  });

  test('a pad deleted on one side and changed on the other', () => {
    const b = base();
    const mineDeleted = edit((c) => c.pads.splice(1, 1), b);
    const theirsChanged = edit((c) => (c.pads[1]!.buttons[0]!.label = 'Solo v2'), b);
    const r = merge3(b, mineDeleted, theirsChanged);
    expect(r.conflicts).toMatchObject([{ key: 'pad:other', what: 'pad', mine: 'deleted', theirs: 'changed' }]);
    expect(r.config.pads.map((p) => p.id)).toEqual(['main']);
    const t = merge3(b, mineDeleted, theirsChanged, { choices: { 'pad:other': 'theirs' } });
    expect(labels(t.config)).toEqual({ main: ['Lamp', 'Boom', 'Fan'], other: ['Solo v2'] });

    const theirsDeleted = edit((c) => c.pads.splice(1, 1), b);
    const mineChanged = edit((c) => c.pads[1]!.buttons.push(newButton('duo', 1, 0)), b);
    const r2 = merge3(b, mineChanged, theirsDeleted);
    expect(r2.conflicts).toMatchObject([{ key: 'pad:other', mine: 'changed', theirs: 'deleted' }]);
    expect(pad(r2.config, 'other').buttons.map((x) => x.id)).toEqual(['solo', 'duo']);
    expect(merge3(b, mineChanged, theirsDeleted, { choices: { 'pad:other': 'theirs' } }).config.pads.map((p) => p.id)).toEqual(['main']);
  });

  test('pad order: theirs alone reordered → theirs; both, differently → a conflict', () => {
    const b = edit((c) => c.pads.push({ ...structuredClone(c.pads[1]!), id: 'third', name: 'Third' }));
    const swap = (c: Config) => c.pads.reverse();
    const r = merge3(b, edit((c) => (c.pads[0]!.name = 'M'), b), edit(swap, b));
    expect(r.conflicts).toEqual([]);
    expect(r.config.pads.map((p) => p.id)).toEqual(['third', 'other', 'main']);
    expect(r.config.pads[2]!.name).toBe('M');
    const mineOrder = edit((c) => c.pads.push(c.pads.shift()!), b); // other, third, main
    const r2 = merge3(b, mineOrder, edit(swap, b));
    expect(r2.conflicts).toMatchObject([{ key: 'order', what: 'order' }]);
    expect(r2.config.pads.map((p) => p.id)).toEqual(['other', 'third', 'main']);
    expect(merge3(b, mineOrder, edit(swap, b), { choices: { order: 'theirs' } }).config.pads.map((p) => p.id)).toEqual(['third', 'other', 'main']);
  });

  test("a pad theirs added lands where it is in theirs' order", () => {
    const b = base();
    const added = { id: 'added', name: 'Added', cols: 1, rows: 1, buttons: [] } as unknown as Pad;
    const theirs = edit((c) => c.pads.splice(1, 0, added), b);
    const mine = edit((c) => c.pads.push({ id: 'mine', name: 'Mine', cols: 1, rows: 1, buttons: [] } as unknown as Pad), b);
    const r = merge3(b, mine, theirs);
    expect(r.conflicts).toEqual([]);
    expect(r.config.pads.map((p) => p.id)).toEqual(['main', 'added', 'other', 'mine']);
  });
});

describe('renames in the draft (origins)', () => {
  test('a renamed pad still gets their changes to its buttons', () => {
    const b = base();
    const mine = edit((c) => (c.pads[0]!.id = 'studio'), b);
    const theirs = edit((c) => (c.pads[0]!.buttons[2]!.label = 'Fan v2'), b);
    const origins: Origins = [
      { pad: 'main', buttons: ['lamp', 'boom', 'fan'] },
      { pad: 'other', buttons: ['solo'] },
    ];
    const r = merge3(b, mine, theirs, { origins });
    expect(r.conflicts).toEqual([]);
    expect(r.config.pads.map((p) => p.id)).toEqual(['studio', 'other']);
    expect(labels(r.config).studio).toEqual(['Lamp', 'Boom', 'Fan v2']);
    // By id alone, the rename looks like a delete (of a pad they changed) plus an add.
    const byId = merge3(b, mine, theirs);
    expect(byId.conflicts).toMatchObject([{ key: 'pad:main', mine: 'deleted', theirs: 'changed' }]);
  });

  test('a renamed button they also changed is a conflict on that button', () => {
    const b = base();
    const mine = edit((c) => (c.pads[0]!.buttons[0]!.id = 'desk'), b);
    const theirs = edit((c) => (c.pads[0]!.buttons[0]!.label = 'Lamp v2'), b);
    const origins: Origins = [
      { pad: 'main', buttons: ['lamp', 'boom', 'fan'] },
      { pad: 'other', buttons: ['solo'] },
    ];
    const r = merge3(b, mine, theirs, { origins });
    expect(r.conflicts).toMatchObject([{ key: 'button:main/lamp', mine: 'changed', theirs: 'changed', mineFields: ['id'], theirsFields: ['label'] }]);
    expect(pad(r.config, 'main').buttons.map((x) => x.id)).toEqual(['desk', 'boom', 'fan']);
    expect(pad(merge3(b, mine, theirs, { origins, choices: { 'button:main/lamp': 'theirs' } }).config, 'main').buttons.map((x) => x.label)).toEqual(['Lamp v2', 'Boom', 'Fan']);
  });

  test('a new button in the draft (origin null) is new, even if its id matches a base one', () => {
    const b = base();
    // Deleted "lamp", then made a new button and typed "lamp" as its id.
    const mine = edit((c) => (c.pads[0]!.buttons[0] = newButton('lamp', 0, 1, 'Another lamp')), b);
    const theirs = edit((c) => (c.pads[0]!.buttons[0]!.label = 'Lamp v2'), b);
    const r = merge3(b, mine, theirs, { origins: [{ pad: 'main', buttons: [null, 'boom', 'fan'] }, { pad: 'other', buttons: ['solo'] }] });
    expect(r.conflicts).toMatchObject([{ key: 'button:main/lamp', mine: 'deleted', theirs: 'changed' }]);
  });
});

describe('links and edge cases', () => {
  test('every pad and button of the result is linked to its counterparts', () => {
    const b = base();
    const mine = edit((c) => (c.pads[0]!.buttons[0]!.label = 'Mine'), b);
    const theirs = edit((c) => (c.pads[0]!.buttons[1]!.label = 'Theirs'), b);
    const r = merge3(b, mine, theirs);
    const [p0] = r.config.pads;
    expect(r.links.get(p0!)).toEqual({ mine: mine.pads[0], theirs: theirs.pads[0] });
    expect(p0!.buttons[0]).toBe(mine.pads[0]!.buttons[0]!);
    expect(p0!.buttons[1]).toBe(theirs.pads[0]!.buttons[1]!);
    expect(r.links.get(p0!.buttons[1]!)).toEqual({ mine: mine.pads[0]!.buttons[1], theirs: theirs.pads[0]!.buttons[1] });
    for (const p of r.config.pads) {
      expect(r.links.has(p)).toBe(true);
      for (const x of p.buttons) expect(r.links.has(x)).toBe(true);
    }
  });

  test('never no pads at all', () => {
    const b = base();
    const mine = edit((c) => c.pads.splice(0, 1), b); // only "other" left
    const theirs = edit((c) => c.pads.splice(1, 1), b); // only "main" left
    const r = merge3(b, mine, theirs);
    expect(r.config.pads.length).toBeGreaterThan(0);
    valid(r.config);
  });
});
