import { describe, expect, it } from 'vitest';
import {
  OpenAiCompatProvider,
  listLmStudioModels,
  pickLmStudioModel,
  openAiChatText,
  type OpenAiCompatConfig,
  type WireResponse,
} from '../src/agent/openaiProvider';
import type { Turn } from '../src/agent/provider';

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as Response);

function recordingFetch(responses: unknown[], calls: string[] = []): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return jsonResponse(responses[Math.min(i++, responses.length - 1)]);
  }) as typeof fetch;
}

const cfg = (over: Partial<OpenAiCompatConfig> = {}): OpenAiCompatConfig => ({
  baseUrl: 'http://localhost:1234/v1',
  model: '',
  fetchImpl: recordingFetch([]),
  ...over,
});

describe('OpenAiCompatProvider (LM Studio)', () => {
  it('url always ends in /chat/completions behind a /v1 base', async () => {
    const calls: string[] = [];
    const fetchImpl = recordingFetch([{ choices: [{ message: { content: 'hi' } }] }], calls);
    const p = new OpenAiCompatProvider({ baseUrl: 'http://localhost:1234/v1/', model: 'm', fetchImpl });
    await p.nextTurn([{ role: 'user', text: 'hello' }]);
    expect(calls[0]).toBe('http://localhost:1234/v1/chat/completions');
  });

  it('resolves model automatically when unset', async () => {
    const models = { data: [{ id: 'qwen2.5-7b', type: 'llm', loaded_instances: [{}] }] };
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes('/models')
        ? jsonResponse(models)
        : jsonResponse({ choices: [{ message: { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_nodes', arguments: '{"query":"auth"}' } }] } }] });
    }) as typeof fetch;
    const p = new OpenAiCompatProvider({ baseUrl: 'http://localhost:1234/v1', model: '', fetchImpl });
    const turn = await p.nextTurn([{ role: 'user', text: 'find auth' }]);
    expect(turn.toolCalls?.[0]).toMatchObject({ name: 'search_nodes', args: { query: 'auth' } });
  });

  it('replays tool results as assistant.tool_calls + tool message pairs', () => {
    const p = new OpenAiCompatProvider(cfg({ systemPrompt: 'sys' }));
    const state: Turn[] = [
      { role: 'user', text: 'do it' },
      { role: 'toolResult', callId: 'c9', name: 'read_node', args: { id: 'a#b' }, ok: true, summary: 'src', payload: { x: 1 } },
    ];
    const msgs = p.toMessages(state);
    expect(msgs[0]).toEqual({ role: 'system', content: 'sys' });
    expect(msgs[1].role).toBe('user');
    expect(msgs[2].tool_calls?.[0]).toEqual({ id: 'c9', type: 'function', function: { name: 'read_node', arguments: '{"id":"a#b"}' } });
    expect(msgs[3]).toMatchObject({ role: 'tool', tool_call_id: 'c9' });
  });

  it('final turn without tool calls is done', async () => {
    const fetchImpl = recordingFetch([{ choices: [{ message: { content: 'finished' } }] }]);
    const p = new OpenAiCompatProvider(cfg({ fetchImpl, model: 'm' }));
    const turn = await p.nextTurn([{ role: 'user', text: 'x' }]);
    expect(turn).toEqual({ done: true, reply: 'finished' });
  });

  it('plain tool-call-less reply maps to done=true (agent stops)', async () => {
    const res: WireResponse = { choices: [{ message: { content: 'no tools here' } }] };
    const p = new OpenAiCompatProvider(cfg({ fetchImpl: recordingFetch([res]), model: 'm' }));
    expect((await p.nextTurn([])).done).toBe(true);
  });

  it('surfs HTTP errors with status', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 404, text: () => Promise.resolve('nf') }) as unknown as Response) as typeof fetch;
    const p = new OpenAiCompatProvider(cfg({ fetchImpl, model: 'm' }));
    await expect(p.nextTurn([{ role: 'user', text: 'x' }])).rejects.toThrow(/HTTP 404/);
  });
});

describe('openAiChatText (no tools, used by /init)', () => {
  it('returns trimmed content and requires a model', async () => {
    const fetchImpl = recordingFetch([{ choices: [{ message: { content: '  reply  ' } }] }]);
    expect(await openAiChatText({ baseUrl: 'http://localhost:1234/v1', model: 'm', fetchImpl }, 'sys', 'usr')).toBe('reply');
    await expect(openAiChatText({ baseUrl: 'http://x/v1', model: '', fetchImpl }, 's', 'u')).rejects.toThrow(/no LM Studio model/);
  });
});

describe('LM Studio model discovery', () => {
  it('prefers the native API (no /v1 suffix) over the openai-compat models list', async () => {
    const calls: string[] = [];
    const fetchImpl = recordingFetch(
      [{ data: [{ id: 'llama-3', type: 'llm', loaded_instances: [1] }, { id: 'embed', type: 'embeddings' }] }],
      calls
    );
    const models = await listLmStudioModels('http://localhost:1234/v1', 1000, fetchImpl);
    expect(calls[0]).toBe('http://localhost:1234/api/v1/models');
    expect(models).toHaveLength(2);
    expect(pickLmStudioModel(models)).toBe('llama-3');
  });

  it('falls back to the openai-compat endpoint when the native API is missing', async () => {
    let first = true;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/api/v1/')) {
        first = false;
        return { ok: false, status: 404 } as Response;
      }
      return jsonResponse({ data: [{ id: 'mistral' }] });
    }) as typeof fetch;
    const models = await listLmStudioModels('http://localhost:1234/v1', 1000, fetchImpl);
    expect(first).toBe(false);
    expect(pickLmStudioModel(models)).toBe('mistral');
  });

  it('throws a friendly error when the server is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(listLmStudioModels('http://localhost:1234/v1', 100, fetchImpl)).rejects.toThrow(/unreachable/);
  });

  it('pickLmStudioModel prefers loaded llm, then any llm, then anything', () => {
    const m = (id: string, type?: string, loaded?: boolean) => ({ id, type, loaded });
    expect(pickLmStudioModel([m('e', 'embeddings'), m('l1', 'llm'), m('l2', 'llm', true)])).toBe('l2');
    expect(pickLmStudioModel([m('e', 'embeddings'), m('l1', 'llm')])).toBe('l1');
    expect(pickLmStudioModel([m('e', 'embeddings')])).toBe('e');
    expect(pickLmStudioModel([])).toBeNull();
  });
});
