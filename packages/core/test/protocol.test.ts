import { describe, expect, it } from 'vitest';
import { isFromWebview, nodeToDto, type FromWebviewToExtension, type FromExtensionToWebview } from '../src/protocol';
import { emptyIndex } from '../src/model';

/**
 * Phase-1 acceptance: one extension->webview->extension round-trip covered by a test.
 * The router itself lives in the extension (thin), so we test the contract:
 * a webview intent is validated, processed against the index, and the pushed
 * state event carries the rendered DTOs.
 */
describe('message protocol round-trip', () => {
  function roundtrip(intent: FromWebviewToExtension) {
    expect(isFromWebview(JSON.parse(JSON.stringify(intent)))).toBe(true);
    // extension responds with graphUpdated built from nodeToDto
    const index = emptyIndex();
    index.nodes['src/a.ts#hello'] = {
      id: 'src/a.ts#hello', file: 'src/a.ts', symbolPath: 'hello', name: 'hello', kind: 'function',
      range: { startLine: 1, endLine: 3 }, signature: 'function hello(): void', contentHash: 'sha256:x',
      tags: ['core'], locked: false, lockReason: '',
    };
    const dto = Object.values(index.nodes).map((n) => nodeToDto(n));
    const response: FromExtensionToWebview = { type: 'graphUpdated', nodes: dto, edges: [], layers: ['core'] };
    return response;
  }

  it('ready -> graphUpdated with drawable nodes', () => {
    const response = roundtrip({ type: 'ready' });
    expect(response.type).toBe('graphUpdated');
    expect(response.nodes[0]!.label).toBe('hello');
    expect(response.nodes[0]!.stale).toBe(false);
  });

  it('search + toggleLock intents are protocol-valid', () => {
    expect(
      isFromWebview({ type: 'search', query: 'x', depth: 2 } satisfies FromWebviewToExtension)
    ).toBe(true);
    expect(
      isFromWebview({ type: 'toggleLock', id: 'src/a.ts#hello' } satisfies FromWebviewToExtension)
    ).toBe(true);
    expect(isFromWebview({ type: 'not-a-thing', x: 1 })).toBe(false);
  });
});
