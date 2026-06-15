/**
 * TypeScript/JavaScript symbol extraction using the TypeScript Compiler API.
 *
 * We traverse the AST and collect:
 * - classes, interfaces, enums, type aliases  → class|interface|enum|type
 * - functions and methods                       → function|method
 * - const/let/var declarations                 → const|let|var
 * - property/accessor declarations            → property
 *
 * The `id` field on each Symbol is always 0 — the caller is responsible for
 * assigning unique ids during insertion.
 */

import * as ts from 'typescript';
import type { FileSymbols, Ref, Symbol as IndexSymbol, SymbolKind, SymbolLang } from './schema.js';

// Map TypeScript SyntaxKind → our SymbolKind taxonomy
const KIND_MAP: Partial<Record<ts.SyntaxKind, SymbolKind>> = {
  [ts.SyntaxKind.ClassDeclaration]:      'class',
  [ts.SyntaxKind.InterfaceDeclaration]: 'interface',
  [ts.SyntaxKind.EnumDeclaration]:       'enum',
  [ts.SyntaxKind.TypeAliasDeclaration]:  'type',
  [ts.SyntaxKind.FunctionDeclaration]:    'function',
  [ts.SyntaxKind.MethodDeclaration]:     'method',
  [ts.SyntaxKind.GetAccessor]:           'property',
  [ts.SyntaxKind.SetAccessor]:           'property',
  [ts.SyntaxKind.PropertyDeclaration]:   'property',
  [ts.SyntaxKind.Parameter]:            'parameter',
  [ts.SyntaxKind.NamespaceExportDeclaration]: 'namespace',
};

function kindOf(node: ts.Node): SymbolKind | null {
  // VariableDeclaration needs special handling — its parent tells us whether
  // it's `const`, `let`, or `var`.
  if (ts.isVariableDeclaration(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclarationList(parent)) {
      const flags = parent.flags;
      if (flags & ts.NodeFlags.Let) return 'let';
      if (flags & ts.NodeFlags.Const) return 'const';
      return 'var';
    }
  }

  // Namespace (module) declaration
  if (ts.isModuleDeclaration(node)) return 'namespace';

  return KIND_MAP[node.kind] ?? null;
}

function extToLang(ext: string): SymbolLang | null {
  switch (ext) {
    case '.ts':   return 'ts';
    case '.tsx':  return 'tsx';
    case '.js':   return 'js';
    case '.jsx':  return 'jsx';
    case '.go':   return 'go';
    case '.py':   return 'py';
    case '.rs':   return 'rs';
    case '.json': return 'json';
    case '.yaml': return 'yaml';
    case '.yml':  return 'yaml';
    default:      return null;
  }
}

function getSignature(node: ts.Declaration, sourceFile: ts.SourceFile): string {
  const printer = ts.createPrinter({});
  const raw = printer.printNode(ts.EmitHint.Unspecified, node, sourceFile);
  return raw.replace(/\s+/g, ' ').slice(0, 500);
}

/**
 * Extract the first line of a JSDoc comment preceding a node.
 * Uses `ts.getLeadingCommentRanges` which is the modern replacement for
 * the removed `ts.getJSDocComments`.
 */
function getJsDoc(node: ts.Node, sourceFile: ts.SourceFile): string {
  const fullText = sourceFile.getFullText();
  // getLeadingCommentRanges wants the position where the node's leading trivia
  // begins (getFullStart), not the node's width — passing getFullWidth() looked
  // past the comment and silently returned no JSDoc for every symbol.
  const nodePos = node.getFullStart();
  const comments = ts.getLeadingCommentRanges(fullText, nodePos);
  if (!comments) return '';

  for (const range of comments) {
    const commentText = fullText.slice(range.pos, range.end);
    // Only process JSDoc comments (/** ... */)
    const trimmed = commentText.trim();
    if (trimmed.startsWith('/**') && trimmed.endsWith('*/')) {
      // Strip the /** and */ delimiters and leading * on each line
      const inner = trimmed
        .slice(3, -2)              // remove /** and */
        .replace(/^[ \t]*\*[ ]?/gm, '')  // remove leading " * " or " *" on each line
        .trim();
      return inner.split('\n')[0]?.trim().slice(0, 200) ?? '';
    }
  }
  return '';
}

/** Build the scope path from a node up to the root (for class-method scope). */
function buildScope(node: ts.Node): string {
  const parts: string[] = [];
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isClassDeclaration(current) ||
      ts.isInterfaceDeclaration(current) ||
      ts.isEnumDeclaration(current) ||
      ts.isTypeAliasDeclaration(current)
    ) {
      parts.unshift(current.name?.text ?? 'Anon');
    } else if (
      ts.isMethodDeclaration(current) ||
      ts.isGetAccessor(current) ||
      ts.isSetAccessor(current) ||
      ts.isPropertyDeclaration(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      if (current.name && ts.isIdentifier(current.name)) {
        parts.unshift(current.name.text);
      }
    }
    current = current.parent;
  }
  return parts.join('.');
}

export interface ParseOptions {
  file: string;
  content: string;
  lang: SymbolLang;
}

/**
 * Parse a TypeScript/JavaScript source file and extract all code symbols.
 *
 * The returned `Symbol.id` field is always `0` — the caller is responsible
 * for assigning unique numeric ids during bulk insertion.
 *
 * Returns an empty array for files that can't be parsed or contain no symbols.
 */
export function parseSymbols(opts: ParseOptions): FileSymbols {
  const { file, content, lang } = opts;

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  } catch {
    /* v8 ignore next -- createSourceFile tolerates malformed input and does not throw; defensive. */
    return { file, lang, symbols: [], mtimeMs: Date.now() };
  }

  const symbols: IndexSymbol[] = [];

  function visit(node: ts.Node): void {
    const kind = kindOf(node);

    if (kind) {
      const nameNode = (node as { name?: ts.Identifier | undefined }).name;
      if (!nameNode || !ts.isIdentifier(nameNode)) return;
      const name = nameNode.text;
      const pos = nameNode.getStart(sourceFile);
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(pos);
      const scope = buildScope(node);
      const signature = getSignature(node as ts.Declaration, sourceFile);
      const docComment = getJsDoc(node, sourceFile);
      const text = [name, signature, docComment].filter(Boolean).join(' | ');

      symbols.push({
        id: 0,
        lang,
        kind,
        name,
        file,
        line: line + 1,
        col: character,
        signature,
        docComment,
        scope,
        text,
      });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Second pass: collect cross-references (call/type/inherit refs)
  const refs = extractRefs(sourceFile);

  return { file, lang, symbols, refs, mtimeMs: Date.now() };
}

// ─── Reference extraction ──────────────────────────────────────────────────────

/** Collect call/type/inherit references from a source file. */
function extractRefs(sourceFile: ts.SourceFile): Ref[] {
  const refs: Ref[] = [];

  function visit(node: ts.Node): void {
    const pos = node.getStart(sourceFile);
    const { line } = sourceFile.getLineAndCharacterOfPosition(pos);
    const lineNum = line + 1;

    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) {
        refs.push({ fromId: 0, toName: expr.text, callType: 'call', line: lineNum });
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      if (ts.isIdentifier(node.expression)) {
        refs.push({ fromId: 0, toName: node.expression.text, callType: 'call', line: lineNum });
      }
    } else if (ts.isTypeReferenceNode(node)) {
      const name = getTypeName(node.typeName);
      if (name) refs.push({ fromId: 0, toName: name, callType: 'type_ref', line: lineNum });
    } else if (ts.isHeritageClause(node)) {
      for (const t of node.types) {
        const name = getTypeName(t.expression as ts.EntityName);
        if (name) refs.push({ fromId: 0, toName: name, callType: node.token === ts.SyntaxKind.ExtendsKeyword ? 'inherit' : 'implement', line: lineNum });
      }
    } else if (ts.isImportDeclaration(node)) {
      const moduleName = getModuleName(node);
      if (moduleName) refs.push({ fromId: 0, toName: moduleName, callType: 'import', line: lineNum });
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return deduplicateRefs(refs);
}

/** Extract the name string from a type name node (simple or qualified). */
function getTypeName(name: ts.EntityName): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isQualifiedName(name)) return `${getTypeName(name.left)}.${name.right.text}`;
  /* v8 ignore next -- an EntityName is always an Identifier or QualifiedName; defensive. */
  return '';
}

/** Get the module path string from an import declaration. */
function getModuleName(node: ts.ImportDeclaration): string {
  const moduleSpecifier = node.moduleSpecifier;
  if (ts.isStringLiteral(moduleSpecifier)) return moduleSpecifier.text;
  /* v8 ignore next -- an import declaration's module specifier is always a string literal; defensive. */
  return '';
}

/** Remove duplicate refs (same toName, callType, line). fromId is always 0 at this stage. */
function deduplicateRefs(refs: Ref[]): Ref[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.toName}:${r.callType}:${r.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Detect SymbolLang from a file path extension. */
export function detectLang(file: string): SymbolLang | null {
  const idx = file.lastIndexOf('.');
  if (idx < 0) return null;
  return extToLang(file.slice(idx));
}