import fs from 'fs/promises';
import path from 'path';
import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import {
  Workspace,
  defaultWorkspace,
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  MAX_DIRECTORY_ENTRIES,
} from './workspace.js';

/**
 * Workspace filesystem tools.
 *
 * Risk assignment follows the security invariant:
 *   list_directory / read_file  → READ           (auto-executes)
 *   write_file                  → WRITE          (approval required)
 *   delete_file                 → DESTRUCTIVE    (approval required)
 *
 * Every path passes through Workspace.resolve(), which is the only place
 * containment is decided.
 *
 * File contents returned by read_file are labelled `source: 'workspace_file'`.
 * That label matters later: content read off disk is external evidence, not a
 * user statement, and must not be promoted into canonical personal memory
 * without passing the memory admission gate.
 */

export function createFilesystemTools(workspace: Workspace = defaultWorkspace): Tool[] {
  return [
    {
      name: 'list_directory',
      description:
        'IRIS ワークスペース内のディレクトリ内容を一覧します。パスはワークスペースルートからの相対パスで指定します。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'ワークスペースルートからの相対パス。省略時はルート。',
          },
        },
      },
      async execute(args: any) {
        const target = workspace.resolve(args?.path ?? '.');
        const stat = await fs.stat(target);
        if (!stat.isDirectory()) {
          throw new Error(`ディレクトリではありません: ${workspace.relative(target)}`);
        }

        const dirents = await fs.readdir(target, { withFileTypes: true });
        const truncated = dirents.length > MAX_DIRECTORY_ENTRIES;
        const slice = dirents.slice(0, MAX_DIRECTORY_ENTRIES);

        const entries = await Promise.all(
          slice.map(async (dirent) => {
            const entryPath = path.join(target, dirent.name);
            let size: number | null = null;
            let modifiedAt: string | null = null;
            try {
              const entryStat = await fs.stat(entryPath);
              size = entryStat.isFile() ? entryStat.size : null;
              modifiedAt = entryStat.mtime.toISOString();
            } catch {
              // A broken symlink should not fail the whole listing.
            }
            return {
              name: dirent.name,
              type: dirent.isDirectory() ? 'directory' : dirent.isFile() ? 'file' : 'other',
              size,
              modifiedAt,
            };
          })
        );

        return {
          path: workspace.relative(target),
          entryCount: dirents.length,
          truncated,
          entries,
        };
      },
    },

    {
      name: 'read_file',
      description:
        'IRIS ワークスペース内のテキストファイルを読み取ります。機密ファイルおよびワークスペース外へのアクセスは拒否されます。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'ワークスペースルートからの相対ファイルパス。',
          },
        },
        required: ['path'],
      },
      async execute(args: any) {
        const target = workspace.resolve(args?.path);
        const stat = await fs.stat(target);
        if (!stat.isFile()) {
          throw new Error(`ファイルではありません: ${workspace.relative(target)}`);
        }

        const handle = await fs.open(target, 'r');
        try {
          const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ_BYTES));
          await handle.read(buffer, 0, buffer.length, 0);

          // A NUL byte in the leading chunk is a reliable binary signal.
          if (buffer.includes(0)) {
            throw new Error(`バイナリファイルは読み取れません: ${workspace.relative(target)}`);
          }

          return {
            source: 'workspace_file',
            path: workspace.relative(target),
            size: stat.size,
            truncated: stat.size > MAX_READ_BYTES,
            modifiedAt: stat.mtime.toISOString(),
            content: buffer.toString('utf8'),
          };
        } finally {
          await handle.close();
        }
      },
    },

    {
      name: 'write_file',
      description:
        'IRIS ワークスペース内にテキストファイルを書き込みます。既存ファイルを上書きする場合があるため、実行には承認が必要です。',
      riskLevel: RiskLevel.WRITE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'ワークスペースルートからの相対ファイルパス。',
          },
          content: {
            type: 'string',
            description: '書き込む内容。',
          },
          mode: {
            type: 'string',
            enum: ['overwrite', 'append', 'create_only'],
            description: '既定は overwrite。create_only は既存ファイルがある場合に失敗します。',
          },
        },
        required: ['path', 'content'],
      },
      async execute(args: any) {
        const target = workspace.resolve(args?.path);
        const content = typeof args?.content === 'string' ? args.content : '';
        const mode = args?.mode ?? 'overwrite';

        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > MAX_WRITE_BYTES) {
          throw new Error(`書き込みサイズが上限を超えています (${bytes} > ${MAX_WRITE_BYTES} bytes)。`);
        }

        const existed = await exists(target);
        if (mode === 'create_only' && existed) {
          throw new Error(`ファイルは既に存在します: ${workspace.relative(target)}`);
        }

        await fs.mkdir(path.dirname(target), { recursive: true });
        if (mode === 'append') {
          await fs.appendFile(target, content, 'utf8');
        } else {
          await fs.writeFile(target, content, 'utf8');
        }

        const stat = await fs.stat(target);
        return {
          path: workspace.relative(target),
          mode,
          created: !existed,
          bytesWritten: bytes,
          size: stat.size,
        };
      },
    },

    {
      name: 'delete_file',
      description:
        'IRIS ワークスペース内のファイルを削除します。取り消せない操作のため、実行には承認が必要です。',
      riskLevel: RiskLevel.DESTRUCTIVE,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'ワークスペースルートからの相対ファイルパス。',
          },
        },
        required: ['path'],
      },
      async execute(args: any) {
        const target = workspace.resolve(args?.path);
        const stat = await fs.stat(target);

        // Recursive directory deletion is intentionally not offered: a single
        // mistaken argument would be unbounded. Directories need a deliberate
        // separate tool if they are ever required.
        if (!stat.isFile()) {
          throw new Error(`ファイルのみ削除できます: ${workspace.relative(target)}`);
        }

        await fs.unlink(target);
        return {
          path: workspace.relative(target),
          deleted: true,
          sizeBefore: stat.size,
        };
      },
    },
  ];
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
