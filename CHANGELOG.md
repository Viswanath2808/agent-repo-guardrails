# Changelog

## 0.1.1 — root-level STATE and LOG

- Doc-size gate: a `STATE.md` and `LOG.md` at the repo root are now budgeted (`project STATE`,
  `project LOG`). In 0.1.0 a single-project repo with its files at the root got one PASS line for
  `CLAUDE.md` and `RESULT: CLEAN` while its `STATE.md` was never measured. Found on the first
  install outside the source repo, 2026-11-04.
- **Behaviour change:** a root `STATE.md` over 240 lines or 24,000 bytes now FAILs where 0.1.0
  ignored it. Move content to `LOG.md`, or file it in `budgets.knownDebt`.

## 0.1.0 — initial

- Session-start ritual: branch, dirty count, ahead/behind the default branch (detected from
  `origin/HEAD`, else `main`, or configured), last three commits, `STATE.md` ages, guard posture,
  config warnings.
- Doc-size gate `scripts/doc-budget.mjs`: line and byte budgets per file role, self-deleting
  known-debt allowlist (shipped empty), zero-match guard.
- Optional guard, off by default: refuses git and `gh` writes with a reason and a hand-over form;
  protects its own config while on; fails closed when on, true no-op when off.
- Config in `.claude/guardrails.json`; zero dependencies; Node 20+.
