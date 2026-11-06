/**
 * What a press stops, two ways. `group`: an exclusive group (any pad) — starting one of its buttons
 * stops the others of the group that are running (cues that replace each other: light fades, music).
 * `stops`: running buttons a press cancels before its own action starts (the host leaves the button
 * itself out). Patterns `pad/button`, `pad/*` (that pad's buttons) or `*` (everything), picked here as
 * chips; a wider pick shows what it covers, and so does the group (its buttons show as stopped). A
 * pattern that names nothing (typed by hand, or its pad gone) is listed to remove. Renames and
 * deletes in the editor keep the patterns in step (editor.ts).
 */
import { useId } from 'preact/hooks';
import type { Button, Pad } from '../../core/config.ts';
import { Close } from '../ui/icons.tsx';
import { Chip, Field, Section, SwitchRow, TextInput } from './fields.tsx';
import { GroupIcon } from './icons.tsx';
import { stopTargets } from './ops.ts';

const name = (x: { label?: string; name?: string; id: string }) => (x.label ?? x.name ?? '').trim() || x.id;

/** The button's group as the host keeps it (trimmed); undefined: none. */
export const groupOf = (b: Pick<Button, 'group'>) => b.group?.trim() || undefined;

/** The other buttons (any pad) in `b`'s group: the ones starting `b` stops. */
export function groupMates(pads: Pad[], b: Button): { pad: Pad; button: Button }[] {
  const g = groupOf(b);
  return g ? pads.flatMap((pad) => pad.buttons.filter((x) => x !== b && groupOf(x) === g).map((button) => ({ pad, button }))) : [];
}

/** Every group in use, sorted. */
export const groupsIn = (pads: Pad[]) => [...new Set(pads.flatMap((p) => p.buttons.flatMap((b) => groupOf(b) ?? [])))].sort();

/** “A”, “B” (Backup) and 2 more: other pads' buttons say which pad. */
function mateNames(list: { pad: Pad; button: Button }[], pad: Pad): string {
  const n = list.map((m) => `“${name(m.button)}”${m.pad === pad ? '' : ` (${name(m.pad)})`}`);
  if (n.length <= 2) return n.join(' and ');
  if (n.length <= 4) return `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
  return `${n.slice(0, 3).join(', ')} and ${n.length - 3} more`;
}

export function GroupField(p: { pads: Pad[]; pi: number; b: Button; error?: string; onChange(group: string | undefined): void }) {
  const uid = useId();
  const pad = p.pads[p.pi]!;
  const g = groupOf(p.b);
  const mates = groupMates(p.pads, p.b);
  const others = groupsIn(p.pads).filter((x) => x !== g);
  const hint = g ? (
    mates.length ? (
      <span data-testid="group-mates">
        Starting it stops {mateNames(mates, pad)} if running; starting one of them stops this one.
      </span>
    ) : (
      <span data-testid="group-mates">No other button is in “{g}” yet: give the buttons that replace each other the same group.</span>
    )
  ) : (
    'Starting one stops the others in its group (on any pad): for cues that replace each other, like light fades or music. Letters, digits, _ and -.'
  );
  return (
    <Section title="Group">
      <Field label="Exclusive group" for={`${uid}-group`} error={p.error} hint={hint} testid="group">
        <TextInput
          id={`${uid}-group`}
          value={p.b.group ?? ''}
          mono
          maxLength={40}
          list={`${uid}-groups`}
          placeholder="none"
          invalid={!!p.error}
          testid="field-group"
          onValue={(v) => p.onChange(v.trim() === '' ? undefined : v)}
        />
        <datalist id={`${uid}-groups`} data-testid="group-options">
          {groupsIn(p.pads).map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      </Field>
      {others.length > 0 && (
        <div class="ed-chips ed-group-pick" data-testid="group-pick">
          <span class="ed-hint">{g ? 'Or move it to:' : 'Join one:'}</span>
          {others.slice(0, 8).map((x) => (
            <button key={x} type="button" class="ed-chip is-group" data-testid={`group-pick-${x}`} onClick={() => p.onChange(x)}>
              <GroupIcon />
              <span>{x}</span>
            </button>
          ))}
        </div>
      )}
    </Section>
  );
}

export function StopsEditor(p: { pads: Pad[]; pi: number; b: Button; error?: string; onChange(stops: string[] | undefined): void }) {
  const stops = p.b.stops ?? [];
  const has = (x: string) => stops.includes(x);
  const set = (list: string[]) => p.onChange(list.length ? list : undefined);
  const toggle = (x: string) => set(has(x) ? stops.filter((s) => s !== x) : [...stops, x]);
  const self = { pad: p.pads[p.pi]!.id, button: p.b.id };
  const everything = has('*');
  const g = groupOf(p.b);
  const mates = new Set(groupMates(p.pads, p.b).map((m) => m.button));
  const dangling = stops.filter((x) => x !== '*' && !stopTargets({ pads: p.pads }, x));
  const byPattern = new Set(stops.flatMap((x) => stopTargets({ pads: p.pads }, x, self) ?? []).map((t) => t.button));
  const byGroup = [...mates].filter((x) => !byPattern.has(x)).length;
  const count = new Set([...byPattern, ...mates]).size;
  const groupNote = !byGroup ? '' : byGroup === count ? `: the ${count === 1 ? 'other one' : 'others'} in its group “${g}”` : ` (${byGroup} of them by its group “${g}”)`;
  return (
    <Section title="Stops">
      <p class="ed-hint">
        A press first stops whichever of these are running (never this button itself), then runs its own action. For an “All off” button: pick what it ends, and set
        the action to Nothing.
      </p>
      <SwitchRow title="Everything that's running" note="Every button on every pad" on={everything} onChange={() => toggle('*')} testid="stop-all" />
      <div class="ed-stops" data-testid="stops-picker">
        {p.pads.map((pad, i) => {
          const padAll = has(`${pad.id}/*`);
          const others = pad.buttons.filter((x) => !(i === p.pi && x === p.b));
          return (
            <div key={i} class="ed-stops-pad">
              <div class="ed-stops-head">{name(pad)}</div>
              <div class="ed-chips">
                <Chip on={everything || padAll} implied={everything} label={i === p.pi ? 'All others here' : `All of ${name(pad)}`} onClick={() => toggle(`${pad.id}/*`)} testid={`stop-${pad.id}/*`} />
                {others.map((x, j) => {
                  const mate = mates.has(x);
                  const xg = groupOf(x);
                  return (
                    <Chip
                      key={j}
                      on={everything || padAll || mate || has(`${pad.id}/${x.id}`)}
                      implied={everything || padAll || mate}
                      title={mate ? `In its group “${g}”: starting this button stops it` : undefined}
                      label={
                        <>
                          {name(x)}
                          {xg && (
                            <span class={`ed-chip-group${mate ? ' is-mate' : ''}`} data-testid={`stop-group-${pad.id}/${x.id}`}>
                              <GroupIcon />
                              {xg}
                            </span>
                          )}
                        </>
                      }
                      onClick={() => toggle(`${pad.id}/${x.id}`)}
                      testid={`stop-${pad.id}/${x.id}`}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {dangling.map((x) => (
        <div key={x} class="ed-stops-gone" data-testid="stop-gone">
          <span class="ed-warn-note">
            Stops <code>{x}</code>, which names no button here.
          </span>
          <button type="button" class="ed-icon" aria-label={`Remove ${x}`} data-testid={`stop-gone-remove-${x}`} onClick={() => set(stops.filter((s) => s !== x))}>
            <Close />
          </button>
        </div>
      ))}
      {p.error ? (
        <span class="ed-err" role="alert" data-testid="error-stops">
          {p.error}
        </span>
      ) : (
        <p class="ed-hint" data-testid="stops-summary">
          {everything
            ? 'Stops everything else that runs.'
            : count
              ? `Stops ${count} button${count === 1 ? " when it's" : "s when they're"} running${groupNote}.`
              : 'Stops nothing.'}
        </p>
      )}
    </Section>
  );
}
