/**
 * Go source symbol extraction using `go/parser`.
 *
 * Spawns a `go run -` child process that parses the file with go/ast and
 * emits JSON. Falls back to empty results on any error.
 *
 * Extracts: package, func, type, const, var
 */

import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { FileSymbols, Symbol as IndexSymbol, SymbolLang } from './schema.js';
import { detectLang } from './ts-parser.js';

// ─── Public API ─────────────────────────────────────────────────────────────

export function parseSymbols(opts: { file: string; content: string; lang: SymbolLang }): FileSymbols {
  const { file, content, lang } = opts;

  try {
    return syncGoParse(file, content, lang);
  } catch {
    return { file, lang, symbols: [], mtimeMs: Date.now() };
  }
}

export { detectLang } from './ts-parser.js';

// ─── Inline Go parser script ────────────────────────────────────────────────

const GO_PARSE_SCRIPT = `
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"strings"
)

type Sym struct {
	Name      string \`json:"name"\`
	Kind      string \`json:"kind"\`
	Line      int    \`json:"line"\`
	Col       int    \`json:"col"\`
	Signature string \`json:"signature"\`
	Scope     string \`json:"scope"\`
}

func main() {
	src, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Print("[]")
		return
	}
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "src.go", src, 0)
	if err != nil {
		fmt.Print("[]")
		return
	}

	var syms []Sym

	// Package-level scope
	pkgScope := node.Name.Name

	// Collect all top-level declarations
	for _, decl := range node.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			name := d.Name.Name
			kind := "function"
			scope := pkgScope
			if d.Recv != nil && len(d.Recv.List) > 0 {
				scope = pkgScope + "." + recvTypeName(d.Recv.List[0].Type) + "." + name
				kind = "method"
			} else {
				scope = pkgScope + "." + name
			}
			pos := fset.Position(d.Pos())
			sig := formatFuncSig(d)
			syms = append(syms, Sym{Name: name, Kind: kind, Line: pos.Line, Col: pos.Column, Signature: sig, Scope: scope})

		case *ast.GenDecl:
			for _, spec := range d.Specs {
				switch s := spec.(type) {
				case *ast.TypeSpec:
					name := s.Name.Name
					pos := fset.Position(s.Pos())
					sig := "type " + name
					if s.TypeParams != nil {
						sig += formatTypeParams(s.TypeParams)
					}
					if st, ok := s.Type.(*ast.StructType); ok {
						sig += " = struct { " + formatFields(st.Fields.List) + " }"
					} else if it, ok := s.Type.(*ast.InterfaceType); ok {
						sig += " = interface { " + formatMethods(it.Methods.List) + " }"
					} else {
						sig += " = " + formatType(s.Type)
					}
					syms = append(syms, Sym{Name: name, Kind: "type", Line: pos.Line, Col: pos.Column, Signature: sig, Scope: pkgScope})

				case *ast.ValueSpec:
					for _, n := range s.Names {
						name := n.Name
						pos := fset.Position(n.Pos())
						kind := "var"
						if d.Tok == token.CONST {
							kind = "const"
						}
						sig := kind + " " + name
						if s.Type != nil {
							sig += " " + formatType(s.Type)
						}
						syms = append(syms, Sym{Name: name, Kind: kind, Line: pos.Line, Col: pos.Column, Signature: sig, Scope: pkgScope})
					}
				}
			}
		}
	}

	data, err := json.Marshal(syms)
	if err != nil {
		fmt.Print("[]")
		return
	}
	fmt.Print(string(data))
}

func recvTypeName(t ast.Expr) string {
	switch v := t.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.StarExpr:
		return recvTypeName(v.X)
	default:
		return "?"
	}
}

func formatFuncSig(d *ast.FuncDecl) string {
	scope := ""
	if d.Recv != nil && len(d.Recv.List) > 0 {
		scope = "(" + formatFieldList(d.Recv.List) + ") "
	}
	scope += formatFuncType(d.Type)
	return "func " + scope
}

func formatFuncType(f *ast.FuncType) string {
	params := formatFieldList(f.Params.List)
	results := ""
	if f.Results != nil {
		results = " -> " + formatFieldList(f.Results.List)
	}
	return params + results
}

func formatFieldList(fields []*ast.Field) string {
	if len(fields) == 0 {
		return "()"
	}
	names := make([]string, 0, len(fields))
	for _, f := range fields {
		name := ""
		if len(f.Names) > 0 {
			name = f.Names[0].Name
		}
		t := formatType(f.Type)
		if name != "" {
			names = append(names, name+" "+t)
		} else {
			names = append(names, t)
		}
	}
	return "(" + strings.Join(names, ", ") + ")"
}

func formatFields(fields []*ast.Field) string {
	lines := make([]string, 0)
	for _, f := range fields {
		name := ""
		if len(f.Names) > 0 {
			name = f.Names[0].Name
		}
		t := formatType(f.Type)
		if name != "" {
			lines = append(lines, name+" "+t)
		} else {
			lines = append(lines, t)
		}
	}
	return strings.Join(lines, "; ")
}

func formatMethods(fields []*ast.Field) string {
	return formatFields(fields)
}

func formatTypeParams(tp *ast.FieldList) string {
	if tp == nil || len(tp.List) == 0 {
		return ""
	}
	params := make([]string, len(tp.List))
	for i, p := range tp.List {
		if len(p.Names) > 0 {
			params[i] = p.Names[0].Name
		} else {
			params[i] = "T"
		}
	}
	return "[" + strings.Join(params, ", ") + "]"
}

func formatType(t ast.Expr) string {
	if t == nil {
		return "?"
	}
	switch v := t.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.SelectorExpr:
		return formatType(v.X) + "." + v.Sel.Name
	case *ast.StarExpr:
		return "*" + formatType(v.X)
	case *ast.ArrayType:
		if v.Len == nil {
			return "[]" + formatType(v.Elt)
		}
		return "[...]" + formatType(v.Elt)
	case *ast.MapType:
		return "map[" + formatType(v.Key) + "]" + formatType(v.Value)
	case *ast.InterfaceType:
		return "interface{}"
	case *ast.StructType:
		return "struct{}"
	case *ast.FuncType:
		return formatFuncType(v)
	case *ast.ChanType:
		return "chan " + formatType(v.Value)
	case *ast.BasicLit:
		return v.Value
	case *ast.IndexExpr:
		// Generic instantiation with one type arg, e.g. Logger[int].
		return formatType(v.X) + "[" + formatType(v.Index) + "]"
	case *ast.IndexListExpr:
		// Generic instantiation with multiple type args, e.g. Map[K, V].
		args := make([]string, len(v.Indices))
		for i, idx := range v.Indices {
			args[i] = formatType(idx)
		}
		return formatType(v.X) + "[" + strings.Join(args, ", ") + "]"
	default:
		return "?"
	}
}
`;

function syncGoParse(filePath: string, content: string, lang: SymbolLang): FileSymbols {
	// Feed the source over stdin — never pass the target .go file as a CLI arg.
	// `go run script.go target.go` makes the toolchain treat target.go as a
	// second package file ("named files must all be in one directory") and
	// refuses *_test.go outright. Reading from stdin sidesteps both, and lets
	// us parse the in-memory content without touching disk.
	const tmpDir = path.join(os.tmpdir(), 'ws-go-parse');
	try {
		mkdirSync(tmpDir, { recursive: true });
		const scriptPath = path.join(tmpDir, 'parse.go');
		writeFileSync(scriptPath, GO_PARSE_SCRIPT, 'utf8');

		// argv-array form (no shell): avoids any quoting/metachar issues in the
		// temp script path. The target source is fed via stdin, not as an arg.
		const stdout = execFileSync('go', ['run', scriptPath], {
			input: content,
			timeout: 15_000,
			encoding: 'utf8',
			windowsHide: true,
		});

		if (!stdout.trim()) {
			return { file: filePath, lang, symbols: [], mtimeMs: Date.now() };
		}

		const raw = JSON.parse(stdout.trim()) as Array<{ name: string; kind: string; line: number; col: number; signature: string; scope: string }>;
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