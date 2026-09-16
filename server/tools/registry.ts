import { Tool, ToolTrust, RiskLevel } from '../core/types.js';
import { withTimeout, retry, TimeoutError, defaultIsRetryable } from '../core/resilience.js';
import { CONFIG } from '../config.js';

export interface ToolExecutionOutcome {
  result?: any;
  error?: string;
  /** True when the call exceeded its time budget. */
  timedOut?: boolean;
  /**
   * True when IRIS cannot tell whether the side effect happened.
   * A timed-out WRITE is NOT a failed WRITE — the file may well exist.
   */
  sideEffectUnknown?: boolean;
  attempts?: number;
}

export interface ExecuteOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: { tool: string; attempt: number; attempts: number; delayMs: number; reason: string }) => void;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    // Provenance must be explicit. An unmarked tool is treated as untrusted
    // rather than silently inheriting the privileges of a core tool.
    this.tools.set(tool.name, { trust: ToolTrust.UNTRUSTED, ...tool });
  }

  registerAll(tools: Tool[]) {
    for (const tool of tools) this.register(tool);
  }

  get(name: string): Tool | undefined { return this.tools.get(name); }
  getAll(): Tool[] { return Array.from(this.tools.values()); }

  /** Description of the registered surface, for /api/settings and audits. */
  describe() {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      riskLevel: t.riskLevel,
      trust: t.trust ?? ToolTrust.UNTRUSTED,
      requiresApproval: t.riskLevel !== RiskLevel.READ,
      autoRetryable: isAutoRetryable(t.riskLevel),
    }));
  }

  /**
   * Executes a tool under a time budget, with a retry policy chosen by risk
   * level (handoff §47).
   *
   * READ is repeatable, so a transient failure is retried. Anything that can
   * change the world is executed exactly once: after a timeout IRIS does not
   * know whether the effect landed, and a blind retry could perform the action
   * twice. Such a call is reported as side-effect-unknown rather than failed,
   * so neither the model nor the user is told "it didn't happen" when it may
   * well have.
   */
  async executeTool(name: string, args: any, options: ExecuteOptions = {}): Promise<ToolExecutionOutcome> {
    const tool = this.get(name);
    if (!tool) return { error: `Tool "${name}" is not registered.` };

    const timeoutMs = options.timeoutMs ?? CONFIG.toolTimeoutMs;
    const repeatable = isAutoRetryable(tool.riskLevel);
    let attempts = 0;

    try {
      const result = await retry(
        async (attempt) => {
          attempts = attempt;
          return withTimeout((signal) => Promise.resolve(tool.execute(args, signal)), {
            ms: timeoutMs,
            label: `ツール ${name}`,
            // For a READ tool a timeout leaves nothing behind; for anything
            // else the outcome is genuinely unknown.
            sideEffectUnknown: !repeatable,
            signal: options.signal,
          });
        },
        {
          attempts: repeatable ? 2 : 1,
          label: `tool:${name}`,
          isRetryable: repeatable ? defaultIsRetryable : () => false,
          signal: options.signal,
          onRetry: ({ attempt, attempts: total, delayMs, error }) =>
            options.onRetry?.({
              tool: name,
              attempt,
              attempts: total,
              delayMs,
              reason: error?.message || String(error),
            }),
        }
      );

      return { result, attempts };
    } catch (err: any) {
      if (err instanceof TimeoutError) {
        return {
          error: err.message,
          timedOut: true,
          sideEffectUnknown: err.sideEffectUnknown,
          attempts,
        };
      }
      return { error: err?.message || 'Tool execution error', attempts };
    }
  }
}

/** Only side-effect-free work may be repeated automatically. */
export function isAutoRetryable(riskLevel: RiskLevel): boolean {
  return riskLevel === RiskLevel.READ;
}

export const defaultToolRegistry = new ToolRegistry();
