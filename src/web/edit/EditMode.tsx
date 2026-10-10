/**
 * Edit mode (admin). Placeholder: App already routes here from the menu's "Edit pads" entry.
 * The editor should reuse PadGrid/cellStyle (run/RunPad.tsx) and ButtonFace (run/ButtonFace.tsx)
 * with a static READY vm (see dev/Gallery.tsx `vmFor`), and save via backend.saveConfig().
 */
import type { Backend } from '../backend/types.ts';

export interface EditModeProps {
  backend: Backend;
  /** Pad shown when edit mode was entered. */
  padId: string;
  onExit(): void;
}

export function EditMode({ onExit }: EditModeProps) {
  return (
    <div class="bp-edit-stub" data-testid="edit-stub">
      <h2>Edit mode is coming</h2>
      <p>For now, edit the config file on the host: changes are picked up live.</p>
      <button type="button" class="bp-cta" onClick={onExit}>
        Back to the pad
      </button>
    </div>
  );
}
