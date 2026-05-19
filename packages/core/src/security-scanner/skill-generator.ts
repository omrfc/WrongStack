import type { TechStack, TechStackInfo, SecurityPattern, GeneratedSkillContent } from './types.js';

export interface GeneratedSkill {
  name: string;
  description: string;
  version: string;
  techStack: TechStack;
  content: GeneratedSkillContent;
  patterns: SecurityPattern[];
  metadata: {
    generatedAt: string;
    confidence: number;
    targetFiles: string[];
  };
}

export interface SkillGeneratorOptions {
  includeSecrets: boolean;
  includeInjection: boolean;
  includeConfig: boolean;
  includeDependencies: boolean;
  severityThreshold: 'critical' | 'high' | 'medium' | 'low';
}

const DEFAULT_OPTIONS: SkillGeneratorOptions = {
  includeSecrets: true,
  includeInjection: true,
  includeConfig: true,
  includeDependencies: true,
  severityThreshold: 'medium',
};

/**
 * Generates security skills dynamically based on tech stack.
 * Uses predefined vulnerability patterns per stack.
 */
export class SkillGenerator {
  private options: SkillGeneratorOptions;

  constructor(options: Partial<SkillGeneratorOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  generate(techStack: TechStackInfo): GeneratedSkill {
    const patterns = this.getPatternsForStack(techStack.stack);
    const content = this.buildSkillContent(techStack, patterns);
    const targetFiles = this.getTargetFilesForStack(techStack);

    return {
      name: `security-scanner-${techStack.stack}`,
      description: `Security scanner for ${techStack.stack} projects`,
      version: '1.0.0',
      techStack: techStack.stack,
      content,
      patterns,
      metadata: {
        generatedAt: new Date().toISOString(),
        confidence: this.calculateConfidence(techStack),
        targetFiles,
      },
    };
  }

  private getPatternsForStack(stack: TechStack): SecurityPattern[] {
    const patterns: SecurityPattern[] = [];
    const severityOrder = ['critical', 'high', 'medium', 'low'];
    const minIndex = severityOrder.indexOf(this.options.severityThreshold);

    if (this.options.includeSecrets) {
      const secretPatterns = this.getSecretPatterns(stack);
      patterns.push(...secretPatterns.filter((p) => severityOrder.indexOf(p.severity) <= minIndex));
    }

    if (this.options.includeInjection) {
      const injectionPatterns = this.getInjectionPatterns(stack);
      patterns.push(...injectionPatterns.filter((p) => severityOrder.indexOf(p.severity) <= minIndex));
    }

    if (this.options.includeConfig) {
      const configPatterns = this.getConfigPatterns(stack);
      patterns.push(...configPatterns.filter((p) => severityOrder.indexOf(p.severity) <= minIndex));
    }

    return patterns;
  }

  private getSecretPatterns(stack: TechStack): SecurityPattern[] {
    const commonSecrets: SecurityPattern = {
      id: 'hardcoded-secrets',
      name: 'Hardcoded Secrets',
      severity: 'critical',
      description: 'Detects hardcoded API keys, tokens, passwords, and private keys',
      patterns: [
        /(?:api[_-]?key|apikey|api[_-]?secret)[^\w]*[=:]\s*["']([a-zA-Z0-9_-]{20,})["']/gi,
        /(?:password|passwd|pwd)[^\w]*[=:]\s*["'][^"']{6,64}["']/gi,
        /(?:secret|token|auth)[^\w]*[=:]\s*["'][a-zA-Z0-9_/-]{20,}["']/gi,
        /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH)?\s+PRIVATE\s+KEY-----/g,
      ],
      fileExtensions: ['.ts', '.js', '.py', '.go', '.java', '.rb', '.php', '.env'],
      falsePositiveMarkers: ['process.env', 'process.argv', 'process.env.NODE_ENV'],
      remediation: 'Use environment variables or a secrets manager. Never commit secrets to version control.',
    };

    const stackSpecific: Partial<Record<TechStack, SecurityPattern[]>> = {
      nodejs: [
        {
          id: 'npmrc-credentials',
          name: 'npmrc Credentials',
          severity: 'high',
          description: 'Detects .npmrc authentication tokens',
          patterns: [
            // eslint-disable-next-line no-control-regex
            /_auth\s*=\s*[a-zA-Z0-9+/]{20,}/g,
            /registry\s*=\s*https:\/\/[a-zA-Z0-9.-]+\/auth/g,
          ],
          fileExtensions: ['.npmrc'],
          falsePositiveMarkers: [],
          remediation: 'Use npm token from environment variable, not hardcoded in .npmrc',
        },
      ],
      python: [
        {
          id: 'python-secret-env',
          name: 'Python Environment Secrets',
          severity: 'high',
          description: 'Detects secrets loaded via os.environ in Python',
          patterns: [
            /os\.environ\[['"](?:API_KEY|SECRET|PASSWORD|TOKEN)/g,
            /getenv\(['"](?:API_KEY|SECRET|PASSWORD|TOKEN)/g,
          ],
          fileExtensions: ['.py'],
          falsePositiveMarkers: ['os.environ.get', 'getenv(', 'os.getenv'],
          remediation: 'Use python-dotenv or environment variable injection at runtime',
        },
      ],
      rust: [
        {
          id: 'rust-env-secrets',
          name: 'Rust Environment Secrets',
          severity: 'high',
          description: 'Detects env! macro with hardcoded secrets',
          patterns: [/env!\s*\[['"](?:API_KEY|SECRET|PASSWORD|TOKEN)/g],
          fileExtensions: ['.rs'],
          falsePositiveMarkers: [],
          remediation: 'Use std::env::var and handle MissingKeyError properly',
        },
      ],
      go: [
        {
          id: 'go-hardcoded-secret',
          name: 'Go Hardcoded Secrets',
          severity: 'critical',
          description: 'Detects hardcoded secrets in Go source',
          patterns: [
            /os\.Getenv\(['"](?:API_KEY|SECRET|PASSWORD|TOKEN)/g,
            /"[a-zA-Z0-9/+=]{40,}"\s*(?:&&|\|\|)\s*err\s*!=\s*nil/g,
          ],
          fileExtensions: ['.go'],
          falsePositiveMarkers: ['os.Getenv', 'os.LookupEnv'],
          remediation: 'Use viper or os.Getenv with validation',
        },
      ],
      java: [
        {
          id: 'java-system-getenv',
          name: 'Java System.getenv',
          severity: 'medium',
          description: 'Detects System.getenv() usage which may expose secrets',
          patterns: [/System\.getenv\(['"](?:API_KEY|SECRET|PASSWORD|TOKEN)/g],
          fileExtensions: ['.java'],
          falsePositiveMarkers: [],
          remediation: 'Use a secrets manager or environment-specific config',
        },
      ],
      dotnet: [
        {
          id: 'dotnet-config-secrets',
          name: '.NET Configuration Secrets',
          severity: 'high',
          description: 'Detects secrets in .NET Configuration managers',
          patterns: [
            /ConfigurationManager\.ConnectionStrings/g,
            /ConfigurationManager\.AppSettings/g,
          ],
          fileExtensions: ['.cs', '.config'],
          falsePositiveMarkers: [],
          remediation: 'Use Azure Key Vault or user secrets during development',
        },
      ],
    };

    return [commonSecrets, ...(stackSpecific[stack] ?? [])];
  }

  private getInjectionPatterns(stack: TechStack): SecurityPattern[] {
    const commonInjection: SecurityPattern = {
      id: 'command-injection',
      name: 'Command Injection',
      severity: 'critical',
      description: 'Detects shell command injection vulnerabilities',
      patterns: [
        /exec\s*\(\s*[`'"].*\$/g,
        /system\s*\(\s*[`'"].*\$/g,
        /shell_exec\s*\(\s*[`'"].*\$/g,
        /exec\s*\(\s*\$/g,
      ],
      fileExtensions: ['.ts', '.js', '.php', '.py', '.rb'],
      falsePositiveMarkers: ['escapeshellarg', 'escapeshellcmd', 'sanitize'],
      remediation: 'Use parameterized commands with argument arrays instead of string interpolation.',
    };

    const stackSpecific: Partial<Record<TechStack, SecurityPattern[]>> = {
      nodejs: [
        {
          id: 'eval-injection',
          name: 'Eval Injection',
          severity: 'critical',
          description: 'Detects dangerous eval/Function usage with user input',
          patterns: [
            /eval\s*\(\s*(?:req|body|input|params|query)/g,
            /new\s+Function\s*\(\s*(?:req|body|input|params|query)/g,
          ],
          fileExtensions: ['.ts', '.js'],
          falsePositiveMarkers: ['JSON.parse'],
          remediation: 'Never eval user input. Use JSON.parse for data, or proper sandboxing.',
        },
        {
          id: 'sql-injection-template',
          name: 'SQL Injection via Template',
          severity: 'critical',
          description: 'Detects SQL queries built with string concatenation',
          patterns: [
            /(?:query|execute|select)\s*\(\s*[`'"].*\+.*(?:req|body|params|query)/gi,
            /\.query\s*\(\s*`.*\$\{/g,
          ],
          fileExtensions: ['.ts', '.js'],
          falsePositiveMarkers: ['parameterized', 'prepared', 'bind'],
          remediation: 'Use parameterized queries or an ORM with proper query building.',
        },
        {
          id: 'nosql-injection',
          name: 'NoSQL Injection',
          severity: 'high',
          description: 'Detects NoSQL query injection via user input',
          patterns: [
            /find\s*\(\s*\{.*\$where/g,
            /collection\.(?:find|aggregate)\s*\([^)]*\$/g,
          ],
          fileExtensions: ['.ts', '.js'],
          falsePositiveMarkers: [],
          remediation: 'Sanitize and validate all user input before NoSQL queries.',
        },
      ],
      python: [
        {
          id: 'python-sql-injection',
          name: 'Python SQL Injection',
          severity: 'critical',
          description: 'Detects SQL queries built with string formatting',
          patterns: [
            /execute\s*\(\s*f?["'].*%.*/g,
            /cursor\.execute\s*\([^)]*\+[^)]*\)/g,
          ],
          fileExtensions: ['.py'],
          falsePositiveMarkers: ['%s', '%d', '?', 'parameterized'],
          remediation: 'Use parameterized queries with cursor.execute(query, params).',
        },
        {
          id: 'pickle-deserialization',
          name: 'Pickle Deserialization',
          severity: 'critical',
          description: 'Detects insecure pickle deserialization',
          patterns: [
            /pickle\.load\s*\(/g,
            /pickle\.loads\s*\(/g,
            /unpickle\.load\s*\(/g,
          ],
          fileExtensions: ['.py'],
          falsePositiveMarkers: [],
          remediation: 'Never unpickle data from untrusted sources. Use JSON or custom serialization.',
        },
      ],
      go: [
        {
          id: 'go-sql-injection',
          name: 'Go SQL Injection',
          severity: 'critical',
          description: 'Detects SQL queries with string concatenation',
          patterns: [
            /db\.Query\s*\([^)]*\+[^)]*\)/g,
            /QueryContext?\s*\([^)]*\+[^)]*\)/g,
          ],
          fileExtensions: ['.go'],
          falsePositiveMarkers: ['$1', '$2', '?', 'params'],
          remediation: 'Use parameterized queries: db.QueryContext(ctx, "SELECT * FROM users WHERE id=?", userID)',
        },
      ],
      java: [
        {
          id: 'java-sql-injection',
          name: 'Java SQL Injection',
          severity: 'critical',
          description: 'Detects SQL with string concatenation in JDBC',
          patterns: [
            /createStatement\s*\(\s*\).*\.executeQuery\s*\([^)]*\+/g,
            /Statement\s*\([^)]*\+/g,
          ],
          fileExtensions: ['.java'],
          falsePositiveMarkers: ['PreparedStatement', '?'],
          remediation: 'Use PreparedStatement with parameters.',
        },
      ],
      rust: [
        {
          id: 'rust-command-injection',
          name: 'Rust Command Injection',
          severity: 'critical',
          description: 'Detects Command::new with string interpolation',
          patterns: [
            /Command::new\s*\([^)]*\)\s*\.(?:arg|args)\s*\([^)]*\+/g,
            /Command::from\s*\(/g,
          ],
          fileExtensions: ['.rs'],
          falsePositiveMarkers: ['Command::new', 'args\\('],
          remediation: 'Use Command::new(array).args(&[...]) to avoid shell injection.',
        },
      ],
      dotnet: [
        {
          id: 'csharp-sql-injection',
          name: 'C# SQL Injection',
          severity: 'critical',
          description: 'Detects SQL with string concatenation in C#',
          patterns: [
            /SqlCommand\s*\([^)]*\+[^)]*\)/g,
            /\.ExecuteQuery\s*\([^)]*\+[^)]*\)/g,
          ],
          fileExtensions: ['.cs'],
          falsePositiveMarkers: ['parameters.Add', '@', 'SqlParameter'],
          remediation: 'Use parameterized queries with SqlParameter.',
        },
      ],
    };

    return [commonInjection, ...(stackSpecific[stack] ?? [])];
  }

  private getConfigPatterns(stack: TechStack): SecurityPattern[] {
    const commonConfig: SecurityPattern[] = [
      {
        id: 'insecure-tls',
        name: 'Insecure TLS Configuration',
        severity: 'high',
        description: 'Detects disabled TLS verification or weak TLS settings',
        patterns: [
          /rejectUnauthorized\s*[:=]\s*false/g,
          /secure\s*[:=]\s*false/g,
          /ssl\s*[:=]\s*false/g,
          /TLS\s*\[\s*['"]?1\.0['"]?\]/gi,
          /InsecureRequestWarning\.disable/g,
        ],
        fileExtensions: ['.ts', '.js', '.py', '.go', '.java'],
        falsePositiveMarkers: ['NODE_TLS_REJECT_UNAUTHORIZED'],
        remediation: 'Always verify TLS certificates in production. Use proper certificate stores.',
      },
      {
        id: 'debug-enabled',
        name: 'Debug Mode Enabled',
        severity: 'medium',
        description: 'Detects debug flags that may expose sensitive information',
        patterns: [
          /debug\s*[:=]\s*true/g,
          /DEBUG\s*[:=]\s*true/g,
          /development\s*mode/g,
        ],
        fileExtensions: ['.ts', '.js', '.py', '.env', '.json'],
        falsePositiveMarkers: ['process.env.NODE_ENV !== "production"', 'if (process.env.DEBUG)'],
        remediation: 'Disable debug mode in production. Use proper log levels.',
      },
    ];

    return commonConfig;
  }

  private getTargetFilesForStack(techStack: TechStackInfo): string[] {
    const filesByStack: Record<TechStack, string[]> = {
      nodejs: [
        '**/*.ts',
        '**/*.js',
        '**/*.json',
        '**/.env*',
        '**/package.json',
        '**/tsconfig.json',
      ],
      python: [
        '**/*.py',
        '**/requirements*.txt',
        '**/setup.py',
        '**/pyproject.toml',
        '**/.env*',
      ],
      rust: ['**/*.rs', '**/Cargo.toml', '**/Cargo.lock'],
      go: ['**/*.go', '**/go.mod', '**/go.sum'],
      java: ['**/*.java', '**/pom.xml', '**/build.gradle', '**/*.properties'],
      dotnet: ['**/*.cs', '**/*.csproj', '**/*.config', '**/appsettings.json'],
      php: ['**/*.php', '**/.env*', '**/composer.json'],
      ruby: ['**/*.rb', '**/Gemfile', '**/.env*'],
      cpp: ['**/*.cpp', '**/*.hpp', '**/CMakeLists.txt'],
      c: ['**/*.c', '**/*.h'],
      kotlin: ['**/*.kt', '**/*.kts', '**/build.gradle.kts'],
      swift: ['**/*.swift', '**/Package.swift'],
      unknown: ['**/*'],
    };

    return filesByStack[techStack.stack] || filesByStack.unknown;
  }

  private buildSkillContent(techStack: TechStackInfo, patterns: SecurityPattern[]): GeneratedSkillContent {
    const lines: string[] = [
      '---',
      `name: security-scanner-${techStack.stack}`,
      `description: |`,
      `  Auto-generated security scanner for ${techStack.stack} projects.`,
      `  Scans for secrets, injection vectors, and configuration issues.`,
      `version: 1.0.0`,
      '---',
      '',
      `# Security Scanner — ${techStack.stack.toUpperCase()}`,
      '',
      `Scans ${techStack.stack} codebase for security vulnerabilities.`,
      '',
      '## Scan Targets',
      '',
      '### Code Vulnerabilities',
      patterns
        .filter((p) => p.fileExtensions.some((ext) => ['.ts', '.js', '.py', '.go', '.java', '.cs', '.rs'].includes(ext)))
        .map((p) => `- **${p.name}** (${p.severity}): ${p.description}`)
        .join('\n'),
      '',
      '### Configuration Issues',
      patterns
        .filter((p) => p.fileExtensions.some((ext) => ['.json', '.yaml', '.yml', '.env', '.config'].includes(ext)))
        .map((p) => `- **${p.name}** (${p.severity}): ${p.description}`)
        .join('\n'),
      '',
      '## Severity Levels',
      '',
      '- **CRITICAL**: Remote code execution, SQL injection, hardcoded secrets',
      '- **HIGH**: Command injection, XXE, authentication bypass',
      '- **MEDIUM**: Information disclosure, weak crypto, debug mode',
      '- **LOW**: Code quality issues, missing headers',
      '',
      '## Report Format',
      '',
      '```',
      '## Security Scan Report',
      '',
      '### CRITICAL',
      '1. **[CRITICAL]** `file:line` — Description',
      '   ```',
      '   // vulnerable code',
      '   ```',
      '   **Remediation**: Fix description',
      '',
      '### Summary',
      '| Severity | Count |',
      '|----------|-------|',
      '| Critical | X     |',
      '| High     | X     |',
      '| Medium   | X     |',
      '| Low      | X     |',
      '```',
      '',
      '## Remediation',
      '',
      patterns.map((p) => `- **${p.name}**: ${p.remediation}`).join('\n'),
    ];

    return {
      type: 'skill',
      content: lines.join('\n'),
    };
  }

  private calculateConfidence(techStack: TechStackInfo): number {
    let confidence = 0.7;

    if (techStack.dependencies.length > 0) confidence += 0.1;
    if (techStack.manifestFile) confidence += 0.1;
    if (techStack.packageManager !== 'unknown') confidence += 0.1;

    return Math.min(confidence, 1.0);
  }
}

export const defaultSkillGenerator = new SkillGenerator();