// lib/decide.mjs -- the pure decision function behind the optional guard.
//
//   decide(input, config) -> { allow: true } | { allow: false, reason, arm }
//
// `input` is the PreToolUse payload (tool_name, tool_input) plus, optionally,
// `projectDir` (scripts/guard.mjs passes it; without it the absolute-path
// checks that need the project root are skipped). `config` is the object
// lib/config.mjs returns. The guard is OFF unless config.guard.enabled is
// exactly true -- a disabled guard returns { allow: true } before looking at
// anything else.
//
// Arms:
//   git-writes       (config.guard.arms) the agent hands every git/gh write to
//                    a human. Mostly an allowlist: a git subcommand or gh
//                    noun not on the read-only list is refused and named.
//                    Documented limits -- what the list lets through that can
//                    still write: `git remote` and `git reflog` are handled
//                    as denylists (named write verbs refused, anything else
//                    allowed, e.g. `git remote prune`); `git fetch` updates
//                    remote-tracking refs; `git config <key>` with one
//                    operand is read as a read; `git add -N` records an
//                    empty intent-to-add entry in the index.
//   protected-paths  always on while the guard is on. The agent may not write
//                    the guard's own config (.claude/guardrails.json), the
//                    session settings (.claude/settings.json,
//                    .claude/settings.local.json), anything under .git/, or
//                    any path in config.guard.protectedPaths -- by Edit/Write
//                    or through the shell. The plugin's own install directory
//                    is NOT protected: it does not live in the user's repo.
//   fail-closed      a shape the tokenizer cannot classify safely (an
//                    unterminated quote, a script read from stdin, a head that
//                    still holds a shell metacharacter after de-splicing) is
//                    refused rather than guessed at.
//
// What a text-matching guard cannot do (measured, and kept as tests where a
// test can show it): it does not track the working directory across chained
// segments (`cd tools && rm -rf hooks` is allowed); it cannot see what a
// variable expands to at run time; it cannot read a heredoc body from a single
// line; it does not know the direction of a file argument (`cp <protected> x`
// is refused although it only reads). Every one of those is why the guard is
// one layer, never the only one.

import path from 'node:path';

const ALLOW = Object.freeze({ allow: true });
function allow() { return ALLOW; }
function deny(reason, arm) { return { allow: false, reason, arm }; }
const GW = 'git-writes';
const PP = 'protected-paths';
const FC = 'fail-closed';

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

// Quote-aware, whitespace-delimited tokenizer, used once a segment's head is
// known. NOT used for the top-level chain split, which has to respect shell
// control operators instead of plain whitespace.
export function tokenizeAll(s) {
  const tokens = [];
  const str = String(s || '');
  const n = str.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(str[i])) i++;
    if (i >= n) break;
    if (str[i] === '"' || str[i] === "'") {
      const q = str[i];
      let j = i + 1;
      while (j < n && str[j] !== q) j++;
      tokens.push(str.slice(i + 1, j));
      i = j + 1;
    } else {
      let j = i;
      while (j < n && !/\s/.test(str[j])) j++;
      tokens.push(str.slice(i, j));
      i = j;
    }
  }
  return tokens;
}

// First whitespace-delimited token of a segment, quote-aware, plus the
// trimmed remainder.
function firstToken(seg) {
  const s = String(seg || '').replace(/^\s+/, '');
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    const end = s.indexOf(q, 1);
    if (end === -1) return { token: s.slice(1), rest: '' };
    return { token: s.slice(1, end), rest: s.slice(end + 1).replace(/^\s+/, '') };
  }
  const m = s.match(/^\S+/);
  if (!m) return { token: '', rest: '' };
  return { token: m[0], rest: s.slice(m[0].length).replace(/^\s+/, '') };
}

// A leading PowerShell call operator ("& cmd", "&cmd").
function stripCallOperator(seg) {
  const s = String(seg || '').replace(/^\s+/, '');
  if (s[0] === '&') return s.slice(1).replace(/^\s+/, '');
  return s;
}

// The chain split does not track bracket depth, so `( a && b )` and
// `{ a; b; }` arrive split across sibling segments, each carrying a stray
// unpaired "(" / "{" or ")" / "}". Left alone, "(git" is not "git" and the
// real head is never recognised. Strips one stray bracket only when the
// segment's own count is unbalanced in that direction, so a balanced
// construct such as $( ... ) is untouched.
function stripStrayGroupingParens(seg) {
  let s = String(seg || '');
  for (const [open, close] of [['(', ')'], ['{', '}']]) {
    if (s[0] === open) {
      const opens = s.split(open).length - 1;
      const closes = s.split(close).length - 1;
      if (opens > closes) s = s.slice(1).replace(/^\s+/, '');
    }
  }
  for (const [open, close] of [['(', ')'], ['{', '}']]) {
    if (s[s.length - 1] === close) {
      const opens = s.split(open).length - 1;
      const closes = s.split(close).length - 1;
      if (closes > opens) s = s.slice(0, -1).replace(/\s+$/, '');
    }
  }
  return s;
}

// A balanced ( ... ) / { ... } wrapping the WHOLE segment (`(git push)`) is
// transparent to what runs. Strips the outermost pair only when its matching
// close is the segment's last character, so "(a) (b)" is untouched.
function stripBalancedEnclosingGroup(seg) {
  let s = String(seg || '').trim();
  while (s[0] === '(' || s[0] === '{') {
    const open = s[0];
    const close = open === '(' ? ')' : '}';
    let depth = 0;
    let matchIdx = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === open) depth++;
      else if (s[i] === close) {
        depth--;
        if (depth === 0) { matchIdx = i; break; }
      }
    }
    if (matchIdx === -1 || matchIdx !== s.length - 1) break;
    s = s.slice(1, matchIdx).trim();
  }
  return s;
}

// Executable basename: directory prefix (\ or /) and a trailing .exe
// stripped, lower-cased. "C:\Program Files\Git\cmd\git.exe" -> "git".
function baseName(token) {
  const parts = String(token || '').split(/[\\/]/);
  let b = parts[parts.length - 1] || '';
  b = b.replace(/\.exe$/i, '');
  return b.toLowerCase();
}

// The shell reassembles a spliced head (`g\it`, `g"it"`, `gi't'`, PowerShell's
// g`it, bash's $'git') into the literal word before it runs; this undoes the
// same splicing before the head is compared. A backslash is kept when the
// token looks like a genuine Windows path, so baseName() can still split it.
function despliceHeadToken(token) {
  const raw = String(token || '');
  let base = raw;
  // $'...' (ANSI-C quoting) and $"..." evaluate to a plain string. A bare
  // $name is a variable this guard cannot resolve, and is left alone.
  if (base[0] === '$' && (base[1] === '"' || base[1] === "'")) base = base.slice(1);
  let t = base.replace(/['"`]/g, '');
  const looksLikeWindowsPath =
    /^[A-Za-z]:[\\/]/.test(base) || /^\\\\/.test(base) || /\.(exe|ps1|mjs|cjs|js|sh|bat|cmd)$/i.test(t);
  if (!looksLikeWindowsPath) t = t.replace(/\\/g, '');
  return t;
}

// After every de-splicing step, a head that still holds a shell
// metacharacter cannot be trusted as an executable name: refuse rather than
// let it reach the "nothing guarded here" default. This is the general
// backstop for whatever splicing shape is found next.
const SUSPICIOUS_HEAD_CHARS_RE = /[$(){}'"|;<>`]/;

// ---------------------------------------------------------------------------
// Top-level command splitting
//
// Split on newline, ;, &&, ||, | and a LONE & (a background job: measured,
// `echo hi & git push` used to classify as one opaque segment). NOT on & in
// &&, &>, >&, <& -- redirections. Quote-aware; an unterminated quote is
// reported so the caller can refuse rather than guess.
// ---------------------------------------------------------------------------
function splitSegments(cmd) {
  const s = String(cmd || '');
  const segments = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inSingle) { cur += c; if (c === "'") inSingle = false; continue; }
    if (inDouble) { cur += c; if (c === '"' && s[i - 1] !== '\\') inDouble = false; continue; }
    if (c === "'") { inSingle = true; cur += c; continue; }
    if (c === '"') { inDouble = true; cur += c; continue; }
    if (c === '\n' || c === ';') { segments.push(cur); cur = ''; continue; }
    if (c === '&' && s[i + 1] === '&') { segments.push(cur); cur = ''; i++; continue; }
    if (c === '&' && s[i + 1] === '>') { cur += c; continue; }
    if (c === '&' && (s[i - 1] === '>' || s[i - 1] === '<')) { cur += c; continue; }
    if (c === '&') { segments.push(cur); cur = ''; continue; }
    if (c === '|' && s[i + 1] === '|') { segments.push(cur); cur = ''; i++; continue; }
    if (c === '|') { segments.push(cur); cur = ''; continue; }
    cur += c;
  }
  segments.push(cur);
  return { segments: segments.map((x) => x.trim()).filter(Boolean), unterminated: inSingle || inDouble };
}

// Payloads of every $( ... ) and `...` substitution in a segment, so an
// invocation hidden inside one is classified too.
function extractSubstitutions(seg) {
  const s = String(seg || '');
  const out = [];
  let i = 0;
  while ((i = s.indexOf('$(', i)) !== -1) {
    let depth = 1;
    let j = i + 2;
    while (j < s.length && depth > 0) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')') depth--;
      j++;
    }
    out.push(s.slice(i + 2, Math.max(i + 2, j - 1)));
    i = j;
  }
  let k = 0;
  for (;;) {
    const start = s.indexOf('`', k);
    if (start === -1) break;
    const end = s.indexOf('`', start + 1);
    if (end === -1) break;
    out.push(s.slice(start + 1, end));
    k = end + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Redirections: `2>/dev/null` after a git subcommand's arguments was read by
// the strict per-subcommand parsers as an extra positional argument (a
// measured false deny). Dropped from the argument list; their TARGET is
// checked separately against the protected paths.
// ---------------------------------------------------------------------------
const REDIRECT_RE = /^(\d*>{1,2}&?\d*|\d*<|&>|<<<?)/;
const BARE_REDIRECT_RE = /^\d*>{1,2}$|^\d*<$/;

function stripRedirections(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (REDIRECT_RE.test(tok)) { i += BARE_REDIRECT_RE.test(tok) ? 2 : 1; continue; }
    out.push(tok);
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transparent prefixes: a wrapper that just runs its argument (an assignment,
// env, time, nohup, exec, sudo, nice, timeout, xargs, bash reserved words)
// puts the real command somewhere other than the first token. Peeled
// iteratively before the head is read.
// ---------------------------------------------------------------------------
function tryConsumeArgFlag(s, flagNames) {
  const p = firstToken(s);
  if (!p.token) return null;
  for (const f of flagNames) {
    if (p.token === f) return firstToken(p.rest).rest;
    if (p.token.startsWith(f) && p.token.length > f.length) return p.rest;
  }
  return null;
}
function tryConsumeBareFlag(s, flagNames) {
  const p = firstToken(s);
  if (!p.token || !flagNames.includes(p.token)) return null;
  return p.rest;
}
function stripFlags(s, argFlags, bareFlags) {
  for (;;) {
    let next = tryConsumeArgFlag(s, argFlags);
    if (next !== null) { s = next; continue; }
    next = tryConsumeBareFlag(s, bareFlags);
    if (next !== null) { s = next; continue; }
    break;
  }
  return s;
}

// One leading NAME=value assignment, quote-aware: a value may be a quoted
// span holding spaces (`PATH="/c/Program Files/nodejs:$PATH" bash x`), which a
// plain whitespace split mis-reads.
function consumeAssignment(s) {
  const str = String(s || '');
  const m = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(str);
  if (!m) return null;
  let i = m[0].length;
  while (i < str.length) {
    const c = str[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < str.length && str[j] !== c) j++;
      i = j < str.length ? j + 1 : str.length;
      continue;
    }
    if (/\s/.test(c)) break;
    i++;
  }
  return str.slice(i).replace(/^\s+/, '');
}

function unwrapTransparentPrefixes(segString) {
  let s = String(segString || '');
  for (;;) {
    const assignRest = consumeAssignment(s);
    if (assignRest !== null) { s = assignRest; continue; }
    const { token, rest } = firstToken(s);
    if (!token) break;
    const tl = token.toLowerCase();
    if (tl === 'env') {
      s = stripFlags(rest, ['-u', '--unset='], ['-i']);
      for (;;) {
        const r = consumeAssignment(s);
        if (r === null) break;
        s = r;
      }
      continue;
    }
    if (tl === 'time') { s = stripFlags(rest, [], ['-p']); continue; }
    // `command -v NAME` / `-V` only look a name up; nothing executes. Only the
    // looked-up NAME is dropped: whatever follows (a redirection into a
    // protected path, measured as a bypass of the first version of this
    // exemption) is re-headed with the inert `echo` so every redirection
    // check still sees it. `command -p` executes, so it keeps unwrapping.
    if (tl === 'command') {
      let cur = rest;
      let lookup = false;
      for (;;) {
        const r = firstToken(cur);
        if (!r.token || !/^-[pvV]+$/.test(r.token)) break;
        if (/[vV]/.test(r.token)) lookup = true;
        cur = r.rest;
      }
      if (lookup) {
        const afterName = firstToken(cur).rest;
        s = afterName ? `echo ${afterName}` : 'echo';
        break;
      }
      s = cur;
      continue;
    }
    if (['nohup', 'exec', 'builtin', 'doas'].includes(tl)) { s = rest; continue; }
    // `if git push; then :; fi` and `! git push` still run git push.
    if (['!', 'if', 'then', 'elif', 'else', 'fi', 'do', 'done', 'while', 'until'].includes(tl)) { s = rest; continue; }
    if (tl === 'sudo') { s = stripFlags(rest, ['-u'], ['-E', '-n', '-S', '-H']); continue; }
    if (tl === 'nice') {
      s = stripFlags(rest, ['-n'], []);
      const p = firstToken(s);
      if (p.token && /^-\d+$/.test(p.token)) s = p.rest;
      continue;
    }
    if (tl === 'ionice') { s = stripFlags(rest, ['-c', '-n'], []); continue; }
    if (tl === 'timeout') {
      s = stripFlags(rest, ['-k', '-s'], ['--preserve-status', '--foreground', '-v']);
      const dur = firstToken(s);
      if (dur.token) s = dur.rest;
      continue;
    }
    // A bare xargs runs echo, which is inert.
    if (tl === 'xargs') {
      s = stripFlags(rest, ['-I', '-n', '-P', '-L', '-d', '-a', '-E', '-s'], ['-0', '-r', '-t', '-p', '-x']);
      continue;
    }
    break;
  }
  return s;
}

const MAX_DEPTH = 6; // unwrap-and-recurse depth; exceeding it refuses.

// ---------------------------------------------------------------------------
// git -- read-only allowlist
// ---------------------------------------------------------------------------
const GIT_GLOBAL_OPTS_WITH_ARG = new Set(['-C', '-c']);
const GIT_GLOBAL_OPTS_BARE = new Set(['--no-pager', '-p']);
const GIT_GLOBAL_OPTS_PREFIX = ['--git-dir=', '--work-tree='];

function skipGitGlobalOptions(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (GIT_GLOBAL_OPTS_WITH_ARG.has(t)) { i += 2; continue; }
    if (GIT_GLOBAL_OPTS_BARE.has(t)) { i += 1; continue; }
    if (GIT_GLOBAL_OPTS_PREFIX.some((p) => t.startsWith(p))) { i += 1; continue; }
    break;
  }
  return i;
}

// Hook-bypass shapes are refused whatever subcommand they ride on.
const HOOK_BYPASS_RE = /--no-verify\b|-c\s+core\.hooksPath\s*=/i;

const GIT_READONLY_BARE = new Set([
  'status', 'log', 'diff', 'show', 'fetch', 'grep', 'ls-files', 'ls-tree',
  'rev-parse', 'rev-list', 'merge-base', 'blame', 'shortlog', 'describe',
  'check-ignore', 'cat-file', 'name-rev', 'for-each-ref', 'count-objects',
  'diff-tree', 'range-diff', 'cherry', 'help', 'version',
]);
const GIT_BRANCH_ALLOWED_FLAGS = new Set([
  '--show-current', '-a', '-l', '--list', '-v', '-vv', '-r', '--contains', '--merged', '--no-merged',
]);

function gitDeny(what) {
  return deny(`${what} -- hand this command to a human; read-only forms are allowed`, GW);
}

function classifyGit(rest) {
  if (HOOK_BYPASS_RE.test(rest)) return gitDeny('git: --no-verify / -c core.hooksPath= skips the repository\'s hooks');
  const tokens = tokenizeAll(rest);
  const start = skipGitGlobalOptions(tokens);
  const sub = tokens[start];
  if (!sub) return deny('git: no subcommand found after the global options -- ambiguous, refused', FC);
  const subL = sub.toLowerCase();
  const args = stripRedirections(tokens.slice(start + 1));

  if (GIT_READONLY_BARE.has(subL)) return allow();
  if (subL === 'reflog') {
    const s2 = (args[0] || '').toLowerCase();
    return s2 === 'expire' || s2 === 'delete' ? gitDeny(`git reflog ${s2} rewrites the reflog`) : allow();
  }
  if (subL === 'remote') {
    const s2 = (args[0] || '').toLowerCase();
    return ['add', 'remove', 'rm', 'rename', 'set-url'].includes(s2) ? gitDeny(`git remote ${s2} changes remote config`) : allow();
  }
  if (subL === 'worktree') {
    const s2 = (args[0] || '').toLowerCase();
    return s2 === 'list' ? allow() : gitDeny(`git worktree ${s2 || '(bare)'}: only "list" is read-only`);
  }
  if (subL === 'branch') {
    if (args.length === 0) return allow();
    let i = 0;
    while (i < args.length) {
      const a = args[i];
      if (GIT_BRANCH_ALLOWED_FLAGS.has(a)) {
        // --contains/--merged/--no-merged take a commit; --list/-l take a
        // pattern (still a read: `git branch --list 'feat/*'` lists).
        if (['--contains', '--merged', '--no-merged', '--list', '-l'].includes(a)
            && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) { i += 2; continue; }
        i += 1;
        continue;
      }
      return gitDeny(`git branch "${a}" is a branch name or a write flag`);
    }
    return allow();
  }
  if (subL === 'tag') {
    if (args.length === 0) return allow();
    if (args.every((a) => a === '-l' || a === '--list' || a === '-n' || /^-n\d+$/.test(a))) return allow();
    return gitDeny('git tag with a tag name or a write flag');
  }
  if (subL === 'stash') {
    const s2 = (args[0] || '').toLowerCase();
    return s2 === 'list' || s2 === 'show' ? allow() : gitDeny(`git stash ${s2 || '(bare)'}: only "list"/"show" are read-only`);
  }
  if (subL === 'config') {
    const READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin']);
    if (args.some((a) => READ_FLAGS.has(a))) return allow();
    const nonFlags = args.filter((a) => !a.startsWith('-'));
    if (args.length > 0 && nonFlags.length === args.length && nonFlags.length === 1) return allow();
    return gitDeny('git config with a key and a value (or an unrecognised form) writes config');
  }
  if (subL === 'add') {
    // -N records the path with no content -- no authorship in it.
    if (args.some((a) => a === '-N' || a === '--intent-to-add')) return allow();
    return gitDeny('git add stages content');
  }
  if (subL === 'notes') {
    const s2 = (args[0] || '').toLowerCase();
    return s2 === 'show' ? allow() : gitDeny(`git notes ${s2 || '(bare)'}: only "show" is read-only`);
  }
  return gitDeny(`git ${subL}: not on the read-only allowlist`);
}

// ---------------------------------------------------------------------------
// gh -- read-only allowlist
// ---------------------------------------------------------------------------

// gh accepts every flag in attached and "=" spellings too (`-XPOST`,
// `-X=POST`, `-ftitle=x`, `--field=k=v`, `--input=body.json`); an
// exact-equality check measured missing all of them. Normalises one arg into
// its flag name and any attached value.
function normalizeGhApiFlag(rawArg) {
  const a = String(rawArg || '');
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq !== -1) return { name: a.slice(0, eq).toLowerCase(), value: a.slice(eq + 1) };
    return { name: a.toLowerCase(), value: undefined };
  }
  if (a.startsWith('-') && a.length > 1) {
    let rest = a.slice(2);
    if (rest.startsWith('=')) rest = rest.slice(1);
    return { name: '-' + a[1].toLowerCase(), value: rest.length ? rest : undefined };
  }
  return { name: a.toLowerCase(), value: undefined };
}

const GH_READ_VERBS = {
  pr: ['list', 'view', 'diff', 'checks', 'status'],
  issue: ['list', 'view', 'status'],
  run: ['list', 'view', 'watch', 'download'],
  release: ['list', 'view'],
  repo: ['view'],
  auth: ['status'],
};

function classifyGh(rest) {
  if (HOOK_BYPASS_RE.test(rest)) return gitDeny('gh: --no-verify / -c core.hooksPath= skips the repository\'s hooks');
  const tokens = stripRedirections(tokenizeAll(rest));
  if (tokens.length === 0) return deny('gh: no command -- ambiguous, refused', FC);
  const noun = tokens[0].toLowerCase();
  const verb = (tokens[1] || '').toLowerCase();
  if (noun === '--version' || noun === 'help' || noun === 'search') return allow();
  if (GH_READ_VERBS[noun]) {
    return GH_READ_VERBS[noun].includes(verb) ? allow() : gitDeny(`gh ${noun} ${verb || '(none)'}: not on the read-only allowlist`);
  }
  if (noun === 'api') {
    const args = tokens.slice(1);
    const flags = args.map(normalizeGhApiFlag);
    if (flags.some((f) => ['-f', '--field', '--raw-field', '--input'].includes(f.name))) {
      return gitDeny('gh api with -f/-F/--field/--raw-field/--input carries a write payload');
    }
    const mi = flags.findIndex((f) => f.name === '-x' || f.name === '--method');
    if (mi !== -1) {
      const method = flags[mi].value !== undefined ? flags[mi].value : args[mi + 1];
      if (!method || method.toUpperCase() !== 'GET') return gitDeny(`gh api -X/--method ${method || '(missing)'} is not GET`);
    }
    return allow();
  }
  return gitDeny(`gh ${noun}${verb ? ' ' + verb : ''}: not on the read-only allowlist`);
}

// ---------------------------------------------------------------------------
// Inline runners -- the laundering vector. Shells (bash -c, cmd /c,
// powershell -Command, eval) are unwrapped and their payload classified as a
// command; code runners (node -e, python -c, perl/ruby -e) are text-scanned,
// because their payload is not shell syntax.
// ---------------------------------------------------------------------------

// The here-string operator is found on the RAW text: the attached form
// `<<<"git push"` glues operator and quote into one token the tokenizer never
// separates (measured). A heredoc's body is on later lines, which a single
// segment cannot see -- any `<<` here is refused.
const HERESTRING_OP_RE = /(^|\s)(<<<-?)/;
const HEREDOC_OP_RE = /(^|\s)(<<-?)/;

function findHereStringOperator(text) {
  const s = String(text || '');
  let m = HERESTRING_OP_RE.exec(s);
  if (m) return { kind: 'herestring', before: s.slice(0, m.index), after: s.slice(m.index + m[1].length + m[2].length) };
  m = HEREDOC_OP_RE.exec(s);
  if (m) return { kind: 'heredoc', before: s.slice(0, m.index), after: s.slice(m.index + m[1].length + m[2].length) };
  return null;
}

function dequoteIfWrapped(text) {
  const s = String(text || '').trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

// An empty trigger payload, or a placeholder ({}, %, $@, $1, a lone "-"),
// means the real code arrives at run time (xargs appends it, stdin supplies
// it) -- invisible from this line, so refused.
const PLACEHOLDER_PAYLOAD_RE = /^(\{\}|%|\$[@*]|"?\$[1-9]"?)$/;
function isPlaceholderOrEmptyPayload(payload) {
  const p = String(payload || '').trim();
  if (!p || p === '-') return true;
  return PLACEHOLDER_PAYLOAD_RE.test(p);
}

// Flag-only invocations (`bash -s`, `bash -`, `bash --`, `bash -x`,
// `bash -o pipefail`) name no script file -- the script comes from stdin.
// A "/"-led token counts as a flag only in the short Windows-switch shape
// (`/c`, `/k`, `/s`, `/q`): found while porting, the original treated every
// "/"-led token as a flag, so `node /abs/path/script.mjs` -- a real script
// operand on a POSIX shell -- read as "no operand" and was refused.
const WINDOWS_SWITCH_RE = /^\/[A-Za-z?]{1,3}$/;
function isFlagToken(t) {
  return t.startsWith('-') || WINDOWS_SWITCH_RE.test(t);
}
// A script operand that IS standard input (`bash /dev/stdin`, `bash /dev/fd/0`,
// `sh /proc/self/fd/0`) is the same sink as no operand at all. The original
// refused these only because it read every "/"-led token as a flag; once
// absolute paths became operands they had to be named (independent review).
const STDIN_PATH_RE = /^\/(dev\/(stdin|fd\/\S*)|proc\/self\/fd\/\S*)$/i;
function dropFlagTokens(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '-' || t === '--' || STDIN_PATH_RE.test(t)) continue;
    if (isFlagToken(t)) {
      if (t === '-o' && tokens[i + 1] && !isFlagToken(tokens[i + 1])) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

function classifyInlineShellRunner(rest, depth, ctx, isTriggerFlag) {
  const raw = String(rest || '');
  const hereOp = findHereStringOperator(raw);
  if (hereOp && hereOp.kind === 'heredoc') {
    return deny('a "<<" heredoc body is on later lines, not this one -- the payload cannot be inspected, refused', FC);
  }
  // Find the trigger flag first; with a here-string present, the trigger's
  // payload is what sits between the trigger and the operator. Both payloads
  // are classified (measured: checking only the here-string let
  // `bash -c 'git push' <<< x` through).
  const beforeTokens = tokenizeAll(hereOp ? hereOp.before : raw);
  const idx = beforeTokens.findIndex((t) => isTriggerFlag(t));
  if (idx === -1) {
    if (hereOp) {
      const payload = dequoteIfWrapped(hereOp.after);
      return payload ? classifyCommand(payload, depth + 1, ctx) : allow();
    }
    if (dropFlagTokens(stripRedirections(beforeTokens)).length === 0) {
      return deny('a shell with no script operand reads its script from stdin -- cannot be inspected, refused', FC);
    }
    return allow(); // an ordinary script file
  }
  const triggerPayload = beforeTokens.slice(idx + 1).join(' ');
  if (isPlaceholderOrEmptyPayload(triggerPayload)) {
    return deny('inline-code flag with an empty or run-time placeholder payload -- cannot be inspected, refused', FC);
  }
  const v = classifyCommand(triggerPayload, depth + 1, ctx);
  if (!v.allow) return v;
  if (hereOp) {
    const hs = dequoteIfWrapped(hereOp.after);
    if (hs) {
      const hv = classifyCommand(hs, depth + 1, ctx);
      if (!hv.allow) return hv;
    }
  }
  return allow();
}

// Any single-dash short-flag cluster containing "c": -c, -lc, -xc, -ec. An
// exact-match list measured missing every cluster.
function isBashCommandTrigger(t) {
  return t.length >= 2 && t[0] === '-' && t[1] !== '-' && /c/i.test(t.slice(1));
}
function isCmdCommandTrigger(t) {
  const tl = t.toLowerCase();
  return tl === '/c' || tl === '/k';
}
// -Command and any prefix of it (PowerShell accepts unambiguous prefixes).
function isPowerShellCommandFlag(tok) {
  const t = tok.toLowerCase();
  if (t === '-c') return true;
  return t.length >= 3 && t[0] === '-' && t[1] !== '-' && '-command'.startsWith(t);
}
// -EncodedCommand and any prefix: a base64 payload cannot be inspected.
function isPowerShellEncodedCommandFlag(tok) {
  const t = tok.toLowerCase();
  return t.length >= 2 && t[0] === '-' && t[1] !== '-' && '-encodedcommand'.startsWith(t);
}

function classifyPowerShellInvocation(rest, depth, ctx) {
  const tokens = tokenizeAll(rest);
  const encIdx = tokens.findIndex(isPowerShellEncodedCommandFlag);
  if (encIdx !== -1) return deny(`powershell "${tokens[encIdx]}" carries a base64 payload that cannot be inspected -- refused`, FC);
  const cmdIdx = tokens.findIndex(isPowerShellCommandFlag);
  if (cmdIdx === -1) {
    if (dropFlagTokens(stripRedirections(tokens)).length === 0) {
      return deny('powershell with no script operand reads from stdin -- cannot be inspected, refused', FC);
    }
    return allow();
  }
  const payload = tokens.slice(cmdIdx + 1).join(' ');
  if (isPlaceholderOrEmptyPayload(payload)) {
    return deny('powershell -Command with an empty, "-" or placeholder payload reads from stdin -- refused', FC);
  }
  return classifyCommand(payload, depth + 1, ctx);
}

// eval re-runs its argument in the current shell. Literal text is unwrapped;
// any $ or backtick means the payload is only known at run time.
function classifyEval(rest, depth, ctx) {
  if (!rest) return allow();
  if (/\$|`/.test(rest)) return deny(`eval of text holding a variable or substitution cannot be inspected -- refused: "${rest.slice(0, 120)}"`, FC);
  return classifyCommand(rest, depth + 1, ctx);
}

// Text-scan for code payloads: a git/gh name followed closely by a write verb,
// or a subprocess/exec-family call that also names git/gh. Deliberately blunt;
// the false-positive direction is "refuse something harmless".
const LAUNDER_VERB_RE = /\b(git|gh)\b[^'"]{0,60}?\b(push|commit|merge|rebase|reset|checkout|switch|restore|clean|rm|mv|cherry-pick|revert|am|apply|init|clone|submodule|gc|prune|update-ref|symbolic-ref|filter-branch|pull|create|delete|edit|close|comment|review|ready|add|config|remote|branch\s+-[dDmMcCf])\b/i;
const SUBPROCESS_SHAPE_RE = /\b(execsync|spawnsync|spawn|exec|system|popen|pty|socket|subprocess\.(?:run|call|popen|check_call|check_output))\b/i;
const GUARDED_TOOL_TOKEN_RE = /\b(git|gh)\b/i;

function payloadLaundersGuardedTool(text) {
  if (LAUNDER_VERB_RE.test(text)) return true;
  return SUBPROCESS_SHAPE_RE.test(text) && GUARDED_TOOL_TOKEN_RE.test(text);
}

function classifyEvalPayload(payload, ctx) {
  if (ctx.gitWrites && payloadLaundersGuardedTool(payload)) {
    return gitDeny(`inline code names git/gh with a write verb, or runs a subprocess that names git/gh: "${payload.slice(0, 120)}"`);
  }
  if (payloadMentionsProtectedPath(payload, ctx)) {
    return deny(`inline code mentions a protected path: "${payload.slice(0, 160)}"`, PP);
  }
  return allow();
}

// Trigger flags as a predicate: exact long forms, attached "flag=value", and
// short-flag clusters (perl/ruby -pe/-ne/-lane all contain "e"). Exact-token
// matching measured missing node's -p/--print and every attached form.
function makeEvalTriggerPredicate(longForms, clusterLetters) {
  const forms = longForms.map((f) => f.toLowerCase());
  return (tok) => {
    const t = String(tok || '').toLowerCase();
    if (!t) return false;
    if (forms.includes(t)) return true;
    if (forms.some((f) => t.startsWith(f + '='))) return true;
    if (t.length >= 2 && t[0] === '-' && t[1] !== '-') {
      for (const ch of t.slice(1)) if (clusterLetters.includes(ch)) return true;
    }
    return false;
  };
}
const NODE_EVAL_LONG_FORMS = ['-e', '-p', '--eval', '--print'];
const isNodeEvalTrigger = makeEvalTriggerPredicate(NODE_EVAL_LONG_FORMS, ['e', 'p']);
const isPythonEvalTrigger = makeEvalTriggerPredicate(['-c'], ['c']);
const isPerlRubyEvalTrigger = makeEvalTriggerPredicate(['-e', '-E'], ['e']);

// Known non-eval flags, so `node --test x` / `node x --check` are not
// mistaken for an unrecognised (possibly eval-shaped) flag.
const BENIGN_RUNNER_FLAGS = {
  node: new Set(['--test', '--version', '-v', '--check', '-c', '--help', '-h']),
  python: new Set(['--version', '-v', '-h', '--help']),
  perl: new Set(['--version', '-h', '--help']),
  ruby: new Set(['--version', '-h', '--help']),
};

function findAttachedEvalPayload(rest, longForms) {
  const s = String(rest || '');
  const alt = longForms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const m = new RegExp(`(?:^|\\s)(?:${alt})=`, 'i').exec(s);
  return m ? s.slice(m.index + m[0].length) : null;
}

function classifyInlineCodeRunner(rest, isEvalTrigger, longForms, benignFlags, ctx) {
  const raw = String(rest || '');
  const attached = findAttachedEvalPayload(raw, longForms);
  if (attached !== null) return classifyEvalPayload(attached, ctx);
  const tokens = tokenizeAll(raw);
  const idx = tokens.findIndex((t) => isEvalTrigger(t));
  if (idx === -1) {
    // No trigger and no real operand (bare `node`, `... | node`, `node < x`,
    // a lone "-") reads its program from stdin. Informational-only flags
    // (`node --version`) are complete commands and stay allowed.
    const stripped = stripRedirections(tokens);
    const benign = benignFlags || new Set();
    if (dropFlagTokens(stripped).length === 0) {
      const allBenign = stripped.length > 0 && stripped.every((t) => benign.has(t.toLowerCase()));
      return allBenign ? allow() : deny('code runner with no script operand reads its program from stdin -- refused', FC);
    }
    // An unrecognised flag might be an eval flag this table does not model:
    // scan the whole remainder as text instead of allowing outright.
    if (stripped.some((t) => t.startsWith('-') && t !== '-' && !benign.has(t.toLowerCase()))) {
      return classifyEvalPayload(raw, ctx);
    }
    return allow();
  }
  const payload = tokens.slice(idx + 1).join(' ');
  if (isPlaceholderOrEmptyPayload(payload)) {
    return deny('inline-eval flag with an empty or run-time placeholder payload -- refused', FC);
  }
  return classifyEvalPayload(payload, ctx);
}

// Invoke-Expression / Invoke-Command / Start-Job, and PowerShell script-block
// bodies (ForEach-Object { git push origin $_ }, foreach (...) { ... },
// try { ... }) -- measured as never classified at all. Text-scanned, not
// recursed: `$_.Name -like '*.sql'` would otherwise trip the
// suspicious-head rule.
function classifyPowerShellTextScanCmdlet(name, rest, ctx) {
  const v = classifyEvalPayload(rest, ctx);
  return v.allow ? v : deny(`${name}: ${v.reason}`, v.arm);
}

// Start-Process launches a NAMED executable. A shell target has its command
// line rebuilt and classified as if typed (measured: `Start-Process
// powershell -ArgumentList "-Command git push"` used to pass); a git/gh
// target has -ArgumentList classified structurally.
const GUARDED_BASES = new Set(['git', 'gh']);
const SHELL_BASES = new Set(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'node', 'python', 'python3', 'perl', 'ruby']);

function classifyStartProcess(rest, depth, ctx) {
  const tokens = tokenizeAll(rest);
  let filePath = null;
  let argListText = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const tl = t.toLowerCase();
    if (tl === '-filepath') { filePath = tokens[i + 1] ?? filePath; i++; continue; }
    if (tl === '-argumentlist') { argListText = tokens[i + 1] ?? ''; i++; continue; }
    if (filePath === null && !t.startsWith('-')) filePath = t;
  }
  if (!filePath) return allow();
  const base = baseName(filePath);
  const cleanedArgs = (argListText || '').replace(/^@\(/, '').replace(/\)$/, '').replace(/,/g, ' ').trim();
  if (SHELL_BASES.has(base)) return classifyCommand(`${base} ${cleanedArgs}`.trim(), depth + 1, ctx);
  if (GUARDED_BASES.has(base)) {
    if (!ctx.gitWrites) return allow();
    return base === 'git' ? classifyGit(cleanedArgs) : classifyGh(cleanedArgs);
  }
  if (ctx.gitWrites && LAUNDER_VERB_RE.test(cleanedArgs)) {
    return gitDeny(`Start-Process "${base}" -ArgumentList names git/gh with a write verb: "${cleanedArgs.slice(0, 120)}"`);
  }
  return allow();
}

// ---------------------------------------------------------------------------
// Protected paths
// ---------------------------------------------------------------------------
const FIXED_PROTECTED = ['.claude/guardrails.json', '.claude/settings.json', '.claude/settings.local.json'];
const GIT_INTERNAL_RE = /(^|[\\/])\.git([\\/]|$)/i;

// Collapses "." / ".." / repeated separators before comparing: a dot-segment
// inside the protected tail (".claude/./settings.json", "tools//hooks")
// defeated plain suffix checks (measured). Lower-cased: case-insensitive on
// every host, which over-protects on a case-sensitive filesystem -- the safe
// direction.
function normalizePath(p) {
  const s = String(p || '').replace(/\\/g, '/').toLowerCase();
  if (!s) return s;
  return path.posix.normalize(s);
}

// "/c/x" and "c:/x" name the same place in a POSIX shell on Windows.
function toDriveCanonical(norm) {
  const m = /^([a-z]):(\/.*)?$/.exec(norm || '');
  if (m) return '/' + m[1] + (m[2] || '');
  return norm || '';
}

function projectCanon(ctx) {
  return ctx.projectDir ? toDriveCanonical(normalizePath(ctx.projectDir)).replace(/\/$/, '') : '';
}

// An absolute (or "../"-relative) argument that lands inside the project is
// reduced to its project-relative remainder, so `rm -rf C:/x/repo/tools` is
// recognised as `rm -rf tools` (measured: ancestry only matched relative
// spellings). A "../" argument is resolved as if the project root were the
// shell's working directory -- the realistic case for an agent session.
function stripProjectDirPrefix(rawStr, ctx) {
  const projCanon = projectCanon(ctx);
  if (!projCanon) return null;
  let norm = normalizePath(rawStr);
  if (!norm) return null;
  norm = (norm === '..' || norm.startsWith('../')) ? path.posix.normalize(projCanon + '/' + norm) : toDriveCanonical(norm);
  if (norm === projCanon) return '';
  if (norm.startsWith(projCanon + '/')) return norm.slice(projCanon.length + 1);
  return null;
}

function isProjectDirOrAncestor(norm, ctx) {
  const projCanon = projectCanon(ctx);
  if (!projCanon || !norm) return false;
  const argCanon = (norm === '..' || norm.startsWith('../'))
    ? path.posix.normalize(projCanon + '/' + norm)
    : toDriveCanonical(norm);
  if (!argCanon) return false;
  return projCanon === argCanon || projCanon.startsWith(argCanon.replace(/\/$/, '') + '/');
}

function pathIsUnderOrEquals(norm, d) {
  return norm === d || norm.endsWith('/' + d) || norm.startsWith(d + '/') || norm.includes('/' + d + '/');
}

// Build the per-call context from config. protectedPaths entries are
// relative to the project root; backslashes, a "./" prefix, a trailing slash
// and an absolute spelling inside the project are all accepted.
function buildContext(input, config) {
  const g = (config && config.guard) || {};
  const projectDir = input && typeof input.projectDir === 'string' && input.projectDir ? input.projectDir : null;
  const ctx = { projectDir, gitWrites: Array.isArray(g.arms) ? g.arms.includes('git-writes') : true };
  const entries = [...FIXED_PROTECTED];
  for (const raw of Array.isArray(g.protectedPaths) ? g.protectedPaths : []) {
    if (typeof raw !== 'string') continue;
    let n = normalizePath(raw).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    const rem = stripProjectDirPrefix(n, ctx);
    if (rem) n = rem;
    if (!n || n === '.' || n === '..' || n.startsWith('../')) continue;
    entries.push(n);
  }
  ctx.protected = [...new Set(entries)];
  ctx.protectedSegs = ctx.protected.map((p) => p.split('/').filter(Boolean));
  ctx.protectedBasenames = new Set(ctx.protected.map((p) => p.split('/').pop()));
  return ctx;
}

// Ancestor-or-self, segment by segment, with glob segments: `rm -rf tools`
// deletes tools/hooks without ever naming it, and `tools/hook*`, `.cla*`
// match a protected name at that depth -- while `tools/*.mjs` and `tools/lib*`
// can never match the name "hooks" and stay allowed.
function globSegmentRegex(seg) {
  const pattern = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${pattern}$`, 'i');
}
function segmentMatches(argSeg, protectedSeg) {
  if (!/[*?]/.test(argSeg)) return argSeg === protectedSeg;
  return globSegmentRegex(argSeg).test(protectedSeg);
}
function matchesProtectedAncestorOrSelf(norm, ctx) {
  const argSegs = String(norm || '').split('/').filter(Boolean);
  if (argSegs.length === 0) return false;
  return ctx.protectedSegs.some((protSegs) => {
    if (argSegs.length > protSegs.length) return false;
    for (let i = 0; i < argSegs.length; i++) if (!segmentMatches(argSegs[i], protSegs[i])) return false;
    return true;
  });
}

// Deleting or moving `.`, `..`, `/`, `~` or `*` destroys every protected
// path without naming one.
const ALWAYS_PROTECTED_BARE_TOKENS = new Set(['.', '..', '/', '\\', '~', '*']);

function stripGlobSuffix(rawArg) {
  const s = String(rawArg || '');
  const idx = s.search(/[*?]/);
  if (idx === -1) return s;
  const upTo = s.slice(0, idx);
  const lastSep = Math.max(upTo.lastIndexOf('/'), upTo.lastIndexOf('\\'));
  return lastSep === -1 ? '' : upTo.slice(0, lastSep);
}

// One discrete argument (already tokenized -- never a substring scan of a
// whole command line).
function isProtectedPathArg(rawArg, ctx) {
  const rawStr = String(rawArg || '');
  if (ALWAYS_PROTECTED_BARE_TOKENS.has(rawStr.trim())) return true;
  // PowerShell accepts a comma-joined path list as one argument
  // (`Remove-Item a,tools/hooks`); measured passing when tested as one string.
  if (rawStr.includes(',')) return rawStr.split(',').some((part) => isProtectedPathArg(part, ctx));
  if (matchesProtectedAncestorOrSelf(normalizePath(rawStr), ctx)) return true;
  const rem = stripProjectDirPrefix(rawStr, ctx);
  if (rem !== null && matchesProtectedAncestorOrSelf(rem, ctx)) return true;
  const effective = /[*?]/.test(rawStr) ? stripGlobSuffix(rawStr) : rawStr;
  const norm = normalizePath(effective);
  if (!norm) return false;
  if (GIT_INTERNAL_RE.test(norm)) return true;
  if (ctx.protected.some((p) => pathIsUnderOrEquals(norm, p))) return true;
  if (isProjectDirOrAncestor(norm, ctx)) return true;
  return false;
}

// Free text (a code payload): a substring search, deliberately loose.
function payloadMentionsProtectedPath(payloadText, ctx) {
  const raw = String(payloadText || '').replace(/\\/g, '/').toLowerCase();
  if (ctx.protected.some((n) => raw.includes(n))) return true;
  // A bare ".claude" names the directory itself (`Get-ChildItem .claude`),
  // boundary-checked so a runtime-built ".../.claude/skills/..." string is
  // not swept up (measured false deny when it was).
  if (/(^|[^\w.])\.claude(?![\w/])/.test(raw)) return true;
  const collapsed = path.posix.normalize(raw);
  return ctx.protected.some((n) => collapsed.includes(n));
}

function findProtectedRedirectionTarget(tokens, ctx) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!REDIRECT_RE.test(tok)) continue;
    let target = BARE_REDIRECT_RE.test(tok) ? tokens[i + 1] : tok.slice(tok.match(REDIRECT_RE)[0].length);
    if (!target) continue;
    // An attached redirection (`>"x"`) is never dequoted by the tokenizer --
    // the quote sits mid-token (measured bypass).
    target = target.replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (isProtectedPathArg(target, ctx)) return target;
  }
  return null;
}

// Every argument of every segment is checked against the protected paths
// UNLESS the head is on this short read-only list. An allowlist, because the
// earlier denylist of write-capable heads measured missing install, dd,
// rsync, patch, [IO.File]::WriteAllText and more. Accepted false deny: the
// direction of an argument is not known, so `cp <protected> /tmp/x` is
// refused too -- read with cat or git show instead.
const READ_ONLY_HEADS_FOR_TOKEN_SCAN = new Set([
  'cat', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'wc', 'ls', 'less', 'more',
  // NOT here (each measured writing a protected file): awk (gawk -i inplace),
  // uniq (its second operand is an output file), sort (only without -o).
  'diff', 'cmp', 'stat', 'file', 'type', 'findstr', 'md5sum', 'sha256sum',
  'cut', 'du', 'echo', 'printf', 'cd', 'pushd', 'test', '[', '[[',
  'basename', 'dirname', 'realpath', 'readlink',
  // Running a script is not a write; -c payloads are handled by their own arm.
  'bash', 'sh',
  'get-content', 'select-string', 'get-childitem', 'get-item', 'test-path',
  'get-filehash', 'compare-object', 'measure-object', 'write-output', 'write-host',
  'set-location',
]);
const GIT_WORKTREE_WRITERS = new Set(['checkout', 'restore', 'mv', 'rm', 'clean']);
const FIND_DESTRUCTIVE_RE = /^-(delete|exec|execdir|ok|okdir|fls|fprint\w*)$/i;

function isReadOnlyHeadForTokenScan(base, argTokens) {
  if (base === 'node') return !argTokens.some((t) => isNodeEvalTrigger(t));
  if (READ_ONLY_HEADS_FOR_TOKEN_SCAN.has(base)) return true;
  // git reads may name protected paths (`git log -- .claude/settings.json`);
  // its writes are the git-writes arm's business. EXCEPT --output (and any
  // unambiguous prefix, git accepts them): `git diff --output=<file>` writes
  // that file (measured). gh is not exempt: `gh run download -D <dir>` writes.
  // checkout/restore/mv/rm/clean rewrite their path operands in the working
  // tree, so those operands are scanned whatever the git-writes arm says
  // (independent review: with arms [] `git restore .claude/settings.json`
  // passed, because the exemption leaned on the git-writes arm).
  if (base === 'git') {
    if (argTokens.some((a) => /^--out/i.test(a))) return false;
    const sub = (argTokens[skipGitGlobalOptions(argTokens)] || '').toLowerCase();
    return !GIT_WORKTREE_WRITERS.has(sub);
  }
  if (base === 'sort') return !argTokens.some((a) => /^(-o|--o)/i.test(a));
  // sed: -i, --in-place and its abbreviations, and bundled -ni/-ri/-Ei.
  if (base === 'sed') return !argTokens.some((a) => /^-[a-z]*i/i.test(a) || /^--i/i.test(a));
  if (base === 'find') return !argTokens.some((a) => FIND_DESTRUCTIVE_RE.test(a));
  return false;
}

// A token may carry its path after "=" (dd's of=, -Path=) or, for a
// PowerShell parameter, after ":" (-Path:value). The colon form is checked
// only on a dash-led token so a drive letter is never mistaken for one.
function protectedPathInToken(tok, ctx) {
  if (isProtectedPathArg(tok, ctx)) return true;
  const eq = tok.indexOf('=');
  if (eq !== -1 && isProtectedPathArg(tok.slice(eq + 1), ctx)) return true;
  if (tok[0] === '-') {
    const colon = tok.indexOf(':');
    if (colon !== -1 && isProtectedPathArg(tok.slice(colon + 1), ctx)) return true;
  }
  return false;
}

function checkEveryTokenForProtectedPath(base, argTokens, ctx) {
  if (isReadOnlyHeadForTokenScan(base, argTokens)) return null;
  for (const a of argTokens) {
    // cmd's own single-letter switches (/c, /k, /q) are not paths. Found while
    // porting: with a project root on C:, "/c" read as the POSIX-shell
    // spelling of the drive -- an ancestor of the project -- and refused
    // `cmd /c echo hi`. The payload after /c is classified by its own arm.
    if (base === 'cmd' && /^\/[a-z]$/i.test(a)) continue;
    if (protectedPathInToken(a, ctx)) return a;
  }
  return null;
}

// `find . -name settings.json -delete` names no protected PATH; the basename
// is matched later by find itself.
function findDestructiveNameHit(base, argTokens, ctx) {
  if (base !== 'find' || !argTokens.some((a) => FIND_DESTRUCTIVE_RE.test(a))) return null;
  for (let i = 0; i < argTokens.length; i++) {
    const flag = argTokens[i].toLowerCase();
    if (flag !== '-name' && flag !== '-iname' && flag !== '-path') continue;
    const val = argTokens[i + 1];
    if (!val) continue;
    if (ctx.protectedBasenames.has(val.toLowerCase().split(/[\\/]/).pop())) return val;
  }
  return null;
}

// `echo .claude/settings.json | xargs rm`: xargs supplies the path at run
// time, so earlier piped segments are scanned for a protected-path mention.
function isXargsHeaded(seg) {
  const { token } = firstToken(String(seg || ''));
  return !!token && token.toLowerCase() === 'xargs';
}
function xargsFeedsProtectedPathToWrite(seg, base, argTokens, priorSegments, ctx) {
  if (!isXargsHeaded(seg) || isReadOnlyHeadForTokenScan(base, argTokens)) return false;
  return (priorSegments || []).some((p) => payloadMentionsProtectedPath(p, ctx));
}

// A PowerShell pipeline feeding a write cmdlet that has no path operand of
// its own (`Get-ChildItem tools/hooks | Remove-Item -Recurse`) takes its
// target from the pipeline. Scoped to cmdlets that act on a piped target --
// a blanket "any non-read-only head" regressed `sort <protected> | uniq -c`.
const PIPELINE_WRITE_CMDLET_HEADS = new Set([
  'remove-item', 'ri', 'set-content', 'sc', 'add-content', 'ac', 'out-file',
  'clear-content', 'clc', 'move-item', 'mi', 'copy-item', 'cpi', 'rename-item', 'rni', 'new-item', 'ni',
]);
function looksLikePathOperand(tok) {
  return /[\\/]/.test(tok) || /\.[A-Za-z0-9]{1,6}$/.test(tok);
}
function pipelineFeedsProtectedPathToWrite(base, argTokens, priorSegments, ctx) {
  if (!PIPELINE_WRITE_CMDLET_HEADS.has(base) || !priorSegments || priorSegments.length === 0) return false;
  if (dropFlagTokens(argTokens).some(looksLikePathOperand)) return false;
  return priorSegments.some((p) => payloadMentionsProtectedPath(p, ctx));
}

// xargs feeding an inline runner that has a trigger flag: an earlier piped
// segment with a git/gh write shape is the payload.
function runnerHasTrigger(runnerBase, argTokens) {
  switch (runnerBase) {
    case 'bash': case 'sh': return argTokens.some(isBashCommandTrigger);
    case 'cmd': return argTokens.some(isCmdCommandTrigger);
    case 'powershell': case 'pwsh': return argTokens.some((t) => isPowerShellCommandFlag(t) || isPowerShellEncodedCommandFlag(t));
    case 'node': return argTokens.some(isNodeEvalTrigger);
    case 'python': case 'python3': case 'py': return argTokens.some(isPythonEvalTrigger);
    case 'perl': case 'ruby': return argTokens.some(isPerlRubyEvalTrigger);
    default: return false;
  }
}

// [IO.File]::WriteAllText("path", ...) tokenizes as one blob (no space before
// the first argument): its quoted strings are scanned once a WRITE method is
// recognised. Read methods are deliberately not matched.
const IO_FILE_WRITE_CALL_RE = /\[\s*(?:System\.)?IO\.File\s*\]\s*::\s*(WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines|Copy|Move|Delete|Create|Replace|SetAttributes|Encrypt|Decrypt)\b/i;
function findProtectedIoFileWriteArg(segmentText, ctx) {
  if (!IO_FILE_WRITE_CALL_RE.test(segmentText)) return null;
  const re = /'([^']*)'|"([^"]*)"/g;
  let m;
  while ((m = re.exec(segmentText))) {
    const q = m[1] !== undefined ? m[1] : m[2];
    if (isProtectedPathArg(q, ctx)) return q;
  }
  return null;
}

function ppDeny(what) {
  return deny(`${what} -- the guard does not let the agent change its own configuration or protected paths; hand this change to a human`, PP);
}

// ---------------------------------------------------------------------------
// Segment and command classification
// ---------------------------------------------------------------------------
function classifySegment(rawSeg, depth, ctx, priorSegments) {
  const seg = stripCallOperator(stripBalancedEnclosingGroup(stripStrayGroupingParens(rawSeg)));
  if (!seg) return allow();

  for (const inner of extractSubstitutions(seg)) {
    const v = classifyCommand(inner, depth + 1, ctx);
    if (!v.allow) return v;
  }

  const unwrapped = unwrapTransparentPrefixes(seg);
  const { token, rest } = firstToken(unwrapped);
  if (!token) return allow(); // e.g. a bare xargs, which runs echo

  // A wrapper that stopped at a flag it does not know (`xargs --verbose`), or
  // at a bare number, has hidden the real head: refuse.
  if (/^-/.test(token) || /^\d+$/.test(token)) {
    return deny(`a wrapper stopped at an unrecognised flag or bare number -- the real command cannot be located, refused: "${token}"`, FC);
  }

  const redirTarget = findProtectedRedirectionTarget(tokenizeAll(unwrapped), ctx);
  if (redirTarget) return ppDeny(`shell redirection into a protected path "${redirTarget}"`);

  // Two readings of the head; a guarded name wins. The path-aware reading
  // keeps backslashes in a token with an extension (a real Windows path), and
  // so read `g\it.exe` as "it" (measured); the fully-stripped reading catches
  // that and is used only when it names git/gh.
  const pathAwareBase = baseName(despliceHeadToken(token));
  const strippedBase = baseName(String(token).replace(/['"`\\]/g, ''));
  const base = (!GUARDED_BASES.has(pathAwareBase) && GUARDED_BASES.has(strippedBase)) ? strippedBase : pathAwareBase;

  // A PowerShell static call ([IO.File]::ReadAllText(...)) is one blob with
  // real brackets and quotes, not splicing; its write siblings are caught by
  // findProtectedIoFileWriteArg.
  const looksLikePowerShellStaticCall = /^\[[^\]]*\]::/.test(token);
  if (!looksLikePowerShellStaticCall && SUSPICIOUS_HEAD_CHARS_RE.test(base)) {
    return deny(`the command head still holds a shell metacharacter after de-splicing -- cannot be read as an executable name, refused: "${token}"`, FC);
  }

  const argTokens = tokenizeAll(rest);
  const hitArg = checkEveryTokenForProtectedPath(base, argTokens, ctx);
  if (hitArg) return ppDeny(`"${base}" targets a protected path "${hitArg}"`);
  const ioHit = findProtectedIoFileWriteArg(unwrapped, ctx);
  if (ioHit) return ppDeny(`[IO.File] write call targets a protected path "${ioHit}"`);
  const findHit = findDestructiveNameHit(base, argTokens, ctx);
  if (findHit) return ppDeny(`find -name ${findHit} with -delete/-exec matches a protected file name`);
  if (xargsFeedsProtectedPathToWrite(seg, base, argTokens, priorSegments, ctx)) {
    return ppDeny(`xargs feeds "${base}" a protected path from an earlier piped segment`);
  }
  if (pipelineFeedsProtectedPathToWrite(base, argTokens, priorSegments, ctx)) {
    return ppDeny(`"${base}" takes its target from a pipeline that names a protected path`);
  }
  if (ctx.gitWrites && isXargsHeaded(seg) && runnerHasTrigger(base, argTokens)
      && (priorSegments || []).some(payloadLaundersGuardedTool)) {
    return gitDeny(`xargs feeds inline code to "${base}" from an earlier piped segment that names a git/gh write`);
  }

  switch (base) {
    case 'git': return ctx.gitWrites ? classifyGit(rest) : allow();
    case 'gh': return ctx.gitWrites ? classifyGh(rest) : allow();
    case 'powershell':
    case 'pwsh':
      return classifyPowerShellInvocation(rest, depth, ctx);
    case 'cmd': return classifyInlineShellRunner(rest, depth, ctx, isCmdCommandTrigger);
    case 'bash':
    case 'sh':
      return classifyInlineShellRunner(rest, depth, ctx, isBashCommandTrigger);
    case 'node': return classifyInlineCodeRunner(rest, isNodeEvalTrigger, NODE_EVAL_LONG_FORMS, BENIGN_RUNNER_FLAGS.node, ctx);
    case 'python':
    case 'python3':
    case 'py':
      return classifyInlineCodeRunner(rest, isPythonEvalTrigger, ['-c'], BENIGN_RUNNER_FLAGS.python, ctx);
    case 'perl': return classifyInlineCodeRunner(rest, isPerlRubyEvalTrigger, ['-e', '-E'], BENIGN_RUNNER_FLAGS.perl, ctx);
    case 'ruby': return classifyInlineCodeRunner(rest, isPerlRubyEvalTrigger, ['-e', '-E'], BENIGN_RUNNER_FLAGS.ruby, ctx);
    case 'eval': return classifyEval(rest, depth, ctx);
    case 'invoke-expression': case 'iex': case 'invoke-command': case 'icm': case 'start-job': case 'sajb':
    case 'foreach-object': case '%': case 'where-object': case '?': case 'foreach': case 'select-object':
    case 'try': case 'catch': case 'finally':
      return classifyPowerShellTextScanCmdlet(base, rest, ctx);
    case 'start-process': case 'saps': case 'start':
      return classifyStartProcess(rest, depth, ctx);
    default:
      return allow();
  }
}

function classifyCommand(cmd, depth, ctx) {
  if (depth > MAX_DEPTH) return deny('command nesting is too deep to classify -- refused', FC);
  const { segments, unterminated } = splitSegments(cmd);
  if (unterminated) return deny('the command has an unterminated quote -- it cannot be tokenized safely, refused', FC);
  for (let i = 0; i < segments.length; i++) {
    const v = classifySegment(segments[i], depth, ctx, segments.slice(0, i));
    if (!v.allow) return v; // one bad segment refuses the whole chain
  }
  return allow();
}

// A lexer-independent backstop: if the RAW text holds a git/gh write shape
// AND an interpreter sink (a pipe into a shell, a here-string or heredoc,
// -c/-Command, xargs, eval, iex, a script block), refuse regardless of what
// the structural classifier concluded. Blunt on purpose -- it survives the
// next splicing trick the structure has not been taught. Known cost: a
// heredoc whose CONTENT mentions `git push` is refused (write such files with
// the editor tool instead).
const GUARDED_WRITE_SHAPE_RE = new RegExp(
  '\\bgit\\s+(push|commit|merge|rebase|reset|checkout|switch|restore|clean|rm|mv|cherry-pick|revert|am|apply|tag|add|config|remote|branch\\s+-[dDmMcCf]|stash\\s+(push|pop|drop|apply|clear))\\b'
  + '|\\bgh\\s+(pr\\s+(create|merge|close|edit|comment|review|ready)|repo\\s+(create|delete|edit)|release\\s+(create|delete)|api\\s+(-X|--method))',
  'i',
);
const INTERPRETER_SINK_RE = new RegExp(
  '\\|\\s*(bash|sh|pwsh|powershell|node|python3?|perl|ruby|cmd)\\b'
  + '|<<<|<<'
  + '|\\b(bash|sh)\\b\\s+-[a-z]*c'
  + '|-Command\\b|\\bxargs\\b|\\beval\\b|\\biex\\b|\\bInvoke-Expression\\b|\\bInvoke-Command\\b|\\bStart-Job\\b|-EncodedCommand\\b'
  + '|^\\s*[({]'
  + '|\\b(foreach-object|where-object|foreach|select-object|try|catch|finally)\\b[^{}]{0,80}\\{[^{}]*\\}'
  + '|[%?][^{}]{0,80}\\{[^{}]*\\}',
  'i',
);

function decideShell(toolName, toolInput, ctx) {
  if (!toolInput || typeof toolInput.command !== 'string') {
    return deny(`${toolName}: tool_input has no "command" string -- refused`, FC);
  }
  const cmd = toolInput.command;
  if (ctx.gitWrites && GUARDED_WRITE_SHAPE_RE.test(cmd) && INTERPRETER_SINK_RE.test(cmd)) {
    return gitDeny(`${toolName}: the command text holds a git/gh write shape AND an interpreter sink: "${cmd.slice(0, 160)}"`);
  }
  return classifyCommand(cmd, 0, ctx);
}

function decideFileWrite(toolName, toolInput, ctx) {
  const fp = toolInput && (toolInput.file_path || toolInput.notebook_path);
  if (typeof fp !== 'string' || !fp) return deny(`${toolName}: no file_path -- refused`, FC);
  const norm = normalizePath(fp);
  if (GIT_INTERNAL_RE.test(norm)) return ppDeny(`${toolName}: a write under .git/ "${fp}"`);
  const rel = stripProjectDirPrefix(fp, ctx);
  const candidates = rel ? [norm, rel] : [norm];
  if (ctx.protected.some((p) => candidates.some((c) => pathIsUnderOrEquals(c, p)))) {
    return ppDeny(`${toolName}: a write to a protected path "${fp}"`);
  }
  return allow();
}

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function decide(input, config) {
  if (!config || !config.guard || config.guard.enabled !== true) return ALLOW;
  try {
    const toolName = input && input.tool_name;
    if (typeof toolName !== 'string' || !toolName) return deny('the hook payload has no tool_name -- refused', FC);
    if (!SHELL_TOOLS.has(toolName) && !FILE_WRITE_TOOLS.has(toolName)) return ALLOW;
    const ctx = buildContext(input, config);
    if (SHELL_TOOLS.has(toolName)) return decideShell(toolName, input.tool_input, ctx);
    return decideFileWrite(toolName, input.tool_input, ctx);
  } catch (e) {
    return deny(`guard internal error -- refusing by default: ${e && e.message ? e.message : String(e)}`, FC);
  }
}
