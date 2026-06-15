/**
 * Python source symbol extraction using the `ast` module.
 *
 * Spawns a `python -c` child process that parses the file with Python's `ast`
 * module and emits JSON. Falls back to empty results on any error.
 *
 * Extracts: class, function, async function, const, var, import, import_from
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FileSymbols, Symbol as IndexSymbol, SymbolLang } from './schema.js';

// ─── Public API ─────────────────────────────────────────────────────────────

export function parseSymbols(opts: { file: string; content: string; lang: SymbolLang }): FileSymbols {
  const { file, lang } = opts;

  try {
    return syncPyParse(file, lang);
  } catch {
    /* v8 ignore next -- syncPyParse has its own catch; this outer guard is defensive. */
    return { file, lang, symbols: [], mtimeMs: Date.now() };
  }
}

export { detectLang } from './ts-parser.js';

// ─── Inline Python parser script ────────────────────────────────────────────

const PY_PARSE_SCRIPT = `import ast, json, sys, os

def get_name(node):
    if isinstance(node, ast.Name):
        return node.id
    elif isinstance(node, ast.Attribute):
        return get_name(node.value) + "." + node.attr
    elif isinstance(node, ast.Subscript):
        return get_name(node.value)
    elif isinstance(node, ast.Call):
        return get_name(node.func)
    elif isinstance(node, ast.Constant):
        return str(node.value)
    return ""

def get_decorators(node):
    decs = []
    for dec in node.decorator_list:
        decs.append(get_name(dec))
    return decs

def get_bases(node):
    bases = []
    for base in node.bases:
        bases.append(get_name(base))
    return bases

def get_args(args):
    parts = []
    for arg in args.args:
        parts.append(arg.arg)
    return ", ".join(parts)

def get_returns(node):
    if node.returns is None:
        return ""
    return get_name(node.returns)

class Sym:
    def __init__(self, name, kind, line, col, signature, scope):
        self.name = name
        self.kind = kind
        self.line = line
        self.col = col
        self.signature = signature
        self.scope = scope
    def to_dict(self):
        return {
            "name": self.name,
            "kind": self.kind,
            "line": self.line,
            "col": self.col,
            "signature": self.signature,
            "scope": self.scope,
        }

def is_private(name):
    return name.startswith("__") and not name.endswith("__")

syms = []
errors = []

try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        source = f.read()
    tree = ast.parse(source, filename=sys.argv[1])
except Exception as e:
    errors.append(str(e))
    print("[]")
    sys.exit(0)

# Module-level scope
module_scope = os.path.basename(sys.argv[1])[:-3]  # strip .py

class ModuleVisitor(ast.NodeVisitor):
    def __init__(self):
        self.scope_stack = [module_scope]

    def visit_ClassDef(self, node):
        bases = get_bases(node)
        decs = get_decorators(node)
        sig = "class " + node.name
        if bases:
            sig += "(" + ", ".join(bases) + ")"
        sig += ": ..."
        syms.append(Sym(
            name=node.name,
            kind="class",
            line=node.lineno,
            col=node.col_offset,
            signature=sig,
            scope=".".join(self.scope_stack) + "." + node.name,
        ))
        self.scope_stack.append(node.name)
        self.generic_visit(node)
        self.scope_stack.pop()

    def visit_FunctionDef(self, node):
        decs = get_decorators(node)
        args = get_args(node.args)
        returns = get_returns(node)
        is_async = isinstance(node, ast.AsyncFunctionDef)

        kind = "function"
        prefix = "def "
        if decs:
            for d in decs:
                if d.endswith(".staticmethod"):
                    kind = "staticmethod"
                elif d.endswith(".classmethod"):
                    kind = "classmethod"
                elif d == "property":
                    kind = "property"

        if is_async:
            kind = "async_" + kind

        sig = f"{prefix}{node.name}({args})"
        if returns:
            sig += f" -> {returns}"
        scope = ".".join(self.scope_stack) + "." + node.name

        syms.append(Sym(
            name=node.name,
            kind=kind,
            line=node.lineno,
            col=node.col_offset,
            signature=sig,
            scope=scope,
        ))
        # Don't descend into function bodies to avoid local symbols
        # self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node):
        # Treat as function
        self.visit_FunctionDef(node)

    def visit_Assign(self, node):
        for target in node.targets:
            if isinstance(target, ast.Name):
                name = target.id
                if is_private(name):
                    continue
                # Infer constness from UPPER_CASE naming
                kind = "const" if name.isupper() else "var"
                col = target.col_offset if hasattr(target, 'col_offset') else 0
                syms.append(Sym(
                    name=name,
                    kind=kind,
                    line=node.lineno,
                    col=col,
                    signature=f"{name} = ...",
                    scope=".".join(self.scope_stack),
                ))

    def visit_AnnAssign(self, node):
        if isinstance(node.target, ast.Name):
            name = node.target.id
            if is_private(name):
                return
            kind = "const" if name.isupper() else "var"
            col = node.target.col_offset if hasattr(node.target, 'col_offset') else 0
            sig = f"{name}: {get_name(node.annotation)}"
            if node.value:
                sig += " = ..."
            syms.append(Sym(
                name=name,
                kind=kind,
                line=node.lineno,
                col=col,
                signature=sig,
                scope=".".join(self.scope_stack),
            ))

    def visit_Import(self, node):
        for alias in node.names:
            name = alias.asname or alias.name
            syms.append(Sym(
                name=name,
                kind="import",
                line=node.lineno,
                col=node.col_offset,
                signature=f"import {alias.name}",
                scope=".".join(self.scope_stack),
            ))

    def visit_ImportFrom(self, node):
        module = node.module or ""
        for alias in node.names:
            name = alias.asname or alias.name
            syms.append(Sym(
                name=name,
                kind="import",
                line=node.lineno,
                col=node.col_offset,
                signature=f"from {module} import {alias.name}",
                scope=".".join(self.scope_stack),
            ))

visitor = ModuleVisitor()
visitor.visit(tree)

print(json.dumps([s.to_dict() for s in syms]))
`;

// ─── Synchronous Python parse via child process ─────────────────────────────

function syncPyParse(filePath: string, lang: SymbolLang): FileSymbols {
	try {
		// Write the parser to a temp .py and run it as a script. Passing the
		// whole 200-line program via `python -c "..."` breaks under cmd.exe on
		// Windows (embedded newlines truncate the command), so the child saw a
		// mangled script and emitted nothing. A real file sidesteps all quoting.
		const tmpDir = path.join(os.tmpdir(), 'ws-py-parse');
		mkdirSync(tmpDir, { recursive: true });
		const scriptPath = path.join(tmpDir, 'parse.py');
		writeFileSync(scriptPath, PY_PARSE_SCRIPT, 'utf8');

		// argv-array form: no shell, so a hostile filename (e.g. one containing
		// shell metacharacters or command substitution) cannot inject commands.
		const stdout = execFileSync('python', [scriptPath, filePath], {
			timeout: 15_000,
			encoding: 'utf8',
			windowsHide: true,
		});

		if (!stdout.trim()) {
			return { file: filePath, lang, symbols: [], mtimeMs: Date.now() };
		}

		const raw = JSON.parse(stdout.trim()) as Array<{
			name: string;
			kind: string;
			line: number;
			col: number;
			signature: string;
			scope: string;
		}>;
		const symbols: IndexSymbol[] = raw.map((s) => ({
			id: 0,
			lang,
			kind: s.kind as IndexSymbol['kind'],
			name: s.name,
			file: filePath,
			line: s.line,
			col: s.col,
			signature: s.signature ?? '',
			docComment: '',
			scope: s.scope ?? '',
			text: `${s.name} ${s.signature ?? ''}`.trim(),
		}));
		return { file: filePath, lang, symbols, mtimeMs: Date.now() };
	} catch {
		return { file: filePath, lang, symbols: [], mtimeMs: Date.now() };
	}
}