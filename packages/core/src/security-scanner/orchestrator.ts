import { expectDefined } from '../utils/expect-defined.js';
import { defaultTechStackDetector } from './detector.js';
import { defaultGitignoreUpdater } from './gitignore-updater.js';
import type { TechStackInfo } from './types.js';
import type { GeneratedSkill } from './skill-generator.js';
import type { ScanResult, Finding } from './scanner.js';
import type { ReportOptions } from './report-generator.js';
import type { Context } from '../core/context.js';
import type { Provider, Request } from '../types/provider.js';
import { ProviderError } from '../types/provider.js';
import { NETWORK_ERR_RE } from '../execution/regex-patterns.js';
import type { RetryPolicy } from '../types/retry-policy.js';
import type { ErrorHandler } from '../types/error-handler.js';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';
import { sanitizeJsonString } from '../utils/safe-json.js';
export interface SecurityScannerOptions {
  projectRoot: string;
  scanOptions?: {
    depth?: 'quick' | 'standard' | 'deep' | undefined;
    includeSecrets?: boolean | undefined;
    includeInjection?: boolean | undefined;
    includeConfig?: boolean | undefined;
  };
  reportOptions?: Partial<ReportOptions> | undefined;
  skipGitignore?: boolean | undefined;
  /** Optional model name to pass to the LLM provider (defaults to the provider's default). */
  model?: string | undefined;
}

/** Accepts a full Context or just the provider+model needed for LLM calls. */
export type SecurityScannerContext = Context | { provider: Provider; model?: string | undefined };

export interface FullScanResult {
  detectionResult: Awaited<ReturnType<typeof defaultTechStackDetector.detect>>;
  generatedSkill: GeneratedSkill;
  scanResult: ScanResult;
  reportPath: string;
  synthesizedReport?: string | undefined;
  gitignoreResult?: Awaited<ReturnType<typeof defaultGitignoreUpdater.update>> | undefined;
}

/**
 * LLM-powered Security Scanner Orchestrator
 * 
 * Flow:
 * 1. Detect tech stack (static)
 * 2. Generate project-specific security skill via LLM
 * 3. Scan code using LLM with generated skill as context
 * 4. Synthesize findings into structured report via LLM
 */
export class SecurityScannerOrchestrator {
  private detector = defaultTechStackDetector;
  private gitignoreUpdater = defaultGitignoreUpdater;

  constructor(private readonly retryPolicy?: RetryPolicy, private readonly errorHandler?: ErrorHandler) {}

  /**
   * Wraps provider.complete with retry logic using the injected RetryPolicy.
   */
  private async completeWithRetry(
    provider: Provider,
    request: Request,
    abortController: AbortController,
    attempt = 0,
  ): Promise<Awaited<ReturnType<Provider['complete']>>> {
    const signal = abortController.signal;
    try {
      return await provider.complete(request, { signal });
    } catch (err) {
      if (signal.aborted) throw err;

      const isProviderErr = err instanceof ProviderError;
      const policy = this.retryPolicy;
      const errAsErr = isProviderErr ? err : err instanceof Error ? err : new Error(String(err));

      // No policy or non-retryable error — rethrow immediately
      if (!policy || !isProviderErr && !NETWORK_ERR_RE.test(errAsErr.message)) {
        throw err;
      }

      const canRetry = policy.shouldRetry(errAsErr, attempt);
      if (!canRetry) throw err;

      // Classify via error handler if available
      if (this.errorHandler) {
        const classified = this.errorHandler.classify(err);
        if (!classified.retryable) throw err;
      }

      const delay = Math.round(policy.delayMs(attempt));
      const status = isProviderErr ? (err as ProviderError).status : 0;
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'security_scanner.retry',
        attempt: attempt + 1,
        delayMs: delay,
        status,
        message: errAsErr.message,
        timestamp: new Date().toISOString(),
      }));

      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      return this.completeWithRetry(provider, request, abortController, attempt + 1);
    }
  }

  /**
   * Run full security scan with LLM assistance.
   * Accepts a full Context (active agent run) or just provider+model (pre-agent session).
   */
  async run(
    ctx: SecurityScannerContext,
    options: SecurityScannerOptions,
  ): Promise<FullScanResult> {
    const { projectRoot, reportOptions, skipGitignore, model: explicitModel } = options;
    const provider = 'provider' in ctx && ctx.provider ? ctx.provider : (ctx as unknown as Provider);
    const model = explicitModel ?? ('model' in ctx ? ctx.model : undefined);

    // Step 1: Detect tech stack (static, fast)
    const detectionResult = await this.detector.detect(projectRoot);
    if (detectionResult.detectedStacks.length === 0) {
      throw new Error(`No supported tech stack detected in ${projectRoot}`);
    }
    // Non-null assertion is intentional — guard above guarantees non-empty array.
    const techStack = expectDefined(detectionResult.detectedStacks[0]);

    // Step 2: Generate project-specific security skill via LLM
    const generatedSkill = await this.generateSkillLLM(provider, model, projectRoot, techStack);

    // Step 3: Scan code using LLM
    const scanResult = await this.scanWithLLM(provider, model, projectRoot, generatedSkill, techStack, options);

    // Step 4: Synthesize report via LLM
    const synthesizedReport = await this.synthesizeReportLLM(provider, model, projectRoot, techStack, scanResult);

    // Step 5: Write report to file
    const reportPath = await this.writeReport(synthesizedReport, reportOptions);

    // Step 6: Update .gitignore if not skipped
    let gitignoreResult;
    if (!skipGitignore) {
      gitignoreResult = await this.gitignoreUpdater.update();
    }

    return {
      detectionResult,
      generatedSkill,
      scanResult,
      reportPath,
      synthesizedReport,
      gitignoreResult,
    };
  }

  /**
   * Generate a project-specific security skill using LLM.
   * The LLM analyzes the project structure and creates tailored security patterns.
   */
  private async generateSkillLLM(
    provider: Provider,
    model: string | undefined,
    projectRoot: string,
    techStack: TechStackInfo
  ): Promise<GeneratedSkill> {
    // Gather project info for LLM context
    const projectInfo = await this.gatherProjectInfo(projectRoot, techStack);

    const prompt = `You are a security expert generating a customized security scanning skill for a specific project.

Analyze the following project and generate a detailed security skill with:
1. Project-specific vulnerability patterns based on the tech stack and structure
2. Language/framework specific security concerns
3. Common attack vectors for this type of application
4. File patterns to scan

## Project Information:
${projectInfo}

## Tech Stack:
- Language: ${techStack.stack}
- Package Manager: ${techStack.packageManager}
- Manifest: ${techStack.manifestFile}

## Dependencies (first 20):
${techStack.dependencies.slice(0, 20).map(d => `- ${d.name}@${d.version}`).join('\n')}

## Your Task:
Generate a JSON security skill with the following structure:
{
  "name": "security-scanner-${techStack.stack}",
  "description": "Custom security scanner for this project",
  "techStack": "${techStack.stack}",
  "patterns": [
    {
      "id": "unique-pattern-id",
      "name": "Pattern Name",
      "severity": "critical|high|medium|low",
      "description": "What this detects",
      "fileExtensions": [".ts", ".js"],
      "remediation": "How to fix"
    }
  ],
  "targetFiles": ["**/*.ts", "**/*.js"],
  "scanInstructions": "Detailed instructions for scanning this codebase"
}

Focus on:
- ${techStack.stack === 'nodejs' ? 'Node.js specific: eval, prototype pollution, npm script injection, express middleware issues, passport.js misconfigs' : ''}
- ${techStack.stack === 'python' ? 'Python specific: pickle deserialization, SQL injection in ORMs, template injection, insecure Django/Flask settings' : ''}
- Common: hardcoded secrets, SQL injection, command injection, XSS, path traversal, XXE

Return ONLY the JSON object, no markdown, no explanation.`;

    const request: Request = {
      model: model ?? 'unknown',
      system: [{ type: 'text', text: 'You are a security expert. Return ONLY valid JSON.' }],
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 4096,
    };

    try {
      const abortController = new AbortController();
      const response = await this.completeWithRetry(provider, request, abortController);
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      
      // Parse JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const sanitized = sanitizeJsonString(expectDefined(jsonMatch[0])) || expectDefined(jsonMatch[0]);
        const skillData = JSON.parse(sanitized);
        return {
          name: skillData.name || `security-scanner-${techStack.stack}`,
          description: skillData.description || `Security scanner for ${techStack.stack}`,
          version: '1.0.0',
          techStack: techStack.stack,
          content: { type: 'skill', content: JSON.stringify(skillData, null, 2) },
          patterns: skillData.patterns || [],
          metadata: {
            generatedAt: new Date().toISOString(),
            confidence: 0.85,
            targetFiles: skillData.targetFiles || [],
          },
        };
      }
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'security_scanner.skill_generation_failed',
        message: err instanceof Error ? err.message : String(err),
        techStack: techStack.stack,
        timestamp: new Date().toISOString(),
      }));
    }

    // Fallback: return basic skill without LLM
    return this.generateFallbackSkill(techStack);
  }

  /**
   * Scan code using LLM with the generated skill as context.
   * The LLM analyzes files and reports security findings.
   */
  private async scanWithLLM(
    provider: Provider,
    model: string | undefined,
    projectRoot: string,
    skill: GeneratedSkill,
    techStack: TechStackInfo,
    options: SecurityScannerOptions
  ): Promise<ScanResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const errors: string[] = [];
    let scannedFiles = 0;

    // Gather files to scan
    const files = await this.gatherFiles(projectRoot, skill.metadata.targetFiles, options.scanOptions?.depth || 'standard');
    
    // Process files in batches to avoid overwhelming the LLM
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const batchFindings = await this.scanFileBatchLLM(provider, model, batch, skill, techStack);
      findings.push(...batchFindings);
      scannedFiles += batch.length;
    }

    // Sort by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const summary = {
      critical: findings.filter(f => f.severity === 'critical').length,
      high: findings.filter(f => f.severity === 'high').length,
      medium: findings.filter(f => f.severity === 'medium').length,
      low: findings.filter(f => f.severity === 'low').length,
      total: findings.length,
    };

    return {
      timestamp: new Date().toISOString(),
      projectRoot,
      techStack,
      findings,
      summary,
      scannedFiles,
      scanDurationMs: Date.now() - startTime,
      errors,
    };
  }

  /**
   * Scan a batch of files using LLM.
   */
  private async scanFileBatchLLM(
    provider: Provider,
    model: string | undefined,
    files: string[],
    skill: GeneratedSkill,
    _techStack: TechStackInfo
  ): Promise<Finding[]> {
    const fileContents: string[] = [];
    for (const file of files) {
      try {
        const content = await readFile(file, 'utf-8');
        const relativePath = relative(process.cwd(), file);
        fileContents.push(`\n=== ${relativePath} ===\n${content.slice(0, 2000)}`);
      } catch {
        // Skip files we can't read
      }
    }

    if (fileContents.length === 0) return [];

    const prompt = `You are a security expert analyzing code for vulnerabilities.

## Security Patterns to Detect (from generated skill):
${skill.patterns.map(p => `- ${p.name} (${p.severity}): ${p.description}`).join('\n')}

## Files to Analyze:
${fileContents.join('\n')}

## Your Task:
Analyze each file for security vulnerabilities matching the patterns above.
For each finding, provide:
1. File path (relative path from === markers)
2. Line number if identifiable
3. Severity (critical/high/medium/low)
4. Category (secrets/injection/config/dependency)
5. Description of the issue
6. Code snippet showing the vulnerability
7. Remediation steps

Return a JSON array of findings:
[
  {
    "file": "path/to/file.ts",
    "line": 42,
    "severity": "high",
    "category": "injection",
    "title": "SQL Injection Risk",
    "description": "...",
    "snippet": "actual code...",
    "remediation": "..."
  }
]

Return ONLY the JSON array. If no issues found, return [].`;

    try {
      const request: Request = {
        model: model ?? 'unknown',
        system: [{ type: 'text', text: 'You are a security expert. Return ONLY valid JSON.' }],
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 4096,
      };
      
      const abortController = new AbortController();
      const response = await this.completeWithRetry(provider, request, abortController);
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const sanitized = sanitizeJsonString(expectDefined(jsonMatch[0])) || expectDefined(jsonMatch[0]);
        const parsed = JSON.parse(sanitized) as Array<{
          file: string;
          line?: number | undefined;
          severity: 'critical' | 'high' | 'medium' | 'low';
          category?: string | undefined;
          title: string;
          description: string;
          snippet?: string | undefined;
          remediation: string;
        }>;
        
        return parsed.map((item, idx) => ({
          id: `llm-finding-${idx}-${Date.now()}`,
          severity: item.severity,
          category: (item.category as Finding['category']) || 'injection',
          title: item.title,
          description: item.description,
          file: item.file,
          line: item.line,
          snippet: item.snippet,
          remediation: item.remediation,
          patternId: 'llm-analysis',
          confidence: 'high' as const,
        }));
      }
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'security_scanner.llm_scan_batch_failed',
        message: err instanceof Error ? err.message : String(err),
        fileCount: files.length,
        timestamp: new Date().toISOString(),
      }));
    }

    return [];
  }

  /**
   * Synthesize a comprehensive security report using LLM.
   */
  private async synthesizeReportLLM(
    provider: Provider,
    model: string | undefined,
    projectRoot: string,
    techStack: TechStackInfo,
    scanResult: ScanResult
  ): Promise<string> {
    const prompt = `You are a security expert writing a comprehensive security report.

## Scan Results:
- Scanned Files: ${scanResult.scannedFiles}
- Total Findings: ${scanResult.summary.total}
- Critical: ${scanResult.summary.critical}
- High: ${scanResult.summary.high}
- Medium: ${scanResult.summary.medium}
- Low: ${scanResult.summary.low}

## Detailed Findings:
${scanResult.findings.map((f, i) => `
${i + 1}. [${f.severity.toUpperCase()}] ${f.title}
   File: ${f.file}${f.line ? `:${f.line}` : ''}
   Category: ${f.category}
   Description: ${f.description}
   ${f.snippet ? `Code: \`\`\`\n${f.snippet}\n\`\`\`` : ''}
   Remediation: ${f.remediation}
`).join('\n')}

## Project:
- Root: ${projectRoot}
- Tech Stack: ${techStack.stack} (${techStack.packageManager})

## Your Task:
Write a comprehensive markdown security report with:
1. Executive Summary (overall security posture)
2. Critical Issues (with detailed analysis and remediation)
3. High Priority Issues
4. Medium Priority Issues
5. Low Priority / Informational
6. Security Recommendations (prioritized action items)
7. Summary Table

Format with proper markdown, emojis for severity, and actionable remediation steps.

Be specific about the vulnerabilities found and how to fix them.`;

    try {
      const request: Request = {
        model: model ?? 'unknown',
        system: [{ type: 'text', text: 'You are a security expert writing detailed reports.' }],
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 8192,
      };
      
      const abortController = new AbortController();
      const response = await this.completeWithRetry(provider, request, abortController);
      return response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    } catch (err) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'security_scanner.report_synthesis_failed',
        message: err instanceof Error ? err.message : String(err),
        findingsCount: scanResult.findings.length,
        timestamp: new Date().toISOString(),
      }));
      // Fallback to basic report
      return this.generateBasicReport(projectRoot, techStack, scanResult);
    }
  }

  /**
   * Generate a basic fallback report when LLM synthesis fails.
   */
  private generateBasicReport(projectRoot: string, techStack: TechStackInfo, scanResult: ScanResult): string {
    const lines: string[] = [];
    lines.push('# Security Scan Report');
    lines.push('');
    lines.push(`**Generated:** ${new Date(scanResult.timestamp).toLocaleString()}`);
    lines.push(`**Project:** ${projectRoot}`);
    lines.push(`**Tech Stack:** ${techStack.stack} (${techStack.packageManager})`);
    lines.push(`**Scanned Files:** ${scanResult.scannedFiles}`);
    lines.push('');
    lines.push('## Summary');
    lines.push('');
    lines.push('| Severity | Count |');
    lines.push('|----------|-------|');
    lines.push(`| 🔴 Critical | ${scanResult.summary.critical} |`);
    lines.push(`| 🟠 High | ${scanResult.summary.high} |`);
    lines.push(`| 🟡 Medium | ${scanResult.summary.medium} |`);
    lines.push(`| 🟢 Low | ${scanResult.summary.low} |`);
    lines.push('');
    
    for (const finding of scanResult.findings) {
      const emoji = finding.severity === 'critical' ? '🔴' : finding.severity === 'high' ? '🟠' : finding.severity === 'medium' ? '🟡' : '🟢';
      lines.push(`## ${emoji} ${finding.title}`);
      lines.push('');
      lines.push(`**File:** \`${finding.file}${finding.line ? `:${finding.line}` : ''}\``);
      lines.push(`**Severity:** ${finding.severity.toUpperCase()}`);
      lines.push(`**Category:** ${finding.category}`);
      lines.push('');
      if (finding.snippet) {
        lines.push('```');
        lines.push(finding.snippet);
        lines.push('```');
        lines.push('');
      }
      lines.push(`**Remediation:** ${finding.remediation}`);
      lines.push('');
    }
    
    return lines.join('\n');
  }

  /**
   * Write synthesized report to file.
   */
  private async writeReport(content: string, reportOptions?: Partial<ReportOptions>): Promise<string> {
    const outputDir = reportOptions?.outputDir || 'security-reports';
    const format = reportOptions?.format || 'markdown';
    
    try {
      await mkdir(outputDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `security-report-${timestamp}.${format}`;
    const filepath = join(outputDir, filename);

    await atomicWrite(filepath, content);
    return filepath;
  }

  /**
   * Gather project info for skill generation.
   */
  private async gatherProjectInfo(projectRoot: string, _techStack: TechStackInfo): Promise<string> {
    const info: string[] = [];
    
    // Read key project files
    const keyFiles = [
      'package.json',
      'tsconfig.json',
      '.env.example',
      'README.md',
      'CONTRIBUTING.md',
    ];

    for (const file of keyFiles) {
      try {
        const content = await readFile(join(projectRoot, file), 'utf-8');
        const displayName = file === 'README.md' || file === 'CONTRIBUTING.md' ? 'README' : file;
        info.push(`\n--- ${displayName} ---\n${content.slice(0, 1000)}`);
      } catch {
        // File doesn't exist, skip
      }
    }

    // Add directory structure hint
    try {
      const entries = await readdir(projectRoot, { withFileTypes: true });
      const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).slice(0, 20);
      info.push(`\n--- Project Directories ---\n${dirs.join(', ')}`);
    } catch {
      // Skip
    }

    return info.join('\n');
  }

  /**
   * Gather files to scan based on patterns.
   */
  private async gatherFiles(
    root: string,
    _patterns: string[],
    depth: 'quick' | 'standard' | 'deep'
  ): Promise<string[]> {
    const files: string[] = [];
    const maxDepth = depth === 'quick' ? 2 : depth === 'deep' ? 20 : 5;
    const extensions = ['.ts', '.js', '.jsx', '.tsx', '.py', '.go', '.java', '.cs', '.rs'];
    
    await this.gatherFilesRecursive(root, files, extensions, 0, maxDepth);
    return files;
  }

  private async gatherFilesRecursive(
    dir: string,
    files: string[],
    extensions: string[],
    currentDepth: number,
    maxDepth: number
  ): Promise<void> {
    if (currentDepth > maxDepth) return;

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const name = entry.name;
          if (name === 'node_modules' || name === 'dist' || name === 'build' || 
              name === '.git' || name === 'coverage' || name.startsWith('.')) continue;
          
          await this.gatherFilesRecursive(
            join(dir, entry.name),
            files,
            extensions,
            currentDepth + 1,
            maxDepth
          );
        } else if (entry.isFile()) {
          const ext = entry.name.lastIndexOf('.');
          if (ext > 0 && extensions.includes(entry.name.slice(ext))) {
            files.push(join(dir, entry.name));
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  /**
   * Generate fallback skill when LLM fails.
   */
  private generateFallbackSkill(techStack: TechStackInfo): GeneratedSkill {
    return {
      name: `security-scanner-${techStack.stack}`,
      description: `Security scanner for ${techStack.stack} projects`,
      version: '1.0.0',
      techStack: techStack.stack,
      content: { type: 'skill', content: 'Fallback static skill' },
      patterns: [
        {
          id: 'hardcoded-secrets',
          name: 'Hardcoded Secrets',
          severity: 'critical',
          description: 'Detects hardcoded API keys, tokens, passwords',
          patterns: [],
          fileExtensions: ['.ts', '.js', '.env'],
          falsePositiveMarkers: [],
          remediation: 'Use environment variables',
        },
      ],
      metadata: {
        generatedAt: new Date().toISOString(),
        confidence: 0.5,
        targetFiles: [`**/*.${techStack.stack === 'nodejs' ? 'ts' : techStack.stack === 'python' ? 'py' : 'ts'}`],
      },
    };
  }

  /**
   * Quick scan - legacy compatibility.
   * NOTE: This won't use LLM as it doesn't have access to ctx.
   */
  async quickScan(projectRoot: string): Promise<ScanResult> {
    const detectionResult = await this.detector.detect(projectRoot);
    if (detectionResult.detectedStacks.length === 0) {
      throw new Error(`No supported tech stack detected in ${projectRoot}`);
    }
    const techStack = expectDefined(detectionResult.detectedStacks[0]);

    // Return minimal result - actual scanning requires LLM context
    return {
      timestamp: new Date().toISOString(),
      projectRoot,
      techStack,
      findings: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
      scannedFiles: 0,
      scanDurationMs: 0,
      errors: ['Quick scan without LLM context is not fully supported. Use run(ctx, options) for full scan.'],
    };
  }
}

export const defaultOrchestrator = new SecurityScannerOrchestrator();
