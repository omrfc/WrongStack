import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TechStackDetector } from '../../src/security-scanner/detector.js';

describe('TechStackDetector', () => {
  let detector: TechStackDetector;
  let tempDir: string;

  beforeEach(() => {
    detector = new TechStackDetector();
  });

  afterEach(async () => {
    detector.clearCache();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createTempProject(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-detector-'));
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }
    tempDir = dir;
    return dir;
  }

  describe('Node.js detection', () => {
    it('detects npm project', async () => {
      const dir = await createTempProject({
        'package.json': JSON.stringify({
          name: 'test-project',
          dependencies: { express: '^4.18.0' },
          devDependencies: { typescript: '^5.0.0' },
        }),
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks).toHaveLength(1);
      expect(result.detectedStacks[0].stack).toBe('nodejs');
      expect(result.detectedStacks[0].packageManager).toBe('npm');
      expect(result.detectedStacks[0].dependencies).toContainEqual({
        name: 'express',
        version: '^4.18.0',
        isDev: false,
      });
    });

    it('detects pnpm project', async () => {
      const dir = await createTempProject({
        'package.json': JSON.stringify({ name: 'test' }),
        'pnpm-lock.yaml': 'lockfileVersion: 6.0',
        'pnpm-workspace.yaml': 'packages:\n  - "packages/*"',
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks[0].packageManager).toBe('pnpm');
      expect(result.isMonorepo).toBe(true);
    });

    it('detects yarn project', async () => {
      const dir = await createTempProject({
        'package.json': JSON.stringify({ name: 'test' }),
        'yarn.lock': '# yarn lockfile',
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks[0].packageManager).toBe('yarn');
    });

    it('detects bun project', async () => {
      const dir = await createTempProject({
        'package.json': JSON.stringify({ name: 'test' }),
        'bun.lockb': 'lockfile',
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks[0].packageManager).toBe('bun');
    });
  });

  describe('Python detection', () => {
    it('detects pip requirements.txt project', async () => {
      const dir = await createTempProject({
        'requirements.txt': 'flask==2.0.0\nrequests>=2.25.0',
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks).toHaveLength(1);
      expect(result.detectedStacks[0].stack).toBe('python');
      expect(result.detectedStacks[0].packageManager).toBe('pip');
    });

    it('detects Poetry project', async () => {
      const dir = await createTempProject({
        'pyproject.toml': `[tool.poetry]
name = "test"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.9"
flask = "^2.0"`,
        'poetry.lock': 'lock content',
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks[0].packageManager).toBe('poetry');
    });
  });

  describe('Rust detection', () => {
    it('detects Cargo project', async () => {
      const dir = await createTempProject({
        'Cargo.toml': `[package]
name = "test"
version = "0.1.0"

[dependencies]
serde = "1.0"
tokio = { version = "1.0", features = ["full"] }

[dev-dependencies]
mockall = "0.11"`,
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks).toHaveLength(1);
      expect(result.detectedStacks[0].stack).toBe('rust');
      expect(result.detectedStacks[0].packageManager).toBe('cargo');
      expect(result.detectedStacks[0].dependencies).toContainEqual({
        name: 'serde',
        version: '1.0',
        isDev: false,
      });
      expect(result.detectedStacks[0].dependencies).toContainEqual({
        name: 'mockall',
        version: '0.11',
        isDev: true,
      });
    });
  });

  describe('Go detection', () => {
    it('detects Go module', async () => {
      const dir = await createTempProject({
        'go.mod': `module example.com/test

go 1.21

require (
	github.com/gin-gonic/gin v1.9.0
	golang.org/x/net v0.10.0
)`,
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks).toHaveLength(1);
      expect(result.detectedStacks[0].stack).toBe('go');
      expect(result.detectedStacks[0].packageManager).toBe('go');
    });
  });

  describe('Java detection', () => {
    it('detects Maven project', async () => {
      const dir = await createTempProject({
        'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.test</groupId>
  <artifactId>test-project</artifactId>
  <version>1.0.0</version>
</project>`,
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks).toHaveLength(1);
      expect(result.detectedStacks[0].stack).toBe('java');
      expect(result.detectedStacks[0].packageManager).toBe('maven');
    });

    it('detects Gradle project', async () => {
      const dir = await createTempProject({
        'build.gradle': 'plugins { id "java" }',
        'gradlew': '#!/bin/bash',
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks[0].packageManager).toBe('gradle');
    });
  });

  describe('.NET detection', () => {
    it('detects .NET csproj', async () => {
      const dir = await createTempProject({
        'TestProject.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
</Project>`,
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks).toHaveLength(1);
      expect(result.detectedStacks[0].stack).toBe('dotnet');
      expect(result.detectedStacks[0].packageManager).toBe('nuget');
    });
  });

  describe('monorepo detection', () => {
    it('detects monorepo via pnpm-workspace.yaml', async () => {
      const dir = await createTempProject({
        'package.json': '{ "name": "monorepo" }',
        'pnpm-lock.yaml': 'lock',
        'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "packages/*"',
        'apps/web/package.json': '{ "name": "web" }',
        'packages/utils/package.json': '{ "name": "utils" }',
      });

      const result = await detector.detect(dir);

      expect(result.isMonorepo).toBe(true);
      expect(result.workspaceConfigs).toContain('pnpm-workspace.yaml');
    });

    it('detects multi-stack project', async () => {
      const dir = await createTempProject({
        'package.json': '{ "name": "main" }',
        'Cargo.toml': '[package]\nname = "native"\nversion = "0.1.0"',
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('caching', () => {
    it('returns cached result on second call', async () => {
      const dir = await createTempProject({
        'package.json': JSON.stringify({ name: 'test', dependencies: { lodash: '^4.17.0' } }),
      });

      const result1 = await detector.detect(dir);
      const result2 = await detector.detect(dir);

      expect(result1).toBe(result2);
    });

    it('clearCache invalidates cache', async () => {
      const dir = await createTempProject({
        'package.json': JSON.stringify({ name: 'test' }),
      });

      await detector.detect(dir);
      detector.clearCache();

      const newDir = await createTempProject({
        'package.json': JSON.stringify({ name: 'test', dependencies: { lodash: '^4.17.0' } }),
      });

      const result = await detector.detect(newDir);
      expect(result.detectedStacks[0].dependencies).toHaveLength(1);
    });
  });

  describe('empty project', () => {
    it('returns empty stacks for unknown project', async () => {
      const dir = await createTempProject({
        'README.md': '# Test',
        'src/main.py': 'print("hello")',
      });

      const result = await detector.detect(dir);

      expect(result.detectedStacks).toHaveLength(0);
      expect(result.isMonorepo).toBe(false);
    });
  });
});