/** Thin top bar: pad tabs, connection indicator, menu button. */
import type { WirePad } from '../../core/protocol.ts';
import type { ConnStatus } from '../backend/types.ts';
import { Menu } from './icons.tsx';

const CONN: Record<ConnStatus, string> = { online: 'LIVE', connecting: 'CONNECTING', offline: 'OFFLINE', unauthorized: 'REJECTED' };

export function TopBar(p: {
  pads: WirePad[];
  padId: string;
  showTabs: boolean;
  status: ConnStatus;
  demo: boolean;
  onPad(id: string): void;
  onMenu(): void;
}) {
  const current = p.pads.find((x) => x.id === p.padId);
  return (
    <header class="bp-bar">
      {p.showTabs ? (
        <nav class="bp-tabs" role="tablist" data-scroll-x>
          {p.pads.map((pad) => (
            <button
              key={pad.id}
              type="button"
              role="tab"
              class="bp-tab"
              aria-selected={pad.id === p.padId}
              data-testid={`tab-${pad.id}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => p.onPad(pad.id)}
            >
              {pad.name}
            </button>
          ))}
        </nav>
      ) : (
        <div class="bp-bar-title">{current?.name ?? 'ButtPad'}</div>
      )}
      {p.demo && <span class="bp-demo-tag">DEMO</span>}
      <div class="bp-conn" data-status={p.status} data-testid="conn" role="status" aria-label={`connection: ${p.status}`}>
        <i class="bp-dot" />
        <span>{CONN[p.status]}</span>
      </div>
      <button type="button" class="bp-icon-btn" aria-label="Menu" data-testid="menu-btn" onPointerDown={(e) => e.preventDefault()} onClick={p.onMenu}>
        <Menu />
      </button>
    </header>
  );
}
