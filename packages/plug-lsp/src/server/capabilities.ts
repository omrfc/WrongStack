import type { ServerCapabilities } from 'vscode-languageserver-protocol';

export function supportsHover(cap: ServerCapabilities): boolean {
  return !!cap.hoverProvider;
}

export function supportsDefinition(cap: ServerCapabilities): boolean {
  return !!cap.definitionProvider;
}

export function supportsReferences(cap: ServerCapabilities): boolean {
  return !!cap.referencesProvider;
}

export function supportsDocumentSymbol(cap: ServerCapabilities): boolean {
  return !!cap.documentSymbolProvider;
}

export function supportsWorkspaceSymbol(cap: ServerCapabilities): boolean {
  return !!cap.workspaceSymbolProvider;
}

export function supportsRename(cap: ServerCapabilities): boolean {
  return !!cap.renameProvider;
}

export function supportsPrepareRename(cap: ServerCapabilities): boolean {
  const provider = cap.renameProvider;
  return typeof provider === 'object' && provider !== null && provider.prepareProvider === true;
}

export function supportsCodeAction(cap: ServerCapabilities): boolean {
  return !!cap.codeActionProvider;
}

export function supportsPullDiagnostics(cap: ServerCapabilities): boolean {
  return !!cap.diagnosticProvider;
}
