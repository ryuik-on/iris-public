import { randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'fs';
import { dirname } from 'path';

/**
 * The token that lets a device that is not this machine talk to IRIS.
 *
 * Generated once and kept in a file rather than asked for in configuration.
 * A token nobody has set is a protection nobody has turned on, and the
 * alternative — refusing every remote request until a human edits an env file
 * — means the feature exists and does not work, which is the same as it not
 * existing. Making one up front means remote access is closed by default and
 * openable in the time it takes to copy a string.
 *
 * `IRIS_ACCESS_TOKEN` still wins if it is set. Someone running two machines
 * against one token should be able to say so.
 *
 * The file is 0600 and its directory 0700, and both are re-applied on every
 * read rather than only at creation. Permissions drift — a restore, a copy, a
 * migration — and the value of this file is exactly its secrecy.
 */

export interface TokenState {
  token: string;
  /** Where it came from, so the answer to "why is it that" is on hand. */
  source: 'env' | 'file' | 'created';
  path: string | null;
}

/** 32 bytes, base64url. Long enough that guessing is not a strategy. */
function mint(): string {
  return randomBytes(32).toString('base64url');
}

export function loadAccessToken(path: string, env = process.env): TokenState {
  const configured = env.IRIS_ACCESS_TOKEN?.trim();
  if (configured) return { token: configured, source: 'env', path: null };

  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, 'utf-8').trim();
      if (existing.length >= 16) {
        harden(path);
        return { token: existing, source: 'file', path };
      }
      // A truncated or empty file is not a token. Replacing it is safer than
      // running with a short one that looks like it works.
    }
  } catch {
    // Fall through and make a new one; an unreadable file cannot be used.
  }

  const token = mint();
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, token + '\n', { mode: 0o600 });
    harden(path);
    return { token, source: 'created', path };
  } catch {
    /**
     * Held in memory for this process only.
     *
     * Remote access still works and stops working at the next restart, which
     * is inconvenient and safe. The alternative — treating a failed write as a
     * reason to allow everyone — is how a protection becomes decorative.
     */
    return { token, source: 'created', path: null };
  }
}

/** 0700 on the directory, 0600 on the file, every time. */
function harden(path: string): void {
  try {
    chmodSync(path, 0o600);
    const dir = dirname(path);
    if (statSync(dir).isDirectory()) chmodSync(dir, 0o700);
  } catch {
    // Reported by the permissions health probe rather than thrown here; a
    // token that exists with loose permissions is still better than no token.
  }
}
