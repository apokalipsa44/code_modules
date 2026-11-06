import type { Contract } from '../model';

export type ProviderToolCall = { id: string; name: string; args: Record<string, unknown> };

export interface ProviderTurn {
  toolCalls?: ProviderToolCall[];
  reply?: string;
  done?: boolean;
}

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'toolResult'; callId: string; name: string; ok: boolean; summary: string; payload: unknown };

/** Agent-visible conversation state (simplified, provider-agnostic). */
export type ConversationState = readonly Turn[];

export interface AgentRequest {
  instruction: string;
  /** Root nodes selected by the user (subgraph context). */
  roots?: string[];
}

/**
 * The model behind the code_modules agent. Implementations:
 *  - ClaudeAgentProvider (extension, Claude Agent SDK),
 *  - MockProvider / ScriptedProvider (tests, offline).
 * The provider is *stateless between calls*: the core AgentRunner owns the
 * tool loop, so lock enforcement can never be bypassed by model-chosen tools.
 */
export interface ModelProvider {
  readonly name: string;
  nextTurn(state: ConversationState): Promise<ProviderTurn>;
}

/** Mock provider: ask what to do, get deterministic replies. Used in tests and as an API-keyless default. */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';

  constructor(
    /** Produces each turn from the conversation so far. */
    private responder: (state: ConversationState) => Promise<ProviderTurn> | ProviderTurn
  ) {}

  async nextTurn(state: ConversationState): Promise<ProviderTurn> {
    return this.responder(state);
  }
}

/** Scripted provider: emits a fixed list of calls (ignores the conversation). */
export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted';
  private index = 0;

  constructor(private steps: ProviderTurn[]) {}

  async nextTurn(_state: ConversationState): Promise<ProviderTurn> {
    const step = this.steps[this.index];
    this.index++;
    return step ?? { done: true, reply: 'done (script exhausted)' };
  }
}

export type { Contract };
