---
name: guardrails
description: Explains what the agent-repo-guardrails plugin does (session-start status, doc-size gate, optional git-write guard) and how to configure it in .claude/guardrails.json; load it when the user asks about this plugin, its guard refusals, its doc budgets or its configuration.
---

# agent-repo-guardrails — configuration reference

Three pieces. The full rationale, threat model and measured record are in the plugin's `README.md`.

- **Session-start ritual** (always on) — prints branch, dirty count, ahead/behind the default branch,
  last three commits, `STATE.md` ages, guard posture, config warnings. It reads, plus one bounded `git fetch origin` (updates
  remote-tracking refs and `FETCH_HEAD`); it runs nothing else.
- **Doc-size gate** (on demand) — `node <plugin root>/scripts/doc-budget.mjs [--root <dir>] [--json] [--quiet]`;
  exit 0 PASS/WARN, 1 FAIL, 2 usage error, unreadable root, or git unusable inside a git work tree;
  `--help` prints the usage line.
- **Guard** (off by default) — a `PreToolUse` refusal of git and `gh` writes, plus self-protection
  of its own config.

## Config file

`<repo>/.claude/guardrails.json`, optional. Absent = defaults. Bad JSON, a wrong type or an unknown
key never breaks a session: that value falls back to its default and the session-start output
carries one warning line.

| Key | Default | Meaning |
|---|---|---|
| `defaultBranch` | `null` | Branch the ritual compares against; `null` = `refs/remotes/origin/HEAD`, else `main`. |
| `roleMap` | `null` | Repo-relative path of a markdown file with a table `\| <worktree dir name> \| <role> \|`; the matching role is printed. |
| `budgets."<label>"` | shipped | Override one budget by label: `root router` (120 lines), `project STATE` (240 lines and 24,000 bytes), `project reference` (2,000 lines). `project LOG` is unlimited by design. |
| `budgets.knownDebt` | `{}` | `{"<path>": {"bytes": N, "filed": "YYYY-MM-DD", "owner": "<optional, named in the DEBT line>"}}` — a ceiling for a file already over budget. Self-deleting: FAIL if it grows past N, FAIL if it drops under budget (delete the entry), FAIL if the file no longer matches a rule. |
| `guard.enabled` | `false` | Only the JSON boolean `true` turns the guard on. |
| `guard.arms` | `["git-writes"]` | `git-writes` refuses every git/`gh` command not on the read-only allowlist. |
| `guard.protectedPaths` | `[]` | Extra repo-relative paths the agent may not write while the guard is on. Always protected while on: `.claude/guardrails.json`, `.claude/settings.json`, `.claude/settings.local.json`, and everything under `.git/`. |

Advice to give about budgets: when a file FAILs, move content out (to its log or a design doc); do
not raise the number. A raised budget is a bigger context cost on every future session.

## Guard behaviour

- Allowed: read-only git (`status`, `log`, `diff`, `show`, `fetch`, `ls-files`, `rev-parse`,
  `branch --list`, …) and `gh pr view` / `list` / `checks` / `diff`.
- Refused: every other git and `gh` form, wherever it appears in a compound line (`;`, `&`, `|`,
  `&&`, `$( )`, backticks), and any Edit, Write or shell redirect into a protected path.
- A refusal exits 2; the message names the command and the reason. When the guard is on, its own
  errors also refuse (a hook exiting with anything but 2 would let the command run).
- When the guard is off, it is a silent no-op on every call.

## When a guard refusal happens — the hand-over form

A refusal is a stop, not a detour. Do not retry the command in another spelling, and do not route
it through a script or another tool. Hand it to the human in this form:

> The guard refused `<exact command>` (`<reason from the refusal>`). It is a write the guard keeps
> human-only. Please run it yourself:
>
> ```
> <exact command>
> ```
>
> I will continue once it has run. The read-only form `<e.g. git status>` is still available to me.

If two calls in a row are refused, say which tool was refused, that you are blocked, and what you
cannot determine without it.

Some harmless shapes are refused on purpose, because the fixes for them were measured to open
bypasses. Pick the allowed form up front:

| Refused | Use instead |
|---|---|
| PowerShell assignment `$x = 5` | Inline the expression, or use the Bash tool |
| A bare quoted literal `'--- x ---'` as output | `Write-Host '--- x ---'` / `echo` |
| `b=$(grep -lE 'x' f)` (a flag inside an assignment's substitution) | Run `grep -lE 'x' f` directly |
| A heredoc whose text names a guarded git verb | Write the file with the Write tool |

## What the guard is not

It stops plain-spelled mistakes and naive injections. It is not a sandbox: crafted spellings
(brace expansion, `${IFS}` splices, assembled paths) were measured getting past it. Branch
protection, least-privilege credentials and per-edit approval are the real controls; the guard is
the layer on top. To turn it on: `{"guard": {"enabled": true}}` in `.claude/guardrails.json`.
