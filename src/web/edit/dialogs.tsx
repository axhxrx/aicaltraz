/**
 * Edit-mode dialogs around saving and syncing with the host: a 409, a merge with conflicts to
 * resolve, a save that would stop running actions, a broken config file on the host, and a draft
 * kept from an earlier session. Each that can destroy work focuses its safe way out.
 */
import type { Conflict, Side } from './merge.ts';
import { Dialog, Segmented } from './fields.tsx';
import { fieldName } from './problems.ts';

/** "12 s", "3 min", "2 h". */
export function ran(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

/** "10:42", or "Tue 10:42" when it wasn't today. */
export function when(t: number): string {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export function ConflictDialog(p: { again: boolean; onMerge(): void; onOverwrite(): void; onCancel(): void }) {
  return (
    <Dialog
      title={p.again ? 'It changed on the host again' : 'The config changed on the host'}
      testid="dialog-conflict"
      tone="warn"
      onClose={p.onCancel}
      actions={
        <>
          <button type="button" class="ed-btn is-primary" data-testid="conflict-merge" onClick={p.onMerge}>
            Merge their changes…
          </button>
          <button type="button" class="ed-btn is-danger" data-testid="conflict-mine" onClick={p.onOverwrite}>
            Overwrite with mine
          </button>
          <button type="button" class="ed-btn is-quiet" data-testid="conflict-cancel" data-autofocus onClick={p.onCancel}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        Since you started editing, the config on the host was changed: someone edited the file by hand, or another admin saved. Saving now would replace their version.
      </p>
      <p>
        <b>Merge</b> takes their changes into your draft (where you both changed the same button, you pick). <b>Overwrite with mine</b> replaces their version with your draft.
      </p>
    </Dialog>
  );
}

const fields = (list: string[]) => list.map((f) => fieldName(f).toLowerCase()).join(', ') || 'it';

function why(c: Conflict): string {
  if (c.what === 'order') return 'You both reordered the pads.';
  if (c.mine === 'added') return 'You both added one with this id.';
  const mine = c.mine === 'deleted' ? 'You deleted it' : `You changed ${fields(c.mineFields)}`;
  const theirs = c.theirs === 'deleted' ? 'the host deleted it' : `the host changed ${fields(c.theirsFields)}`;
  return `${mine}; ${theirs}.`;
}

export function MergeDialog(p: { conflicts: Conflict[]; taken: number; choices: Record<string, Side>; onChoose(key: string, side: Side): void; onApply(): void; onCancel(): void }) {
  const n = p.conflicts.length;
  return (
    <Dialog
      title={`${n} change${n === 1 ? '' : 's'} on both sides`}
      testid="dialog-merge"
      tone="warn"
      onClose={p.onCancel}
      actions={
        <>
          <button type="button" class="ed-btn is-primary" data-testid="merge-apply" onClick={p.onApply}>
            Merge
          </button>
          <button type="button" class="ed-btn is-quiet" data-testid="merge-cancel" data-autofocus onClick={p.onCancel}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        {p.taken > 0 && `${p.taken} of the host's changes merge as they are. `}
        Where you and the host changed the same thing, pick which version to keep. You can undo the merge.
      </p>
      <ul class="ed-merge-list">
        {p.conflicts.map((c, i) => {
          const side = p.choices[c.key] ?? 'mine';
          return (
            <li key={c.key} class="ed-merge-item" data-testid="merge-item">
              <div class="ed-merge-title">{c.title}</div>
              <div class="ed-merge-why">{why(c)}</div>
              <Segmented<Side>
                label={`Keep which version of ${c.title}`}
                value={side}
                testid={`merge-${i}`}
                onChange={(s) => p.onChoose(c.key, s)}
                options={[
                  { value: 'mine', label: c.mine === 'deleted' ? 'Keep it deleted' : 'Keep mine' },
                  { value: 'theirs', label: c.theirs === 'deleted' ? 'Delete it' : 'Take theirs' },
                ]}
              />
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

export function StopDialog(p: { runs: { name: string; ms: number }[]; onSave(): void; onCancel(): void }) {
  const list = p.runs.map((r) => `${r.name} (running ${ran(r.ms)})`);
  return (
    <Dialog
      title={p.runs.length === 1 ? 'Saving stops a running action' : 'Saving stops running actions'}
      testid="dialog-stop"
      tone="danger"
      onClose={p.onCancel}
      actions={
        <>
          <button type="button" class="ed-btn is-danger" data-testid="stop-save" onClick={p.onSave}>
            Save and stop {p.runs.length === 1 ? 'it' : 'them'}
          </button>
          <button type="button" class="ed-btn is-quiet" data-testid="stop-cancel" data-autofocus onClick={p.onCancel}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        This will stop: <b data-testid="stop-list">{list.join(', ')}</b>.
      </p>
      <p>Your draft deletes {p.runs.length === 1 ? 'that button' : 'those buttons'} or changes {p.runs.length === 1 ? 'its' : 'their'} id (or the pad's), so the host ends the run.</p>
    </Dialog>
  );
}

export function BrokenFileDialog(p: { errors: string[]; onSave(): void; onCancel(): void }) {
  return (
    <Dialog
      title="The config file on the host is broken"
      testid="dialog-broken"
      tone="danger"
      onClose={p.onCancel}
      actions={
        <>
          <button type="button" class="ed-btn is-danger" data-testid="broken-save" onClick={p.onSave}>
            Replace it with mine
          </button>
          <button type="button" class="ed-btn is-quiet" data-testid="broken-cancel" data-autofocus onClick={p.onCancel}>
            Cancel
          </button>
        </>
      }
    >
      <p>
        The config file on the host is currently invalid
        {p.errors.length ? (
          <>
            {' '}
            (<span data-testid="broken-errors">{p.errors.slice(0, 3).join('; ')}</span>
            {p.errors.length > 3 ? `; +${p.errors.length - 3} more` : ''})
          </>
        ) : null}
        : maybe someone is editing it by hand right now. The host still runs the previous config.
      </p>
      <p>
        <b>Saving will replace it</b> with your config, and whatever was in it is gone.
      </p>
    </Dialog>
  );
}

export function RestoreDialog(p: { savedAt: number; onRestore(): void; onDiscard(): void }) {
  return (
    <Dialog
      title={`Restore unsaved changes from ${when(p.savedAt)}?`}
      testid="dialog-restore"
      onClose={p.onRestore}
      actions={
        <>
          <button type="button" class="ed-btn is-primary" data-testid="restore-yes" data-autofocus onClick={p.onRestore}>
            Restore my changes
          </button>
          <button type="button" class="ed-btn is-danger" data-testid="restore-no" onClick={p.onDiscard}>
            Discard them
          </button>
        </>
      }
    >
      <p>You were editing on this device and didn't save. Restoring brings your draft back, merged with the host's config as it is now.</p>
    </Dialog>
  );
}
