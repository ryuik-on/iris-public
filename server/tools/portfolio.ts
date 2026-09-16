import { Tool, RiskLevel, ToolTrust } from '../core/types.js';
import { PortfolioService } from '../services/portfolio.js';

/**
 * Answering "how is it going" from the ledger rather than from memory.
 *
 * Read-only, and read fresh. The ledger is the authority; this reports what it
 * currently says and nothing IRIS has decided on its own.
 *
 * The failure answer matters more than the success one. If the ledger cannot
 * be read, the model is told that in those words — because the alternative is
 * a reply that says there is nothing in progress, which is a false statement
 * about someone's work and indistinguishable from a genuinely quiet week.
 */
export function createPortfolioTools(portfolio: PortfolioService): Tool[] {
  return [
    {
      name: 'get_project_status',
      description:
        'MED-AI Builder Lab の台帳から、Project と Task の進捗を読みます。' +
        '進行中・停止中の Task、その解除条件、台帳に登録されていないリポジトリがわかります。' +
        '「medrecall の進捗は」「今止まっているのは」などに答えるときに使います。',
      riskLevel: RiskLevel.READ,
      trust: ToolTrust.TRUSTED_CORE,
      schema: {
        type: 'object',
        properties: {
          includeDone: {
            type: 'boolean',
            description: '完了済み Task も含めるか。既定は false（未完のみ）。',
          },
        },
      },
      async execute(args: any) {
        const read = portfolio.read();

        if (!read.ok) {
          return {
            error: true,
            readable: false,
            source: read.source,
            message: read.reason,
            guidance:
              '台帳を読めませんでした。「進行中の作業はありません」とは答えないでください。' +
              '読めなかったことと、その場所を伝えてください。',
          };
        }

        const includeDone = args?.includeDone === true;

        return {
          readable: true,
          source: read.source,
          projects: read.projects.map((project) => ({
            id: project.id,
            name: project.name,
            status: project.status,
            priority: project.priority,
            progress: project.progress,
            tasks: project.tasks
              .filter((task) => includeDone || task.status !== 'Done')
              .map((task) => ({
                id: task.id,
                title: task.title,
                status: task.status,
                owner: task.owner,
                dependsOn: task.dependsOn,
                // For a Blocked task this is the release condition, which is
                // the one thing someone asking actually wants.
                notes: task.notes.slice(0, 400),
                updated: task.updated,
              })),
          })),
          decisions: read.decisions,
          labs: read.labs.length,
          /**
           * Repositories with commits that the ledger does not name.
           *
           * Reported because the ledger calls itself the single record of
           * active work, and a repository being worked on that it has never
           * heard of is precisely the drift nobody would otherwise see.
           */
          unregisteredRepos: read.repos
            .filter((repo) => !repo.registered && repo.lastCommit !== null)
            .map((repo) => ({ name: repo.name, path: repo.path, lastCommit: repo.lastCommit })),
          warnings: read.warnings,
        };
      },
    },
  ];
}
