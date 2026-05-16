import type { Tool } from '@wrongstack/core';
import { auditTool } from './audit.js';
import { bashTool } from './bash.js';
import { batchToolUseTool } from './batch-tool-use.js';
import { diffTool } from './diff.js';
import { documentTool } from './document.js';
import { editTool } from './edit.js';
import { execTool } from './exec.js';
import { fetchTool } from './fetch.js';
import { formatTool } from './format.js';
import { gitTool } from './git.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { installTool } from './install.js';
import { jsonTool } from './json.js';
import { lintTool } from './lint.js';
import { logsTool } from './logs.js';
import { outdatedTool } from './outdated.js';
import { patchTool } from './patch.js';
import { planTool } from './plan.js';
import { readTool } from './read.js';
import { replaceTool } from './replace.js';
import { scaffoldTool } from './scaffold.js';
import { searchTool } from './search.js';
import { testTool } from './test.js';
import { todoTool } from './todo.js';
import { toolHelpTool } from './tool-help.js';
import { toolSearchTool } from './tool-search.js';
import { toolUseTool } from './tool-use.js';
import { treeTool } from './tree.js';
import { typecheckTool } from './typecheck.js';
import { writeTool } from './write.js';

export const builtinTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  replaceTool,
  globTool,
  grepTool,
  bashTool,
  execTool,
  fetchTool,
  searchTool,
  todoTool,
  planTool,
  gitTool,
  patchTool,
  jsonTool,
  diffTool,
  treeTool,
  lintTool,
  formatTool,
  typecheckTool,
  testTool,
  installTool,
  auditTool,
  outdatedTool,
  logsTool,
  documentTool,
  scaffoldTool,
  toolSearchTool,
  toolUseTool,
  batchToolUseTool,
  toolHelpTool,
];
