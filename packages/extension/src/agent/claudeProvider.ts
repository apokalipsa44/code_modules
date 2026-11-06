import type { AgentToolContext, ToolGate } from '@nodecode/core';

export interface SdkRunResult {
  reply: string;
  toolCalls: number;
  blocked: string[];
}

export interface SdkAgent {
  name: string;
}

/**
 * Claude Agent SDK adapter (real implementation, loaded lazily).
 *
 * The SDK is given ONLY our MCP tool server ("nodecode") whose tools delegate to
 * the core ToolGate — raw file-write / bash tools are never registered. An
 * additional permission gate (`canUseTool`) is the final pass: it denies every
 * tool not on the allowlist, so even model-hallucinated tools cannot touch files.
 */
interface MagicModule {
  query(opts: {
    prompt: string;
    options?: {
      cwd?: string;
      model?: string;
      apiKey?: string;
      permissionMode?: string;
      systemPrompt?: string | { type: string; preset?: string };
      allowedTools?: string[];
      mcpServers?: Record<string, unknown>;
      canUseTool?: (toolName: string, input: unknown) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string }>;
      settingSources?: string[];
      includePartialMessages?: boolean;
      stderr?: (data: string) => void;
      hooks?: Record<string, unknown>;
    };
  }): AsyncIterable<SdkEvent>; // NOTE: query() returns an AsyncGenerator; documentation may wrap it
}

interface SdkEvent {
  type: string;
  subtype?: string;
  tool?: { name?: string; input?: unknown };
  result?: string;
  data?: { text?: string; message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } };
  text?: string;
}

export async function tryLoadSdk(): Promise<MagicModule | null> {
  try {
    // esbuild-external; resolved at runtime from node_modules
    return (await import('@anthropic-ai/claude-agent-sdk')) as MagicModule;
  } catch {
    return null;
  }
}

export async function sdkAgentRun(
  sdk: MagicModule,
  apiKey: string,
  instruction: string,
  ctx: AgentToolContext,
  gate: ToolGate,
  opts: { systemPrompt: string; model?: string; cwd?: string }
): Promise<SdkRunResult> {
  const { createSdkMcpServer, tool } = (sdk as unknown as {
    createSdkMcpServer?: (o: { name: string; version: string; tools: unknown[] }) => unknown;
    tool?: (opts: { name: string; description: string; inputSchema: unknown; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> }) => unknown;
  });

  if (!createSdkMcpServer || !tool) {
    throw new Error('NodeCode: Claude Agent SDK version lacks createSdkMcpServer/tool API');
  }

  const mcpServer = createSdkMcpServer({
    name: 'nodecode',
    version: '0.1.0',
    tools: gate.names().map((name) =>
      tool!({
        name,
        description: nodecodeToolDescriptions[name] ?? name,
        inputSchema: nodecodeSchemaFor(name),
        handler: async (args: Record<string, unknown>) => {
          // re-check happens inside the gate; this is the ONLY tool surface
          try {
            const res = await gate.execute(name, args ?? {});
            return { content: [{ type: 'text', text: JSON.stringify({ ok: res.ok, summary: res.summary, payload: res.payload }, null, 0) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: JSON.stringify({ ok: false, summary: String(err) }) }] };
          }
        },
      })
    ),
  });

  const used = new Set<string>();
  const blocked: string[] = [];
  let reply = '';

  for await (const event of sdk.query({
    prompt: instruction,
    options: {
      cwd: opts.cwd,
      model: opts.model,
      apiKey,
      allowedTools: [...gate.names()].map((n) => `mcp__nodecode__${n}`),
      permissionMode: 'default',
      mcpServers: { nodecode: mcpServer },
      systemPrompt: opts.systemPrompt,
      canUseTool: async (toolName /* final gate */) => {
        const base = toolName.startsWith('mcp__nodecode__') ? toolName.replace('mcp__nodecode__', '') : toolName;
        used.add(base);
        if (!(gate.names() as readonly string[]).includes(base)) {
          blocked.push(toolName);
          return { behavior: 'deny' as const, message: `NodeCode: tool ${toolName} is not allowed. Only ${gate.names().join(', ')} exist.` };
        }
        return { behavior: 'allow' as const };
      },
      settingSources: [],
    },
  })) {
    if (event.type === 'assistant') {
      const content = event.data?.message?.content ?? [];
      for (const c of content) {
        if (c.type === 'text' && c.text) reply += c.text + '\n';
        if (c.type === 'tool_use' && c.name) used.add(String(c.name).replace('mcp__nodecode__', ''));
      }
    } else if (event.type === 'result') {
      reply = event.result || reply;
    }
  }

  return { reply: reply.trim(), toolCalls: used.size, blocked };
}

const nodecodeToolDescriptions: Record<string, string> = {
  search_nodes: 'Search code nodes by symbol/tag/summary. Returns ids with summaries.',
  read_node: 'Read one node: full source for unlocked nodes, contract only for locked ones.',
  edit_node: 'Replace the full contents of one unlocked node. Rejected for locked nodes.',
  create_node: 'Insert new code at a file line; rejected inside locked ranges.',
  list_dependencies: 'List nodes this node depends on.',
  list_dependents: 'List nodes depending on this node.',
  run_checks: 'Run configured typecheck/tests (read-only).',
};

function nodecodeSchemaFor(name: string): unknown {
  const str = (k: string, required = true) => ({ [k]: { type: 'string', required } });
  switch (name) {
    case 'search_nodes':
      return { type: 'object', properties: str('query') };
    case 'read_node':
    case 'edit_node':
    case 'list_dependencies':
    case 'list_dependents':
      return name === 'edit_node'
        ? { type: 'object', properties: { ...str('id'), newContent: { type: 'string', required: true } } }
        : { type: 'object', properties: str('id') };
    case 'create_node':
      return {
        type: 'object',
        properties: { file: { type: 'string', required: true }, line: { type: 'number', required: true }, content: { type: 'string', required: true } },
      };
    default:
      return { type: 'object', properties: {} };
  }
}
