import { buildContract } from '../locks/contract';
import type { LockDecision } from '../locks/engine';
import { LockEngine } from '../locks/engine';
import { neighbors, transitive } from '../graph/order';
import { searchNodes as rankNodes } from '../graph/search';
import { hashOf } from '../hashing';
import type { EditApplier, SourceEdit } from '../edit/apply';
import type { ContractView, GraphIndex } from '../model';

export interface AgentToolContext {
  index: GraphIndex;
  locks: LockEngine;
  /** Current workspace file contents. */
  readFile(file: string): Promise<string> | string;
  /** Persistent edit path (WorkspaceEdit in the extension). */
  applier: EditApplier;
  /** Optional: typecheck/test runner for run_checks and the breakage guard. */
  runChecks?(): Promise<ChecksResult>;
  /** Recompute dependencies of a file after an edit (LSP-backed in extension). */
  refreshAfterEdit?(file: string): Promise<void>;
}

export interface ChecksResult {
  ok: boolean;
  summary: string;
  diagnostics: Array<{ file: string; message: string; line?: number; severity?: string }>;
}

export const TOOL_NAMES = [
  'search_nodes',
  'read_node',
  'edit_node',
  'create_node',
  'list_dependencies',
  'list_dependents',
  'run_checks',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolResult {
  ok: boolean;
  summary: string;
  payload: unknown;
  /** Edit that was applied (for diff review / rollback bookkeeping). */
  appliedEdit?: SourceEdit;
  rolledBack?: boolean;
  blockedReason?: string;
  staleWarnings?: string[];
}

/**
 * The tool layer. This is the ONLY way the agent touches the repo:
 * no raw filesystem, no bash, no generic edit tools exist behind this gate,
 * and every handler re-checks locks (never trust the prompt).
 */
export class ToolGate {
  constructor(private ctx: AgentToolContext) {}

  get index(): GraphIndex {
    return this.ctx.index;
  }

  names(): readonly ToolName[] {
    return TOOL_NAMES;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'search_nodes':
        return this.searchNodes(stringArg(args, 'query'));
      case 'read_node':
        return this.readNode(stringArg(args, 'id'));
      case 'edit_node':
        return this.editNode(stringArg(args, 'id'), stringArg(args, 'newContent'));
      case 'create_node':
        return this.createNode(
          stringArg(args, 'file'),
          numberArg(args, 'line'),
          stringArg(args, 'content')
        );
      case 'list_dependencies':
        return this.listNeighbors(stringArg(args, 'id'), 'deps');
      case 'list_dependents':
        return this.listNeighbors(stringArg(args, 'id'), 'dependents');
      case 'run_checks':
        return this.runChecks();
      default:
        return {
          ok: false,
          summary: `unknown tool "${name}". Available: ${TOOL_NAMES.join(', ')}`,
          payload: null,
        };
    }
  }

  private async searchNodes(query: string): Promise<ToolResult> {
    const hits = rankNodes(this.ctx.index, query, 15);
    return {
      ok: true,
      summary: `${hits.length} node(s) matching "${query}"`,
      payload: hits.map((h) => ({
        id: h.node.id,
        symbolPath: h.node.symbolPath,
        file: h.node.file,
        kind: h.node.kind,
        tags: h.node.tags,
        summary: h.node.meta?.userSummary ?? '',
        locked: this.ctx.locks.effectivelyLocked(h.node),
      })),
    };
  }

  private async readNode(id: string): Promise<ToolResult> {
    const node = this.ctx.locks.byId(id);
    if (!node) {
      return { ok: false, summary: `unknown node ${id}`, payload: null };
    }
    const locked = this.ctx.locks.effectivelyLocked(node);
    const fileText = await this.ctx.readFile(node.file);
    if (locked) {
      const contract = contractViewOf(this.ctx, id, fileText);
      return {
        ok: true,
        summary: `${id} is LOCKED — read contract only (implementation not exposed)`,
        payload: { id, contract, source: null as string | null },
        staleWarnings: contract.staleWarning ? [contract.staleWarning] : [],
      };
    }
    const lines = fileText.split('\n');
    const content = lines.slice(node.range.startLine - 1, node.range.endLine).join('\n');
    return {
      ok: true,
      summary: `read ${id} (${node.range.startLine}-${node.range.endLine})`,
      payload: {
        id,
        file: node.file,
        range: node.range,
        contract: contractViewOf(this.ctx, id, fileText),
        source: content,
      },
    };
  }

  private async editNode(id: string, newContent: string): Promise<ToolResult> {
    const decision = this.ctx.locks.canEdit(id);
    if (!decision.allowed) {
      return {
        ok: false,
        summary: decision.reason,
        payload: { nodeId: id },
        blockedReason: decision.reason,
      };
    }
    const node = this.ctx.locks.byId(id)!;
    const bodyCheck = this.ctx.locks.checkReplacement(id, newContent);
    if (!bodyCheck.allowed) {
      return {
        ok: false,
        summary: bodyCheck.reason,
        payload: { nodeId: id },
        blockedReason: bodyCheck.reason,
      };
    }
    const fileText = await this.ctx.readFile(node.file);
    const oldContent = fileText
      .split('\n')
      .slice(node.range.startLine - 1, node.range.endLine)
      .join('\n');
    if (oldContent === newContent) {
      return { ok: true, summary: 'no change (content identical)', payload: { unchanged: true } };
    }
    const edit: SourceEdit = {
      file: node.file,
      startLine: node.range.startLine,
      endLine: node.range.endLine,
      newText: newContent,
    };
    const applied = await this.ctx.applier.apply([edit]);
    if (!applied.ok) {
      return { ok: false, summary: `apply failed: ${applied.error}`, payload: null };
    }
    // Indirect breakage guard: re-check dependents, roll back on locked-contract violation.
    const guard = await this.breakageGuard(node.file, edit, oldContent);
    if (guard.violation) {      return {
        ok: false,
        summary: `EDIT ROLLED BACK: ${guard.reason}`,
        payload: { nodeId: id, diagnostics: guard.diagnostics },
        appliedEdit: edit,
        rolledBack: true,
      };
    }
    if (this.ctx.refreshAfterEdit) await this.ctx.refreshAfterEdit(node.file);
    return {
      ok: true,
      summary: `edited ${id} (${hashOf(newContent).slice(0, 16)}…); dependents re-checked${guard.warnings.length ? ': ' + guard.warnings.join('; ') : ''}`,
      payload: { nodeId: id, oldContent, newContent, diagnostics: guard.diagnostics },
      appliedEdit: edit,
      staleWarnings: guard.warnings,
    };
  }

  /**
   * Indirect breakage guard. After edit_node:
   *  1. re-extract dependents; if a locked dependent's contract breaks -> rollback.
   *  2. run configured checks (if any) -> rollback on errors inside locked dependents.
   */
  private async breakageGuard(file: string, edit: SourceEdit, oldContent: string) {
    const warnings: string[] = [];
    const diagnostics: ChecksResult['diagnostics'] = [];
    const editedNodeIds = Object.values(this.ctx.index.nodes)
      .filter((n) => n.file === file)
      .map((n) => n.id);

    let violation = false;
    let reason = '';
    const dependents = transitive(this.ctx.index, editedNodeIds, 'dependents');
    if (this.ctx.runChecks) {
      const checks = await this.ctx.runChecks();
      diagnostics.push(...checks.diagnostics);
      if (!checks.ok) {
        const lockedBroken = [...dependents].some((depId) => {
          const dep = this.ctx.locks.byId(depId);
          return dep && this.ctx.locks.effectivelyLocked(dep);
        });
        if (lockedBroken || checkDiagsHitLocked(checks, this.ctx, [...dependents, ...editedNodeIds])) {
          await this.ctx.applier.apply([
            { file: edit.file, startLine: edit.startLine, endLine: edit.endLine, newText: oldContent },
          ]);
          return {
            violation: true,
            reason: `checks failed for dependent(s) of the edited node: ${checks.summary}`,
            diagnostics: checks.diagnostics,
            warnings,
          };
        }
        warnings.push(`checks report issues in editable dependents: ${checks.summary}`);
      }
    } else {
      warnings.push('no check runner configured; stale-metadata scan only');
      for (const n of Object.values(this.ctx.index.nodes)) {
        if (n.meta && n.meta.metaHash !== n.contentHash && !n.meta.stale) {
          warnings.push(`metadata for ${n.id} is stale`);
        }
      }
    }
    void violation;
    void reason;
    return { violation, reason, diagnostics, warnings };
  }

  private async createNode(file: string, line: number, content: string): Promise<ToolResult> {
    const decision = this.ctx.locks.canInsertAtLine(file, line);
    if (!decision.allowed) {
      return { ok: false, summary: decision.reason, payload: null, blockedReason: decision.reason };
    }
    let text: string;
    try {
      text = await this.ctx.readFile(file);
    } catch {
      return { ok: false, summary: `unknown file ${file}`, payload: null };
    }
    const totalLines = text.split('\n').length;
    const insertLine = Math.max(1, Math.min(line, totalLines));
    // insertion = replace zero lines at insertLine (splices a new line in)
    const zeroEdit: SourceEdit = { file, startLine: insertLine, endLine: insertLine - 1, newText: content };
    const applied = await this.ctx.applier.apply([zeroEdit]);
    if (!applied.ok) {
      return { ok: false, summary: `apply failed: ${applied.error}`, payload: null };
    }
    if (this.ctx.refreshAfterEdit) await this.ctx.refreshAfterEdit(file);
    return {
      ok: true,
      summary: `inserted new code at ${file}:${insertLine}`,
      payload: { file, line: insertLine, content },
      appliedEdit: zeroEdit,
    };
  }

  private listNeighbors(id: string, direction: 'deps' | 'dependents'): ToolResult {
    const node = this.ctx.locks.byId(id);
    if (!node) return { ok: false, summary: `unknown node ${id}`, payload: null };
    const ids = neighbors(this.ctx.index, id, direction);
    const payload = {
      nodeId: id,
      direction: direction === 'deps' ? 'dependencies' : 'dependents',
      items: ids.map((nid) => {
        const n = this.ctx.locks.byId(nid);
        const locked = n ? this.ctx.locks.effectivelyLocked(n) : false;
        return {
          id: nid,
          kind: n?.kind ?? 'unknown',
          tags: n?.tags ?? [],
          locked,
          summary: n?.meta?.userSummary ?? '',
        };
      }),
    };
    return { ok: true, summary: `${payload.items.length} ${payload.direction}`, payload };
  }

  private async runChecks(): Promise<ToolResult> {
    if (!this.ctx.runChecks) {
      return {
        ok: true,
        summary: 'no check runner configured (read-only tool, nothing ran)',
        payload: { configured: false },
      };
    }
    const res = await this.ctx.runChecks();
    return {
      ok: true,
      summary: res.summary,
      payload: res,
    };
  }
}

export function contractViewOf(
  ctx: { locks: LockEngine },
  nodeId: string,
  fileText: string
): ContractView {
  const node = ctx.locks.byId(nodeId);
  const contract = buildContract(node as never, fileText);
  const stale = Boolean(node?.meta && node.meta.metaHash !== node.contentHash);
  return {
    ...contract,
    staleWarning: stale
      ? `metadata for ${nodeId} is STALE (code changed since generation)`
      : undefined,
  };
}

/** Does a failed checks result reference a file that contains a locked dependent? */
function checkDiagsHitLocked(
  res: ChecksResult,
  ctx: AgentToolContext,
  dependents: string[]
): boolean {
  const lockedFiles = new Set(
    dependents
      .map((depId) => ctx.locks.byId(depId))
      .filter((dep) => dep && ctx.locks.effectivelyLocked(dep))
      .map((dep) => dep!.file)
  );
  return res.diagnostics.some((d) => lockedFiles.has(d.file));
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`tool arg "${key}" must be a string`);
  return v;
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number') throw new Error(`tool arg "${key}" must be a number`);
  return v;
}
