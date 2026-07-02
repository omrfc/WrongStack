import { readdir, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import type { SecurityPattern, TechStackInfo } from './types.js';
import type { GeneratedSkill } from './skill-generator.js';

export interface Finding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: 'secrets' | 'injection' | 'config' | 'dependency' | 'filesystem';
  title: string;
  description: string;
  file: string;
  line?: number | undefined;
  snippet?: string | undefined;
  remediation: string;
  patternId: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface ScanResult {
  timestamp: string;
  projectRoot: string;
  techStack: TechStackInfo;
  findings: Finding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    total: number;
  };
  scannedFiles: number;
  scanDurationMs: number;
  errors: string[];
}

export interface ScanOptions {
  includeSecrets: boolean;
  includeInjection: boolean;
  includeConfig: boolean;
  includeDependencies: boolean;
  excludePaths: string[];
  fileExtensions: string[];
  depth: 'quick' | 'standard' | 'deep';
}

const DEFAULT_SCAN_OPTIONS: ScanOptions = {
  includeSecrets: true,
  includeInjection: true,
  includeConfig: true,
  includeDependencies: true,
  excludePaths: ['node_modules', 'dist', '.git', 'coverage', 'build', 'target'],
  fileExtensions: [],
  depth: 'standard',
};

export class SecurityScanner {
  private options: ScanOptions;

  constructor(options: Partial<ScanOptions> = {}) {
    this.options = { ...DEFAULT_SCAN_OPTIONS, ...options };
  }

  async scan(projectRoot: string, skill: GeneratedSkill, techStack: TechStackInfo): Promise<ScanResult> {
    const startTime = Date.now();
    const findings: Finding[] = [];
    const errors: string[] = [];
    let scannedFiles = 0;

    const targetExtensions = this.getTargetExtensions(skill, techStack);
    const files = await this.gatherFiles(projectRoot, targetExtensions);

    for (const file of files) {
      try {
        const content = await readFile(file, 'utf-8');
        const fileFindings = this.scanFile(content, file, skill.patterns);
        findings.push(...fileFindings);
        scannedFiles++;
      } catch (err) {
        errors.push(`Failed to read ${file}: ${err}`);
      }
    }

    // Sort findings by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    const summary = this.calculateSummary(findings);
    const scanDurationMs = Date.now() - startTime;

    return {
      timestamp: new Date().toISOString(),
      projectRoot,
      techStack,
      findings,
      summary,
      scannedFiles,
      scanDurationMs,
      errors,
    };
  }

  private async gatherFiles(root: string, extensions: string[]): Promise<string[]> {
    const files: string[] = [];
    const maxDepth = this.options.depth === 'quick' ? 2 : this.options.depth === 'deep' ? 20 : 5;

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
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (this.shouldExclude(entry.name)) continue;
          await this.gatherFilesRecursive(fullPath, files, extensions, currentDepth + 1, maxDepth);
        } else if (entry.isFile()) {
          if (extensions.length === 0 || extensions.includes(extname(entry.name))) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  }

  private shouldExclude(name: string): boolean {
    return this.options.excludePaths.some(
      (exclude) => name === exclude || name.startsWith(exclude + '/') || name.startsWith(exclude + '\\')
    );
  }

  private getTargetExtensions(skill: GeneratedSkill, _techStack: TechStackInfo): string[] {
    if (this.options.fileExtensions.length > 0) {
      return this.options.fileExtensions;
    }

    const extensions = new Set<string>();
    for (const pattern of skill.patterns) {
      for (const ext of pattern.fileExtensions) {
        if (ext.startsWith('.')) {
          extensions.add(ext.toLowerCase());
        }
      }
    }

    return [...extensions];
  }

  private scanFile(content: string, filePath: string, patterns: SecurityPattern[]): Finding[] {
    const findings: Finding[] = [];
    const lines = content.split('\n');

    for (const pattern of patterns) {
      if (!this.matchesCategory(pattern)) continue;

      for (const regex of pattern.patterns) {
        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          const line = lines[lineNum];
          if (!line) continue;

          // Reset INSIDE the line loop: pattern.patterns are declared with
          // the /g flag (see skill-generator.ts), and `.test()` on a /g regex
          // advances `lastIndex` between calls. A match on line N leaves
          // `lastIndex` past the end of line N+1's string, silently skipping
          // every subsequent match — turning the scanner into a one-finding-
          // per-file tool. Reset here so each line gets a fresh search.
          regex.lastIndex = 0;

          if (regex.test(line)) {
            // Check false positive markers
            if (this.isFalsePositive(line, pattern.falsePositiveMarkers)) {
              continue;
            }

            findings.push({
              id: `${pattern.id}-${filePath}-${lineNum}`,
              severity: pattern.severity as Finding['severity'],
              category: this.getCategoryFromPattern(pattern),
              title: pattern.name,
              description: pattern.description,
              file: relative(process.cwd(), filePath),
              line: lineNum + 1,
              snippet: line.trim(),
              remediation: pattern.remediation,
              patternId: pattern.id,
              confidence: 'high',
            });
          }
        }
      }
    }

    return findings;
  }

  private matchesCategory(pattern: SecurityPattern): boolean {
    if (pattern.id.includes('secret') || pattern.id.includes('npmrc') || pattern.id.includes('env')) {
      return this.options.includeSecrets;
    }
    if (
      pattern.id.includes('injection') ||
      pattern.id.includes('sql') ||
      pattern.id.includes('command') ||
      pattern.id.includes('eval')
    ) {
      return this.options.includeInjection;
    }
    if (pattern.id.includes('config') || pattern.id.includes('tls') || pattern.id.includes('debug')) {
      return this.options.includeConfig;
    }
    return true;
  }

  private getCategoryFromPattern(pattern: SecurityPattern): Finding['category'] {
    if (pattern.id.includes('secret')) return 'secrets';
    if (pattern.id.includes('injection') || pattern.id.includes('sql') || pattern.id.includes('command')) return 'injection';
    if (pattern.id.includes('config') || pattern.id.includes('tls') || pattern.id.includes('debug')) return 'config';
    if (pattern.id.includes('dependency')) return 'dependency';
    return 'filesystem';
  }

  private isFalsePositive(line: string, markers: string[]): boolean {
    for (const marker of markers) {
      if (line.includes(marker)) {
        return true;
      }
    }
    return false;
  }

  private calculateSummary(findings: Finding[]): ScanResult['summary'] {
    return {
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      total: findings.length,
    };
  }
}

export const defaultSecurityScanner = new SecurityScanner();