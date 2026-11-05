# agent-repo-guardrails

Guardrails for a repo that an AI coding agent works in for months: a reference implementation, a
threat model, and a record of the failure modes that were measured while building it.

## 1. What it does

At the start of every session it prints a short, factual status of the repo â€” branch, uncommitted
files, how far the branch is behind its default, the last three commits, and how stale each
`STATE.md` is â€” so the agent begins from what is true instead of from what it remembers. It ships a
doc-size gate that keeps the files an agent reads in full every session small, on bytes as well as
lines, because a line budget is evaded by making lines longer. And it carries an optional pre-tool
guard, **off by default**, that refuses git and `gh` write commands with a reason and a hand-over
form, so a human authors every commit, push and pull request.

## 2. What it does NOT defend against â€” read this before installing

The guard is a text matcher in front of a shell. It is built for one adversary: **the agent itself,
cooperating**. Concretely, two cases:

1. **An honest mistake** â€” the model misreads the task and emits a command it was told not to run.
2. **A naive injection** â€” text in a file, a tool result or a pasted message talks the model into
   emitting such a command, written the way a cooperative engineer would write it.

In both cases the command arrives in a plain spelling: no quote splicing, no `${IFS}`, no
brace-expanded verbs, no path assembled from fragments. Plain spellings are refused
deterministically, every time.

**It does not defend against an adversary crafting command text to slip past a parser.** That line
cannot be held by text matching over bash and PowerShell, and this was measured, not assumed: on the
implementation this plugin was reduced from, a fuzz run of 54,750 generated command strings, each
executed against stub binaries in a sandbox (2026-09-28), found spellings that the guard allowed and
the shell ran. Examples of the classes found â€” every one of them allowed:

| Class | Example |
|---|---|
| Brace expansion of the verb | `""{git,push}` |
| Field-separator splice | `'rm'${IFS}.claude/settings.json` |
| Command substitution inside a destination | `truncate -s 0 "$(printf .clau)de/settings.json"` |
| Redirect target never folded | `echo x > .cla''ude/settings.json` |
| A bound variable as the write target | `t=.claude/settings.json ; rm $t` |
| Bash backslash normalisation | `.clau\de/` is `.claude/` to bash |
| Interpreter payloads scanned by substring only | `node -e` with `'.clau'+'de/â€¦'` |
| Option permutation and unlisted writers | `sed $t -i â€¦`, `awk -i inplace`, `sort -o`, `perl -pi` |

Each of these was left open on purpose. A parser rewrite went through twelve review rounds, and
every round found a real bypass inside the previous round's fix; the closures that did hold refused
ordinary commands such as `Set-Content "$(Get-Location)\out.txt"`. The guard's job is
to make the plain mistake impossible, not to be a sandbox. **Defending against the adversarial
class is the job of the layers in section 6** â€” the guard is never the only one.

What the plugin also does not do: it does not stop the agent reading anything, it does not watch
MCP tools, and the doc gate and status ritual report rather than act (the ritual's one write is a
bounded `git fetch`, section 7).

## 3. Install

From a marketplace (replace `Viswanath2808` with the account that hosts it):

```
/plugin marketplace add Viswanath2808/agent-repo-guardrails
/plugin install agent-repo-guardrails
```

Local, for trying it or developing it (loads in place, nothing is copied; `/reload-plugins` picks
up edits):

```
claude --plugin-dir path/to/agent-repo-guardrails
```

Requirements: Node 20 or later on `PATH` (the hooks use exec form, `"command": "node"`). Zero
dependencies â€” every script uses `node:` built-ins only, so there is no install step and no lockfile.

After install, the session-start ritual runs on the next session. The doc gate runs when you call
it. The guard does nothing until you turn it on (section 4.3).

## 4. The three pieces

All configuration lives in one optional file, `<your repo>/.claude/guardrails.json`. Absent means
defaults. An unparseable file, a wrong type or an unknown key never breaks a session: the plugin
falls back to defaults for that value and the session-start ritual prints one warning line naming it.

```json
{
  "defaultBranch": null,
  "roleMap": null,
  "budgets": {},
  "guard": {
    "enabled": false,
    "arms": ["git-writes"],
    "protectedPaths": []
  }
}
```

### 4.1 Session-start ritual (always on)

`scripts/session-start.mjs`, wired to `SessionStart` on `startup` and `clear`. Its stdout becomes
part of the agent's context. Output is plain lines, factual, not instructions.

| Key | Default | Meaning |
|---|---|---|
| `defaultBranch` | `null` | Branch to compare against. `null` = read `refs/remotes/origin/HEAD`, else `main`. |
| `roleMap` | `null` | Path (relative to the repo) of a markdown file holding a table `\| <worktree dir name> \| <role> \|`. When a row matches this tree's directory name, the role is printed. `null` = skip. |

What it prints: tree and branch (`DETACHED @ <sha>` when detached); the count of uncommitted files;
ahead/behind against `origin/<default>` after a `git fetch` (offline, it says so and uses the last
fetched state); the last three commits; up to six tracked `*/STATE.md` files with the age of each
one's last commit; the guard's posture; any config warnings. When the branch is behind, it prints
the two checkout commands a human can run (detach and look, or start fresh work from the default
branch), with a note first when uncommitted files would get in the way â€” it never runs them.

Example output (line formats from `lib/ritual.mjs`; the values are made up):

```
Guard: off
Tree: my-repo
Branch: feat/parser-cache  |  dirty files: 2
origin/main: ahead 3 / behind 5
  2 uncommitted file(s) here -- a checkout either refuses or carries them onto the new branch
  BEHIND origin/main by 5. The two catch-up forms:
    git checkout --detach origin/main              # look, without a branch
    git checkout -b <new-branch> origin/main       # new work from the current tip
Last 3 commits:
  a1b2c3d fix(parser): cache invalidation on rename
  ...
STATE.md files (last commit):
  docs/STATE.md  2d ago
  api/STATE.md   19d ago
```

### 4.2 Doc-size gate (run on demand, or from your own pre-push hook / CI)

```
node scripts/doc-budget.mjs [--root <dir>] [--json] [--quiet]
```

Exit `0` on PASS or WARN, `1` on FAIL, `2` on a usage error, an unreadable root, or git unusable
inside a git work tree; `--help` prints the usage line. It lists
markdown files with `git ls-files`, and walks the tree (skipping `node_modules` and `.git`) when the
root is not a git repo.

Shipped budgets â€” asymmetric on purpose, each matching how the file is read:

| Label | Matches | Budget | Why |
|---|---|---|---|
| `root router` | `CLAUDE.md` at the root | 120 lines (warn 100) | Loaded every session; routing and global rules only. |
| `project STATE` | `<dir>/STATE.md`, one or two levels deep | 240 lines **and** 24,000 bytes (warn 200 / 20,000) | Read in full at every session start. |
| `project LOG` | `<dir>/LOG.md` | unlimited, by design | Append-only, grepped, never read whole. A growing log is the system working. |
| `project reference` | `<dir>/CLAUDE.md` | 2,000 lines (warn 1,800) | Durable reference, read section by section. |

**Why bytes as well as lines.** A line budget is evaded by making lines longer, and long-lived
state files did exactly that without anyone deciding to. Measured 2026-10-08 on the repo this
plugin comes from: one state file sat at 213 lines â€” a PASS on lines â€” and 81,654 bytes, longest
line 5,019 characters. That was about 26,500 tokens, over the agent's 25,000-token single-read
page, so "read in full" took three reads. The byte budget is 240 lines Ã— ~100 characters; every
other state file in that repo was under it on the day it was set.

**Zero-match guard.** If no file matches any rule, the gate says so loudly and exits `0` â€” an empty
repo is not a FAIL, but a pattern that silently stopped matching (for example after a directory
move) must not read as green.

| Key | Meaning |
|---|---|
| `budgets."<label>"` | Override a shipped budget, keyed by the label above, e.g. `{"project STATE": {"max": 300, "maxBytes": 30000}}`. |
| `budgets.knownDebt` | Files already over budget on the day you adopt the gate: `{"<path>": {"bytes": <measured size>, "filed": "YYYY-MM-DD", "owner": "<who trims it>"}}` â€” `owner` is optional and is named in the DEBT line. |

The override exists for file layouts this plugin cannot predict. **When a file FAILs, move content
out of it (to its log, or a design doc) â€” do not raise the number.** Raising a budget accepts a
bigger context cost on every future session.

`knownDebt` is a **self-deleting allowlist**. The size you file is a ceiling: the file reports DEBT
instead of FAIL until it grows past the ceiling (FAIL) or drops under budget (FAIL â€” delete the
entry). By convention, a trim that stays over budget re-files the lower number, so the ceiling only
moves down â€” the gate reads the filed number fresh each run and cannot enforce this itself.
An entry for a file that no longer matches a rule is a dead entry â€” FAIL. The plugin ships the list
empty.

Illustrative output:

```
[PASS] CLAUDE.md                 root router        84 lines
[FAIL] api/STATE.md              project STATE     213 lines  81,654 bytes > 24,000 (longest line 5,019 chars)
[PASS] api/LOG.md                project LOG      4,210 lines (unlimited by design)
RESULT: FAIL (1 fail, 0 warn, 3 checked)
```

### 4.3 Guard (optional, off by default)

`scripts/guard.mjs`, wired to `PreToolUse` for `Bash`, `PowerShell`, `Edit`, `Write`, `MultiEdit`
and `NotebookEdit`. While `guard.enabled` is `false` it is a true no-op: it exits `0` silently on
every call, including on its own internal errors.

| Key | Default | Meaning |
|---|---|---|
| `guard.enabled` | `false` | `true` turns the guard on. Anything that is not the JSON boolean `true` is treated as `false`. |
| `guard.arms` | `["git-writes"]` | Which arms run. `git-writes` refuses every git and `gh` command that is not on the read-only allowlist. |
| `guard.protectedPaths` | `[]` | Extra paths, relative to the repo, that the agent may not write while the guard is on. |

**The `git-writes` arm.** Allowed: read-only forms such as `git status`, `log`, `diff`, `show`,
`fetch`, `ls-files`, `rev-parse`, `branch --list`, and `gh pr view`, `list`, `checks`, `diff`.
Refused: everything else â€” commit, push, merge, rebase, tag, branch creation, `gh pr create`,
`gh api` with a write method or payload. It tokenises bash and PowerShell shapes, including `;`,
`&`, `|`, `&&`, `$( )`, backticks and quoting, so `echo ok; git push` is refused as surely as
`git push`.

**Self-protection, always on while the guard is on.** The agent may not Edit, Write or
shell-redirect into `.claude/guardrails.json`, `.claude/settings.json`,
`.claude/settings.local.json`, anything under `.git/`, or any `guard.protectedPaths` entry â€” otherwise the first thing a mistaken agent could do is switch the
guard off. The plugin's own install directory is not protected: it is not in your repo.

**A refusal is a stop.** The guard exits `2` and its message reaches the agent:

```
agent-repo-guardrails guard BLOCKED [git-writes]: git push: not on the read-only allowlist -- hand this command to a human; read-only forms are allowed
Hand this command to a human to run; read-only forms are allowed.
```

The intended agent behaviour is to hand the exact command to the human and move on â€” not to retry
it in another spelling. The skill shipped with this plugin says so in the agent's own context.

**Fails closed.** In Claude Code, a `PreToolUse` hook blocks only on exit code `2`; every other
non-zero exit is a non-blocking error, so a hook that crashes with exit `1` lets the command run.
When the guard is on, every failure path â€” unparseable input, a thrown error â€” ends in exit `2`
with a reason.

## 5. Measured failure modes

Each row is something that was measured, with how and when. "Re-proved by" names the test in this
plugin that carries the case forward; harness facts have no unit test and should be re-measured
after a Claude Code upgrade.

| What | How it was measured | Date | Re-proved by |
|---|---|---|---|
| A `PreToolUse` hook that exits with any code but `2` fails open | Read from the hooks contract when the source guard was built; the live build confirmed exit `0` never blocks (5 tool calls) â€” the non-`2` failure case is the documented contract, not a separate run | 2026-09-25 | `test/guard.test.mjs` (failure paths end in exit 2 when enabled) |
| A plugin `PreToolUse` exit `2` blocks the call even when a project-level hook on the same event allows it; both hooks fire on one call | Throw-away plugin loaded with `--plugin-dir` beside a project hook, live session | 2026-10-22 | harness fact â€” re-measure |
| A plugin `SessionStart` hook's stdout reaches the agent's context, the same as a settings hook's | Same throw-away plugin, marker line read back by the agent | 2026-10-22 | harness fact â€” re-measure |
| `CLAUDE_PROJECT_DIR` is set for plugin hooks and equals the worktree the session started in | Same throw-away plugin, payload logged | 2026-10-22 | harness fact â€” re-measure |
| On Windows, `CLAUDE_PLUGIN_ROOT` arrives with backslashes, contrary to the docs | Same throw-away plugin, value logged | 2026-10-22 | harness fact â€” no script reads the variable; each locates itself via `import.meta.url` |
| Exec-form `"command": "node"` resolves without a hardcoded interpreter path | Same throw-away plugin, Windows host | 2026-10-22 | harness fact â€” re-measure |
| A line budget is evaded by line length (213 lines PASS, 81,654 bytes) | Line and byte count of every state file in the source repo | 2026-10-08 | `test/doc-budget.test.mjs` (213 lines Ã— 380 chars: PASS lines, FAIL bytes) |
| A posture line that cannot fail reads as evidence: in the source, a flat "armed" line stayed green while the guard's self-protection was lifted, because its two self-test commands were untouched by what had changed | Reading the posture arm against the change that lifted protection | 2026-09-27 | `test/ritual.test.mjs` (the guard line runs a deny and an allow fixture through `decide()` and prints `self-test FAILED` when either is wrong) |
| Text matching cannot hold against an adversary (section 2 table) | 54,750 generated strings executed against stub binaries in a sandbox | 2026-09-28 | documented limit â€” not a test |
| Five false denies on everyday shapes (below) | Pure-function probe against the guard module, then 68 cases written before any fix | 2026-09-27 | `test/guard.test.mjs` |

**The five false denies.** Each is a fail-closed rule firing on a shape that cannot hide an
invocation. They were fixed, the fixes were reviewed twelve times, every round found a real bypass
inside the previous fix, and the fixes were reverted: these shapes are accepted as refused. When
one bites, use the allowed form instead. Four of the five carry over to this plugin; one does not,
because the arm that produced it was not ported (each row has a test in `test/guard.test.mjs`).

| Refused | Why it was refused | Use instead |
|---|---|---|
| PowerShell assignment: `$x = 5`, `$u = [Environment]::â€¦` | The statement's head `$u` was read as an unresolvable command name | Inline the expression, or use the Bash tool |
| A bare quoted literal as output: `'--- machine ---'` | Its leading dashes were read as an unrecognised flag | `Write-Host '--- machine ---'` / `echo` |
| ~~A redirection counted as an argument: `<tool> -v 2>&1`~~ **Allowed in this plugin** | The original refusal came from a database-CLI arm that is not ported; `node -v 2>&1` is tested as allowed | â€” |
| A flag inside an assignment's `$( )`: `b=$(grep -lE 'x' f)` | The assignment value ended at the first space, so the substitution's arguments became the head | Run `grep -lE 'x' f` directly |
| A heredoc whose content names a guarded verb: `cat > f <<'EOF'` â€¦ `git push` â€¦ | Guarded-verb text flowing into a write is refused while the `git-writes` arm is on â€” correct as designed | Write the file with the Write tool |

Two shapes the original refused by mistake are **fixed here, with tests**: `cmd /c echo hi` (the `/c`
switch was read as a path to the project's drive root) and `node /abs/path/script.mjs` (any token
starting with `/` was read as a flag, so the script operand went missing and the call read as a
stdin sink).

Method note, measured: three of those five came from using the guard for ordinary work while fixing
it, not from the bug report. Drive the guard through an hour of real work and it reports its own
false denies.

## 6. The layers beneath â€” the guard is never the only one

| Risk | The real control | What the guard adds |
|---|---|---|
| A push to the default branch | Branch protection on the remote, plus a `pre-push` hook in the repo | The agent does not author commits or pushes at all |
| Damage with a credential | Least privilege: the agent's credentials are read-only, deploy credentials never in its reach | The agent does not even try |
| The agent editing its own guardrails | Per-edit approval outside auto mode; Claude Code's own self-modification checks in auto mode | A deterministic refusal on the plain spelling, with a reason |

If the guard is your only control against one of these, add the layer first.

## 7. FAQ

**Why is the guard off by default?** Someone who installs a plugin and immediately cannot commit
learns one thing: to uninstall it. Read section 2, decide the threat model fits, then set
`"guard": {"enabled": true}`. Enabling is meant to be a deliberate second step.

**Why not just `permissions.deny`?** For simple cases they overlap, and if `permissions.deny`
covers what you need, use it. The guard adds three things: a deterministic refusal with a reason the
agent can act on; a hand-over form, so the refusal ends in a human running the command rather than
the agent trying variants; and parsing of compound shell lines (`a; b`, `$( )`, PowerShell
statements). It also comes with a measured record of what text matching cannot do, which applies to
any pattern-based deny list.

**Can I run it beside my own `PreToolUse` hook?** Yes. Both run on every matching call, and a block
from either one blocks the call (measured, section 5).

**Why does the doc gate not budget the log?** Because the log is never read whole. Budgets follow
read patterns: a file read in full every session is small; a file that is grepped can be any size.

**Does anything get written at runtime?** Nothing is written under the plugin's directory. The gate
only reads; the ritual reads, plus one bounded `git fetch origin`, which updates remote-tracking
refs and `FETCH_HEAD` in your repo.

## 8. Licence

MIT â€” see `LICENSE`. It covers the code, the tests and this README.
