import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Filesystem confinement for production tools.
 *
 * This module is the security boundary for every filesystem tool. It matters
 * more than the tools themselves because READ tools auto-execute without
 * approval: an unconfined `read_file` would let a single model turn — or text
 * injected into one — exfiltrate .env, SSH keys or the IRIS database itself.
 *
 * Three independent defences, all of which must pass:
 *   1. path confinement — the resolved path must stay inside the workspace root;
 *   2. symlink resolution — a link pointing outside the root is rejected even
 *      though its literal path looks contained;
 *   3. a secret denylist — enforced even for paths inside the root.
 *
 * The root deliberately defaults to a dedicated workspace directory rather than
 * the IRIS repository. IRIS must not be able to casually rewrite the code that
 * supervises IRIS, so its own source is out of reach by default. Pointing
 * IRIS_WORKSPACE_ROOT at the repo is possible but is an explicit choice.
 */

export class WorkspaceAccessError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = 'WorkspaceAccessError';
  }
}

export const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), 'IRIS_Workspace');

/** Byte ceilings so a tool result cannot flood the model context. */
export const MAX_READ_BYTES = 256 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 500;

/**
 * Names that must never be read or written even inside the workspace, in case
 * credentials are ever placed there. Matched case-insensitively against every
 * path segment.
 */
const DENIED_SEGMENTS = [
  '.git',
  '.ssh',
  '.gnupg',
  '.aws',
  '.config',
  'node_modules',
];

const DENIED_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^.*\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^(credentials|client_secret|service[-_]?account|token|secrets?)(\..*)?$/i,
  /^.*\.(db|sqlite|sqlite3)(-wal|-shm)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
];

/**
 * Whether a path is protected regardless of which root it sits under.
 *
 * Exported so review-context assembly applies the same rules: that content is
 * sent to an external model, so shipping a .env into a review prompt would be
 * a worse leak than reading one locally.
 */
export function isDeniedPath(relativePath: string): { denied: boolean; reason?: string } {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    if (DENIED_SEGMENTS.includes(segment.toLowerCase())) {
      return { denied: true, reason: 'denied_segment' };
    }
    if (DENIED_PATTERNS.some((pattern) => pattern.test(segment))) {
      return { denied: true, reason: 'denied_pattern' };
    }
  }
  return { denied: false };
}

export interface WorkspaceOptions {
  root?: string;
}

export class Workspace {
  readonly root: string;

  constructor(options: WorkspaceOptions = {}) {
    const configured = options.root || process.env.IRIS_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT;
    this.root = path.resolve(configured);
    this.ensureRoot();
  }

  private ensureRoot() {
    if (!fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }
    const stat = fs.statSync(this.root);
    if (!stat.isDirectory()) {
      throw new WorkspaceAccessError(
        `ワークスペースルートがディレクトリではありません: ${this.root}`,
        'root_not_directory'
      );
    }
  }

  /** The root with symlinks resolved — the true boundary for containment checks. */
  private realRoot(): string {
    return fs.realpathSync(this.root);
  }

  /**
   * Resolves a caller-supplied path to an absolute path guaranteed to live
   * inside the workspace, or throws.
   *
   * An absolute path outside the root resolves to a relative path starting with
   * '..' and is rejected by the same check that catches traversal, so absolute
   * input needs no special case.
   */
  resolve(candidate: string): string {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new WorkspaceAccessError('パスが指定されていません。', 'empty_path');
    }
    if (candidate.includes('\0')) {
      throw new WorkspaceAccessError('パスに不正な文字が含まれています。', 'invalid_path');
    }

    const resolved = path.resolve(this.root, candidate);
    this.assertContained(resolved, candidate);
    this.assertNotDenied(resolved, candidate);
    this.assertNoSymlinkEscape(resolved, candidate);
    return resolved;
  }

  private assertContained(resolved: string, original: string) {
    const relative = path.relative(this.root, resolved);
    const escapes = relative.startsWith('..') || path.isAbsolute(relative);
    if (escapes) {
      throw new WorkspaceAccessError(
        `ワークスペース外へのアクセスは許可されていません: ${original}`,
        'outside_workspace'
      );
    }
  }

  private assertNotDenied(resolved: string, original: string) {
    const relative = path.relative(this.root, resolved);
    const denied = isDeniedPath(relative);
    if (denied.denied) {
      throw new WorkspaceAccessError(
        denied.reason === 'denied_segment'
          ? `保護されたディレクトリへのアクセスは許可されていません: ${original}`
          : `機密の可能性があるファイルへのアクセスは許可されていません: ${original}`,
        denied.reason!
      );
    }
  }

  /**
   * Checks where a path actually leads.
   *
   * Two distinct dangers, and only the first was covered originally: a link
   * that points *outside* the root, and a link that points at a *protected
   * file inside* it. The second slipped through every check —
   * `notes.md -> .env` passed the denylist on its own name and passed
   * containment because its target is also inside the root — and read_file is
   * a READ tool, so it auto-executes with no human in the loop. Verified
   * against a real .env before this check existed.
   *
   * For a path that does not exist yet (a create), the nearest existing
   * ancestor is checked instead, which catches writes through a symlinked
   * parent directory.
   */
  private assertNoSymlinkEscape(resolved: string, original: string) {
    const realRoot = this.realRoot();

    let probe = resolved;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return;
      probe = parent;
    }

    const realProbe = fs.realpathSync(probe);
    const relative = path.relative(realRoot, realProbe);

    const escapes = relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative));
    if (escapes) {
      throw new WorkspaceAccessError(
        `シンボリックリンク経由のワークスペース外アクセスは許可されていません: ${original}`,
        'symlink_escape'
      );
    }

    // The link stayed inside the root — but the denylist must judge the target,
    // not the name the caller used to reach it.
    const deniedTarget = isDeniedPath(relative);
    if (deniedTarget.denied) {
      throw new WorkspaceAccessError(
        `リンク先が機密の可能性があるため拒否されました: ${original} -> ${relative}`,
        deniedTarget.reason!
      );
    }
  }

  /** Path relative to the root, for reporting back without leaking the absolute layout. */
  relative(absolutePath: string): string {
    const relative = path.relative(this.root, absolutePath);
    return relative === '' ? '.' : relative;
  }
}

export const defaultWorkspace = new Workspace();
