/** Edit mode's error/warning mapping (src/web/edit/problems.ts): index paths and the host's by-id form. */
import { describe, expect, test } from 'bun:test';
import { Config, parseConfig } from '../src/core/config.ts';
import { describe as line, toProblems } from '../src/web/edit/problems.ts';

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
    expect(list).toContainEqual({ pad: 0, button: 0, field: 'holdMs', message: 'Must be at most 5000' });
    expect(list).toContainEqual({ pad: 0, button: 0, field: 'cooldownMs', message: 'Must be at least 0' });
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
      { pad: 1, button: 0, field: null, message: 'something new' },
      { pad: 1, button: null, field: null, message: 'a pad thing' },
      { pad: null, button: null, field: null, message: 'pad "gone" › button "x": not here any more' },
      { pad: null, button: null, field: null, message: '…and 3 more' },
    ]);
    expect(line(list[0]!, cfg)).toBe('Main › “Lamp” · Command: not found: /srv/bp/lamp.sh');
    expect(line(list[4]!, cfg)).toBe('FX › off · Stops: “fx/nope” matches no other button');
  });
});
