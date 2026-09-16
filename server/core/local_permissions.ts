import { chmodSync, mkdirSync, statSync, existsSync } from 'fs';

/**
 * Who else on this machine can read what IRIS keeps.
 *
 * The workspace confinement, the approval boundary and the `local_only`
 * privacy flag all govern what *IRIS* will hand out. None of them says
 * anything about another account on the same machine opening the file
 * directly — and on 2026-08-20 every one of these was world-readable: the
 * financial line items, the worktrees, and `backups/`, which holds a complete
 * copy of the database including the transactions marked as never leaving the
 * device.
 *
 * This is not the containment `full_sandbox_migration` described, and it is
 * not a substitute for it. It is the part of that intent obtainable on a
 * machine that must keep its TCC grants — and it matters more, not less, on a
 * laptop that gets carried around.
 *
 * Directories are 700 and files 600: owner only, nothing for group or other.
 */

export interface PermissionTarget {
  path: string;
  kind: 'directory' | 'file';
  /** Why this one matters, for a report a person reads. */
  holds: string;
}

export const DIRECTORY_MODE = 0o700;
export const FILE_MODE = 0o600;

export interface PermissionCheck {
  path: string;
  holds: string;
  exists: boolean;
  /** Octal, as stored. */
  mode: number | null;
  ok: boolean;
  /** Who else can read it, in words. */
  reason: string | null;
}

/** Whether a mode grants anything to group or other. */
export function isPrivate(mode: number): boolean {
  return (mode & 0o077) === 0;
}

export function describeExposure(mode: number): string {
  const group = (mode >> 3) & 0o7;
  const other = mode & 0o7;
  const parts: string[] = [];
  if (group !== 0) parts.push(`グループが ${group & 4 ? '読める' : ''}${group & 2 ? '書ける' : ''}`.trim());
  if (other !== 0) parts.push(`他のユーザが ${other & 4 ? '読める' : ''}${other & 2 ? '書ける' : ''}`.trim());
  return parts.join('、');
}

/**
 * Applies the intended mode, creating the directory if it is not there.
 *
 * Called at startup rather than once by hand: a directory recreated by a later
 * `mkdir` inherits the process umask, and the tightening would quietly undo
 * itself the first time something was rebuilt.
 */
export function enforce(target: PermissionTarget): PermissionCheck {
  const mode = target.kind === 'directory' ? DIRECTORY_MODE : FILE_MODE;
  try {
    if (target.kind === 'directory' && !existsSync(target.path)) {
      mkdirSync(target.path, { recursive: true, mode });
    }
    if (!existsSync(target.path)) {
      return { path: target.path, holds: target.holds, exists: false, mode: null, ok: true, reason: null };
    }
    chmodSync(target.path, mode);
  } catch {
    /* reported below from whatever the mode actually is */
  }
  return check(target);
}

export function check(target: PermissionTarget): PermissionCheck {
  if (!existsSync(target.path)) {
    return { path: target.path, holds: target.holds, exists: false, mode: null, ok: true, reason: null };
  }
  let mode: number;
  try {
    mode = statSync(target.path).mode & 0o777;
  } catch (err: any) {
    return {
      path: target.path,
      holds: target.holds,
      exists: true,
      mode: null,
      ok: false,
      reason: `権限を読めません: ${err?.message ?? err}`,
    };
  }
  const ok = isPrivate(mode);
  return {
    path: target.path,
    holds: target.holds,
    exists: true,
    mode,
    ok,
    reason: ok ? null : describeExposure(mode),
  };
}
