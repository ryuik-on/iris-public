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

/**
 * 読み取り専用で広げたルートの中で、さらに読ませない場所。
 *
 * ホーム全体を読み取りだけ許すと、ワークスペースの拒否リスト（`.env`、鍵、
 * `*.db` など）に載らない**アプリの内部**まで届く。`Library` は鍵束と各アプリの
 * 保存先、`.iris` は IRIS 自身の記憶と家計、`.claude` などは他のエージェントの
 * 会話の記録と設定。**読んだ中身はクラウドの模型に渡る**ので、名前で塞ぐ。
 */
const READ_ONLY_DENIED_SEGMENTS = [
  'library', '.iris', '.claude', '.codex', '.gemini', '.antigravity', '.docker', '.kube',
  '.npm', '.trash', '.local', '.cache', '.vscode', '.cursor',
];

function isDeniedReadOnly(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  return segments.some((segment) => READ_ONLY_DENIED_SEGMENTS.includes(segment.toLowerCase()));
}

function expandHome(candidate: string): string {
  if (candidate === '~') return os.homedir();
  if (candidate.startsWith('~/')) return path.join(os.homedir(), candidate.slice(2));
  return candidate;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export interface WorkspaceOptions {
  root?: string;
  /** 読み取り専用で足すルート。指定が無ければ `IRIS_READ_ROOTS`（`:` 区切り）。 */
  readRoots?: string[];
  /** 書き込みを足すルート。指定が無ければ `IRIS_WRITE_ROOTS`。**承認画面を通る書き込みだけ**が使う。 */
  writeRoots?: string[];
}

export class Workspace {
  readonly root: string;
  /** 読むだけできる場所。書き込みと削除は、ここでは決して通らない。 */
  readonly readRoots: string[];
  /** 承認を通せば書ける場所（ワークスペース以外）。削除はここでも通らない。 */
  readonly writeRoots: string[];

  constructor(options: WorkspaceOptions = {}) {
    const configured = options.root || process.env.IRIS_WORKSPACE_ROOT || DEFAULT_WORKSPACE_ROOT;
    this.root = path.resolve(configured);
    this.ensureRoot();
    const extra = options.readRoots
      ?? (process.env.IRIS_READ_ROOTS ?? '').split(path.delimiter).map((r) => r.trim()).filter(Boolean);
    this.readRoots = extra.map((r) => path.resolve(expandHome(r))).filter((r) => fs.existsSync(r));
    const writable = options.writeRoots
      ?? (process.env.IRIS_WRITE_ROOTS ?? '').split(path.delimiter).map((r) => r.trim()).filter(Boolean);
    this.writeRoots = writable.map((r) => path.resolve(expandHome(r))).filter((r) => fs.existsSync(r));
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

  /**
   * 読むための解決。ワークスペースの中は今までどおり、外は**許可した読み取り
   * ルートの中の絶対パス（`~` 可）だけ**。書き込み・削除はこちらを通らない。
   *
   * 外側は三つを重ねて確かめる。(1) ルートの中か、(2) 名前で拒否されていないか
   * （ワークスペースと同じ拒否リストに、アプリの内部を足したもの）、(3) シンボリック
   * リンクの行き先がまだルートの中で、行き先の名前も拒否されていないか。
   */
  resolveRead(candidate: string): string {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new WorkspaceAccessError('パスが指定されていません。', 'empty_path');
    }
    if (candidate.includes('\0')) {
      throw new WorkspaceAccessError('パスに不正な文字が含まれています。', 'invalid_path');
    }
    const expanded = expandHome(candidate);
    if (!path.isAbsolute(expanded)) return this.resolve(candidate);

    const absolute = path.resolve(expanded);
    if (within(this.root, absolute)) return this.resolve(absolute);

    const base = this.readRoots.find((r) => within(r, absolute));
    if (!base) {
      throw new WorkspaceAccessError(
        `読み取りを許可した場所の外です: ${candidate}` +
          (this.readRoots.length ? `（許可: ${this.readRoots.join(', ')}）` : '（読み取り専用の場所は設定されていません）'),
        'outside_workspace'
      );
    }
    this.assertReadable(absolute, base, candidate);

    // 行き先を見る。まだ無いパスは、いちばん近い既存の親で。
    let probe = absolute;
    while (!this.existsWithoutFollowingLink(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return absolute;
      probe = parent;
    }
    const real = fs.realpathSync(probe);
    const realBase = this.readRoots.map((r) => fs.realpathSync(r)).find((r) => within(r, real));
    if (!realBase) {
      throw new WorkspaceAccessError(
        `シンボリックリンク経由で許可した場所の外へ出るため拒否されました: ${candidate}`,
        'symlink_escape'
      );
    }
    this.assertReadable(real, realBase, candidate);
    return absolute;
  }

  private assertReadable(absolute: string, base: string, original: string) {
    // ホームの中なら、ホームからの道筋で見る。`~/Library/...` を、許可した
    // ルートが `~/Library` の外側であっても、名前で塞ぐため。
    const home = os.homedir();
    const from = within(home, absolute) ? home : base;
    const relative = path.relative(from, absolute);
    const denied = isDeniedPath(relative);
    if (denied.denied || isDeniedReadOnly(relative)) {
      throw new WorkspaceAccessError(
        `機密の可能性がある、または読ませない場所です: ${original}`,
        denied.denied ? denied.reason! : 'denied_read_only_segment'
      );
    }
  }

  /**
   * 書くための解決。ワークスペースの中は今までどおり。外は、書き込みを許した
   * ルートの中の絶対パス（`~` 可）だけ。**削除はここを通らない。**
   *
   * 読むときの拒否に、**書くときだけの拒否**を足す。ホームの直下の隠しファイル
   * （`.zshrc` など）、`Applications`（IRIS 自身の画面アプリがある）、そして
   * **IRIS 自身のリポジトリ**。IRIS を監督するコードを、IRIS が書き換えられては
   * ならない（このファイルの冒頭の方針）。
   */
  resolveWrite(candidate: string): string {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) {
      throw new WorkspaceAccessError('パスが不正です。', 'invalid_path');
    }
    const expanded = expandHome(candidate);
    const absolute = path.resolve(this.root, expanded);
    const inWorkspace = within(this.root, absolute);
    const base = inWorkspace ? this.root : this.writeRoots.find((r) => within(r, absolute));
    if (!base) throw new WorkspaceAccessError(`書き込みを許可した場所の外です: ${candidate}`, 'outside_workspace');
    if (inWorkspace) this.assertNotDenied(absolute, candidate);
    else this.assertWritable(absolute, base, candidate);

    // Capture a physical parent once. The writer never re-resolves mutable links.
    const physicalBase = fs.realpathSync(base);
    let probe = path.dirname(absolute);
    while (!this.existsWithoutFollowingLink(probe)) probe = path.dirname(probe);
    const physical = path.resolve(fs.realpathSync(probe), path.relative(probe, absolute));
    if (!within(physicalBase, physical)) {
      throw new WorkspaceAccessError(`リンク経由で許可した場所の外へ出るため拒否されました: ${candidate}`, 'symlink_escape');
    }
    if (inWorkspace) {
      const denied = isDeniedPath(path.relative(physicalBase, physical));
      if (denied.denied) throw new WorkspaceAccessError('リンク先が保護された場所です。', denied.reason!);
    } else this.assertWritable(physical, physicalBase, candidate);
    if (this.existsWithoutFollowingLink(physical) && fs.lstatSync(physical).isSymbolicLink()) {
      throw new WorkspaceAccessError('リンクには書き込めません。', 'symlink_escape');
    }
    return physical;
  }

  private assertWritable(absolute: string, base: string, original: string) {
    this.assertReadable(absolute, base, original);
    const home = os.homedir();
    const fromHome = within(home, absolute) ? path.relative(home, absolute) : null;
    const top = fromHome ? fromHome.split(path.sep)[0] : null;
    const reasons: string[] = [];
    if (top && top.startsWith('.')) reasons.push('ホーム直下の隠しファイル');
    if (top && top.toLowerCase() === 'applications') reasons.push('アプリの置き場');
    const repo = path.resolve(process.cwd());
    if (within(repo, absolute)) reasons.push('IRIS 自身のコード');
    if (reasons.length) {
      throw new WorkspaceAccessError(
        `書き込みを許さない場所です（${reasons.join('・')}）: ${original}`,
        'denied_write_target'
      );
    }
  }

  /** 一覧に出さない名前。開けないものを並べて誘わない。 */
  hiddenInListing(parent: string, name: string): boolean {
    if (within(this.root, parent)) return false;
    const home = os.homedir();
    const relative = path.relative(within(home, parent) ? home : parent, path.join(parent, name));
    return isDeniedPath(relative).denied || isDeniedReadOnly(relative);
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
    while (!this.existsWithoutFollowingLink(probe)) {
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
    const relative = path.relative(within(this.root, absolutePath) ? this.root : this.realRoot(), absolutePath);
    // ワークスペースの外（読み取り専用の場所）は、そのまま絶対パスで返す。
    if (relative.startsWith('..') || path.isAbsolute(relative)) return absolutePath;
    return relative === '' ? '.' : relative;
  }

  private existsWithoutFollowingLink(candidate: string): boolean {
    try { fs.lstatSync(candidate); return true; }
    catch (err: any) { if (err?.code === 'ENOENT') return false; throw err; }
  }
}

export const defaultWorkspace = new Workspace();
