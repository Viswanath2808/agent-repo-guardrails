// lib/ritual.mjs -- the session-start ritual as a pure builder.
//
// What it is for: a coding agent starting a session in a long-lived repo
// does not know which tree it is in, whether that tree is behind the
// default branch, or whether the working copy is dirty -- unless it
// remembers to ask. The ritual asks for it, every start, and prints the
// answers as plain facts (SessionStart stdout becomes the model's context).
// The failure it was written against, measured in the source repo: a
// worktree left 39 commits behind its default branch, which nobody noticed
// until a diff against origin showed changes nobody had made.
//
// buildStatus() takes git, a file reader, the guard's decide() and the
// clock as arguments, so every branch is unit-testable without a network,
// a repository or a real guard (test/ritual.test.mjs).
//
// Contract:
//   - Never throws. Every git call is wrapped; a failure becomes one line.
//   - Only read-only git subcommands (READ_ONLY_GIT). `fetch` updates
//     remote-tracking refs only; it never touches the working tree or a
//     local branch.
//   - Stays under 25 printed lines in the worst case. A preamble of 100+
//     lines on every start is how a check turns into wallpaper nobody reads.
//   - Factual, not imperative: it reports state and the shape of the
//     catch-up commands; it does not tell anyone what to do.

import path from 'node:path';

/** The git subcommands the ritual may run. A test asserts nothing else is ever called. */
export const READ_ONLY_GIT = new Set(['rev-parse', 'status', 'symbolic-ref', 'fetch', 'rev-list', 'log', 'ls-files']);

export const FETCH_TIMEOUT_MS = 5000; // bounded so an offline machine never hangs the start
const STATE_CAP = 6;

function firstLine(e) {
  const msg = e && typeof e === 'object' && 'message' in e ? e.message : e;
  return String(msg ?? '').split('\n')[0].trim();
}

/** Backslash-tolerant basename: git prints forward slashes, a caller might not. */
function baseName(p) {
  return path.posix.basename(String(p).replace(/\\/g, '/').replace(/\/+$/, ''));
}

function toSlashes(p) {
  return String(p).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Role map: an optional markdown table `| <worktree-dir-name> | <role> |`.
// ---------------------------------------------------------------------------

/** Strip the markdown a prose cell carries and keep one short clause. */
export function shortRole(prose) {
  const s = String(prose || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
  const clause = s.split(/(?<=[.:])\s/)[0] || s;
  return clause.length > 90 ? clause.slice(0, 87) + '...' : clause;
}

function cells(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const parts = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  return parts.length >= 2 ? parts : null;
}

const isSeparator = (row) => row.every((c) => /^:?-{1,}:?$/.test(c));

/** Parse `| dir | role |` rows into Map<dir, shortRole>. Header and separator rows are skipped. */
export function parseRoleTable(text) {
  const map = new Map();
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const row = cells(lines[i]);
    if (!row || isSeparator(row)) continue;
    const next = i + 1 < lines.length ? cells(lines[i + 1]) : null;
    if (next && isSeparator(next)) continue; // the header row
    const key = row[0].replace(/[`*]/g, '').trim();
    if (!key) continue;
    map.set(key, shortRole(row[1]));
  }
  return map;
}

// ---------------------------------------------------------------------------
// Guard posture. A printed "on" is not evidence the guard works; a passed
// self-test is. So when the guard is enabled and its git-writes arm is
// loaded, two fixtures are run through decide(): `git push` must be refused
// and `git status` allowed. What this cannot prove: that the PreToolUse hook
// is actually wired and firing -- that is the plugin loader's job, and a
// disabled plugin prints no ritual at all (silence is the failure mode).
// ---------------------------------------------------------------------------

function guardLine(config, decide, decideError) {
  const g = (config && config.guard) || {};
  if (g.enabled !== true) return 'Guard: off';
  const arms = Array.isArray(g.arms) ? g.arms : [];
  const head = `Guard: on (arms: ${arms.length ? arms.join(', ') : 'none'})`;
  if (!arms.includes('git-writes')) return head;
  if (typeof decide !== 'function') {
    return `${head}  |  self-test unavailable (${decideError || 'no decide() supplied'})`;
  }
  try {
    const deny = decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin x' } }, config);
    if (!deny || deny.allow !== false) return `${head}  |  self-test FAILED -- known-deny fixture (git push) was allowed`;
    const allow = decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } }, config);
    if (!allow || allow.allow !== true) return `${head}  |  self-test FAILED -- known-allow fixture (git status) was denied`;
  } catch (e) {
    return `${head}  |  self-test FAILED -- ${firstLine(e)}`;
  }
  return `${head}  |  self-test passed`;
}

// ---------------------------------------------------------------------------
// STATE.md files: any tracked `STATE.md` at the root or below, with the age
// of the last commit that touched each. One `git log` walk, newest first;
// the first time a path appears is its last commit.
// ---------------------------------------------------------------------------

function age(seconds) {
  const s = Math.max(0, seconds);
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function stateLines(git, nowMs) {
  const out = [];
  let files;
  try {
    files = git(['ls-files', '-z', '--', 'STATE.md', '*/STATE.md']).split('\0').map((f) => f.trim()).filter(Boolean);
  } catch (e) {
    return [`STATE.md files: unavailable (${firstLine(e)})`];
  }
  if (files.length === 0) return ['STATE.md files: none tracked'];

  const last = new Map(); // path -> unix seconds
  let ageKnown = true;
  try {
    const log = git(['log', '--format=%x00%ct', '--name-only', '--', 'STATE.md', '*/STATE.md']);
    let ts = null;
    for (const raw of log.split(/\r?\n/)) {
      if (raw.startsWith('\0')) { ts = Number.parseInt(raw.slice(1), 10); continue; }
      const f = raw.trim();
      if (f && ts !== null && !last.has(f)) last.set(f, ts);
    }
  } catch {
    ageKnown = false;
  }

  const nowS = Math.floor(nowMs / 1000);
  const rows = files.map((f) => ({ f, ts: last.has(f) ? last.get(f) : null }));
  rows.sort((a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity) || a.f.localeCompare(b.f));
  const shown = rows.slice(0, STATE_CAP);
  const width = Math.max(...shown.map((r) => r.f.length));
  out.push('STATE.md files (last commit):');
  for (const r of shown) {
    const when = !ageKnown ? 'age unknown' : r.ts === null ? 'not yet committed' : age(nowS - r.ts);
    out.push(`  ${r.f.padEnd(width)}  ${when}`);
  }
  if (rows.length > STATE_CAP) out.push(`  ... and ${rows.length - STATE_CAP} more`);
  return out;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * @param {object}   o
 * @param {(args: string[], opts?: {timeout?: number}) => string} o.git  runs git, returns trimmed stdout, throws on failure
 * @param {object}   o.config          merged config (lib/config.mjs)
 * @param {number}   [o.now]           epoch ms
 * @param {string[]} [o.configWarnings]
 * @param {string}   [o.projectDir]    resolves config.roleMap
 * @param {(file: string) => string} [o.readFile]
 * @param {Function} [o.decide]        the guard's decide(input, config), when loaded
 * @param {string}   [o.decideError]   why decide() could not be loaded
 * @returns {string[]} lines
 */
export function buildStatus({ git, config, now = Date.now(), configWarnings = [], projectDir = process.cwd(), readFile, decide, decideError } = {}) {
  const lines = [];
  const say = (l) => lines.push(l);
  const cfg = config || {};

  say(guardLine(cfg, decide, decideError));
  if (configWarnings && configWarnings.length) say(`Config warnings: ${configWarnings.join('; ')}`);

  // 1. Tree (+ optional role)
  let treeName;
  try {
    treeName = baseName(git(['rev-parse', '--show-toplevel']));
  } catch (e) {
    say(`Tree: could not resolve (${firstLine(e)}) -- git facts skipped`);
    return lines;
  }
  let treeLine = `Tree: ${treeName}`;
  if (typeof cfg.roleMap === 'string' && cfg.roleMap.trim()) {
    const shown = toSlashes(cfg.roleMap.trim());
    try {
      if (typeof readFile !== 'function') throw new Error('no file reader');
      const map = parseRoleTable(readFile(path.resolve(projectDir, cfg.roleMap.trim())));
      if (map.size === 0) treeLine += `  |  WARNING: 0 rows parsed from ${shown} (expected a | dir | role | table) -- the role map is blind`;
      else if (map.has(treeName)) treeLine += `  |  role: ${map.get(treeName)}`;
      else treeLine += `  |  no row in ${shown} for this tree`;
    } catch (e) {
      treeLine += `  |  role map ${shown} unreadable (${firstLine(e)})`;
    }
  }
  say(treeLine);

  // 2. Branch (or detached SHA) + dirty count
  let dirtyCount = null;
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const label = branch === 'HEAD' ? `DETACHED @ ${git(['rev-parse', '--short', 'HEAD'])}` : branch;
    let dirty = '?';
    try {
      const status = git(['status', '--porcelain']);
      dirty = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
      dirtyCount = dirty;
    } catch { /* leave '?' */ }
    say(`Branch: ${label}  |  dirty files: ${dirty}`);
  } catch (e) {
    say(`Branch: could not resolve (${firstLine(e)})`);
  }

  // 3. Default branch: config, else origin/HEAD, else 'main'
  let base = typeof cfg.defaultBranch === 'string' && cfg.defaultBranch.trim() ? cfg.defaultBranch.trim() : null;
  if (!base) {
    try {
      const ref = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      base = ref.replace(/^origin\//, '') || 'main';
    } catch {
      base = 'main';
    }
  }
  const remoteRef = `origin/${base}`;

  // 4. fetch, then ahead/behind (offline -> compare against the last-known ref)
  let fetchFailed = false;
  try {
    git(['fetch', 'origin', '--quiet'], { timeout: FETCH_TIMEOUT_MS });
  } catch (e) {
    fetchFailed = true;
    say(`git fetch origin failed (offline?) -- comparing against the last-known ${remoteRef}: ${firstLine(e)}`);
  }
  try {
    const counts = git(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]);
    const [ahead, behind] = counts.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    say(`${fetchFailed ? `${remoteRef} (stale, fetch failed)` : remoteRef}: ahead ${ahead} / behind ${behind}`);
    if (behind > 0) {
      // A checkout with uncommitted files either refuses or silently carries
      // them onto the new branch -- stated before the commands, so it is read first.
      if (typeof dirtyCount === 'number' && dirtyCount > 0) {
        say(`  ${dirtyCount} uncommitted file(s) here -- a checkout either refuses or carries them onto the new branch`);
      }
      say(`  BEHIND ${remoteRef} by ${behind}. The two catch-up forms:`);
      say(`    git checkout --detach ${remoteRef}              # look, without a branch`);
      say(`    git checkout -b <new-branch> ${remoteRef}       # new work from the current tip`);
    }
  } catch (e) {
    say(`${remoteRef} comparison unavailable: ${firstLine(e)}`);
  }

  // 5. Last 3 commits
  try {
    const log = git(['log', '-3', '--oneline', '--no-decorate']);
    say('Last 3 commits:');
    for (const l of log.split(/\r?\n/).filter(Boolean)) say(`  ${l}`);
  } catch (e) {
    say(`Last 3 commits: unavailable (${firstLine(e)})`);
  }

  // 6. STATE.md files
  for (const l of stateLines(git, now)) say(l);

  return lines;
}
