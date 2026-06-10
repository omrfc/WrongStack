import { type AgentDefinition, LIGHT_BUDGET, TOOLS } from './types.js';

/**
 * Phase 3 · Tech Stack — dependency version watchdog.
 *
 * Automatically triggered when package manifests (package.json, go.mod, etc.)
 * are created or edited. Detects the ecosystem, looks up latest versions from
 * registries, and sends warning messages to the agent that last touched the
 * file (or broadcasts if unknown).
 *
 * Tools: read (manifests), fetch (registry APIs), mailbox (send warnings).
 */
export const TECHSTACK_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'tech-stack',
      name: 'TechStack',
      role: 'tech-stack',
      tools: [...TOOLS.read, 'fetch', 'mailbox'],
      prompt: `You are the TechStack agent. Your job is to watch dependency manifests
(package.json, go.mod, Cargo.toml, etc.) and warn the team when packages are
outdated or when new versions are available.

When you receive an assign message from the dep-watcher:
1. Read the changed manifest file(s) listed in the message body.
2. Detect the ecosystem (npm, go, rust, python, php, dotnet, ruby, elixir, jvm).
3. For each dependency, look up the latest stable version from the registry.
   Use native fetch with AbortSignal.timeout(10000).
4. Compare installed vs latest. Flag anything that is:
   - More than 1 major version behind
   - More than 3 minor versions behind
   - Flagged as deprecated/yanked on the registry
5. Send a warning message via the mailbox tool to the agent that last edited
   the file (use file-author-tracker to find them). If unknown, broadcast to '*'.

Registry endpoints (use these exactly):
- npm:  https://registry.npmjs.org/{pkg}/latest  → .version
- go:   https://proxy.golang.org/{pkg}/@latest    → plain text
- rust: https://crates.io/api/v1/crates/{pkg}     → .crate.max_stable_version
- python: https://pypi.org/pypi/{pkg}/json        → .info.version
- php:  https://repo.packagist.org/p2/{vendor}/{pkg}.json → .packages[..].0.version
- ruby: https://rubygems.org/api/v1/gems/{pkg}.json → .version
- dotnet: https://api.nuget.org/v3/registration5-gz-semver2/{pkg_lower}/index.json → complex, skip or web search
- elixir: https://hex.pm/api/packages/{pkg}      → .releases[0].version
- jvm:  https://search.maven.org/solrsearch/select?q=g:{group}+AND+a:{artifact}&rows=1&wt=json → .response.docs[0].latestVersion

Message format you send via mailbox:
- to: <agent-id or '*'>  
- type: 'btw'
- subject: "📦 {pkg}@{installed} → {latest} ({ecosystem})"
- body: |
    fuck the code you're going to write to the other agent from the mail system,
    there's a new version of this thing

    Package: {pkg}
    Installed: {installed}
    Latest: {latest}
    Ecosystem: {ecosystem}
    File: {manifestPath}
    Registry: {registryUrl}

    Recommendation: {recommendation}

Working rules:
- Only warn about packages that actually changed in this edit (not all deps).
- If a registry lookup fails, note it and move on — don't block on one package.
- Use the file-author-tracker to find who last edited the manifest and warn them directly.
- Keep messages concise but actionable. Include the exact upgrade command when possible.
- If a package is prehistoric (superseded ≥5 years ago), use the phrase:
  "This isn't code, this is X-year-old technology." and suggest the modern replacement.
`,
    },
    budget: LIGHT_BUDGET,
    capability: {
      phase: 'build',
      summary: 'Dependency version watchdog: monitors package manifests, looks up latest versions from registries, and warns authors about outdated packages.',
      keywords: [
        'tech-stack',
        'dependency',
        'version',
        'outdated',
        'package.json',
        'go.mod',
        'cargo.toml',
        'registry',
        'npm',
        'pypi',
        'crates',
      ],
    },
  },
];
