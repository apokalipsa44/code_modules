import type { CodeNode, GraphIndex, LockPolicy } from '../model';

export interface LockDecision {
  allowed: boolean;
  reason: string;
}

const ALLOW: LockDecision = { allowed: true, reason: '' };

/**
 * Lock engine — the single source of truth for "may this code change?".
 * Rules:
 *  - a node explicitly locked (by user or default policy) is immutable;
 *  - every descendant of a locked node (shared file, symbolPath prefixed) is
 *    effectively locked too — replacing an ancestor would destroy locked code;
 *  - a replacement of an unlocked node is rejected if the replacement would
 *    remove or alter any locked descendant (see `checkReplacement`).
 */
export class LockEngine {
  private index!: GraphIndex;

  attach(index: GraphIndex): void {
    this.index = index;
  }

  lockPolicy(): LockPolicy {
    return this.index?.lockPolicy ?? { defaultLockedTags: ['auth', 'payments'] };
  }

  byId(id: string): CodeNode | undefined {
    return this.index.nodes[id];
  }

  /** Is this node readable-only for the agent? (self locked or inside locked ancestor) */
  effectivelyLocked(node: CodeNode): boolean {
    if (node.locked) return true;
    return Boolean(this.lockedAncestorOf(node));
  }

  lockedAncestorOf(node: CodeNode): CodeNode | undefined {
    for (const other of Object.values(this.index.nodes)) {
      if (!other.locked || other.file !== node.file) continue;
      if (other.symbolPath === node.symbolPath) continue;
      if (node.symbolPath.startsWith(other.symbolPath + '.')) return other;
    }
    return undefined;
  }

  canEdit(nodeId: string): LockDecision {
    const node = this.byId(nodeId);
    if (!node) return { allowed: false, reason: `unknown node ${nodeId}` };
    if (node.locked) {
      return {
        allowed: false,
        reason: `LOCKED: ${nodeId} (${node.lockReason || 'locked'}). Ask the user to unlock it; you may not modify it.`,
      };
    }
    const ancestor = this.lockedAncestorOf(node);
    if (ancestor) {
      return {
        allowed: false,
        reason: `LOCKED: ${nodeId} is inside locked ${ancestor.id}. You may not modify it.`,
      };
    }
    return ALLOW;
  }

  /**
   * Replacement-focused check: would `newBody` (the full new source of nodeId)
   * remove or modify any locked descendant inside the node?
   */
  checkReplacement(nodeId: string, newBody: string): LockDecision {
    const base = this.canEdit(nodeId);
    if (!base.allowed) return base;
    const node = this.byId(nodeId)!;
    const lockedDescendants = Object.values(this.index.nodes).filter(
      (n) =>
        n.locked &&
        n.file === node.file &&
        n.symbolPath.startsWith(node.symbolPath + '.')
    );
    for (const d of lockedDescendants) {
      const localName = d.symbolPath.slice(node.symbolPath.length + 1).split('.')[0]!;
      const stillThere =
        new RegExp(`(^|[\\s{,(])${escapeRegExp(localName)}\\b`).test(newBody) ||
        newBody.includes(localName);
      const stillLockedShape = d.kind === 'method' || d.kind === 'function';
      if (!stillThere) {
        return {
          allowed: false,
          reason: `LOCKED: replacing ${nodeId} would remove locked ${d.id}.`,
        };
      }
      if (!stillLockedShape) continue;
    }
    return ALLOW;
  }

  /** Can new code be inserted at `line` of `file` without touching locked ranges? */
  canInsertAtLine(file: string, line: number): LockDecision {
    const locked = Object.values(this.index.nodes).filter(
      (n) => n.locked && n.file === file
    );
    for (const n of locked) {
      if (line >= n.range.startLine && line <= n.range.endLine) {
        return { allowed: false, reason: `LOCKED: line ${line} is inside locked node ${n.id}.` };
      }
    }
    return ALLOW;
  }

  /** Apply default lock policy to a fresh node (mutates). */
  applyDefault(node: CodeNode): void {
    applyDefaultLocks(node, this.lockPolicy());
  }

  setLocked(nodeId: string, locked: boolean, reason = 'manual'): void {
    const n = this.byId(nodeId);
    if (!n) throw new Error(`code_modules: unknown node ${nodeId}`);
    n.locked = locked;
    n.lockReason = locked ? reason : '';
  }

  toggleLock(nodeId: string, reason = 'manual'): boolean {
    const n = this.byId(nodeId);
    if (!n) throw new Error(`code_modules: unknown node ${nodeId}`);
    n.locked = !n.locked;
    n.lockReason = n.locked ? reason : '';
    return n.locked;
  }
}

export function applyDefaultLocks(node: CodeNode, policy: LockPolicy): void {
  if (node.locked) return;
  const hit = policy.defaultLockedTags.find((t) => node.tags.includes(t));
  if (hit) {
    node.locked = true;
    node.lockReason = `default policy: ${hit}`;
  }
}

export function proposePolicy(tags: Iterable<string>): string[] {
  const defaultSensitive = ['auth', 'payments', 'secrets', 'crypto', 'session', 'security'];
  return [...tags].filter((t) => defaultSensitive.includes(t));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
