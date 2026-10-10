/**
 * Validation errors ("pads.0.buttons.2.action.command: …", from parseConfig or the host's 400)
 * mapped onto the draft: which pad, which button, which field, in plain words. Also the host's
 * worded form, which names things by id (`pad "lights" › button "key": …`, or `pad #2` when an id
 * doesn't say which): PUT warnings come that way (src/server/config-warnings.ts), resolved against
 * the config they're about.
 */
import { ENV_NAME_MESSAGE, type Button, type Config } from '../../core/config.ts';

export interface Problem {
  pad: number | null;
  button: number | null;
  /** Path inside the button/pad, e.g. `holdMs`, `action.command`, `action.env.FOO`; null = the whole thing. */
  field: string | null;
  message: string;
}

const FIELD: Record<string, string> = {
  id: 'Id',
  name: 'Name',
  cols: 'Columns',
  rows: 'Rows',
  label: 'Label',
  color: 'Color',
  trigger: 'Trigger',
  holdMs: 'Hold time',
  driftPx: 'Finger drift',
  whileRunning: 'While running',
  confirm: 'Confirm',
  confirmWindowMs: 'Confirm window',
  timeoutMs: 'Timeout',
  resultHoldMs: 'Result time',
  cooldownMs: 'Ignore presses after',
  stops: 'Stops',
  key: 'Key',
  action: 'Action',
  'action.type': 'Action type',
  'action.command': 'Command',
  'action.args': 'Arguments',
  'action.script': 'Script',
  'action.shell': 'Shell',
  'action.cwd': 'Working folder',
  'action.env': 'Environment',
};

export function fieldName(field: string): string {
  const arg = /^action\.args\.(\d+)$/.exec(field);
  if (arg) return `Argument ${Number(arg[1]) + 1}`;
  const env = /^action\.env\.(.+)$/.exec(field);
  if (env) return `Variable ${env[1]}`;
  if (/^stops\.\d+$/.test(field)) return 'Stops';
  return FIELD[field] ?? field;
}

export function pretty(msg: string): string {
  let m: RegExpExecArray | null;
  if (/^Too small: expected string to have >=1 characters?$/.test(msg)) return "Can't be empty";
  if ((m = /^Too small: expected number to be >=?(.+)$/.exec(msg))) return `Must be at least ${m[1]}`;
  if ((m = /^Too big: expected number to be <=?(.+)$/.exec(msg))) return `Must be at most ${m[1]}`;
  if (/expected int, received number/.test(msg)) return 'Must be a whole number';
  if (/expected number, received/.test(msg)) return 'Must be a number';
  if ((m = /^Too big: expected string to have <=(\d+) characters?$/.exec(msg))) return `At most ${m[1]} characters`;
  if (/^Too small: expected array to have >=1 items?$/.test(msg)) return 'Needs at least one';
  if (msg === 'use pad/button, pad/* or *') return 'Use pad/button, pad/* or *';
  if (/^duplicate button id/.test(msg)) return 'Another button on this pad has this id';
  if (/^duplicate pad id/.test(msg)) return 'Another pad has this id';
  if (msg === 'letters, digits, _ and - only') return 'Letters, digits, _ and - only';
  if (msg === ENV_NAME_MESSAGE) return `${msg.charAt(0).toUpperCase()}${msg.slice(1)}`;
  return msg;
}

/** `pad "x" › button "y": message` (either may be `#n`, 1-based). */
const BY_ID = /^pad (?:"([\w-]+)"|#(\d+))(?: › button (?:"([\w-]+)"|#(\d+)))?: ([\s\S]*)$/;

/**
 * A host warning's field, by what it says (config-warnings.ts): the program for exec, the shell for
 * shell actions, the folder, a stops pattern. The message loses the words the field name says.
 */
function warningField(msg: string, b: Pick<Button, 'action'> | undefined): { field: string | null; message: string } {
  let m: RegExpExecArray | null;
  const program = b?.action.type === 'shell' ? 'action.shell' : 'action.command';
  if ((m = /^cwd not found: ([\s\S]*)$/.exec(msg))) return { field: 'action.cwd', message: `not found: ${m[1]}` };
  if ((m = /^(command|shell) not found: ([\s\S]*)$/.exec(msg))) return { field: m[1] === 'shell' ? 'action.shell' : 'action.command', message: `not found: ${m[2]}` };
  if ((m = /^stops "(.*)" matches no other button$/.exec(msg))) return { field: 'stops', message: `“${m[1]}” matches no other button` };
  if (/^(is a directory|not a regular file|permission denied|not executable|interpreter not found)/.test(msg)) return { field: program, message: msg };
  return { field: null, message: msg };
}

/**
 * Split "path: message" (the message may contain ": " itself). `cfg`: the config they're about, to
 * resolve the host's by-id form (without it, those stay general).
 */
export function toProblems(errors: string[], cfg?: Pick<Config, 'pads'>): Problem[] {
  return errors.map((raw) => {
    const byId = BY_ID.exec(raw);
    if (byId) {
      const [, padId, padN, btnId, btnN, msg = ''] = byId as unknown as (string | undefined)[];
      const pi = padN !== undefined ? Number(padN) - 1 : (cfg?.pads.findIndex((p) => p.id === padId) ?? -1);
      const pad = cfg?.pads[pi];
      if (!pad) return { pad: null, button: null, field: null, message: raw };
      if (btnId === undefined && btnN === undefined) return { pad: pi, button: null, field: null, message: msg };
      const bi = btnN !== undefined ? Number(btnN) - 1 : pad.buttons.findIndex((b) => b.id === btnId);
      if (!pad.buttons[bi]) return { pad: pi, button: null, field: null, message: msg };
      return { pad: pi, button: bi, ...warningField(msg, pad.buttons[bi]) };
    }
    const at = raw.indexOf(': ');
    const path = at >= 0 ? raw.slice(0, at) : '(root)';
    const message = pretty(at >= 0 ? raw.slice(at + 2) : raw);
    const seg = path.split('.');
    if (seg[0] !== 'pads' || seg.length < 2 || !/^\d+$/.test(seg[1]!)) return { pad: null, button: null, field: path === '(root)' ? null : path, message };
    const pad = Number(seg[1]);
    if (seg[2] === 'buttons' && seg[3] !== undefined && /^\d+$/.test(seg[3])) {
      const rest = seg.slice(4).join('.');
      return { pad, button: Number(seg[3]), field: rest || null, message };
    }
    return { pad, button: null, field: seg.slice(2).join('.') || null, message };
  });
}

/** One line for a list: "Lights › “Fill light” · Command: Can't be empty". */
export function describe(p: Problem, cfg: Config): string {
  const pad = p.pad === null ? null : cfg.pads[p.pad];
  const b = pad && p.button !== null ? pad.buttons[p.button] : null;
  const where = [pad ? pad.name || pad.id : null, b ? (b.label.trim() ? `“${b.label.trim()}”` : b.id) : null].filter(Boolean).join(' › ');
  const what = p.field ? `${fieldName(p.field)}: ${p.message}` : p.message;
  return where ? `${where} · ${what}` : what;
}

/** Field errors of one button (first message per field; '' = the button as a whole). */
export function buttonFieldErrors(list: Problem[], pad: number, button: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of list) if (p.pad === pad && p.button === button && !out.has(p.field ?? '')) out.set(p.field ?? '', p.message);
  return out;
}

export function padFieldErrors(list: Problem[], pad: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of list) if (p.pad === pad && p.button === null && !out.has(p.field ?? '')) out.set(p.field ?? '', p.message);
  return out;
}
