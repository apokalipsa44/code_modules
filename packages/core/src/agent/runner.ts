import type { ConversationState, ModelProvider, Turn } from './provider';
import { ToolGate, type ToolResult } from './tools';

export interface AgentRunOptions {
  instruction: string;
  roots?: string[];
  maxTurns?: number;
}

export interface AgentRunResult {
  reply: string;
  turns: number;
  toolCalls: number;
  results: Array<{ name: string; ok: boolean; summary: string; rolledBack?: boolean }>;
  blocked: string[];
  appliedEdits: number;
}

/**
 * Core-owned agent loop. The model only decides WHAT to do via tool calls;
 * the ToolGate decides IF it may. The runner appends tool results to the
 * conversation so the model can adapt, up to maxTurns.
 */
export class AgentRunner {
  constructor(
    private provider: ModelProvider,
    private gate: ToolGate
  ) {}

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const turns: Turn[] = [{ role: 'user', text: options.instruction }];
    const maxTurns = options.maxTurns ?? 12;
    let reply = '';
    let toolCalls = 0;
    const results: AgentRunResult['results'] = [];
    const blocked: string[] = [];
    let appliedEdits = 0;

    for (let i = 0; i < maxTurns; i++) {
      const state: ConversationState = turns;
      const turn = await this.provider.nextTurn(state);
      if (turn.reply) {
        reply = turn.reply;
        turns.push({ role: 'assistant', text: turn.reply });
      }
      if (!turn.toolCalls || turn.toolCalls.length === 0 || turn.done) {
        if (turn.done || !turn.toolCalls) break;
      }
      for (const call of turn.toolCalls ?? []) {
        toolCalls++;
        let result: ToolResult;
        try {
          result = await this.gate.execute(call.name, call.args ?? {});
        } catch (err) {
          result = {
            ok: false,
            summary: `tool "${call.name}" failed: ${String(err)}`,
            payload: null,
          };
        }
        results.push({ name: call.name, ok: result.ok, summary: result.summary, rolledBack: result.rolledBack });
        if (!result.ok && result.blockedReason) blocked.push(result.blockedReason);
        if (result.appliedEdit && !result.rolledBack) appliedEdits++;
        turns.push({
          role: 'toolResult',
          callId: call.id,
          name: call.name,
          args: call.args,
          ok: result.ok,
          summary: result.summary,
          payload: result.payload,
        });
      }
      if (turn.done) break;
    }

    return { reply, turns: turns.filter((t) => t.role === 'assistant').length, toolCalls, results, blocked, appliedEdits };
  }
}
