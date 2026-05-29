/**
 * Unified cross-reference extraction across all supported languages.
 *
 * `extractRefs(file, content, lang)` → returns `Ref[]`
 *
 * Each language has its own approach:
 * - TS/JS: uses the TypeScript Compiler API (imported from ts-parser.ts)
 * - Go: inline `go run <script>` script using go/ast to walk CallExpr, SelectorExpr, Ident, ImportSpec
 * - Python: inline `python -c` script using ast to walk Call, Name, Attribute, Subscript, Import, ImportFrom
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import type { Ref, SymbolLang } from './schema.js';

// ─── Go reference extraction script ─────────────────────────────────────────

const GO_REFS_SCRIPT = `
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
)

type Ref struct {
	ToName   string \`json:"toName"\`
	CallType string \`json:"callType"\`
	Line     int    \`json:"line"\`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("[]")
		return
	}

	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, os.Args[1], nil, 0)
	if err != nil {
		fmt.Println("[]")
		return
	}

	var refs []Ref

	for _, decl := range node.Decls {
		ast.Inspect(decl, func(n ast.Node) bool {
			switch expr := n.(type) {
			case *ast.CallExpr:
				line := fset.Position(expr.Pos()).Line
				if ident, ok := expr.Fun.(*ast.Ident); ok {
					refs = append(refs, Ref{ToName: ident.Name, CallType: "call", Line: line})
				}
				if sel, ok := expr.Fun.(*ast.SelectorExpr); ok {
					if ident, ok := sel.X.(*ast.Ident); ok {
						refs = append(refs, Ref{ToName: ident.Name + "." + sel.Sel.Name, CallType: "call", Line: line})
					}
				}

			case *ast.SelectorExpr:
				line := fset.Position(expr.Pos()).Line
				if ident, ok := expr.X.(*ast.Ident); ok {
					refs = append(refs, Ref{ToName: ident.Name, CallType: "type_ref", Line: line})
				}

			case *ast.Ident:
				if expr.Obj != nil {
					line := fset.Position(expr.Pos()).Line
					refs = append(refs, Ref{ToName: expr.Name, CallType: "type_ref", Line: line})
				}

			case *ast.ImportSpec:
				if expr.Path != nil {
					path := strings.Trim(expr.Path.Value, "\\"\\"")
					line := fset.Position(expr.Pos()).Line
					refs = append(refs, Ref{ToName: path, CallType: "import", Line: line})
				}

			case *ast.TypeSpec:
				line := fset.Position(expr.Pos()).Line
				refs = append(refs, Ref{ToName: expr.Name.Name, CallType: "type_ref", Line: line})
			}
			return true
		})
	}

	data, err := json.Marshal(refs)
	if err != nil {
		fmt.Println("[]")
		return
	}
	fmt.Print(string(data))
}
`;

// ─── Python reference extraction script ─────────────────────────────────────

const PY_REFS_SCRIPT = `import ast, json, sys

def get_name(node):
    if node is None:
        return ""
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
    else:
        return ""

def walk(node, refs):
    for child in ast.iter_child_nodes(node):
        if isinstance(child, ast.Call):
            name = get_name(child.func)
            if name:
                refs.append({"toName": name, "callType": "call", "line": child.lineno})
            walk(child, refs)

        elif isinstance(child, ast.Attribute):
            name = get_name(child)
            if name and "." in name:
                parts = name.rsplit(".", 1)
                refs.append({"toName": parts[0], "callType": "type_ref", "line": child.lineno})
            walk(child, refs)

        elif isinstance(child, ast.Name):
            if isinstance(child.ctx, ast.Load):
                refs.append({"toName": child.id, "callType": "type_ref", "line": child.lineno})
            walk(child, refs)

        elif isinstance(child, ast.Subscript):
            val = get_name(child.value)
            if val:
                refs.append({"toName": val, "callType": "type_ref", "line": child.lineno})
            walk(child, refs)

        elif isinstance(child, ast.Import):
            for alias in child.names:
                if alias.asname:
                    refs.append({"toName": alias.name, "callType": "import", "line": child.lineno})
            walk(child, refs)

        elif isinstance(child, ast.ImportFrom):
            for alias in child.names:
                if alias.asname:
                    refs.append({"toName": alias.name, "callType": "import", "line": child.lineno})
            walk(child, refs)

        else:
            walk(child, refs)

try:
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        source = f.read()
    tree = ast.parse(source)
    refs = []
    walk(tree, refs)
    print(json.dumps(refs))
except Exception:
    print("[]")
`;

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ExtractRefsOptions {
  file: string;
  content: string;
  lang: SymbolLang;
}

/**
 * Extract cross-references (calls, type refs, imports) from a source file.
 * Returns an array of `Ref` objects with `fromId: 0` (caller fills this in).
 *
 * Falls back to an empty array if the language is not supported or the
 * child process fails.
 */
export async function extractRefs(opts: ExtractRefsOptions): Promise<Ref[]> {
  const { file, lang } = opts;

  switch (lang) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return extractTsRefs(opts.content);

    case 'go':
      return extractGoRefs(file);

    case 'py':
      return extractPyRefs(file);

    default:
      return [];
  }
}

// ─── TypeScript reference extraction ──────────────────────────────────────────

async function extractTsRefs(_content: string): Promise<Ref[]> {
  // TS ref extraction is handled by ts-parser.ts which exposes refs in
  // FileSymbols. Callers should use parseSymbols() and extract the refs field.
  return [];
}

// ─── Go reference extraction via child process ───────────────────────────────

async function extractGoRefs(filePath: string): Promise<Ref[]> {
  const tmpDir = path.join(process.env.TEMP ?? '/tmp', 'ws-go-refs');
  try {
    mkdirSync(tmpDir, { recursive: true });
    const scriptPath = path.join(tmpDir, 'refs.go');
    writeFileSync(scriptPath, GO_REFS_SCRIPT, 'utf8');

    let stdout: string;
    try {
      // argv-array form: no shell, so a hostile filename cannot inject commands.
      stdout = execFileSync('go', ['run', scriptPath, filePath], {
        timeout: 30_000,
        encoding: 'utf8',
        windowsHide: true,
      });
    } finally {
      try { unlinkSync(scriptPath); } catch { /* ignore */ }
    }

    if (!stdout.trim()) return [];
    const raw = JSON.parse(stdout.trim()) as Array<{ toName: string; callType: string; line: number }>;
    return raw.map((r) => ({
      fromId: 0,
      toName: r.toName,
      callType: r.callType as Ref['callType'],
      line: r.line,
    }));
  } catch {
    return [];
  }
}

// ─── Python reference extraction via child process ────────────────────────────

async function extractPyRefs(filePath: string): Promise<Ref[]> {
  const tmpDir = path.join(process.env.TEMP ?? '/tmp', 'ws-py-refs');
  try {
    mkdirSync(tmpDir, { recursive: true });
    // Write the parser to a temp .py and run it as a script. Passing it via
    // `python -c "<script>"` required interpolating into a shell command
    // string, which let a hostile filename inject commands. Running argv-array
    // (no shell) with the script on disk closes that and avoids quoting issues.
    const scriptPath = path.join(tmpDir, 'refs.py');
    writeFileSync(scriptPath, PY_REFS_SCRIPT, 'utf8');

    let stdout: string;
    try {
      stdout = execFileSync('python', [scriptPath, filePath], {
        timeout: 30_000,
        encoding: 'utf8',
        windowsHide: true,
      });
    } finally {
      try { unlinkSync(scriptPath); } catch { /* ignore */ }
    }

    if (!stdout.trim()) return [];
    const raw = JSON.parse(stdout.trim()) as Array<{ toName: string; callType: string; line: number }>;
    return raw.map((r) => ({
      fromId: 0,
      toName: r.toName,
      callType: r.callType as Ref['callType'],
      line: r.line,
    }));
  } catch {
    return [];
  }
}