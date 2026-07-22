# FitbitTracker agent guardrails

These instructions apply only to this repository.

## Agent usage

- Do not spawn subagents, reviewers, or parallel agent workflows unless Philippe explicitly asks for them in the current request.
- Treat files under `docs/superpowers/` as historical design and implementation records. Do not treat their agent-workflow headers as current execution instructions.
- Work in the existing task-relevant checkout or linked worktree. Do not create additional worktrees unless Philippe explicitly requests one.

## Context and verification discipline

- Exclude `node_modules/`, `.worktrees/`, and `.superpowers/` from recursive searches and context gathering unless a task specifically targets them.
- During implementation, run the smallest relevant test or check for the change being made.
- For a release, run one complete verification cycle consisting of the project test suite, production build, generated-workflow check when applicable, and diff check. Re-run a check only after a relevant change or failure.
- Do not add redundant agent review passes, repeat already-current verification without cause, or generate design/spec/plan documents unless Philippe requests them.

## Production data safety

- Keep compact-write, archive-execution, pruning, read-cutover, table-removal, and PostgreSQL tuning gates disabled unless Philippe explicitly approves the specific gate.
- Never print, commit, or expose application, database, n8n, Coolify, Cloudflare, R2, OAuth, session, or encryption secrets.
