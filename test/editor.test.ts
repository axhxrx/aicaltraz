/** The edit-mode draft (src/web/edit/editor.ts): identities through edits, merges, saves and restores. */
import { describe, expect, test } from 'bun:test';
import { Config, type ConfigInput } from '../src/core/config.ts';
import { Editor } from '../src/web/edit/editor.ts';
import { merge3 } from '../src/web/edit/merge.ts';

const INPUT: ConfigInput = {
  version: 1,
  pads: [
    {
      id: 'main',
      name: 'Main',
      cols: 3,
      rows: 2,
      buttons: [
        { id: 'lamp', label: 'Lamp', x: 0, y: 0, key: 'l', action: { type: 'shell', script: 'echo lamp' } },
        { id: 'button-2', label: 'Wipe card', x: 1, y: 0, confirm: true, action: { type: 'shell', script: 'echo wiped' } },
      ],
    },
    { id: 'other', name: 'Other', cols: 2, rows: 2, buttons: [{ id: 'solo', label: 'Solo', x: 0, y: 0, action: { type: 'shell', script: 'echo solo' } }] },
  ],
};
const host = () => Config.parse(INPUT);
const ids = (ed: Editor, pi = 0) => ed.state.draft.pads[pi]!.buttons.map((b) => b.id);

describe('new ids', () => {
  test("a new button never takes the id of a host button deleted in the draft (it would run the host's one)", () => {
    const ed = new Editor(host(), 'r1');
    ed.select(1);
    ed.removeButton();
    const ix = ed.addButton(2, 0)!;
    expect(ed.button(ix)!.id).toBe('button-3');
    // Its label-following id stays clear of it too.
    ed.patchButton({ label: 'Button 2' }, 'label', ix);
    expect(ed.button(ix)!.id).toBe('button-2-2');
  });

  test('duplicate: new id, no key binding', () => {
    const ed = new Editor(host(), 'r1');
    ed.select(0);
    const ix = ed.duplicate()!;
    expect(ed.button(ix)).toMatchObject({ id: 'lamp-copy', label: 'Lamp copy' });
    expect(ed.button(ix)!.key).toBeUndefined();
    expect(ed.button(0)!.key).toBe('l');
  });

  test('a button added while a save is in flight keeps following its label after the save returns', () => {
    const ed = new Editor(host(), 'r1');
    ed.select(0);
    ed.patchButton({ label: 'Lamp v2' }, 'label');
    const sent = ed.state.draft;
    const ix = ed.addButton(2, 0)!;
    ed.patchButton({ label: 'Fi' }, 'label', ix);
    ed.saved(sent, 'r2');
    ed.patchButton({ label: 'Fill light' }, 'label', ix);
    expect(ed.button(ix)!.id).toBe('fill-light');
    // One that went out with the save has a real id now.
    const ed2 = new Editor(host(), 'r1');
    const iy = ed2.addButton(2, 0)!;
    ed2.saved(ed2.state.draft, 'r2');
    ed2.patchButton({ label: 'Fan' }, 'label', iy);
    expect(ed2.button(iy)!.id).toBe('button-3');
  });
});

describe('action type', () => {
  test('switching back gives the action exactly as it was', () => {
    const ed = new Editor(host(), 'r1');
    ed.select(0);
    ed.patchButton({ action: { type: 'shell', script: 'ls -d ~', shell: undefined } });
    ed.setActionType('exec');
    expect(ed.button()!.action).toEqual({ type: 'exec', command: '/bin/sh', args: ['-c', 'ls -d ~'] });
    ed.setActionType('shell');
    expect(ed.button()!.action).toEqual({ type: 'shell', script: 'ls -d ~' });
  });
});

describe('merging the host config into the draft', () => {
  test('a renamed pad gets their changes; undo goes back to the old draft and base, redo again', () => {
    const base = host();
    const ed = new Editor(base, 'r1');
    ed.patchPad({ id: 'studio' }, 'id');
    ed.select(0);
    ed.patchButton({ label: 'Lamp (mine)' }, 'label');
    const theirs = Config.parse({ ...INPUT, pads: [{ ...INPUT.pads[0]!, buttons: [INPUT.pads[0]!.buttons![0]!, { ...INPUT.pads[0]!.buttons![1]!, label: 'Wipe (theirs)' }] }, INPUT.pads[1]!] });
    const res = merge3(ed.state.base, ed.state.draft, theirs, { origins: ed.origins() });
    expect(res.conflicts).toEqual([]);
    const before = ed.state.draft;
    ed.applyMerge(res, theirs, 'r2');
    expect(ed.state).toMatchObject({ baseRev: 'r2', base: theirs });
    expect(ed.state.draft.pads[0]!.id).toBe('studio');
    expect(ed.state.draft.pads[0]!.buttons.map((b) => b.label)).toEqual(['Lamp (mine)', 'Wipe (theirs)']);
    // The selection stayed on the same button.
    expect(ed.button()!.label).toBe('Lamp (mine)');
    // Origins are against the new base now: the renamed pad is still "main" there.
    expect(ed.origins()[0]).toEqual({ pad: 'main', buttons: ['lamp', 'button-2'] });
    expect(ed.undo()).toBe(true);
    expect(ed.state.draft).toBe(before);
    expect(ed.state).toMatchObject({ baseRev: 'r1', base });
    expect(ed.redo()).toBe(true);
    expect(ed.state.baseRev).toBe('r2');
  });

  test('after a save, undo never takes the base back (it would claim the host is still on the old rev)', () => {
    const ed = new Editor(host(), 'r1');
    const theirs = Config.parse({ ...INPUT, pads: [INPUT.pads[0]!, { ...INPUT.pads[1]!, name: 'Other (theirs)' }] });
    ed.select(0);
    ed.patchButton({ label: 'x' }, 'label');
    ed.applyMerge(merge3(ed.state.base, ed.state.draft, theirs, { origins: ed.origins() }), theirs, 'r2');
    ed.saved(ed.state.draft, 'r3');
    ed.undo();
    expect(ed.state.baseRev).toBe('r3');
  });

  test('discard is undoable', () => {
    const base = host();
    const ed = new Editor(base, 'r1');
    ed.addButton(2, 0);
    const draft = ed.state.draft;
    ed.discard(base, 'r1');
    expect(ed.dirty).toBe(false);
    ed.undo();
    expect(ed.state.draft).toBe(draft);
    expect(ed.dirty).toBe(true);
  });
});

describe('snapshot / restore (a draft kept on the device)', () => {
  test('identities and label-following ids survive a round trip through JSON', () => {
    const ed = new Editor(host(), 'r1');
    ed.patchPad({ id: 'studio' }, 'id');
    const ix = ed.addButton(2, 0)!;
    ed.patchButton({ label: 'Fog' }, 'label', ix);
    const snap = JSON.parse(JSON.stringify(ed.snapshot()));
    expect(snap.origins[0]).toEqual({ pad: 'main', buttons: ['lamp', 'button-2', null] });
    expect(snap.fresh[0].buttons).toEqual([false, false, true]);

    const again = new Editor(host(), 'r9');
    again.restore(snap);
    expect(again.state.baseRev).toBe('r1');
    expect(again.dirty).toBe(true);
    expect(again.origins()).toEqual(snap.origins);
    again.patchButton({ label: 'Fog machine' }, 'label', 2);
    expect(again.state.draft.pads[0]!.buttons[2]!.id).toBe('fog-machine');
  });
});

describe('stops follow renames and deletes', () => {
  const withStops = (): Config =>
    Config.parse({
      ...INPUT,
      pads: [
        { ...INPUT.pads[0]!, buttons: [...INPUT.pads[0]!.buttons!, { id: 'off', label: 'All off', x: 2, y: 0, stops: ['main/lamp', 'other/*', 'other/solo'], action: { type: 'none' } }] },
        { ...INPUT.pads[1]!, buttons: [{ ...INPUT.pads[1]!.buttons![0]!, stops: ['main/lamp'] }] },
      ],
    });
  const stops = (ed: Editor) => ed.state.draft.pads.flatMap((p) => p.buttons.map((b) => b.stops ?? null));

  test("a button's new id (typed, or following its label) goes into every pattern naming it; undo takes it back", () => {
    const ed = new Editor(withStops(), 'r1');
    ed.select(0);
    ed.patchButton({ id: 'desk' }, 'id');
    expect(stops(ed)).toEqual([null, null, ['main/desk', 'other/*', 'other/solo'], ['main/desk']]);
    ed.undo();
    expect(stops(ed)).toEqual([null, null, ['main/lamp', 'other/*', 'other/solo'], ['main/lamp']]);
    // A new button's id follows its label: so do the patterns.
    const ix = ed.addButton(0, 1)!;
    ed.select(2);
    ed.patchButton({ stops: ['main/button-4'] });
    ed.patchButton({ label: 'Fog' }, 'label', ix);
    expect(ed.button(ix)!.id).toBe('fog');
    expect(ed.button(2)!.stops).toEqual(['main/fog']);
  });

  test('another button still having the old id keeps the patterns as they are', () => {
    const ed = new Editor(withStops(), 'r1');
    ed.select(1);
    ed.patchButton({ id: 'lamp' }, 'id'); // a duplicate for now
    ed.select(0);
    ed.patchButton({ id: 'desk' }, 'id');
    expect(ed.button(2)!.stops).toEqual(['main/lamp', 'other/*', 'other/solo']);
  });

  test("a pad's new id carries its `pad/…` patterns", () => {
    const ed = new Editor(withStops(), 'r1');
    ed.showPad(1);
    ed.patchPad({ id: 'studio' }, 'id');
    expect(stops(ed)).toEqual([null, null, ['main/lamp', 'studio/*', 'studio/solo'], ['main/lamp']]);
  });

  test('a deleted button or pad leaves no patterns behind (the last one: no `stops` at all); undo brings them back', () => {
    const ed = new Editor(withStops(), 'r1');
    ed.removeButton(0);
    expect(stops(ed)).toEqual([null, ['other/*', 'other/solo'], null]);
    expect(ed.state.draft.pads[1]!.buttons[0]).not.toHaveProperty('stops');
    ed.undo();
    ed.removePad(1);
    expect(stops(ed)).toEqual([null, null, ['main/lamp']]);
    ed.undo();
    expect(stops(ed)).toEqual([null, null, ['main/lamp', 'other/*', 'other/solo'], ['main/lamp']]);
  });

  test("identities hold through it: the patched buttons are still the host's", () => {
    const ed = new Editor(withStops(), 'r1');
    ed.select(0);
    ed.patchButton({ id: 'desk' }, 'id');
    expect(ed.origins()).toEqual([
      { pad: 'main', buttons: ['lamp', 'button-2', 'off'] },
      { pad: 'other', buttons: ['solo'] },
    ]);
  });
});

describe('tidy (before a save)', () => {
  test('labels and pad names are trimmed as the host keeps them, without an undo step of their own', () => {
    const ed = new Editor(host(), 'r1');
    ed.select(0);
    ed.patchButton({ label: '  Lamp  ' }, 'label');
    ed.patchPad({ name: 'Main ' }, 'name');
    const steps = ed.state.past.length;
    ed.tidy();
    expect(ed.button(0)!.label).toBe('Lamp');
    expect(ed.state.draft.pads[0]!.name).toBe('Main');
    expect(ed.state.past.length).toBe(steps);
    expect(ed.dirty).toBe(false);
    expect(ed.origins()[0]).toEqual({ pad: 'main', buttons: ['lamp', 'button-2'] });
  });
});

describe('action type none', () => {
  test('to Nothing and straight back gives the action as it was; from Nothing to another type, it starts blank', () => {
    const ed = new Editor(host(), 'r1');
    ed.select(0);
    ed.setActionType('none');
    expect(ed.button()!.action).toEqual({ type: 'none' });
    ed.setActionType('shell');
    expect(ed.button()!.action).toEqual({ type: 'shell', script: 'echo lamp' });
    ed.setActionType('none');
    ed.setActionType('exec');
    expect(ed.button()!.action).toEqual({ type: 'exec', command: '', args: [] });
    ed.setActionType('none');
    ed.setActionType('exec');
    ed.setActionType('none');
    ed.setActionType('shell');
    expect(ed.button()!.action).toEqual({ type: 'shell', script: '' });
  });
});
