import type { Contract } from '../model';
import type { MetaProvider } from '../meta/generate';
import type { ProviderToolCall, ConversationState, ModelProvider, ProviderTurn } from './provider';
import { TOOL_NAMES } from './tools';

/**
 * LM Studio (and any OpenAI-compatible server) provider.
 *
 * Pattern borrowed from the sibling project `btfa`:
 *  - inference goes through the OpenAI-compatible endpoint: DO NOT forget `/v1`
 *    in the base URL (the client appends only `/chat/completions`);
 *  - the API key is a placeholder — LM Studio ignores it;
 *  - model selection is dynamic: list models from the native REST API
 *    (`GET {host}/api/v1/models`, no `/v1` suffix) and pick a loaded one;
 *  - generous timeouts: loading a large model into VRAM can take tens of
 *    seconds and a short read timeout misreports a slow load as unreachable.
 * No streaming (the agent loop needs full turns), temperature low (0.2).
 */

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the OpenAI function-calling `parameters` field. */
  parameters: Record<string, unknown>;
};

const strProp = (k: string) => ({ [k]: { type: 'string' } });

export const TOOL_SPECS: Record<string, ToolSpec> = {
  search_nodes: {
    name: 'search_nodes',
    description: 'Search code nodes by symbol/tag/summary. Returns ids with summaries.',
    parameters: { type: 'object', properties: strProp('query'), required: ['query'] },
  },
  read_node: {
    name: 'read_node',
    description: 'Read one node: full source for unlocked nodes, contract only for locked ones.',
    parameters: { type: 'object', properties: strProp('id'), required: ['id'] },
  },
  edit_node: {
    name: 'edit_node',
    description: 'Replace the full contents of one unlocked node. Rejected for locked nodes.',
    parameters: {
      type: 'object',
      properties: { ...strProp('id'), newContent: { type: 'string' } },
      required: ['id', 'newContent'],
    },
  },
  create_node: {
    name: 'create_node',
    description: 'Insert new code at a file line; rejected inside locked ranges.',
    parameters: {
      type: 'object',
      properties: { file: { type: 'string' }, line: { type: 'number' }, content: { type: 'string' } },
      required: ['file', 'line', 'content'],
    },
  },
  list_dependencies: {
    name: 'list_dependencies',
    description: 'List nodes this node depends on.',
    parameters: { type: 'object', properties: strProp('id'), required: ['id'] },
  },
  list_dependents: {
    name: 'list_dependents',
    description: 'List nodes depending on this node.',
    parameters: { type: 'object', properties: strProp('id'), required: ['id'] },
  },
  run_checks: {
    name: 'run_checks',
    description: 'Run configured typecheck/tests (read-only).',
    parameters: { type: 'object', properties: {} },
  },
};

/** ToolSpecs for the full TOOL_NAMES list (single source for all agent adapters). */
export function toolSpecs(names?: readonly string[]): ToolSpec[] {
  const list = names ?? TOOL_NAMES;
  return list.map(
    (n) => TOOL_SPECS[n] ?? { name: n, description: n, parameters: { type: 'object', properties: {} } }
  );
}

export interface OpenAiCompatConfig {
  /** OpenAI-compatible base URL, MUST end in `/v1` (e.g. http://localhost:1234/v1). */
  baseUrl: string;
  /** Model id as served by the server. Empty ⇒ resolved via listLmStudioModels(). */
  model: string;
  /** Placeholder by default (“lm-studio”); LM Studio ignores it. */
  apiKey?: string;
  /** Agent system prompt incl. subgraph context (built by the host). */
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** OpenAI wire types (thin — avoids adding a client dependency to core). */
interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}
interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface WireResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: WireToolCall[] } }>;
}

export class OpenAiCompatProvider implements ModelProvider {
  readonly name = 'openai-compat';
  private fetchImpl: typeof fetch;

  constructor(
    public config: OpenAiCompatConfig
  ) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** ConversationState → OpenAI messages. Tool results are replayed as synthetic
   *  assistant.tool_calls + tool pairs, so strict OpenAI ordering always holds. */
  toMessages(state: ConversationState): WireMessage[] {
    const messages: WireMessage[] = [];
    if (this.config.systemPrompt) messages.push({ role: 'system', content: this.config.systemPrompt });
    for (const t of state) {
      if (t.role === 'user') messages.push({ role: 'user', content: t.text });
      else if (t.role === 'assistant') messages.push({ role: 'assistant', content: t.text });
      else if (t.role === 'toolResult') {
        const call: WireToolCall = {
          id: t.callId,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.args ?? {}) },
        };
        messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        messages.push({ role: 'tool', tool_call_id: t.callId, content: JSON.stringify({ ok: t.ok, summary: t.summary, payload: t.payload }) });
      }
    }
    return messages;
  }

  fromWire(message: NonNullable<WireResponse['choices']>[number]['message']): ProviderTurn {
    const content = message?.content ?? '';
    const calls = message?.tool_calls ?? [];
    const toolCalls: ProviderToolCall[] = calls
      .filter((c) => c && c.function?.name)
      .map((c) => {
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = c.function.arguments ? JSON.parse(c.function.arguments) : {};
          if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
        } catch {
          args = { _rawArguments: c.function.arguments };
        }
        return { id: c.id || `call_${c.function.name}_${String(c.function.arguments).length}`, name: c.function.name, args };
      });
    if (toolCalls.length > 0) {
      return { toolCalls, reply: content || undefined, done: false };
    }
    return { done: true, reply: content };
  }

  async nextTurn(state: ConversationState): Promise<ProviderTurn> {
    const model = this.config.model || (await defaultOpenAiCompatModel(this.config.baseUrl, this.fetchImpl) ?? 'local-model');
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model,
      temperature: this.config.temperature ?? 0.2,
      max_tokens: this.config.maxTokens ?? 4096,
      messages: this.toMessages(state),
      tools: toolSpecs().map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      stream: false,
    };
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey || 'lm-studio'}`,
      },
      body: JSON.stringify(body),
      // AbortSignal.timeout exists in Node ≥18; kept for read-timeout parity with btfa.
      signal: globalThis.AbortSignal ? AbortSignal.timeout(this.config.timeoutMs ?? 120_000) : undefined,
    } as RequestInit);
    if (!res.ok) {
      throw new Error(`LM Studio/OpenAI-compat server returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as WireResponse;
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error('LM Studio/OpenAI-compat: empty completion response');
    return this.fromWire(message);
  }
}

/** Chat turn without tools — used for /init summarization. */
export async function openAiChatText(
  config: OpenAiCompatConfig,
  system: string,
  user: string,
  overrideModel?: string
): Promise<string> {
  const doFetch = config.fetchImpl ?? fetch;
  const model = overrideModel ?? config.model;
  if (!model) throw new Error('code_modules: no LM Studio model selected');
  const res = await doFetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey || 'lm-studio'}` },
    body: JSON.stringify({
      model,
      temperature: config.temperature ?? 0.2,
      max_tokens: config.maxTokens ?? 2048,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
    }),
    signal: globalThis.AbortSignal ? AbortSignal.timeout(config.timeoutMs ?? 120_000) : undefined,
  } as RequestInit);
  if (!res.ok) throw new Error(`LM Studio/OpenAI-compat server returned HTTP ${res.status}`);
  const data = (await res.json()) as WireResponse;
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}

// ---- model discovery (native LM Studio REST API, like btfa) --------------------

export interface LmStudioModelEntry {
  id: string;
  type?: string;
  loaded?: boolean;
}

interface NativeModelEntry {
  id?: string;
  type?: string;
  loaded_instances?: unknown[];
}

/** Lists models via GET {nativeBase}/api/v1/models; falls back to the
 *  OpenAI-compat {v1Base}/models when the native API is absent. */
export async function listLmStudioModels(baseUrl: string, timeoutMs = 10_000, fetchImpl: typeof fetch = fetch): Promise<LmStudioModelEntry[]> {
  const root = baseUrl.replace(/\/+$/, '');
  // /v1 suffix only applies to the OpenAI-compat surface; native API sits one level up.
  const nativeBase = root.endsWith('/v1') ? root.slice(0, -3) : root;
  const candidates = [`${nativeBase}/api/v1/models`, `${root}/models`];
  for (const url of candidates) {
    try {
      const res = await fetchImpl(url, { signal: globalThis.AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined } as RequestInit);
      if (!res.ok) continue;
      const data = (await res.json()) as { data?: NativeModelEntry[] };
      const entries = data.data ?? [];
      const mapped: LmStudioModelEntry[] = entries.map((m) => ({
        id: String(m.id ?? ''),
        type: m.type,
        loaded: Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0,
      }));
      if (mapped.some((m) => m.id)) return mapped;
    } catch {
      /* try the next surface */
    }
  }
  throw new Error(`code_modules: LM Studio unreachable at ${root} — is the server running?`);
}

/** Picks the best model: first loaded llm, then first llm, then first entry. */
export function pickLmStudioModel(models: LmStudioModelEntry[]): string | null {
  const llm = models.filter((m) => m.type === 'llm' || m.type === undefined);
  return llm.find((m) => m.loaded)?.id ?? llm[0]?.id ?? models[0]?.id ?? null;
}

/** Empty model setting ⇒ resolve automatically (btfa's "never hardcode" rule). */
export async function defaultOpenAiCompatModel(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const models = await listLmStudioModels(baseUrl, 10_000, fetchImpl);
  return pickLmStudioModel(models);
}

// ---- /init metadata summarization ---------------------------------------------

const REQUESTED_SUMMARY = `You summarize one code node for a code graph. Reply with ONLY a JSON object (no markdown):
{"userSummary": "one-line plain summary", "agentSummary": {"inputs": "...", "outputs": "...", "invariants": ["..."], "sideEffects": ["..."]}, "tags": ["kebab-tags"]}`;

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/** MetaProvider over an OpenAI-compatible endpoint; falls back to the heuristic
 *  provider when the server is unreachable or returns non-JSON. */
export function lmStudioMetaProvider(config: OpenAiCompatConfig): MetaProvider {
  return {
    name: 'lmstudio-meta',
    async summarize(node, context) {
      const { heuristicMetaProvider } = await import('../meta/generate.js');
      const fallback = heuristicMetaProvider();
      try {
        const ctxLines = context.length ? `\nContext (already summarized):\n${context.map((c) => `- ${c.id}: ${c.summary}`).join('\n')}` : '';
        const user =
          `node: ${node.id}\nkind: ${node.kind}\nfile: ${node.file}\nsignature: ${node.signature}\nsource:\n${node.source}${ctxLines}`;
        const raw = await openAiChatText(config, REQUESTED_SUMMARY, user);
        const parsed: {
          userSummary?: string;
          agentSummary?: { inputs?: string; outputs?: string; invariants?: string[]; sideEffects?: string[] };
          tags?: string[];
        } = JSON.parse(stripFences(raw));
        if (!parsed.userSummary) return fallback.summarize(node, context);
        return {
          userSummary: parsed.userSummary,
          agentSummary: {
            inputs: parsed.agentSummary?.inputs ?? '',
            outputs: parsed.agentSummary?.outputs ?? '',
            invariants: parsed.agentSummary?.invariants ?? [],
            sideEffects: parsed.agentSummary?.sideEffects ?? [],
          },
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
        };
      } catch {
        return fallback.summarize(node, context);
      }
    },
  };
}

export type { Contract };
