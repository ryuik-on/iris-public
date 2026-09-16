import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import { Workspace, defaultWorkspace } from './workspace.js';

/**
 * System-awareness tools.
 *
 * `get_current_time` looks trivial but is foundational: a language model has no
 * clock, so without it every deadline, "today" and "how long ago" is a guess.
 * This is the first primitive the later Life State / NOW layer builds on.
 */
export function createSystemTools(workspace: Workspace = defaultWorkspace): Tool[] {
  return [
    {
      name: 'get_current_time',
      description:
        '現在の日時を取得します。日付・時刻・曜日・タイムゾーンに依存する判断の前に使用してください。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          timeZone: {
            type: 'string',
            description: 'IANA タイムゾーン名 (例: Asia/Tokyo)。省略時はシステム設定。',
          },
        },
      },
      async execute(args: any) {
        const now = new Date();
        const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const timeZone = args?.timeZone || systemZone;

        let localized: string;
        try {
          localized = new Intl.DateTimeFormat('ja-JP', {
            timeZone,
            dateStyle: 'full',
            timeStyle: 'medium',
          }).format(now);
        } catch {
          throw new Error(`不明なタイムゾーンです: ${timeZone}`);
        }

        return {
          iso: now.toISOString(),
          epochMs: now.getTime(),
          timeZone,
          localized,
          weekday: new Intl.DateTimeFormat('ja-JP', { timeZone, weekday: 'long' }).format(now),
        };
      },
    },

    {
      name: 'get_workspace_info',
      description:
        'IRIS が読み書きできるワークスペースの場所と制約を返します。ファイル操作の前に利用可能範囲を確認できます。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: { type: 'object', properties: {} },
      async execute() {
        return {
          root: workspace.root,
          note: 'すべてのファイル操作はこのディレクトリ内に限定されます。ワークスペース外および機密ファイルへのアクセスは拒否されます。',
        };
      },
    },
  ];
}
