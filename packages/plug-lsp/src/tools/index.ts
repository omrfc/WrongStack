import type { Tool } from '@wrongstack/core';
import type { ToolDeps } from './shared.js';
import { createCodeActionsTool } from './code-actions.js';
import { createDefinitionTool } from './definition.js';
import { createDiagnosticsTool } from './diagnostics.js';
import { createHoverTool } from './hover.js';
import { createReferencesTool } from './references.js';
import { createRenameTool } from './rename.js';
import { createSymbolsTool } from './symbols.js';

export function makeLSPTools(deps: ToolDeps): Tool[] {
  return [
    createDiagnosticsTool(deps),
    createDefinitionTool(deps),
    createReferencesTool(deps),
    createHoverTool(deps),
    createSymbolsTool(deps),
    createRenameTool(deps),
    createCodeActionsTool(deps),
  ];
}
