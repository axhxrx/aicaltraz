/**
 * ButtPad config schema. This file is the contract every implementation (this Bun server, a future
 * Swift app, whatever) agrees on; `bun run schema` emits it as JSON Schema for non-TS consumers.
 */
import { z } from 'zod';

/** Environment variable names a shell can use: no spaces, `=`, or leading digit. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ENV_NAME_MESSAGE = 'letters, digits and _ only, not starting with a digit';

const env = z.record(z.string().regex(ENV_NAME), z.string(), {
  error: (iss) => (iss.code === 'invalid_key' ? ENV_NAME_MESSAGE : undefined),
});

export const ExecAction = z.strictObject({
  type: z.literal('exec'),
  /** Executable path, or a name resolved via PATH. Run directly, no shell. */
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().trim().optional(),
  env: env.optional(),
});

export const ShellAction = z.strictObject({
  type: z.literal('shell'),
  /** Passed to the shell as a single command string (`sh -c` / `cmd /c`). */
  script: z.string().min(1),
  /** Shell binary. Defaults to /bin/sh (POSIX) or %ComSpec%/cmd.exe (Windows) — never $SHELL, so behavior doesn't depend on how the host was started. */
  shell: z.string().trim().optional(),
  cwd: z.string().trim().optional(),
  env: env.optional(),
});

/** Runs nothing and succeeds at once: for buttons that only `stops` others. */
export const NoneAction = z.strictObject({ type: z.literal('none') });

export const Action = z.discriminatedUnion('type', [ExecAction, ShellAction, NoneAction]);

export const Trigger = z.enum(['hold', 'tap', 'double']);

/** What a press does while the action is already running. */
export const WhileRunning = z.enum(['ignore', 'cancel', 'queue']);

/** `pad/button`, `pad/*` or `*`. */
export const STOP_PATTERN = /^(\*|[\w-]+\/(\*|[\w-]+))$/;

export const Button = z.strictObject({
  id: z.string().min(1).regex(/^[\w-]+$/, 'letters, digits, _ and - only'),
  label: z.string().trim().max(200).default(''),
  /** Any CSS color. The ready-state background. */
  color: z.string().default('#2f6fde'),
  /** Grid placement, 0-based cell coords, spans in cells. */
  x: z.int().min(0),
  y: z.int().min(0),
  w: z.int().min(1).default(1),
  h: z.int().min(1).default(1),
  trigger: Trigger.default('hold'),
  holdMs: z.int().min(100).max(5000).default(500),
  /** How far (CSS px) a finger may slide during a hold before the press cancels. */
  driftPx: z.number().min(0).default(60),
  whileRunning: WhileRunning.default('ignore'),
  /** Require a second press within confirmWindowMs before firing. */
  confirm: z.boolean().default(false),
  confirmWindowMs: z.int().min(500).max(60_000).default(3000),
  timeoutMs: z.int().min(100).max(86_400_000).default(120_000),
  /** How long SUCCESS/FAILURE stays on screen before going back to READY. */
  resultHoldMs: z.int().min(0).max(60_000).default(2500),
  /** After this button fires, presses on this device are ignored for this long (key chatter, bounces). */
  cooldownMs: z.int().min(0).max(10_000).default(400),
  /** Running buttons this one cancels before its own action starts (itself excluded). */
  stops: z.array(z.string().regex(STOP_PATTERN, 'use pad/button, pad/* or *')).optional(),
  /** Exclusive group (any pad): starting this button stops the running buttons of the same group. */
  group: z.string().trim().regex(/^[\w-]+$/, 'letters, digits, _ and - only').max(40).optional(),
  /** The host drops a press that reaches it later than this after it was made (dead Wi-Fi, a frozen host). */
  maxLatenessMs: z.int().min(200).max(10_000).default(3000),
  /** Keyboard key (KeyboardEvent.key) that presses this button, for BLE remotes etc. */
  key: z.string().optional(),
  action: Action,
});

export const Pad = z.strictObject({
  id: z.string().min(1).regex(/^[\w-]+$/, 'letters, digits, _ and - only'),
  name: z.string().trim().min(1).max(60),
  cols: z.int().min(1).max(12).default(2),
  rows: z.int().min(1).max(12).default(2),
  buttons: z.array(Button).default([]),
});

export const Config = z
  .strictObject({
    $schema: z.string().optional(),
    version: z.literal(1),
    server: z
      .strictObject({
        host: z.string().default('0.0.0.0'),
        port: z.int().min(1).max(65535).default(8787),
      })
      .prefault({}),
    pads: z.array(Pad).min(1),
  })
  .superRefine((cfg, ctx) => {
    for (const issue of gridIssues(cfg)) ctx.addIssue({ code: 'custom', ...issue });
  });

interface GridIssue {
  path: (string | number)[];
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A grid size as written (absent: the default 2), or undefined when it isn't a valid one. */
const gridSize = (v: unknown) => (v === undefined ? 2 : Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 12 ? (v as number) : undefined);
const cellNum = (v: unknown, min: number) => (Number.isInteger(v) && (v as number) >= min ? (v as number) : undefined);

/**
 * Duplicate pad ids, duplicate button ids within a pad, buttons outside their pad's grid or overlapping.
 * Works on any input, valid or not (zod skips refinements after some field errors, so parseConfig
 * also runs this on the raw input): whatever it can't read (a pad without a valid grid size, a button
 * without valid x/y/w/h) is left to the field checks.
 */
function gridIssues(input: unknown): GridIssue[] {
  const out: GridIssue[] = [];
  const pads = isRecord(input) && Array.isArray(input.pads) ? input.pads : [];
  const padIds = new Set<string>();
  pads.forEach((pad: unknown, pi) => {
    if (!isRecord(pad)) return;
    if (typeof pad.id === 'string') {
      if (padIds.has(pad.id)) out.push({ path: ['pads', pi, 'id'], message: `duplicate pad id "${pad.id}"` });
      padIds.add(pad.id);
    }
    const cols = gridSize(pad.cols);
    const rows = gridSize(pad.rows);
    const ids = new Set<string>();
    const occupied = new Map<string, string>();
    (Array.isArray(pad.buttons) ? pad.buttons : []).forEach((b: unknown, bi) => {
      if (!isRecord(b)) return;
      const path = ['pads', pi, 'buttons', bi];
      const name = typeof b.id === 'string' ? `"${b.id}"` : `#${bi + 1}`;
      if (typeof b.id === 'string') {
        if (ids.has(b.id)) out.push({ path: [...path, 'id'], message: `duplicate button id "${b.id}"` });
        ids.add(b.id);
      }
      const [x, y, w, h] = [cellNum(b.x, 0), cellNum(b.y, 0), cellNum(b.w ?? 1, 1), cellNum(b.h ?? 1, 1)];
      if (cols === undefined || rows === undefined || x === undefined || y === undefined || w === undefined || h === undefined) return;
      if (x + w > cols || y + h > rows) {
        out.push({ path, message: `button ${name} extends outside the ${cols}x${rows} grid` });
        return;
      }
      for (let cx = x; cx < x + w; cx++)
        for (let cy = y; cy < y + h; cy++) {
          const other = occupied.get(`${cx},${cy}`);
          if (other) out.push({ path, message: `button ${name} overlaps ${other} at cell ${cx},${cy}` });
          else occupied.set(`${cx},${cy}`, name);
        }
    });
  });
  return out;
}

export type ExecAction = z.infer<typeof ExecAction>;
export type ShellAction = z.infer<typeof ShellAction>;
export type NoneAction = z.infer<typeof NoneAction>;
export type Action = z.infer<typeof Action>;
export type Button = z.infer<typeof Button>;
export type Pad = z.infer<typeof Pad>;
export type Config = z.infer<typeof Config>;
/** Pre-defaults shape, i.e. what a human writes in the file. */
export type ConfigInput = z.input<typeof Config>;

export type ParseResult = { ok: true; config: Config } | { ok: false; errors: string[] };

/**
 * Validate a config as written. Errors are `path: message` with index paths
 * (`pads.0.buttons.5.holdMs: Too big: expected number to be <=5000`), all of them in one pass: the
 * grid and id checks run even when fields are invalid. (The host words them for people, by id:
 * src/server/config-errors.ts.)
 */
export function parseConfig(raw: unknown): ParseResult {
  const r = Config.safeParse(raw);
  if (r.success) return { ok: true, config: r.data };
  const issues: GridIssue[] = [...r.error.issues.map((i) => ({ path: i.path as (string | number)[], message: i.message })), ...gridIssues(raw)];
  return { ok: false, errors: [...new Set(issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`))] };
}

export function findButton(cfg: Config, padId: string, buttonId: string): Button | undefined {
  return cfg.pads.find((p) => p.id === padId)?.buttons.find((b) => b.id === buttonId);
}

/** Stable key for a button across pads. */
export const buttonKey = (padId: string, buttonId: string) => `${padId}/${buttonId}`;
