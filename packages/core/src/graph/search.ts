import type { CodeNode, GraphIndex } from '../model';

export interface ScoredNode {
  node: CodeNode;
  score: number;
  matchedBy: string;
}

/**
 * Rank nodes for a query: symbol-name matches beat tag matches beat summary matches.
 * Empty query yields an empty result (caller should show recent/overview instead).
 */
export function searchNodes(index: GraphIndex, query: string, limit = 20): ScoredNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const scored: ScoredNode[] = [];

  for (const node of Object.values(index.nodes)) {
    const sym = node.symbolPath.toLowerCase();
    const fileTok = node.file.toLowerCase();
    const tags = node.tags.map((t) => t.toLowerCase());
    const summary = (node.meta?.userSummary ?? '').toLowerCase();
    let score = 0;
    let matchedBy = '';

    for (const term of terms) {
      let tier = 0;
      if (sym === term) tier = 100;
      else if (camelWords(node.symbolPath).includes(term)) tier = 70;
      else if (sym.endsWith('.' + term)) tier = 80;
      else if (sym.includes(term)) tier = 50;
      else if (isSubsequence(term, sym)) tier = 8;
      if (tier > 0) {
        score += tier;
        matchedBy ||= 'symbol';
      }
      // supporting signals stack on top of the symbol tier
      if (tags.includes(term)) {
        score += 40;
        matchedBy ||= 'tag';
      } else if (tags.some((t) => t.includes(term))) {
        score += 20;
        matchedBy ||= 'tag';
      }
      if (fileTok.includes(term)) {
        score += 15;
        matchedBy ||= 'file';
      }
      if (summary.includes(term)) {
        score += 10;
        matchedBy ||= 'summary';
      }
    }

    if (score > 0) scored.push({ node, score, matchedBy: matchedBy || 'fuzzy' });
  }

  scored.sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id));
  return scored.slice(0, limit);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

/** 'UserSettingsScreen' / 'user_settings_screen' / 'user.settings' -> ['user','settings','screen'] */
function camelWords(sym: string): string[] {
  return sym
    .split(/[._/#-]/)
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}
