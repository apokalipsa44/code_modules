import type { Node as TsNode, Parser } from 'web-tree-sitter';
import { hashOf } from '../hashing';
import type { CodeNode, NodeKind, SourceRange } from '../model';
import { getParser, grammarForFile } from './parser';

/**
 * Result of extracting one file. Contains only derived data:
 * lock/meta/tag state is merged later by the GraphStore so it survives edits.
 */
export interface FileExtraction {
  file: string;
  /** Extracted nodes WITHOUT lock/meta state (those are user data). */
  nodes: Array<Omit<CodeNode, 'locked' | 'lockReason' | 'meta'>>;
  /** Imported module specifiers as written, e.g. "./session". */
  imports: string[];
  /** Map import-local-name -> specifier (for fallback edges). */
  importSymbols: Record<string, string>;
  /** Exported symbol name -> node id. */
  exports: Record<string, string>;
  /** Identifiers referenced inside each node (deduped). */
  refs: Record<string, string[]>;
}

const MAX_SIGNATURE_LENGTH = 240;

/** Null-safe children / namedChildren. */
export function kids(n: TsNode): TsNode[] {
  return n.children.filter((c): c is TsNode => c !== null);
}

export function namedKids(n: TsNode): TsNode[] {
  return n.namedChildren.filter((c): c is TsNode => c !== null);
}

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

function kindForFunction(name: string, filePath: string, bodyText: string): NodeKind {
  const upper = name.toUpperCase();
  const isRouteFile =
    /(^|\/)api(\/|$)/.test(filePath) || /\.(route|controller)\.(ts|tsx|js|jsx)$/.test(filePath);
  if (HTTP_VERBS.includes(upper)) return 'route';
  if (
    isRouteFile &&
    /^(get|post|put|patch|delete|middleware)/.test(name.toLowerCase())
  ) {
    return 'route';
  }
  if (/\.tsx$/.test(filePath) && /<[A-Za-z][^>]*>/.test(bodyText)) return 'component';
  return 'function';
}

function rangeOf(node: TsNode): SourceRange {
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cap(s: string): string {
  if (s.length > MAX_SIGNATURE_LENGTH) return s.slice(0, MAX_SIGNATURE_LENGTH - 3) + '...';
  return s;
}

function bodyNode(n: TsNode): TsNode | null {
  return (
    n.childForFieldName('body') ??
    kids(n).find((c) => c.type === 'statement_block') ??
    null
  );
}

/** Declaration header text, body elided. */
function declarationText(n: TsNode): string {
  const body = bodyNode(n);
  let head = n.text;
  const arrowIdx = n.text.indexOf('=>');
  if (body) {
    head = n.text.slice(0, body.startIndex - n.startIndex);
  } else if (arrowIdx > 0) {
    head = n.text.slice(0, arrowIdx);
  }
  let sig = collapse(head);
  if (sig.endsWith('=')) sig = sig.slice(0, -1).trim();
  if (!sig) sig = collapse(n.text.split('\n')[0] ?? '');
  return cap(sig);
}

interface Extracted {
  symbolPath: string;
  name: string;
  kind: NodeKind;
  tsNode: TsNode;
}

function toNode(e: Extracted, file: string): Omit<CodeNode, 'locked' | 'lockReason' | 'meta'> {
  return {
    id: `${file}#${e.symbolPath}`,
    file,
    symbolPath: e.symbolPath,
    name: e.name,
    kind: e.kind,
    range: rangeOf(e.tsNode),
    signature: declarationText(e.tsNode),
    contentHash: hashOf(e.tsNode.text),
    tags: [],
  };
}

export function nodeIdFor(file: string, symbolPath: string): string {
  return `${file}#${symbolPath}`;
}

const FN_VALUE_TYPES = new Set([
  'arrow_function',
  'function',
  'function_expression',
  'generator_function',
  'generator_function_expression',
]);

export class TsExtractor {
  private parsers = new Map<string, Promise<Parser>>();

  async extract(file: string, text: string): Promise<FileExtraction> {
    const kind = grammarForFile(file);
    let parser = this.parsers.get(kind);
    if (!parser) {
      parser = getParser(kind);
      this.parsers.set(kind, parser);
    }
    const p = await parser;
    const tree = p.parse(text)!;
    const extracted: Extracted[] = [];
    const imports: string[] = [];
    const importSymbols: Record<string, string> = {};

    this.walk(tree.rootNode, '', extracted, imports, importSymbols, file, false);

    const nodes = extracted.map((e) => toNode(e, file));
    const exports: Record<string, string> = {};
    const refs: Record<string, string[]> = {};
    for (const e of extracted) {
      const id = nodeIdFor(file, e.symbolPath);
      refs[id] = collectIdentifiers(e.tsNode);
      if (e.kind !== 'type') exports[e.name] = id;
    }
    return { file, nodes, imports, importSymbols, exports, refs };
  }

  private walk(
    n: TsNode,
    prefix: string,
    out: Extracted[],
    imports: string[],
    importSymbols: Record<string, string>,
    file: string,
    exported: boolean
  ): void {
    switch (n.type) {
      case 'program':
        for (const c of namedKids(n)) this.walk(c, prefix, out, imports, importSymbols, file, false);
        return;
      case 'import_statement': {
        const sourceNode = n.childForFieldName('source');
        const spec = sourceNode ? sourceNode.text.replace(/^['"]|['"]$/g, '') : '';
        if (spec) imports.push(spec);
        const clause = namedKids(n).find((c) => c.type !== 'string');
        if (clause) {
          for (const name of collectImportNames(clause)) importSymbols[name] = spec;
        }
        return;
      }
      case 'export_statement': {
        const isDefault = /(^|\s)default(\s|$)/.test(collapse(n.text).slice(0, 30));
        const inner = namedKids(n).find(
          (c) =>
            c.type !== 'export_clause' &&
            c.type !== 'identifier' &&
            c.type !== 'string' &&
            c.type !== 'attributes' &&
            c.type !== 'decorator'
        );
        if (!inner) {
          // export { x } from './y' / export { x } — record exports
          for (const c of namedKids(n)) {
            if (c.type === 'export_clause') {
              for (const spec of namedKids(c)) {
                const alias = spec.childForFieldName('alias');
                const localName = (alias ?? spec.namedChildren[0] ?? spec).text.replace(/^['"]|['"]$/g, '');
                void localName;
              }
            }
          }
          return;
        }
        if (isDefault && FN_VALUE_TYPES.has(inner.type)) {
          out.push({ symbolPath: joinPath(prefix, 'default'), name: 'default', kind: 'function', tsNode: inner });
          return;
        }
        if (isDefault && (inner.type === 'class_declaration') && !inner.childForFieldName('name')) {
          out.push({ symbolPath: joinPath(prefix, 'default'), name: 'default', kind: 'class', tsNode: inner });
          return;
        }
        // re-walk the inner declaration with exported=true
        this.walk(inner, prefix, out, imports, importSymbols, file, true);
        // also handle `export default` on named functions: handled by function_declaration case below
        return;
      }
      case 'function_declaration':
      case 'generator_function_declaration': {
        const nameNode = n.childForFieldName('name');
        if (!nameNode) {
          for (const c of namedKids(n))
            this.walk(c, prefix, out, imports, importSymbols, file, exported);
          return;
        }
        this.pushNamedFunction(n, nameNode.text, prefix, file, out);
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const declarator of namedKids(n).filter((c) => c.type === 'variable_declarator')) {
          const nameNode = declarator.childForFieldName('name');
          const value = declarator.childForFieldName('value');
          if (!nameNode || !value) {
            // anonymous default: export default = ...
            if (exported && /default/.test(n.parent?.text.slice(0, 40) ?? '')) {
              out.push({ symbolPath: joinPath(prefix, 'default'), name: 'default', kind: 'function', tsNode: declarator });
            }
            continue;
          }
          const name = nameNode.text;
          if (FN_VALUE_TYPES.has(value.type)) {
          const sym = joinPath(prefix, name);
          const e: Extracted = {
            symbolPath: sym,
            name,
            kind: kindForFunction(name, file, value.text),
            tsNode: declarator,
          };
          if (/\.tsx$/.test(file) && hasJsx(value)) e.kind = 'component';
          const routeCand = kindForFunction(name, file, value.text);
          if (routeCand === 'route') e.kind = 'route';
          out.push(e);
          // recurse into nested declarations inside arrow/function values
          const body = bodyNode(value);
          if (body) this.walkInner(body, sym, file, out);
          continue;
          }
          if (value.type === 'class') {
            const className = value.childForFieldName('name')?.text ?? name;
            const classExtract = this.pushNamedFunction(value, className, prefix, file, out, 'class');
            void classExtract;
            continue;
          }
          if (exported && value.type === 'object') {
            this.pushConfigOrRoutes(n, declarator, name, prefix, file, out);
            continue;
          }
          if (exported) {
            out.push({
              symbolPath: joinPath(prefix, name),
              name,
              kind: 'const',
              tsNode: declarator,
            });
          }
        }
        return;
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const nameNode = n.childForFieldName('name');
        if (!nameNode) {
          for (const c of namedKids(n))
            this.walk(c, prefix, out, imports, importSymbols, file, exported);
          return;
        }
        this.pushNamedFunction(n, nameNode.text, prefix, file, out, 'class');
        return;
      }
      case 'method_definition':
      case 'public_field_definition':
      case 'field_definition': {
        if (!prefix) return;
        const nameNode =
          n.childForFieldName('name') ??
          n.childForFieldName('key') ??
          namedKids(n)[0];
        if (!nameNode) return;
        const name = nameNode.text.replace(/['"`]/g, '');
        const value = n.childForFieldName('value');
        if (!value || !FN_VALUE_TYPES.has(value.type)) {
          if (value && value.type === 'statement_block') {
            out.push({ symbolPath: joinPath(prefix, name), name, kind: 'method', tsNode: n });
          }
          return;
        }
        out.push({ symbolPath: joinPath(prefix, name), name, kind: 'method', tsNode: n });
        return;
      }
      case 'type_alias_declaration':
      case 'interface_declaration': {
        const nameNode = n.childForFieldName('name');
        if (!nameNode) return;
        out.push({
          symbolPath: joinPath(prefix, nameNode.text),
          name: nameNode.text,
          kind: 'type',
          tsNode: n,
        });
        return;
      }
      default: {
        for (const c of namedKids(n))
          this.walk(c, prefix, out, imports, importSymbols, file, exported);
      }
    }
  }

  private pushNamedFunction(
    n: TsNode,
    name: string,
    prefix: string,
    file: string,
    out: Extracted[],
    forcedKind?: NodeKind
  ): Extracted {
    const sym = joinPath(prefix, name);
    let kind: NodeKind = forcedKind ?? kindForFunction(name, file, n.text);
    if (!forcedKind && /\.tsx$/.test(file) && hasJsx(n)) kind = 'component';
    const entry: Extracted = { symbolPath: sym, name, kind, tsNode: n };
    out.push(entry);
    // recurse into the body for nested functions/methods
    const body = bodyNode(n);
    if (body) this.walkInner(body, sym, file, out);
    else {
      // arrow value nodes: walk children to find nested declarations
      for (const c of namedKids(n)) {
        void c;
      }
    }
    return entry;
  }

  /** Walk a function body collecting nested named functions and class members. */
  private walkInner(body: TsNode, prefix: string, file: string, out: Extracted[]): void {
    const visit = (n: TsNode): void => {
      switch (n.type) {
        case 'function_declaration':
        case 'generator_function_declaration': {
          const nameNode = n.childForFieldName('name');
          if (nameNode) {
            const entry: Extracted = {
              symbolPath: joinPath(prefix, nameNode.text),
              name: nameNode.text,
              kind: kindForFunction(nameNode.text, file, n.text),
              tsNode: n,
            };
            out.push(entry);
            const innerBody = bodyNode(n);
            if (innerBody) walkAll(innerBody, prefix + '.' + nameNode.text, file, out);
            break;
          }
          walkAll(n, prefix, file, out);
          return;
        }
        case 'lexical_declaration':
        case 'variable_declaration': {
          for (const declarator of namedKids(n).filter((c) => c.type === 'variable_declarator')) {
            const nameNode = declarator.childForFieldName('name');
            const value = declarator.childForFieldName('value');
            if (nameNode && value && FN_VALUE_TYPES.has(value.type)) {
              const sym = joinPath(prefix, nameNode.text);
              out.push({
                symbolPath: sym,
                name: nameNode.text,
                kind: kindForFunction(nameNode.text, file, value.text),
                tsNode: declarator,
              });
              const innerBody = bodyNode(value);
              if (innerBody) walkAll(innerBody, sym, file, out);
            }
          }
          return;
        }
        default: {
          walkAll(n, prefix, file, out);
          return;
        }
      }
    };
    const walkAll = (n: TsNode, pref: string, _f: string, _out: Extracted[]): void => {
      if (n.type === 'class_body') {
        this.walkClassBody(n, pref, file, out);
        return;
      }
      for (const c of namedKids(n)) {
        if (c.type === 'class_body') {
          this.walkClassBody(c, pref, file, out);
        } else {
          visit(c);
        }
      }
    };
    walkAll(body, prefix, file, out);
  }

  private walkClassBody(n: TsNode, prefix: string, file: string, out: Extracted[]): void {
    for (const c of namedKids(n)) {
      if (!['method_definition', 'public_field_definition', 'field_definition', 'abstract_method_signature', 'decorator'].includes(c.type)) {
        continue;
      }
      if (c.type === 'decorator') continue;
      const nameNode = c.childForFieldName('name') ?? c.childForFieldName('key') ?? namedKids(c)[0];
      if (!nameNode) continue;
      const name = nameNode.text.replace(/['"`]/g, '');
      const value = c.childForFieldName('value');
      if (value && FN_VALUE_TYPES.has(value.type)) {
        out.push({
          symbolPath: joinPath(prefix, name),
          name,
          kind: 'method',
          tsNode: c,
        });
      } else if (value?.type === 'statement_block' || c.type === 'method_definition') {
        out.push({
          symbolPath: joinPath(prefix, name),
          name,
          kind: 'method',
          tsNode: c,
        });
      }
      void file;
    }
  }

  /** exported const name = { ...props with function values... } -> config node + fn children. */
  private pushConfigOrRoutes(
    parentNode: TsNode,
    declarator: TsNode,
    name: string,
    prefix: string,
    file: string,
    out: Extracted[]
  ): void {
    out.push({
      symbolPath: joinPath(prefix, name),
      name,
      kind: 'config',
      tsNode: declarator,
    });
    const value = declarator.childForFieldName('value');
    if (!value) return;
    for (const prop of namedKids(value)) {
      if (prop.type !== 'pair') continue;
      const keyNode = prop.childForFieldName('key');
      const propVal = prop.childForFieldName('value');
      if (!keyNode || !propVal || !FN_VALUE_TYPES.has(propVal.type)) continue;
      const key = keyNode.text.replace(/['"`]/g, '');
      out.push({
        symbolPath: joinPath(prefix, `${name}.${key}`),
        name: key,
        kind: kindForFunction(key, file, propVal.text),
        tsNode: propVal,
      });
    }
    void parentNode;
  }
}

function joinPath(prefix: string, name: string): string {
  return prefix ? `${prefix}.${name}` : name;
}

function hasJsx(node: TsNode): boolean {
  let found = false;
  const walk = (n: TsNode): void => {
    if (found) return;
    if (
      n.type === 'jsx_element' ||
      n.type === 'jsx_self_closing_element' ||
      n.type === 'jsx_fragment'
    ) {
      found = true;
      return;
    }
    for (const c of namedKids(n)) walk(c);
  };
  walk(node);
  return found;
}

/** All identifier leaves (deduped), used for fallback edge resolution. */
function collectIdentifiers(node: TsNode): string[] {
  const out = new Set<string>();
  const walk = (n: TsNode): void => {
    if (n.type === 'identifier' || n.type === 'shorthand_property_identifier' || n.type === 'type_identifier') {
      out.add(n.text);
    }
    for (const c of namedKids(n)) walk(c);
  };
  walk(node);
  return [...out];
}

function collectImportNames(clause: TsNode): string[] {
  const out: string[] = [];
  const walk = (n: TsNode): void => {
    if (n.type === 'import_clause') {
      for (const c of namedKids(n)) {
        if (c.type === 'import_specifier' || c.type === 'named_imports') {
          walk(c);
        } else if (c.type === 'identifier') {
          out.push(c.text);
        }
      }
      return;
    }
    if (n.type === 'named_imports' || n.type === 'import_specifier') {
      for (const c of namedKids(n)) {
        if (c.type === 'import_specifier') {
          const alias = c.childForFieldName('alias');
          const src = c.namedChildren[0];
          out.push(alias?.text ?? src?.text ?? '');
        } else if (c.type === 'identifier' || c.type === 'namespace_import') {
          const alias = c.childForFieldName('alias');
          if (alias) out.push(alias.text);
          else if (c.type === 'identifier') out.push(c.text);
        }
      }
      return;
    }
    for (const c of namedKids(n)) walk(c);
  };
  walk(clause);
  return out.filter((x) => x && x !== '*');
}

/** File extensions tried when resolving a relative import specifier. */
export const RESOLVE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

export interface ResolveIo {
  exists(path: string): boolean;
}

/** Resolve a (relative) import specifier against the workspace. */
export function resolveImport(
  fromFile: string,
  specifier: string,
  io: ResolveIo
): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = fromFile.split('/').slice(0, -1).join('/');
  const base = normalizePosix(dir ? `${dir}/${specifier}` : specifier);
  const candidates = [base, ...RESOLVE_EXTENSIONS.map((ext) => base + ext)];
  for (const c of candidates) if (io.exists(c)) return c;
  return null;
}

export function normalizePosix(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
