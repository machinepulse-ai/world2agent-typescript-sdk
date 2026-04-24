/**
 * Derive a filesystem- and skill-router-safe skill identifier from an npm
 * package name. The mapping is deterministic and 1:1 (within the W2A naming
 * conventions): strip the leading `@` and replace `/` with `-`.
 *
 *   "@world2agent/sensor-hackernews" → "world2agent-sensor-hackernews"
 *
 * Both the channel/bridge and any tooling that writes SKILL.md files to
 * `~/.claude/skills/<id>/` MUST use this function so the path on disk and
 * the `Use skill: <id>` directive emitted with each signal stay in lockstep.
 */
export function packageToSkillId(pkg: string): string {
  return pkg.replace(/^@/, "").replace(/\//g, "-");
}
