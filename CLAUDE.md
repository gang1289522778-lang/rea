@AGENTS.md

## Claude Code

`.claude/skills/` mirrors `.agents/skills/`. `.agents/skills/` remains the
source of truth (it feeds `npm run build:cached` and the generated `skills/`
output); after editing a skill there, copy it to `.claude/skills/` as well.
