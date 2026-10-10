/**
 * Process facts the runner and the state store need: whether a process group still has live
 * members, a fingerprint (start time) that tells a process from a later one that reused its PID,
 * and stopping a process group a previous host left behind.
 */
import { readdirSync, readFileSync } from 'node:fs';

const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

export const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

/** Linux: the fields of /proc/PID/stat from `state` (field 3) on; undefined if there's no such process. */
function procStat(pid: number): string[] | undefined {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'latin1');
  } catch {
    return undefined;
  }
  // "pid (comm) state ppid pgrp …"; comm may contain anything, so split after its last ')'.
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

/** Linux: whether process group `pgid` has a member that isn't a zombie, from /proc. */
export function hasLiveMember(pgid: number): boolean {
  let pids: string[];
  try {
    pids = readdirSync('/proc');
  } catch {
    return true;
  }
  for (const pid of pids) {
    const c = pid.charCodeAt(0);
    if (c < 48 || c > 57) continue;
    const f = procStat(Number(pid));
    if (f && Number(f[2]) === pgid && f[0] !== 'Z' && f[0] !== 'X') return true;
  }
  return false;
}

/** Whether process group `pgid` has a live member (on Linux, zombies don't count). */
export function groupAlive(pgid: number): boolean {
  if (isWindows) return false;
  try {
    process.kill(-pgid, 0);
  } catch (e) {
    return errCode(e) === 'EPERM';
  }
  return isLinux ? hasLiveMember(pgid) : true;
}

let bootId: string | undefined | null = null;
const linuxBootId = () => {
  if (bootId === null)
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      bootId = undefined;
    }
  return bootId;
};

/** `ps -o stat=,lstart=` output → fingerprint; undefined for a zombie or nothing. */
function fromPs(out: string): string | undefined {
  const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(out);
  if (!m || m[1]!.startsWith('Z')) return undefined;
  return `ps:${m[2]}`;
}

/**
 * Identifies one process across PID reuse by its start time: on Linux /proc/PID/stat `starttime`
 * (clock ticks since boot) plus the boot id; elsewhere `ps -o lstart=`. undefined when there is no
 * such live (non-zombie) process, or the platform can't tell (Windows).
 */
export function processFingerprint(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 1 || isWindows) return undefined;
  if (isLinux) {
    const f = procStat(pid);
    if (!f || f[0] === 'Z' || f[0] === 'X' || !f[19]) return undefined;
    return `linux:${linuxBootId() ?? '?'}:${f[19]}`;
  }
  try {
    const r = Bun.spawnSync(['ps', '-o', 'stat=,lstart=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    return r.success ? fromPs(r.stdout.toString()) : undefined;
  } catch {
    return undefined;
  }
}

/** processFingerprint without blocking where it needs a `ps` (not Linux). */
export async function processFingerprintAsync(pid: number): Promise<string | undefined> {
  if (isLinux || isWindows || !Number.isInteger(pid) || pid <= 1) return processFingerprint(pid);
  try {
    const p = Bun.spawn(['ps', '-o', 'stat=,lstart=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const out = await new Response(p.stdout).text();
    return (await p.exited) === 0 ? fromPs(out) : undefined;
  } catch {
    return undefined;
  }
}

/** Signal group `pgid`, or process `pid` alone when the group can't be signalled. Whether it was delivered. */
function signal(pgid: number, pid: number, sig: 'SIGTERM' | 'SIGKILL'): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    try {
      process.kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * A process group a previous host left running (it crashed while the run was going), being
 * stopped: SIGTERM now, SIGKILL after `graceMs` to whatever is left. `dying()` until the group is
 * seen empty or got the SIGKILL; a group seen empty is never signalled again (its id may be recycled).
 */
export class Leftover {
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private gone = false;

  constructor(
    readonly pgid: number,
    readonly pid: number,
    graceMs: number,
  ) {
    if (!signal(pgid, pid, 'SIGTERM')) {
      this.gone = true;
      return;
    }
    this.killTimer = setTimeout(() => this.forceKill(), graceMs);
    this.pollTimer = setInterval(() => {
      if (!this.alive()) this.stop();
    }, 50);
    this.killTimer.unref?.();
    this.pollTimer.unref?.();
  }

  alive(): boolean {
    if (this.gone) return false;
    if (!groupAlive(this.pgid)) this.gone = true;
    return !this.gone;
  }

  dying(): boolean {
    return this.killTimer !== undefined;
  }

  forceKill() {
    const live = this.dying() && this.alive();
    this.stop();
    if (live) signal(this.pgid, this.pid, 'SIGKILL');
  }

  private stop() {
    clearTimeout(this.killTimer);
    clearInterval(this.pollTimer);
    this.killTimer = this.pollTimer = undefined;
  }
}
