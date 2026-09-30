export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';
export interface ConversationTurn {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: any;
    /**
     * Opaque provider state that must be echoed back on later turns.
     * Gemini 3.x rejects a request whose functionCall parts lost their
     * thought_signature; Anthropic has an analogous notion for thinking blocks.
     * Kept as an untyped bag so core types stay provider-neutral.
     */
    providerMetadata?: Record<string, any>;
  }>;
  toolCallId?: string;
  toolName?: string;
  toolResult?: any;
  /**
   * Opaque provider state for the turn as a whole (e.g. an assistant turn's
   * original content blocks). Thinking blocks must be replayed unchanged on the
   * same model, and cannot be reconstructed from the extracted text.
   */
  providerMetadata?: Record<string, any>;
}
export enum RiskLevel {
  READ = 'READ',
  WRITE = 'WRITE',
  EXTERNAL_ACTION = 'EXTERNAL_ACTION',
  DESTRUCTIVE = 'DESTRUCTIVE',
}
export interface ToolSchema {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
}
/**
 * Supply-chain provenance, orthogonal to RiskLevel.
 * RiskLevel answers "what damage can this do?"; ToolTrust answers "who wrote it
 * and has it been reviewed?". An external MCP server may offer a READ tool that
 * is still untrusted.
 */
export enum ToolTrust {
  TRUSTED_CORE = 'TRUSTED_CORE',
  REVIEWED = 'REVIEWED',
  EXPERIMENTAL = 'EXPERIMENTAL',
  UNTRUSTED = 'UNTRUSTED',
}
export interface Tool {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  /** Defaults to UNTRUSTED when absent, so provenance must be stated explicitly. */
  trust?: ToolTrust;
  /**
   * Only ever honoured for READ tools. The orchestrator requires approval for
   * WRITE / EXTERNAL_ACTION / DESTRUCTIVE regardless of this flag.
   */
  skipApproval?: boolean;
  schema: ToolSchema;
  /**
   * One or two sentences saying what this call will actually do.
   *
   * For the approval dialog, which had been rendering the arguments — first as
   * JSON and then as a labelled list, and both are transcriptions. Someone
   * deciding whether to allow a thing wants to be told what the thing is, not
   * handed its parameters to work it out from.
   *
   * Written here because the tool is the only thing that knows what its own
   * arguments mean. A generic renderer can only reformat them, and asking a
   * model to summarise would put a paraphrase, and a delay, between a person
   * and a decision they are being asked to make.
   */
  summarise?(args: any): string;
  /** `signal` aborts when the tool's time budget or the run deadline expires. */
  execute(args: any, signal?: AbortSignal): Promise<any>;
}
export interface PendingApproval {
  id: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, any>;
  riskLevel: RiskLevel;
  description: string;
  /** What this particular call does, in a sentence, when the tool can say. */
  summary?: string;
  /** 人に聞く問い（`approval_text.ts`）。画面の見出し。 */
  heading?: string;
  /** 判断に要る事実を人の言葉で。 */
  facts?: Array<{ label: string; value: string }>;
  createdAt: string;
}
export interface OrchestratorResponse {
  status: 'completed' | 'requires_approval';
  reply?: string;
  executedTools?: Array<{ name: string; args: any; result: any }>;
  pendingApproval?: PendingApproval;
  /** Per-execution identity. Not durable thread identity. */
  sessionId: string;
  /** Durable thread identity, when the run is attached to a conversation. */
  conversationId?: string | null;
}
