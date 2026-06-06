# /skill /skill-gen /skill-install /skill-update /skill-uninstall

These commands are registered by the built-in `wstack-skills` plugin.

## /skill - Skill Browser

Lists all available skills or shows the full body of a named skill.

```text
/skill              -> list all skills with trigger hints
/skill <name>       -> show full skill body
```

Skills are loaded by `DefaultSkillLoader` from three scopes:

- Project-local: `<projectRoot>/.wrongstack/skills/<name>/SKILL.md`
- User-global: `~/.wrongstack/skills/<name>/SKILL.md`
- Bundled: `packages/core/skills/<name>/SKILL.md`

## /skill-gen - LLM-Assisted Skill Creator

Launches an LLM-driven skill creation session. The LLM reads `packages/core/skills/skill-creator/SKILL.md` and guides the user through defining the name, trigger conditions, and instructions.

## /skill-install - Install a Skill

```text
/skill-install <user/repo[@ref]> [--global]
```

Installs skills from a GitHub repository. Repositories may contain a single `SKILL.md` at the root or multiple skills under a `skills/` directory. Without `--global`, installs into the project skill directory.

## /skill-update - Update Installed Skills

```text
/skill-update
/skill-update <name>
/skill-update <user/repo@ref>
/skill-update <name> --global
```

Updates installed skills from their recorded GitHub source.

## /skill-uninstall - Remove a Skill

```text
/skill-uninstall <name> [--global]
```

Removes an installed project or user-global skill. When called without a name, it lists installed skills for the selected scope.

## Skill format

See `packages/core/skills/skill-creator/SKILL.md` and `docs/skills.md` for the canonical skill format.

## Code reference

- `packages/core/src/plugins/skills-plugin.ts`
- `packages/core/src/skills/skill-installer.ts`
- `packages/core/src/execution/skill-loader.ts`
- `packages/core/skills/skill-creator/SKILL.md`
- `packages/core/tests/plugins/skills-plugin.test.ts`
- `docs/skills.md`
