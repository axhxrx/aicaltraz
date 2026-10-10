/**
 * `stops`: running buttons a press cancels before its own action starts (the host leaves the
 * button itself out). Patterns `pad/button`, `pad/*` (that pad's buttons) or `*` (everything),
 * picked here as chips; a wider pick shows what it covers. A pattern that names nothing (typed by
 * hand, or its pad gone) is listed to remove. Renames and deletes in the editor keep the patterns
 * in step (editor.ts).
 */
import type { Button, Pad } from '../../core/config.ts';
import { Chip, Section, SwitchRow } from './fields.tsx';
import { Close } from '../ui/icons.tsx';
import { stopTargets } from './ops.ts';

const name = (x: { label?: string; name?: string; id: string }) => (x.label ?? x.name ?? '').trim() || x.id;

export function StopsEditor(p: { pads: Pad[]; pi: number; b: Button; error?: string; onChange(stops: string[] | undefined): void }) {
  const stops = p.b.stops ?? [];
  const has = (x: string) => stops.includes(x);
  const set = (list: string[]) => p.onChange(list.length ? list : undefined);
  const toggle = (x: string) => set(has(x) ? stops.filter((s) => s !== x) : [...stops, x]);
  const self = { pad: p.pads[p.pi]!.id, button: p.b.id };
  const everything = has('*');
  const dangling = stops.filter((x) => x !== '*' && !stopTargets({ pads: p.pads }, x));
  const count = new Set(stops.flatMap((x) => stopTargets({ pads: p.pads }, x, self) ?? []).map((t) => `${t.pad.id}/${t.button.id}`)).size;
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
                {others.map((x, j) => (
                  <Chip key={j} on={everything || padAll || has(`${pad.id}/${x.id}`)} implied={everything || padAll} label={name(x)} onClick={() => toggle(`${pad.id}/${x.id}`)} testid={`stop-${pad.id}/${x.id}`} />
                ))}
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
          {everything ? 'Stops everything else that runs.' : count ? `Stops ${count} button${count === 1 ? '' : 's'} when they're running.` : 'Stops nothing.'}
        </p>
      )}
    </Section>
  );
}
