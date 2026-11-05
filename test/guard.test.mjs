// test/guard.test.mjs -- the negative-test table for the optional guard.
//
// The table IS the spec: every row is a command shape that was either a
// measured bypass of an earlier version (deny rows) or a measured false deny
// of one (allow rows, the "controls"). Deleting a row deletes a test, not
// noise. Rows are grouped by the failure mode they re-prove.
//
// Run: node --test plugins/agent-repo-guardrails/test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decide, tokenizeAll } from '../lib/decide.mjs';
import { loadConfig } from '../lib/config.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_SCRIPT = path.join(PLUGIN_ROOT, 'scripts', 'guard.mjs');

// A fictional project root. Absolute-path rows below are spelled against it.
const PROJECT = 'C:\\work\\repo';

// The guard as a user would enable it, with one extra protected directory so
// the user-configured protectedPaths arm is exercised alongside the fixed set.
const ON = Object.freeze({ guard: { enabled: true, arms: ['git-writes'], protectedPaths: ['tools/hooks'] } });
const OFF = Object.freeze({ guard: { enabled: false, arms: ['git-writes'], protectedPaths: ['tools/hooks'] } });
const PATHS_ONLY = Object.freeze({ guard: { enabled: true, arms: [], protectedPaths: ['tools/hooks'] } });

function call(tool, arg, config = ON, projectDir = PROJECT) {
  let tool_name;
  let tool_input;
  switch (tool) {
    case 'bash': tool_name = 'Bash'; tool_input = { command: arg }; break;
    case 'pwsh': tool_name = 'PowerShell'; tool_input = { command: arg }; break;
    case 'edit': tool_name = 'Edit'; tool_input = { file_path: arg, old_string: 'a', new_string: 'b' }; break;
    case 'write': tool_name = 'Write'; tool_input = { file_path: arg, content: 'x' }; break;
    case 'multiedit': tool_name = 'MultiEdit'; tool_input = { file_path: arg, edits: [] }; break;
    case 'notebook': tool_name = 'NotebookEdit'; tool_input = { notebook_path: arg, new_source: 'x' }; break;
    default: throw new Error(`unknown tool shorthand ${tool}`);
  }
  return decide({ tool_name, tool_input, projectDir }, config);
}

const BSL = String.fromCharCode(92); // one literal backslash, built so no escape ambiguity
const W = (rel) => PROJECT + BSL + rel.split('/').join(BSL); // an absolute Windows path in the project

// [expect, tool, input, note?, armExpected?]
const D = 'deny';
const A = 'allow';
const FC_ARM = 'fail-closed';
const CASES = [
  // ---- git writes: refused --------------------------------------------------
  [D, 'bash', 'git push origin x', '', 'git-writes'],
  [D, 'bash', 'git commit -m x', '', 'git-writes'],
  [D, 'bash', 'git checkout -b x'],
  [D, 'bash', 'git add f'],
  [D, 'bash', 'git stash', 'bare stash writes'],
  [D, 'bash', 'git push --no-verify', 'hook-bypass shape'],
  [D, 'bash', 'git -C ../other push', 'global option before the subcommand'],
  [D, 'bash', '"C:\\Program Files\\Git\\cmd\\git.exe" push', 'quoted full path to git.exe'],
  [D, 'bash', 'git status; git push', 'one bad segment refuses the chain'],
  [D, 'bash', 'git log && git commit -a', 'chain'],
  [D, 'bash', 'powershell -Command "git push"', 'unwrapped'],
  [D, 'bash', 'cmd /c git push', 'unwrapped'],
  [D, 'bash', `node -e "require('child_process').execSync('git push')"`, 'inline code text scan'],
  [D, 'bash', 'git branch x', 'positional name creates a branch'],
  [D, 'bash', 'git branch -D x'],
  [D, 'bash', 'git tag v1', 'named tag'],
  [D, 'bash', 'git config user.name x', 'key + value is a write'],
  [D, 'bash', 'git worktree add ../x'],
  [D, 'bash', 'git pull'],
  [D, 'bash', 'gh pr create --title x'],
  [D, 'bash', 'gh pr merge 1'],
  [D, 'bash', 'gh api -X POST repos/o/r/issues'],
  [D, 'bash', 'gh api -f k=v repos/o/r/issues'],
  [D, 'bash', 'git reflog expire'],
  [D, 'bash', 'git remote add x y'],
  [D, 'bash', 'git notes remove x'],
  [D, 'bash', 'git -c core.hooksPath=x status', 'hook bypass, even on a read subcommand'],
  [D, 'bash', 'gh issue create --title x'],
  [D, 'bash', 'gh run cancel 1'],
  [D, 'bash', 'gh release create v1'],
  [D, 'bash', 'gh repo delete x'],
  [D, 'bash', 'gh workflow run x'],
  [D, 'bash', 'gh gist create x'],
  [D, 'bash', 'gh secret set X'],
  [D, 'bash', 'gh variable set X'],
  [D, 'bash', 'gh alias set x y'],
  [D, 'bash', 'git push --repo=scripts/build.ps1', 'a script path as a flag value does not change the verb'],
  [D, 'bash', 'git commit -m "ran scripts/build.ps1"', 'a path inside the message does not change the verb'],
  [D, 'bash', 'git branch -D x 2>/dev/null', 'a redirection does not launder a write'],
  [D, 'bash', 'git branch feat/x', 'no --list/-l, so a name'],

  // ---- git/gh reads: allowed ------------------------------------------------
  [A, 'bash', 'git status'],
  [A, 'bash', 'git log --oneline -5'],
  [A, 'bash', 'git diff HEAD origin/main -- docs'],
  [A, 'bash', 'git fetch origin'],
  [A, 'bash', 'git show origin/main:docs/STATE.md'],
  [A, 'bash', `git grep -n x origin/main -- '*.md'`],
  [A, 'bash', 'git branch --show-current'],
  [A, 'bash', 'git branch -a'],
  [A, 'bash', 'git stash list'],
  [A, 'bash', 'git add -N newfile', 'intent-to-add records no content'],
  [A, 'bash', 'git add --intent-to-add newfile'],
  [A, 'bash', 'git config core.hooksPath', 'one key, no value: a read'],
  [A, 'bash', 'git config --get remote.origin.url'],
  [A, 'bash', 'git config --get-regexp remote.*'],
  [A, 'bash', 'git worktree list'],
  [A, 'bash', 'git rev-list --left-right --count HEAD...origin/main'],
  [A, 'bash', 'git log --grep="push"', 'a write verb inside a quoted argument of a read'],
  [A, 'bash', 'git reflog show'],
  [A, 'bash', 'git remote -v'],
  [A, 'bash', 'git notes show'],
  [A, 'bash', 'git tag -l'],
  [A, 'bash', 'gh pr list --state open'],
  [A, 'bash', 'gh pr view 512'],
  [A, 'bash', 'gh api repos/o/r/pulls/1/comments', 'GET is the default'],
  [A, 'pwsh', '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr list --state open', 'call operator + quoted path'],
  [A, 'bash', 'gh issue list'],
  [A, 'bash', 'gh run list'],
  [A, 'bash', 'gh release view v1'],
  [A, 'bash', 'gh repo view'],
  [A, 'bash', 'gh search issues x'],
  [A, 'bash', 'gh auth status'],
  [A, 'bash', 'gh --version'],
  [A, 'pwsh', '.\\scripts\\build.ps1 -Clean', 'an ordinary script'],
  [A, 'pwsh', 'powershell -File scripts\\thing.ps1', 'an ordinary script via -File'],

  // ---- redirections are not positional arguments ---------------------------
  [A, 'bash', 'git -C "$wt" branch --show-current 2>/dev/null'],
  [A, 'bash', 'git tag -l 2>&1'],
  [A, 'bash', 'git config core.hooksPath 2>/dev/null'],
  [A, 'bash', 'git branch --show-current > out.txt'],
  [A, 'bash', `git branch --list 'feat/*'`, '--list takes a pattern, still a read'],
  [A, 'bash', 'git branch -l feat/x'],

  // ---- fail closed ----------------------------------------------------------
  [D, 'bash', 'git status "unterminated', 'unterminated quote cannot be tokenized'],

  // ---- inline runners: unwrap and recurse, or text-scan ---------------------
  [D, 'bash', 'bash -c "git push"'],
  [D, 'bash', 'pwsh -c "git push"'],
  [A, 'bash', 'powershell -Command "echo hi"', 'benign payload'],
  [D, 'bash', `python -c "import os; os.system('git push')"`],
  [A, 'bash', `node -e "console.log('hi')"`],
  [D, 'bash', 'bash -lc "git push"', 'short-option cluster containing c'],
  [D, 'bash', 'sh -xc "git push"'],
  [D, 'bash', 'cmd /k git push'],
  [D, 'bash', 'powershell -Comm "git push"', 'a prefix of -Command'],
  [D, 'bash', 'powershell -EncodedCommand cQBhAHMAZAA=', 'base64 cannot be inspected'],
  [A, 'pwsh', 'powershell -File script.ps1'],
  [A, 'pwsh', 'powershell -NoProfile -Command Get-Date'],
  [A, 'bash', 'cmd /c echo hi', 'cmd switches are not paths (found while porting)'],
  [A, 'bash', 'node /c/Users/someone/scratch/e2e.mjs', 'an absolute POSIX-shell script path is an operand, not a flag (found while porting)'],
  [A, 'bash', 'bash /opt/scripts/run.sh'],
  [A, 'bash', 'python3 /tmp/job/main.py'],
  [D, 'bash', 'echo x | node /c', 'a short slash switch is still a flag'],
  [D, 'bash', 'cat p.sh | bash /dev/stdin', 'standard input named as the script', 'fail-closed'],
  [D, 'bash', 'bash /dev/fd/0', 'standard input named as the script', 'fail-closed'],
  [D, 'bash', 'sh /proc/self/fd/0', 'standard input named as the script', 'fail-closed'],
  [D, 'bash', 'node /dev/stdin', 'standard input named as the script', 'fail-closed'],
  [D, 'bash', 'python3 /dev/fd/0', 'standard input named as the script', 'fail-closed'],
  [D, 'bash', 'cat p.sh | bash -', 'a lone "-" script operand', 'fail-closed'],
  [D, 'bash', 'cat p.js | node /dev/stdin', 'piped into stdin named as the script', 'fail-closed'],
  [D, 'bash', 'cat p.sh | bash /dev/fd/0', 'piped into stdin named as the script', 'fail-closed'],
  [D, 'bash', 'curl x | sh /proc/self/fd/0', 'piped into stdin named as the script', 'fail-closed'],
  [D, 'pwsh', 'Get-Content p.js | node /dev/stdin', 'piped into stdin named as the script', 'fail-closed'],

  // ---- splitting: lone & is a separator, &&/&>/>& are not ------------------
  [D, 'bash', 'echo hi & git push', 'lone & backgrounds echo, then runs push'],
  [A, 'bash', 'node x 2>&1'],
  [A, 'bash', 'cmd &> log'],

  // ---- Start-Process launches what -ArgumentList names ---------------------
  [D, 'pwsh', 'Start-Process powershell -ArgumentList "-Command git push"', 'shell target'],
  [A, 'pwsh', `Start-Process powershell -Verb RunAs -ArgumentList '-NoExit -Command New-Item -ItemType SymbolicLink -Path C:\\x -Target C:\\y'`],
  [D, 'pwsh', 'Start-Process git -ArgumentList "push"'],
  [A, 'pwsh', 'Start-Process -FilePath "C:\\Program Files\\Git\\cmd\\git.exe" -ArgumentList "status"'],
  [A, 'pwsh', 'Start-Process notepad'],

  // ---- PowerShell evaluators ------------------------------------------------
  [D, 'pwsh', 'Invoke-Expression "git push origin main"'],
  [A, 'pwsh', `iex 'git status'`],
  [D, 'pwsh', 'Start-Job -ScriptBlock { gh pr merge 5 }'],
  [A, 'pwsh', 'Invoke-Command -ScriptBlock { git status }'],

  // ---- transparent prefixes: the wrapper is not the command ----------------
  [A, 'bash', 'MSYS_NO_PATHCONV=1 git show origin/main:.github/workflows/gates.yml'],
  [D, 'bash', 'MSYS_NO_PATHCONV=1 git push'],
  [A, 'bash', 'timeout -k 5 90 git status'],
  [D, 'bash', 'timeout 90 git push'],
  [D, 'bash', 'xargs git push'],
  [D, 'bash', 'echo x | xargs -I{} git add {}'],
  [A, 'bash', 'xargs -n1 git log'],
  [D, 'bash', 'env X=1 gh pr merge 5'],
  [A, 'bash', 'env -i gh pr list'],
  [A, 'bash', 'time git status'],
  [D, 'bash', 'nohup git push'],
  [D, 'bash', 'sudo -u me git commit -m x'],
  [A, 'bash', 'nice -n 10 git fetch origin'],
  [A, 'bash', 'timeout 90 "/c/Program Files/nodejs/node.exe" tools/x.mjs', 'an ordinary node script'],
  [A, 'bash', 'PATH="/c/Program Files/nodejs:$PATH" bash tools/hooks/pre-push', 'quoted assignment value with spaces'],
  [D, 'bash', `FOO='a b' git push`],
  [D, 'bash', `X="a b" node -p "require('child_process').execSync('git push')"`],
  [D, 'bash', 'echo origin | xargs --verbose git push', 'unrecognised wrapper flag fails closed'],
  [D, 'bash', 'timeout --kill-after=5 5 git push'],
  [D, 'bash', 'env --ignore-environment git push'],
  [A, 'bash', 'timeout 90 "/c/Program Files/nodejs/node.exe" tools/lint.mjs --errors-only'],

  // ---- spliced and quoted heads ---------------------------------------------
  [D, 'bash', 'eval git push'],
  [A, 'bash', 'eval "echo hi"'],
  [D, 'bash', 'exec git push'],
  [A, 'bash', 'exec git status'],
  [D, 'bash', 'bash', 'bare bash reads its script from stdin'],
  [D, 'bash', 'echo "git push" | bash'],
  [D, 'bash', 'bash <<< "git push"', 'here-string payload'],
  [A, 'bash', 'bash tools/hooks/pre-push', 'a named script file'],
  [A, 'bash', 'bash -c "git status"'],
  [D, 'bash', 'g\\it push', 'backslash splice'],
  [D, 'bash', 'g"it" push', 'quote splice'],
  [D, 'bash', `gi't' push`, 'quote splice'],
  [D, 'bash', 'g' + BSL + 'it.exe push origin x', 'splice with an extension'],
  [D, 'pwsh', 'g`it push origin x', 'PowerShell backtick escape in the head'],
  [D, 'pwsh', '& "g`it" push'],
  [D, 'pwsh', 'gi`t commit -m x'],
  [A, 'pwsh', '& "C:' + BSL + 'Program Files' + BSL + 'Git' + BSL + 'cmd' + BSL + 'git.exe" status', 'a real path keeps its separators'],
  [D, 'pwsh', '& "C:' + BSL + 'Program Files' + BSL + 'Git' + BSL + 'cmd' + BSL + 'git.exe" push'],
  [A, 'pwsh', 'Write-Output "a`tb"', 'backtick in an argument, not the head'],
  [D, 'bash', `$'git' push`, 'ANSI-C quoting'],
  [D, 'bash', `$"git" push`, 'locale string quoting'],

  // ---- code runners: trigger flags in every spelling -----------------------
  [D, 'bash', `node -p "require('child_process').execSync('git push origin HEAD:main')"`],
  [D, 'bash', `node --eval="require('child_process').execSync('gh pr merge 1 --admin')"`, 'attached form'],
  [D, 'bash', `node --print "require('child_process').execSync('git ' + 'x')"`, 'subprocess call + a git token, no verb'],
  [D, 'bash', `echo "require('child_process').execSync('git push')" | node`, 'stdin sink'],
  [D, 'bash', `echo "import os; os.system('git push')" | python3 -`, 'lone "-" operand'],
  [A, 'bash', 'node -p "1+1"'],
  [A, 'bash', 'node -e "console.log(1)"'],
  [A, 'bash', 'python3 -c "print(1)"'],
  [A, 'bash', `node -e "console.log(require(process.env.USERPROFILE+'/.claude/skills/x/notes.json').releases[0].version)"`, 'a path string under ~/.claude is not a protected path'],
  [A, 'bash', '"/c/Program Files/nodejs/node.exe" --test tools/hooks/guard.test.mjs'],
  [A, 'bash', 'node tools/hooks/session-start.mjs'],
  [A, 'bash', 'node tools/doc-index.mjs --check'],
  [A, 'bash', 'node --version'],
  [D, 'bash', 'node < x.js', 'input redirection, no operand'],
  [A, 'bash', 'node x.js < input.txt'],
  [D, 'bash', 'python3 < x.py'],
  [D, 'bash', 'bash < x.sh'],
  [D, 'pwsh', 'powershell < x.ps1'],
  [A, 'bash', 'bash x.sh < input.txt'],

  // ---- here-strings, groups, reserved words ---------------------------------
  [D, 'bash', `bash -c 'git push' <<< x`, 'both the -c payload and the here-string are classified'],
  [D, 'bash', `bash -c 'git push' <<< ''`],
  [D, 'bash', `bash -c 'git push' << EOF`],
  [D, 'bash', `bash -c 'rm -rf tools/hooks' <<< x`, 'protected path behind -c'],
  [D, 'bash', `bash <<<"git push"`, 'attached here-string'],
  [D, 'bash', `bash <<<'git push'`, 'attached here-string, single-quoted'],
  [D, 'bash', '(git push)'],
  [D, 'bash', '( git push )'],
  [D, 'bash', '{ git push; }'],
  [D, 'bash', 'if git push; then :; fi'],
  [D, 'bash', '! git push'],
  [A, 'bash', '(cd tools && git status)'],
  [A, 'bash', '(git diff --quiet origin/main...HEAD -- tools/hooks/pre-push && echo ok || echo changed)'],

  // ---- xargs and stdin sinks -------------------------------------------------
  [D, 'bash', `echo 'git push' | xargs -I{} bash -c {}`, 'placeholder payload'],
  [D, 'bash', `echo "'git push'" | xargs bash -c`, 'empty -c payload, xargs appends at runtime'],
  [D, 'bash', `echo 'git push' | xargs -0 bash -c`],
  [D, 'bash', `echo 'git push' | xargs -I{} sh -c {}`],
  [D, 'bash', `echo 'git push' | xargs -I{} node -e {}`],
  [D, 'bash', `echo 'git push' | xargs -I{} python -c {}`],
  [D, 'bash', `echo 'git push' | bash -s`],
  [D, 'bash', `echo 'git push' | bash -`],
  [D, 'bash', `echo 'git push' | bash --`],
  [D, 'bash', `echo 'git push' | bash -x`],
  [D, 'bash', `echo 'git push' | bash -o pipefail`],
  [D, 'bash', `echo 'git push' | sh -s`],
  [D, 'pwsh', `echo "git push" | powershell -Command -`],
  [D, 'bash', `echo "import os;os.system('git push')" | python -u`],
  [A, 'bash', 'bash -x tools/hooks/pre-push', 'flag plus a real script operand'],
  [A, 'bash', 'python3 -u script.py'],

  // ---- the raw-text backstop -------------------------------------------------
  [A, 'bash', 'grep -n "git push" docs/x.md', 'a write shape with no interpreter sink'],
  [D, 'bash', 'echo "git push" | bash -s'],

  // ---- gh api write flags in attached and "=" spellings ---------------------
  [D, 'bash', 'gh api -XPOST repos/o/r/issues'],
  [D, 'bash', 'gh api -XPUT repos/o/r/pulls/7/merge'],
  [D, 'bash', 'gh api repos/o/r/issues --field=title=x'],
  [D, 'bash', 'gh api repos/o/r/issues -ftitle=x'],
  [D, 'bash', 'gh api repos/o/r/issues -Fx=1'],
  [D, 'bash', 'gh api repos/o/r/issues --raw-field=x=1'],
  [D, 'bash', 'gh api repos/o/r/issues --input=body.json'],
  [D, 'bash', `gh api graphql -fquery='mutation{x}'`],
  [A, 'bash', 'gh api -XGET user'],
  [A, 'bash', 'gh api user --method=GET'],

  // ---- PowerShell script-block bodies ---------------------------------------
  [D, 'pwsh', 'try { git push } catch { Write-Host failed }'],
  [D, 'pwsh', 'foreach ($b in $merged) { git branch -D $b }'],
  [D, 'pwsh', 'git branch --merged main | ForEach-Object { git branch -D $_.Trim() }'],
  [D, 'pwsh', 'Get-ChildItem -Filter *.sql | ForEach-Object { git add $_ }'],
  [D, 'pwsh', 'Get-Content b.txt | % { git push origin $_ }'],
  [D, 'pwsh', 'Get-ChildItem | Where-Object { git push }'],
  [D, 'pwsh', 'Get-ChildItem | ForEach-Object { gh pr merge 1 }'],
  [D, 'pwsh', `iex 'git add -A'`],
  [D, 'pwsh', 'Invoke-Command -ScriptBlock { git add . }'],
  [A, 'pwsh', `Get-ChildItem | Where-Object { $_.Name -like '*.sql' }`, 'text-scanned, not recursed'],
  [A, 'pwsh', 'Get-ChildItem | ForEach-Object { $_.Name }'],
  [A, 'pwsh', 'try { Get-Content x } catch { }'],

  // ---- `command -v` is a lookup, not an execution ---------------------------
  ...['command -v node', 'command -V git', 'command -v git push', 'command -v node || echo not-found',
    '(command -v python3 || echo missing) && echo ok', 'command -p -v node', 'command -vp node',
    'command -pv node', 'command -v node > /dev/null', 'command -v node 2>&1',
    'command -V git > docs/tmp-lookup.txt'].map((c) => [A, 'bash', c, 'lookup']),
  ...['command git push', 'command -p git push', 'command -p git commit -m x', 'command -x git push',
    'command -- git push'].map((c) => [D, 'bash', c, 'still executes']),
  ...['command -v node > .claude/settings.json', 'command -V node >> tools/hooks/guard.mjs',
    'command -v x > .git/hooks/pre-push', 'command -v x 2> .claude/settings.local.json',
    'nohup command -V x > .claude/settings.json', 'time command -v x > .claude/settings.json',
    'command -v node >".claude/settings.json"', 'command -pv x > tools/hooks/lib/x.mjs',
    'command -v x > .claude/guardrails.json'].map((c) => [D, 'bash', c, 'a lookup must not hide a protected redirect', 'protected-paths']),

  // ---- out of scope ----------------------------------------------------------
  [A, 'bash', 'echo hi'],
  [A, 'bash', 'npm install'],

  // ===========================================================================
  // Self-protection: the guard's config, the session settings, .git/, and the
  // user's protectedPaths (here: tools/hooks).
  // ===========================================================================
  [D, 'edit', W('.claude/settings.json'), '', 'protected-paths'],
  [D, 'edit', W('.claude/settings.local.json')],
  [D, 'edit', W('.claude/guardrails.json'), 'the guard config protects itself', 'protected-paths'],
  [D, 'write', W('.claude/guardrails.json')],
  [D, 'multiedit', W('.claude/guardrails.json')],
  [D, 'edit', W('tools/hooks/guard.mjs'), 'user protectedPaths entry'],
  [D, 'edit', W('tools/hooks/lib/decide.mjs')],
  [D, 'write', W('.git/config'), 'never a write under .git/'],
  [D, 'notebook', W('.git/x.ipynb')],
  [A, 'edit', W('docs/notes.md'), 'an ordinary path'],
  [A, 'edit', W('.claude/agents/reviewer.md'), 'other files under .claude are not protected'],
  [A, 'edit', W('tools/hooks.md'), 'a sibling with a shared prefix'],
  [D, 'edit', W('tools/hooks/lib/../lib/decide.mjs'), 'dot-segment'],
  [D, 'write', W('.claude/./settings.json'), 'dot-segment'],
  [D, 'edit', W('tools/hooks/../hooks/lib/x.mjs'), 'Windows ..\\ segment'],
  [A, 'edit', W('tools/hooks/../README.md'), 'normalises out of the protected dir'],
  [D, 'edit', 'C:/Users/someone/.claude/settings.json', 'user-level settings file'],

  // ---- shell writes into protected paths ------------------------------------
  [D, 'bash', 'echo x > .claude/settings.json', 'redirection target', 'protected-paths'],
  [D, 'bash', 'echo x > .claude/guardrails.json', 'redirection target', 'protected-paths'],
  [D, 'bash', 'rm -rf tools/hooks', '', 'protected-paths'],
  [D, 'bash', 'tee tools/hooks/guard.mjs'],
  [D, 'bash', 'sed -i s/x/y/ tools/hooks/lib/decide.mjs', 'sed writes only with -i'],
  [D, 'pwsh', 'Set-Content .claude\\settings.json x'],
  [D, 'pwsh', 'Set-Content .claude\\guardrails.json "{}"'],
  [D, 'pwsh', 'Remove-Item -Recurse tools\\hooks'],
  [D, 'bash', `node -e "require('fs').writeFileSync('.claude/settings.json','{}')"`, 'payload text mentions a protected path'],
  [D, 'bash', `node -e "require('fs').writeFileSync('.claude/guardrails.json','{}')"`],
  [A, 'bash', 'cat .claude/settings.json', 'a read'],
  [A, 'bash', 'cat .claude/guardrails.json', 'a read'],
  [A, 'bash', 'grep hooks .claude/settings.json'],
  [A, 'bash', 'cat .claude/settings.json > /tmp/x', 'redirection target is not protected'],
  [D, 'bash', 'cp x .claude/./settings.json', 'dot-segment'],
  [D, 'bash', 'rm -rf tools/./hooks', 'dot-segment'],
  [D, 'bash', 'echo x > tools/hooks//guard.mjs', 'doubled separator'],
  [D, 'pwsh', '[IO.File]::WriteAllText("tools/hooks/lib/x.mjs", "x")'],
  [D, 'pwsh', '[IO.File]::WriteAllText(".claude/guardrails.json", "{}")'],
  [A, 'pwsh', '[IO.File]::ReadAllText("tools/hooks/guard.mjs")', 'a read method'],
  [D, 'bash', 'install x tools/hooks/lib/x.mjs'],
  [D, 'bash', 'dd if=x of=tools/hooks/lib/x.mjs'],
  [D, 'bash', 'patch tools/hooks/guard.mjs < p'],
  [D, 'bash', 'rsync x tools/hooks/'],
  [D, 'pwsh', 'Set-Content -Path tools\\hooks\\x.mjs -Value y'],
  [A, 'bash', 'grep -n matcher .claude/settings.json'],
  [A, 'bash', 'wc -l tools/hooks/guard.mjs tools/hooks/lib/decide.mjs'],
  [A, 'bash', '"/c/Program Files/nodejs/node.exe" --test tools/hooks/guard.test.mjs 2>&1 | tail -12'],
  [A, 'pwsh', 'Get-Content .claude\\settings.json | Select-String matcher'],
  [A, 'bash', 'cd tools/hooks && ls'],
  [A, 'bash', 'echo "FAIL tools/hooks/x"', 'echo is read-only'],
  [D, 'bash', 'sed -i s/a/b/ tools/hooks/guard.mjs'],
  [A, 'bash', 'find tools/hooks -name "*.mjs"', 'find without -delete/-exec'],
  [D, 'bash', 'find tools/hooks -delete'],
  [D, 'bash', 'awk -i inplace "{print}" tools/hooks/guard.mjs', 'gawk writes in place'],
  [D, 'bash', 'sort -o tools/hooks/guard.mjs x'],
  [D, 'bash', 'sort --output=tools/hooks/guard.mjs x'],
  [D, 'bash', 'uniq x tools/hooks/guard.mjs', 'second operand is an output file'],
  [D, 'bash', 'git diff --output=tools/hooks/lib/decide.mjs', 'git --output writes a file'],
  [D, 'bash', 'git log -1 --output .claude/settings.json'],
  [D, 'bash', 'gh run download 1 -D tools/hooks/lib', 'gh download writes files'],
  [A, 'bash', 'git show HEAD:tools/hooks/guard.mjs | head'],
  [A, 'bash', 'git log --oneline -- tools/hooks .claude/settings.json'],
  [A, 'bash', 'sort tools/hooks/x | uniq -c'],

  // ---- ancestry, globs, bare tokens, absolute spellings ---------------------
  [D, 'bash', 'rm -rf .claude'],
  [D, 'bash', 'rm -rf .claude/'],
  [D, 'bash', 'rm -rf .claude/*', 'unbounded glob'],
  [D, 'bash', 'mv .claude .claude.bak'],
  [D, 'bash', 'rmdir /s /q .claude'],
  [D, 'pwsh', 'Remove-Item -Recurse -Force .claude'],
  [D, 'bash', 'rm -rf tools', 'ancestor of a protected dir'],
  [D, 'bash', 'rm -rf tools/*'],
  [D, 'bash', 'mv tools tools.old'],
  [D, 'pwsh', 'Remove-Item -Recurse -Force tools'],
  [D, 'bash', 'find . -name settings.json -delete', 'name pattern hits a protected basename'],
  [D, 'bash', 'find . -name guardrails.json -delete'],
  [D, 'bash', 'echo .claude/settings.json | xargs rm', 'protected path piped into xargs'],
  [D, 'bash', 'rm -rf .'],
  [D, 'bash', 'rm -rf ..'],
  [D, 'bash', 'rm -rf C:/work/repo', 'the project root itself'],
  [A, 'bash', 'rm tools/lib/foo.mjs'],
  [A, 'bash', 'mkdir -p tools/newtool'],
  [A, 'bash', 'ls .claude'],
  [A, 'bash', 'git log --oneline -- tools/hooks'],
  [A, 'bash', 'cp docs/a.md docs/b.md'],
  [A, 'bash', 'rm -rf "C:/Users/someone/AppData/Local/Temp/scratch/x"', 'unrelated absolute path'],
  [A, 'bash', 'for f in tools/*.mjs; do "/c/Program Files/nodejs/node.exe" "$f" >/dev/null 2>&1 || echo "FAIL $f"; done', 'bounded glob'],
  [D, 'bash', 'rm -rf ../repo', 'relative ".." resolves onto the project dir'],
  [A, 'bash', 'rm -rf ../other/tmp', 'resolves to an unrelated sibling'],
  [D, 'bash', 'rm -r tools/hook*', 'glob segment matches "hooks"'],
  [D, 'bash', 'rm -r tools/h?oks'],
  [D, 'bash', 'rm -rf .cla*'],
  [D, 'bash', 'rm -rf tools/hooks/guard-*'],
  [A, 'bash', 'rm -rf tools/*.mjs', 'can only match a file, never the protected dir'],
  [A, 'bash', 'rm -rf tools/lib*'],
  [A, 'bash', 'cd tools && rm -rf hooks', 'ACCEPTED LIMIT: no cwd tracking across segments'],
  [D, 'bash', 'rm -rf C:/work/repo/tools', 'absolute, drive-letter form'],
  [D, 'bash', 'rm -rf /c/work/repo/tools', 'absolute, POSIX-shell drive form'],
  [D, 'bash', 'rm -rf C:/work/repo/tools/*'],
  [D, 'bash', 'rm -rf ../repo/tools'],
  [D, 'pwsh', 'Remove-Item -Recurse -Force C:\\work\\repo\\tools'],
  [D, 'bash', 'rm -rf C:/work/repo/.claude'],
  [A, 'bash', 'rm -rf C:/work/repo/tools/lib/tmp'],

  // ---- quote-attached redirection targets -----------------------------------
  [D, 'bash', 'echo x >"tools/hooks/guard.mjs"'],
  [D, 'bash', `echo x >'.claude/settings.json'`],
  [D, 'bash', 'echo x >>"tools/hooks/lib/decide.mjs"'],
  [D, 'bash', 'cat f >"tools/hooks/session-start.mjs"'],
  [D, 'bash', 'echo x 1>".claude/settings.json"'],
  [D, 'bash', 'echo x &>".claude/settings.json"'],
  [D, 'pwsh', 'echo x >"tools/hooks/guard.mjs"'],
  [D, 'bash', 'echo x >".claude/guardrails.json"'],
  [A, 'bash', 'echo x > "docs/notes.md"'],
  [A, 'bash', 'echo x >"docs/notes.md"'],

  // ---- sed / sort / git / find spellings ------------------------------------
  [D, 'bash', 'sed --in-place s/a/b/ tools/hooks/guard.mjs'],
  [D, 'bash', 'sed --in-place=.bak s/a/b/ tools/hooks/guard.mjs'],
  [D, 'bash', 'sed --i s/a/b/ tools/hooks/guard.mjs', 'abbreviated long form'],
  [D, 'bash', 'sed --in-pl s/a/b/ tools/hooks/guard.mjs'],
  [D, 'bash', 'sed -ni s/a/b/p tools/hooks/guard.mjs', 'bundled short form'],
  [D, 'bash', 'sed -ri s/a/b/ tools/hooks/guard.mjs'],
  [D, 'bash', 'sed -Ei s/a/b/ tools/hooks/guard.mjs'],
  [A, 'bash', 'sed -n 1,5p tools/hooks/guard.mjs', '-n is not in-place'],
  [A, 'bash', 'sed -e s/a/b/ docs/x.md'],
  [A, 'bash', 'sort tools/hooks/x'],
  [D, 'bash', 'git diff --outp=tools/hooks/lib/decide.mjs', 'unambiguous prefix of --output'],
  [A, 'bash', 'git log --oneline -- tools/hooks', '--oneline must not match --out'],
  [D, 'bash', 'sort --o=tools/hooks/guard.mjs x'],
  [D, 'bash', String.raw`find tools/hooks -okdir echo {} \;`],
  [D, 'bash', 'find tools/hooks -fls tools/hooks/out.txt'],

  // ---- PowerShell comma lists and colon-bound parameters --------------------
  [D, 'pwsh', 'Remove-Item tools/hooks,tools/lib -Recurse -Force'],
  [D, 'pwsh', 'Remove-Item notes.md,tools/hooks/guard.mjs'],
  [D, 'pwsh', 'Remove-Item notes.md,.claude/settings.json -Force'],
  [D, 'pwsh', 'Set-Content -Path notes.md,tools/hooks/guard.mjs -Value x'],
  [D, 'pwsh', 'Out-File -FilePath notes.md,tools/hooks/lib/decide.mjs'],
  [D, 'pwsh', 'Remove-Item -Path:tools/hooks'],
  [D, 'pwsh', 'Remove-Item -LiteralPath:.claude/settings.json'],
  [D, 'pwsh', 'Set-Content -Path:tools/hooks/guard.mjs -Value x'],
  [D, 'bash', 'rm -rf tools/hooks,tools/lib', 'ACCEPTED false deny: bash has no comma lists'],

  // ---- evaluators that name a protected path --------------------------------
  [D, 'pwsh', `iex 'Remove-Item -Recurse -Force tools/hooks'`],
  [D, 'pwsh', 'Invoke-Command -ScriptBlock { Remove-Item .claude/settings.json }'],
  [D, 'pwsh', 'Invoke-Command -ScriptBlock { Remove-Item .claude/guardrails.json }'],

  // ---- PowerShell pipelines feeding a write cmdlet --------------------------
  [D, 'pwsh', 'Get-ChildItem tools/hooks -Recurse | Remove-Item -Force -Recurse'],
  [D, 'pwsh', 'Get-ChildItem .claude -Recurse | Remove-Item -Force'],
  [D, 'pwsh', 'Get-ChildItem .claude/settings.json | Remove-Item -Force'],
  [D, 'pwsh', 'Get-Item .claude/settings.json | Remove-Item -Force'],
  [D, 'pwsh', 'Get-ChildItem tools/hooks/lib -Filter *.mjs | Remove-Item'],
  [D, 'pwsh', 'Get-ChildItem tools/hooks | Set-Content -Value x'],
  [D, 'pwsh', 'Get-ChildItem tools/hooks | Clear-Content'],
  [D, 'pwsh', 'Get-ChildItem tools/hooks | Move-Item -Destination x'],
  [A, 'pwsh', 'Get-ChildItem tools/hooks | Select-Object Name'],
  [A, 'pwsh', 'Get-ChildItem docs | Remove-Item -WhatIf'],
  [A, 'bash', 'ls tools/hooks | wc -l'],
];

// ---- five everyday shapes measured as FALSE denies of an earlier version.
// They are accepted, not fixed: each is a fail-closed rule firing on a shape
// that cannot hide an invocation, and relaxing each one was measured to open
// a new bypass in review. Four are still refused by this guard; the fifth
// (`<tool> -v 2>&1`) was refused only by an arm this plugin does not ship.
CASES.push(
  [D, 'pwsh', '$x = 5', 'ACCEPTED false deny: PowerShell assignment, head holds "$"', FC_ARM],
  [D, 'pwsh', `$u = [Environment]::GetEnvironmentVariable('Path','User')`, 'ACCEPTED false deny: PowerShell assignment', FC_ARM],
  [D, 'pwsh', `'--- machine ---'`, 'ACCEPTED false deny: bare quoted literal used as output', FC_ARM],
  [D, 'bash', `b=$(grep -lE 'x' f)`, 'ACCEPTED false deny: $( ) capture with a flag inside', FC_ARM],
  [D, 'bash', "cat > notes.md <<'EOF'\nrun git push when done\nEOF", 'ACCEPTED false deny: heredoc whose text names a git write verb', 'git-writes'],
  [A, 'bash', 'node -v 2>&1', 'the fifth shape: refused only by a database-tool arm this plugin does not ship'],
);

function label([expect, tool, input, note]) {
  return `${tool}: ${input} -> ${expect}${note ? ` (${note})` : ''}`;
}

// ---------------------------------------------------------------------------
// The table, guard enabled.
// ---------------------------------------------------------------------------
for (const row of CASES) {
  const [expect, tool, input, , arm] = row;
  test(label(row), () => {
    const v = call(tool, input);
    if (expect === A) {
      assert.equal(v.allow, true, `expected allow, got deny [${v.arm}] ${v.reason}`);
    } else {
      assert.equal(v.allow, false, 'expected deny, got allow');
      assert.equal(typeof v.reason, 'string');
      assert.ok(v.reason.length > 0, 'a deny carries a reason');
      if (arm) assert.equal(v.arm, arm, `expected arm ${arm}, got ${v.arm}: ${v.reason}`);
    }
  });
}

// ---------------------------------------------------------------------------
// A disabled guard is a true no-op: every former deny allows.
// ---------------------------------------------------------------------------
for (const row of CASES.filter((r) => r[0] === D)) {
  test(`disabled guard: ${row[1]}: ${row[2]} -> allow`, () => {
    assert.deepEqual(call(row[1], row[2], OFF), { allow: true });
  });
}
test('no config at all -> allow (off is the default)', () => {
  assert.deepEqual(decide({ tool_name: 'Bash', tool_input: { command: 'git push' } }), { allow: true });
  assert.deepEqual(decide({ tool_name: 'Bash', tool_input: { command: 'git push' } }, {}), { allow: true });
});

// ---------------------------------------------------------------------------
// Arms: with git-writes off, git writes pass but self-protection stays on.
// ---------------------------------------------------------------------------
test('arms [] : git push -> allow', () => assert.equal(call('bash', 'git push', PATHS_ONLY).allow, true));
test('arms [] : gh pr merge 1 -> allow', () => assert.equal(call('bash', 'gh pr merge 1', PATHS_ONLY).allow, true));
test('arms [] : edit guardrails.json -> still deny', () => {
  const v = call('edit', W('.claude/guardrails.json'), PATHS_ONLY);
  assert.equal(v.allow, false);
  assert.equal(v.arm, 'protected-paths');
});
test('arms [] : echo x > .claude/settings.json -> still deny', () => assert.equal(call('bash', 'echo x > .claude/settings.json', PATHS_ONLY).allow, false));
test('arms [] : rm -rf tools/hooks -> still deny', () => assert.equal(call('bash', 'rm -rf tools/hooks', PATHS_ONLY).allow, false));
test('arms [] : git diff --output=.claude/settings.json -> still deny (a file write, not a git write)', () => {
  assert.equal(call('bash', 'git diff --output=.claude/settings.json', PATHS_ONLY).allow, false);
});
// Independent review: git worktree writers rewrite their path operands, so
// protected-paths must refuse them even with the git-writes arm off.
for (const c of ['git checkout HEAD -- .claude/settings.json', 'git restore .claude/settings.json',
  'git restore --source=HEAD~1 .claude/guardrails.json', 'git rm .claude/guardrails.json',
  'git mv .claude/settings.json x.json', 'git clean -fdx tools/hooks', 'git checkout .']) {
  test(`arms [] : ${c} -> still deny (protected-paths)`, () => {
    const v = call('bash', c, PATHS_ONLY);
    assert.equal(v.allow, false, 'expected deny');
    assert.equal(v.arm, 'protected-paths', v.reason);
  });
}
for (const c of ['git log -- .claude/settings.json', 'git diff HEAD -- tools/hooks', 'git checkout -b feat/x', 'git restore docs/notes.md']) {
  test(`arms [] : ${c} -> allow (a read, or no protected operand)`, () => assert.equal(call('bash', c, PATHS_ONLY).allow, true));
}
test('unknown arm name is ignored, git-writes still on', () => {
  const v = call('bash', 'git push', { guard: { enabled: true, arms: ['git-writes', 'no-such-arm'], protectedPaths: [] } });
  assert.equal(v.allow, false);
});

// ---------------------------------------------------------------------------
// protectedPaths spelling: backslashes, ./ prefix, trailing slash, absolute.
// ---------------------------------------------------------------------------
for (const spelling of ['tools\\hooks', './tools/hooks', 'tools/hooks/', 'C:\\work\\repo\\tools\\hooks']) {
  test(`protectedPaths spelled "${spelling}" protects tools/hooks`, () => {
    const cfg = { guard: { enabled: true, arms: ['git-writes'], protectedPaths: [spelling] } };
    assert.equal(call('edit', W('tools/hooks/a.mjs'), cfg).allow, false);
    assert.equal(call('bash', 'rm -rf tools/hooks', cfg).allow, false);
    assert.equal(call('edit', W('tools/other.mjs'), cfg).allow, true);
  });
}
test('protectedPaths empty: only the fixed set is protected', () => {
  const cfg = { guard: { enabled: true, arms: ['git-writes'], protectedPaths: [] } };
  assert.equal(call('edit', W('tools/hooks/a.mjs'), cfg).allow, true);
  assert.equal(call('edit', W('.claude/guardrails.json'), cfg).allow, false);
});
test('the plugin\'s own install directory is not protected', () => {
  assert.equal(call('edit', 'C:/Users/someone/.claude/plugins/cache/x/agent-repo-guardrails/lib/decide.mjs').allow, true);
});

// ---------------------------------------------------------------------------
// Tool dispatch and fail-closed inputs.
// ---------------------------------------------------------------------------
test('unknown tool -> allow (outside the guard\'s scope)', () => {
  assert.deepEqual(decide({ tool_name: 'Read', tool_input: { file_path: '.claude/settings.json' } }, ON), { allow: true });
  assert.deepEqual(decide({ tool_name: 'SomeOtherTool', tool_input: {} }, ON), { allow: true });
});
test('Bash with no command field -> deny', () => assert.equal(decide({ tool_name: 'Bash', tool_input: {} }, ON).allow, false));
test('PowerShell with no command field -> deny', () => assert.equal(decide({ tool_name: 'PowerShell', tool_input: { description: 'x' } }, ON).allow, false));
test('Edit with no file_path -> deny', () => assert.equal(decide({ tool_name: 'Edit', tool_input: {} }, ON).allow, false));
test('no tool_name -> deny', () => assert.equal(decide({ tool_input: { command: 'git status' } }, ON).allow, false));
test('internal exception (throwing getter) -> deny naming an internal error', () => {
  const throwing = { get command() { throw new Error('boom'); } };
  const v = decide({ tool_name: 'Bash', tool_input: throwing }, ON);
  assert.equal(v.allow, false);
  assert.match(v.reason, /internal error/i);
});
test('session-start self-test contract: bare payload, no projectDir', () => {
  const cfg = { guard: { enabled: true, arms: ['git-writes'], protectedPaths: [] } };
  const push = decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } }, cfg);
  assert.equal(push.allow, false);
  assert.deepEqual(decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } }, cfg), { allow: true });
});
test('git push refusal text names the command and the hand-over', () => {
  const v = call('bash', 'git push origin main');
  assert.equal(v.arm, 'git-writes');
  assert.match(v.reason, /git push/);
});
test('tokenizeAll splits on whitespace and respects quotes', () => {
  assert.deepEqual(tokenizeAll('a b "c d" e'), ['a', 'b', 'c d', 'e']);
  assert.deepEqual(tokenizeAll(''), []);
  assert.deepEqual(tokenizeAll('  '), []);
});

// ---------------------------------------------------------------------------
// The matcher in hooks/hooks.json is anchored: an unanchored matcher is a
// substring match, and was measured matching BashOutput and KillBash, which
// then reached the guard and could never be used.
// ---------------------------------------------------------------------------
test('hooks.json PreToolUse matcher covers exactly the guarded tools', () => {
  const hooks = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const entry = hooks.hooks.PreToolUse.find((e) => e.hooks.some((h) => (h.args || []).some((a) => a.includes('guard.mjs'))));
  assert.ok(entry, 'expected a PreToolUse entry wiring guard.mjs');
  const re = new RegExp(entry.matcher);
  for (const name of ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']) assert.ok(re.test(name), name);
  for (const name of ['BashOutput', 'KillBash', 'Read', 'Glob', 'Grep', 'Agent', 'TodoWrite', 'WebFetch']) assert.ok(!re.test(name), name);
});

// ---------------------------------------------------------------------------
// The hook script, end to end, as a subprocess. CLAUDE_PROJECT_DIR points at a
// temp project so the user's real config is never read.
// ---------------------------------------------------------------------------
function tempProject(configText) {
  const dir = mkdtempSync(path.join(tmpdir(), 'guardrails-proj-'));
  if (configText !== undefined) {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'guardrails.json'), configText);
  }
  return dir;
}
function runGuard(script, projectDir, stdin) {
  return spawnSync(process.execPath, [script], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  });
}
const payload = (command, cwd) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });
const ENABLED_JSON = JSON.stringify({ guard: { enabled: true } });

test('guard.mjs: no config (guard off) + git push -> exit 0, silent', () => {
  const dir = tempProject();
  try {
    const r = runGuard(GUARD_SCRIPT, dir, payload('git push', dir));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: enabled + git push -> exit 2, reason and hand-over on stderr, no stdout', () => {
  const dir = tempProject(ENABLED_JSON);
  try {
    const r = runGuard(GUARD_SCRIPT, dir, payload('git push origin main', dir));
    assert.equal(r.status, 2, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /BLOCKED/);
    assert.match(r.stderr, /git push/);
    assert.match(r.stderr, /hand this command to a human/i);
    assert.equal(r.stdout, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: enabled + git status -> exit 0, silent', () => {
  const dir = tempProject(ENABLED_JSON);
  try {
    const r = runGuard(GUARD_SCRIPT, dir, payload('git status', dir));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: enabled + Edit of the guard config -> exit 2', () => {
  const dir = tempProject(ENABLED_JSON);
  try {
    const stdin = JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, '.claude', 'guardrails.json') }, cwd: dir });
    const r = runGuard(GUARD_SCRIPT, dir, stdin);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /protected-paths/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: enabled + stdin not JSON -> exit 2 (fail closed)', () => {
  const dir = tempProject(ENABLED_JSON);
  try {
    const r = runGuard(GUARD_SCRIPT, dir, 'not json {');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not valid JSON/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: disabled + stdin not JSON -> exit 0 (a disabled guard is a no-op)', () => {
  const dir = tempProject();
  try {
    const r = runGuard(GUARD_SCRIPT, dir, 'not json {');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: unparseable config file -> defaults (guard off) -> exit 0', () => {
  const dir = tempProject('{ "guard": { "enabled": true, ');
  try {
    const r = runGuard(GUARD_SCRIPT, dir, payload('git push', dir));
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: config with unknown keys still works (enabled -> git push exit 2)', () => {
  const dir = tempProject(JSON.stringify({ colour: 'blue', guard: { enabled: true, extra: 1 } }));
  try {
    assert.ok(loadConfig(dir).warnings.some((w) => /unknown key/.test(w)), 'loadConfig reports the unknown keys');
    const r = runGuard(GUARD_SCRIPT, dir, payload('git push', dir));
    assert.equal(r.status, 2, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: guard.enabled not a boolean -> treated as off -> exit 0', () => {
  const dir = tempProject(JSON.stringify({ guard: { enabled: 'yes' } }));
  try {
    const r = runGuard(GUARD_SCRIPT, dir, payload('git push', dir));
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: CLAUDE_PLUGIN_ROOT with backslashes does not matter (script resolves its own modules)', () => {
  const dir = tempProject(ENABLED_JSON);
  try {
    const r = spawnSync(process.execPath, [GUARD_SCRIPT], {
      input: payload('git push', dir),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT.split('/').join(BSL) },
    });
    assert.equal(r.status, 2, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Independent review: if the stderr write throws (stderr closed), block()
// used to throw too and the process exited 1 -- which fails OPEN. A
// read-only handle as stderr makes every write fail.
test('guard.mjs: enabled + git push with an unwritable stderr -> still exit 2', () => {
  const dir = tempProject(ENABLED_JSON);
  const roFile = path.join(dir, 'ro.txt');
  writeFileSync(roFile, '');
  const fd = openSync(roFile, 'r');
  try {
    const r = spawnSync(process.execPath, [GUARD_SCRIPT], {
      input: payload('git push', dir),
      stdio: ['pipe', 'pipe', fd],
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    });
    assert.equal(r.status, 2, `got ${r.status}`);
  } finally { closeSync(fd); rmSync(dir, { recursive: true, force: true }); }
});

// A decision module that fails to parse, or is missing, must REFUSE when the
// guard is on: measured on an earlier version with a static import, node died
// before any try block ran and exited 1 -- which the hooks contract treats as
// a non-blocking error, so the tool call went through. Runs a COPY of the
// plugin's script beside a temp lib/.
function brokenPluginCopy(decideText) {
  const root = mkdtempSync(path.join(tmpdir(), 'guardrails-plugin-'));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'lib'));
  copyFileSync(GUARD_SCRIPT, path.join(root, 'scripts', 'guard.mjs'));
  copyFileSync(path.join(PLUGIN_ROOT, 'lib', 'config.mjs'), path.join(root, 'lib', 'config.mjs'));
  if (decideText !== undefined) writeFileSync(path.join(root, 'lib', 'decide.mjs'), decideText);
  return root;
}
test('guard.mjs: enabled + corrupted decision module -> exit 2 (fail closed)', () => {
  const root = brokenPluginCopy('this is not javascript (\n');
  const dir = tempProject(ENABLED_JSON);
  try {
    const r = runGuard(path.join(root, 'scripts', 'guard.mjs'), dir, payload('git status', dir));
    assert.equal(r.status, 2, `got ${r.status}`);
    assert.match(r.stderr, /decision module failed to load/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: enabled + missing decision module -> exit 2 (fail closed)', () => {
  const root = brokenPluginCopy();
  const dir = tempProject(ENABLED_JSON);
  try {
    const r = runGuard(path.join(root, 'scripts', 'guard.mjs'), dir, payload('git status', dir));
    assert.equal(r.status, 2, `got ${r.status}`);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: disabled + corrupted decision module -> exit 0 (never loaded)', () => {
  const root = brokenPluginCopy('this is not javascript (\n');
  const dir = tempProject();
  try {
    const r = runGuard(path.join(root, 'scripts', 'guard.mjs'), dir, payload('git push', dir));
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: enabled + corrupted config module -> exit 2 (fallback reads the file directly)', () => {
  const root = brokenPluginCopy(readFileSync(path.join(PLUGIN_ROOT, 'lib', 'decide.mjs'), 'utf8'));
  writeFileSync(path.join(root, 'lib', 'config.mjs'), 'export const = ;\n');
  const dir = tempProject(ENABLED_JSON);
  try {
    const r = runGuard(path.join(root, 'scripts', 'guard.mjs'), dir, payload('git status', dir));
    assert.equal(r.status, 2, `got ${r.status}`);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});
test('guard.mjs: disabled + corrupted config module -> exit 0', () => {
  const root = brokenPluginCopy(readFileSync(path.join(PLUGIN_ROOT, 'lib', 'decide.mjs'), 'utf8'));
  writeFileSync(path.join(root, 'lib', 'config.mjs'), 'export const = ;\n');
  const dir = tempProject();
  try {
    const r = runGuard(path.join(root, 'scripts', 'guard.mjs'), dir, payload('git push', dir));
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true }); }
});
