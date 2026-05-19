/**
 * Skill content structure for generated security skills.
 */
export interface GeneratedSkillContent {
  type: 'skill';
  content: string;
}

export type TechStack =
  | 'nodejs'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'dotnet'
  | 'php'
  | 'ruby'
  | 'cpp'
  | 'c'
  | 'kotlin'
  | 'swift'
  | 'unknown';

export type PackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'pip'
  | 'poetry'
  | 'cargo'
  | 'maven'
  | 'gradle'
  | 'nuget'
  | 'composer'
  | 'bundler'
  | 'cmake'
  | 'swiftpm'
  | 'go'
  | 'unknown';

export interface DetectedDependency {
  name: string;
  version: string;
  isDev: boolean;
  hasSecurityIssue?: boolean;
}

export interface TechStackInfo {
  stack: TechStack;
  packageManager: PackageManager;
  manifestFile: string;
  dependencies: DetectedDependency[];
  projectPath: string;
}

export interface DetectionResult {
  timestamp: string;
  projectRoot: string;
  detectedStacks: TechStackInfo[];
  isMonorepo: boolean;
  workspaceConfigs?: string[];
}

export interface SkillGenerationContext {
  techStack: TechStackInfo;
  scanScope: ScanScope;
  severityLevel: SeverityLevel;
}

export type ScanScope = 'quick' | 'standard' | 'deep';

export type SeverityLevel = 'critical' | 'high' | 'medium' | 'low' | 'all';

export interface SecurityPattern {
  id: string;
  name: string;
  severity: SeverityLevel;
  description: string;
  patterns: RegExp[];
  fileExtensions: string[];
  falsePositiveMarkers: string[];
  remediation: string;
}

export interface GeneratedSecuritySkill {
  name: string;
  description: string;
  techStack: TechStack;
  patterns: SecurityPattern[];
  rules: string[];
  metadata: {
    generatedAt: string;
    version: string;
    confidence: number;
  };
  content: GeneratedSkillContent;
}