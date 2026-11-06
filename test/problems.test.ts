/** Edit mode's error/warning mapping (src/web/edit/problems.ts): index paths and the host's by-id form. */
import { describe, expect, test } from 'bun:test';
import { Config, parseConfig } from '../src/core/config.ts';
import type { SaveChanges } from '../src/web/edit/editor.ts';
import { aboutChanges, describe as line, toProblems } from '../src/web/edit/problems.ts';

const cfg = Config.parse({
  version: 1,
  pads: [
    { id: 'main', name: 'Main', cols: 3, rows: 1, buttons: [{ id: 'lamp', label: 'Lamp', x: 0, y: 0, action: { type: 'exec', command: './lamp.sh' } }] },
    { id: 'fx', name: 'FX', cols: 3, rows: 1, buttons: [{ id: 'fog', label: 'Fog', x: 0, y: 0, action: { type: 'shell', script: 'fog', shell: 'zsh' } }, { id: 'off', x: 1, y: 0, stops: ['fx/nope'], action: { type: 'none' } }] },
  ],
});

describe('index paths (parseConfig, the host’s 400)', () => {
  test('pad, button and field, in plain words', () => {
    const bad = parseConfig({ ...cfg, pads: [{ ...cfg.pads[0], buttons: [{ ...cfg.pads[0]!.buttons[0], holdMs: 99999, cooldownMs: -1, label: 'x'.repeat(201) }] }, cfg.pads[1]] });
    expect(bad.ok).toBe(false);
    const list = toProblems(bad.ok ? [] : bad.errors);
    // Time fields are typed in seconds: their range is said in seconds.
    expect(list).toContainEqual({ pad: 0, button: 0, field: 'holdMs', message: 'Must be at most 5 s' });
    expect(list).toContainEqual({ pad: 0, button: 0, field: 'cooldownMs', message: 'Must be at least 0 s' });
    expect(toProblems(['pads.0.buttons.0.timeoutMs: Too big: expected number to be <=86400000'])[0]!.message).toBe('Must be at most 86400 s (24 h)');
    expect(list).toContainEqual({ pad: 0, button: 0, field: 'label', message: 'At most 200 characters' });
    expect(toProblems(['pads.1.buttons.1.stops.0: use pad/button, pad/* or *'])).toEqual([{ pad: 1, button: 1, field: 'stops.0', message: 'Use pad/button, pad/* or *' }]);
    expect(toProblems(['pads.1.name: Too small: expected string to have >=1 characters'])).toEqual([{ pad: 1, button: null, field: 'name', message: "Can't be empty" }]);
  });
});

describe("the host's by-id form (PUT warnings)", () => {
  test('resolved against the config they are about, each to its field', () => {
    const list = toProblems(
      [
        'pad "main" › button "lamp": command not found: /srv/bp/lamp.sh',
        'pad "main" › button "lamp": cwd not found: /srv/bp/nope',
        'pad "fx" › button "fog": shell not found: zsh (not on PATH)',
        'pad "fx" › button "fog": permission denied (chmod +x?): /bin/zsh',
        'pad "fx" › button "off": stops "fx/nope" matches no other button',
        'pad "fx" › button "fog": the script uses bash syntax ([[ … ]]), but runs with /bin/sh, which is not bash on many systems (dash on Debian, Ubuntu, Raspberry Pi OS): add "shell": "bash"',
        'pad "main" › button "lamp": key "Control" never presses it: a modifier key on its own (Control, Alt, Meta/⌘, AltGr) is kept for shortcuts; pick another key',
        'pad "main" › button "lamp": group "solo" has no other button: it stops nothing',
        'pad #2 › button #1: something new',
        'pad "fx": a pad thing',
        'pad "gone" › button "x": not here any more',
        '…and 3 more',
      ],
      cfg,
    );
    expect(list).toEqual([
      { pad: 0, button: 0, field: 'action.command', message: 'not found: /srv/bp/lamp.sh' },
      { pad: 0, button: 0, field: 'action.cwd', message: 'not found: /srv/bp/nope' },
      { pad: 1, button: 0, field: 'action.shell', message: 'not found: zsh (not on PATH)' },
      { pad: 1, button: 0, field: 'action.shell', message: 'permission denied (chmod +x?): /bin/zsh' },
      { pad: 1, button: 1, field: 'stops', message: '“fx/nope” matches no other button' },
      {
        pad: 1,
        button: 0,
        field: 'action.shell',
        message: 'the script uses bash syntax ([[ … ]]), but runs with /bin/sh, which is not bash on many systems (dash on Debian, Ubuntu, Raspberry Pi OS): set Shell to bash',
      },
      { pad: 0, button: 0, field: 'key', message: '"Control" never presses it: a modifier key on its own (Control, Alt, Meta/⌘, AltGr) is kept for shortcuts; pick another key' },
      { pad: 0, button: 0, field: 'group', message: '“solo” has no other button: it stops nothing' },
      { pad: 1, button: 0, field: null, message: 'something new' },
      { pad: 1, button: null, field: null, message: 'a pad thing' },
      { pad: null, button: null, field: null, message: 'pad "gone" › button "x": not here any more' },
      { pad: null, button: null, field: null, message: '…and 3 more' },
    ]);
    expect(line(list[0]!, cfg)).toBe('Main › “Lamp” · Command: not found: /srv/bp/lamp.sh');
    expect(line(list[4]!, cfg)).toBe('FX › off · Stops: “fx/nope” matches no other button');
  });
});

describe('host warnings about what a save changed, and old news', () => {
  test('a changed button; a group a button left (or went from); a pattern naming buttons it removed. The rest: old news', () => {
    const sent = Config.parse({
      version: 1,
      pads: [
        { id: 'main', name: 'Main', cols: 3, rows: 1, buttons: [{ id: 'lamp', x: 0, y: 0, action: { type: 'exec', command: './lamp.sh' } }, { id: 'fan', x: 1, y: 0, action: { type: 'exec', command: './fan.sh' } }] },
        { id: 'fx', name: 'FX', cols: 3, rows: 1, buttons: [{ id: 'fog', x: 0, y: 0, group: 'smoke', action: { type: 'shell', script: 'fog' } }, { id: 'off', x: 1, y: 0, stops: ['gone/*', 'main/old'], action: { type: 'none' } }] },
      ],
    });
    const [lamp] = sent.pads[0]!.buttons;
    const [, off] = sent.pads[1]!.buttons;
    const w = toProblems(
      [
        'pad "main" › button "lamp": command not found: /srv/bp/lamp.sh',
        'pad "main" › button "fan": command not found: /srv/bp/fan.sh',
        'pad "fx" › button "fog": group "smoke" has no other button: it stops nothing',
        'pad "fx" › button "off": stops "gone/*" matches no other button',
        'pad "fx" › button "off": stops "main/old" matches no other button',
        '…and 3 more',
      ],
      sent,
    );
    const about = (ch: Partial<SaveChanges>) => w.map((x) => aboutChanges(x, sent, { buttons: new Set(), groups: new Set(), gone: new Set(), ...ch }));
    expect(about({})).toEqual([false, false, false, false, false, false]);
    // Lamp changed: news. Fan's program is just as missing, but Fan wasn't touched.
    expect(about({ buttons: new Set([lamp!]) })).toEqual([true, false, false, false, false, false]);
    // A button left "smoke" (Fog, untouched, is alone in it now); pad "gone" lost its last button; main/old was renamed.
    expect(about({ groups: new Set(['smoke']), gone: new Set(['gone/last', 'main/old']) })).toEqual([false, false, true, true, true, false]);
    expect(about({ gone: new Set(['gone2/x', 'main/older']) })).toEqual([false, false, false, false, false, false]);
    // A changed button: all that's said about it.
    expect(about({ buttons: new Set([off!]) })).toEqual([false, false, false, true, true, false]);
  });
});
