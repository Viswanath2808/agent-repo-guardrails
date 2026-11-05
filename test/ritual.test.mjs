// test/ritual.test.mjs -- the session-start ritual.
//
// buildStatus() is pure: git, the file reader, the guard's decide() and the
// clock are all injected, so every branch of the ritual is tested here
// without a network, a real repository, or a real guard. One subprocess test
// at the end runs scripts/session-start.mjs for real against an empty temp
// directory, to prove the hook script itself never fails a session.
//
// Run: node --test plugins/agent-repo-guardrails/test/

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStatus, parseRoleTable, READ_ONLY_GIT } from '../lib/ritual.mjs';
import { DEFAULTS } from '../lib/config.mjs';

// Inside a git hook (pre-push) git exports GIT_DIR and friends; the script
// subprocess below would then describe the HOST repo from inside an empty temp
// dir ("Branch: <host branch> | dirty files: 1105"). Measured 2026-10-22: red
// under pre-push, green standalone. Scrub before spawning.
for (const k of Object.keys(process.env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE)$/.test(k)) delete process.env[k];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'scripts', 'session-start.mjs');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);

function cfg(overrides = {}) {
  const c = structuredClone(DEFAULTS);
  for (const [k, v] of Object.entries(overrides)) {
    c[k] = k === 'guard' ? { ...c.guard, ...v } : v;
  }
  return c;
}

/**
 * A fake git. `table` maps the space-joined argument list to a string
 * (stdout) or an Error (thrown). Unlisted commands throw, so a test sees an
 * unexpected call as a failure path, never as silent success.
 */
function fakeGit(table = {}) {
  const calls = [];
  const fn = (args, opts = {}) => {
    calls.push({ args, opts });
    const key = args.join(' ');
    if (!(key in table)) throw new Error(`fake git: unexpected call: git ${key}`);
    const v = table[key];
    if (v instanceof Error) throw v;
    return typeof v === 'function' ? v(args, opts) : v;
  };
  fn.calls = calls;
  return fn;
}

const STATE_LOG_KEY = 'log --format=%x00%ct --name-only -- STATE.md */STATE.md';

/** A healthy repository on a feature branch, clean, level with origin/main. */
function healthyTable(extra = {}) {
  return {
    'rev-parse --show-toplevel': '/home/dev/widgets',
    'rev-parse --abbrev-ref HEAD': 'feat/thing',
    'status --porcelain': '',
    'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
    'fetch origin --quiet': '',
    'rev-list --left-right --count HEAD...origin/main': '0\t0',
    'log -3 --oneline --no-decorate': 'aaa1111 third\nbbb2222 second\nccc3333 first',
    'ls-files -z -- STATE.md */STATE.md': '',
    [STATE_LOG_KEY]: '',
    ...extra,
  };
}

function run(table, opts = {}) {
  const git = fakeGit(table);
  const lines = buildStatus({ git, config: cfg(opts.config), now: NOW, ...opts.extra });
  return { git, lines, text: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Tree + branch
// ---------------------------------------------------------------------------

test('tree name is the basename of the top-level directory', () => {
  const { lines } = run(healthyTable());
  assert.ok(lines.some((l) => l === 'Tree: widgets'), lines.join('\n'));
});

test('a top-level path with backslashes still yields a bare tree name', () => {
  const { text } = run(healthyTable({ 'rev-parse --show-toplevel': 'C:\\work\\widgets' }));
  assert.match(text, /^Tree: widgets$/m);
  assert.doesNotMatch(text, /\\/);
});

test('not a git repository -> one "could not resolve" line, no throw', () => {
  const { text } = run({});
  assert.match(text, /^Tree: could not resolve/m);
  assert.match(text, /^Guard: off/m);
});

test('branch and a clean tree', () => {
  const { text } = run(healthyTable());
  assert.match(text, /^Branch: feat\/thing {2}\| {2}dirty files: 0$/m);
});

test('detached HEAD prints DETACHED @ <short sha>', () => {
  const { text } = run(healthyTable({ 'rev-parse --abbrev-ref HEAD': 'HEAD', 'rev-parse --short HEAD': 'abc1234' }));
  assert.match(text, /^Branch: DETACHED @ abc1234/m);
});

test('dirty file count is the number of porcelain lines', () => {
  const { text } = run(healthyTable({ 'status --porcelain': ' M a.md\n?? b.md\n M c/d.mjs\n' }));
  assert.match(text, /dirty files: 3$/m);
});

test('status failing leaves the dirty count as "?"', () => {
  const { text } = run(healthyTable({ 'status --porcelain': new Error('boom') }));
  assert.match(text, /dirty files: \?$/m);
});

// ---------------------------------------------------------------------------
// Default branch: config, else origin/HEAD, else main
// ---------------------------------------------------------------------------

test('config.defaultBranch wins and origin/HEAD is never asked', () => {
  const { git, text } = run(
    healthyTable({ 'rev-list --left-right --count HEAD...origin/trunk': '1\t0' }),
    { config: { defaultBranch: 'trunk' } },
  );
  assert.match(text, /^origin\/trunk: ahead 1 \/ behind 0$/m);
  assert.ok(!git.calls.some((c) => c.args[0] === 'symbolic-ref'));
});

test('origin/HEAD detection: origin/develop -> compares against origin/develop', () => {
  const { text } = run(healthyTable({
    'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/develop',
    'rev-list --left-right --count HEAD...origin/develop': '0\t2',
  }));
  assert.match(text, /^origin\/develop: ahead 0 \/ behind 2$/m);
});

test('origin/HEAD unset -> falls back to main', () => {
  const { text } = run(healthyTable({ 'symbolic-ref --short refs/remotes/origin/HEAD': new Error('not a symbolic ref') }));
  assert.match(text, /^origin\/main: ahead 0 \/ behind 0$/m);
});

// ---------------------------------------------------------------------------
// fetch, then ahead/behind
// ---------------------------------------------------------------------------

test('fetch is bounded by a timeout (an offline machine must not hang the start)', () => {
  const { git } = run(healthyTable());
  const fetch = git.calls.find((c) => c.args[0] === 'fetch');
  assert.ok(fetch, 'fetch was called');
  assert.ok(Number.isFinite(fetch.opts.timeout) && fetch.opts.timeout > 0 && fetch.opts.timeout <= 10000);
});

test('fetch runs before the ahead/behind comparison', () => {
  const { git } = run(healthyTable());
  const i = git.calls.findIndex((c) => c.args[0] === 'fetch');
  const j = git.calls.findIndex((c) => c.args[0] === 'rev-list');
  assert.ok(i >= 0 && j > i);
});

test('level with origin -> no behind warning', () => {
  const { text } = run(healthyTable());
  assert.doesNotMatch(text, /BEHIND/);
  assert.doesNotMatch(text, /checkout/);
});

test('behind -> warning plus the two checkout forms, naming the detected branch', () => {
  const { text } = run(healthyTable({ 'rev-list --left-right --count HEAD...origin/main': '0\t39' }));
  assert.match(text, /^origin\/main: ahead 0 \/ behind 39$/m);
  assert.match(text, /BEHIND origin\/main by 39/);
  assert.match(text, /git checkout --detach origin\/main/);
  assert.match(text, /git checkout -b <new-branch> origin\/main/);
});

test('behind + dirty -> the uncommitted-files line comes BEFORE the checkout forms', () => {
  const { lines } = run(healthyTable({
    'status --porcelain': ' M a\n M b',
    'rev-list --left-right --count HEAD...origin/main': '0\t3',
  }));
  const dirty = lines.findIndex((l) => /2 uncommitted file/.test(l));
  const detach = lines.findIndex((l) => /checkout --detach/.test(l));
  assert.ok(dirty >= 0, lines.join('\n'));
  assert.ok(detach > dirty, lines.join('\n'));
});

test('behind + clean -> no uncommitted-files line', () => {
  const { text } = run(healthyTable({ 'rev-list --left-right --count HEAD...origin/main': '0\t3' }));
  assert.doesNotMatch(text, /uncommitted/);
});

test('fetch fails (offline) -> one fetch line, comparison marked stale', () => {
  const { text } = run(healthyTable({
    'fetch origin --quiet': new Error('Could not resolve host'),
    'rev-list --left-right --count HEAD...origin/main': '0\t1',
  }));
  assert.match(text, /^git fetch origin failed \(offline\?\).*Could not resolve host/m);
  assert.match(text, /^origin\/main \(stale, fetch failed\): ahead 0 \/ behind 1$/m);
});

test('no origin branch to compare -> "comparison unavailable", no throw', () => {
  const { text } = run(healthyTable({
    'rev-list --left-right --count HEAD...origin/main': new Error("ambiguous argument 'HEAD...origin/main'"),
  }));
  assert.match(text, /^origin\/main comparison unavailable: ambiguous argument/m);
});

// ---------------------------------------------------------------------------
// Last 3 commits
// ---------------------------------------------------------------------------

test('last 3 commits, each indented', () => {
  const { lines } = run(healthyTable());
  const i = lines.indexOf('Last 3 commits:');
  assert.ok(i >= 0);
  assert.deepEqual(lines.slice(i + 1, i + 4), ['  aaa1111 third', '  bbb2222 second', '  ccc3333 first']);
});

test('log fails -> "unavailable" line', () => {
  const { text } = run(healthyTable({ 'log -3 --oneline --no-decorate': new Error('does not have any commits yet') }));
  assert.match(text, /^Last 3 commits: unavailable \(does not have any commits yet\)$/m);
});

// ---------------------------------------------------------------------------
// STATE.md files and their last-commit age
// ---------------------------------------------------------------------------

function stateLog(entries) {
  // Mirrors `git log --format=%x00%ct --name-only`: a NUL + timestamp line,
  // a blank line, then the file names touched by that commit. Newest first.
  return entries.map(([ts, files]) => `\x00${ts}\n\n${files.join('\n')}`).join('\n');
}

test('no STATE.md tracked -> one "none tracked" line', () => {
  const { text } = run(healthyTable());
  assert.match(text, /^STATE\.md files: none tracked$/m);
});

test('STATE.md files listed with their last-commit age, newest first', () => {
  const { lines } = run(healthyTable({
    'ls-files -z -- STATE.md */STATE.md': 'STATE.md\x00apps/a/STATE.md\x00apps/b/STATE.md\x00',
    [STATE_LOG_KEY]: stateLog([
      [NOW_S - 2 * 3600, ['apps/b/STATE.md']],
      [NOW_S - 3 * 86400, ['apps/a/STATE.md', 'apps/b/STATE.md']],
      [NOW_S - 40 * 86400, ['STATE.md']],
    ]),
  }));
  const i = lines.indexOf('STATE.md files (last commit):');
  assert.ok(i >= 0, lines.join('\n'));
  assert.match(lines[i + 1], /^ {2}apps\/b\/STATE\.md\s+2h ago$/);
  assert.match(lines[i + 2], /^ {2}apps\/a\/STATE\.md\s+3d ago$/);
  assert.match(lines[i + 3], /^ {2}STATE\.md\s+40d ago$/);
});

test('a tracked STATE.md with no commit yet says so', () => {
  const { text } = run(healthyTable({
    'ls-files -z -- STATE.md */STATE.md': 'apps/new/STATE.md\x00',
    [STATE_LOG_KEY]: '',
  }));
  assert.match(text, /apps\/new\/STATE\.md\s+not yet committed/);
});

test('more than 6 STATE.md files -> capped at 6 plus an "and N more" line', () => {
  const files = Array.from({ length: 9 }, (_, k) => `p${k}/STATE.md`);
  const { lines } = run(healthyTable({
    'ls-files -z -- STATE.md */STATE.md': files.join('\x00') + '\x00',
    [STATE_LOG_KEY]: stateLog(files.map((f, k) => [NOW_S - (k + 1) * 86400, [f]])),
  }));
  const shown = lines.filter((l) => /^ {2}p\d\/STATE\.md/.test(l));
  assert.equal(shown.length, 6);
  assert.ok(lines.includes('  ... and 3 more'));
});

test('STATE.md age lookup failing -> file list still printed, age unknown', () => {
  const { text } = run(healthyTable({
    'ls-files -z -- STATE.md */STATE.md': 'apps/a/STATE.md\x00',
    [STATE_LOG_KEY]: new Error('boom'),
  }));
  assert.match(text, /apps\/a\/STATE\.md\s+age unknown/);
});

test('ls-files failing -> one "unavailable" line', () => {
  const { text } = run(healthyTable({ 'ls-files -z -- STATE.md */STATE.md': new Error('boom') }));
  assert.match(text, /^STATE\.md files: unavailable \(boom\)$/m);
});

// ---------------------------------------------------------------------------
// Role map (optional): a markdown table | dirname | role |
// ---------------------------------------------------------------------------

const ROLE_TABLE = [
  '# Trees',
  '',
  '| Tree | Role |',
  '|---|---|',
  '| `widgets` | **Product** work -- the [main](x.md) tree. Second sentence here. |',
  '| gadgets | docs and tooling |',
].join('\n');

test('parseRoleTable reads rows, skips header + separator, strips markdown', () => {
  const map = parseRoleTable(ROLE_TABLE);
  assert.equal(map.size, 2);
  assert.equal(map.get('widgets'), 'Product work -- the main tree.');
  assert.equal(map.get('gadgets'), 'docs and tooling');
});

test('roleMap null (default) -> no role is printed and no file is read', () => {
  let read = 0;
  const { text } = run(healthyTable(), { extra: { readFile: () => { read++; return ROLE_TABLE; } } });
  assert.equal(read, 0);
  assert.doesNotMatch(text, /role:/);
});

test('roleMap set and the tree has a row -> role printed on the Tree line', () => {
  const { text } = run(healthyTable(), {
    config: { roleMap: 'docs/trees.md' },
    extra: { projectDir: '/home/dev/widgets', readFile: () => ROLE_TABLE },
  });
  assert.match(text, /^Tree: widgets {2}\| {2}role: Product work -- the main tree\.$/m);
});

test('roleMap set, no row for this tree -> says so, factually', () => {
  const { text } = run(healthyTable({ 'rev-parse --show-toplevel': '/home/dev/scratch-clone' }), {
    config: { roleMap: 'docs/trees.md' },
    extra: { projectDir: '/home/dev/scratch-clone', readFile: () => ROLE_TABLE },
  });
  assert.match(text, /^Tree: scratch-clone {2}\| {2}no row in docs\/trees\.md for this tree$/m);
});

test('roleMap file has zero parseable rows -> a loud line (a blind map must not look like a miss)', () => {
  const { text } = run(healthyTable(), {
    config: { roleMap: 'docs/trees.md' },
    extra: { projectDir: '/home/dev/widgets', readFile: () => '# nothing here\n' },
  });
  assert.match(text, /0 rows parsed from docs\/trees\.md/);
});

test('roleMap file unreadable -> warning on the Tree line, no throw', () => {
  const { text } = run(healthyTable(), {
    config: { roleMap: 'docs/trees.md' },
    extra: { projectDir: '/home/dev/widgets', readFile: () => { throw new Error('ENOENT: no such file'); } },
  });
  assert.match(text, /^Tree: widgets {2}\| {2}role map docs\/trees\.md unreadable \(ENOENT: no such file\)$/m);
});

// ---------------------------------------------------------------------------
// Guard posture: reported from config, and self-tested when on
// ---------------------------------------------------------------------------

const goodDecide = ({ tool_input }) => (/^git push/.test(tool_input.command) ? { allow: false, reason: 'x', arm: 'git-writes' } : { allow: true });

test('guard off (default) -> "Guard: off" and decide() is never called', () => {
  let called = 0;
  const { lines } = run(healthyTable(), { extra: { decide: () => { called++; return { allow: true }; } } });
  assert.equal(lines[0], 'Guard: off');
  assert.equal(called, 0);
});

test('guard on + a decide() that passes both fixtures -> on, arms listed, self-test passed', () => {
  const { lines } = run(healthyTable(), { config: { guard: { enabled: true } }, extra: { decide: goodDecide } });
  assert.equal(lines[0], 'Guard: on (arms: git-writes)  |  self-test passed');
});

test('guard on + a decide() that allows git push -> self-test FAILED, named fixture', () => {
  const { lines } = run(healthyTable(), { config: { guard: { enabled: true } }, extra: { decide: () => ({ allow: true }) } });
  assert.match(lines[0], /^Guard: on \(arms: git-writes\) {2}\| {2}self-test FAILED -- known-deny fixture \(git push\) was allowed$/);
});

test('guard on + a decide() that denies git status -> self-test FAILED, named fixture', () => {
  const { lines } = run(healthyTable(), { config: { guard: { enabled: true } }, extra: { decide: () => ({ allow: false }) } });
  assert.match(lines[0], /known-allow fixture \(git status\) was denied/);
});

test('guard on + a decide() that throws -> self-test FAILED with the message', () => {
  const { lines } = run(healthyTable(), { config: { guard: { enabled: true } }, extra: { decide: () => { throw new Error('boom'); } } });
  assert.match(lines[0], /self-test FAILED -- boom$/);
});

test('guard on + no decide() available -> self-test unavailable', () => {
  const { lines } = run(healthyTable(), { config: { guard: { enabled: true } } });
  assert.match(lines[0], /^Guard: on \(arms: git-writes\) {2}\| {2}self-test unavailable/);
});

test('guard on without the git-writes arm -> no git fixture is run', () => {
  let called = 0;
  const { lines } = run(healthyTable(), {
    config: { guard: { enabled: true, arms: [] } },
    extra: { decide: () => { called++; return { allow: true }; } },
  });
  assert.equal(called, 0);
  assert.match(lines[0], /^Guard: on \(arms: none\)/);
});

test('self-test passes the loaded config to decide()', () => {
  let seen = null;
  run(healthyTable(), {
    config: { guard: { enabled: true } },
    extra: { decide: (input, c) => { seen = c; return goodDecide(input); } },
  });
  assert.equal(seen && seen.guard && seen.guard.enabled, true);
});

// ---------------------------------------------------------------------------
// Config line
// ---------------------------------------------------------------------------

test('config warnings -> one line after the guard line', () => {
  const { lines } = run(healthyTable(), { extra: { configWarnings: ['a bad', 'b bad'] } });
  assert.equal(lines[1], 'Config warnings: a bad; b bad');
});

test('no config warnings -> no warnings line', () => {
  const { text } = run(healthyTable());
  assert.doesNotMatch(text, /Config warnings/);
});

// ---------------------------------------------------------------------------
// Whole-ritual invariants
// ---------------------------------------------------------------------------

test('git throwing on every call -> buildStatus still returns lines, never throws', () => {
  const git = () => { throw new Error('git not installed'); };
  const lines = buildStatus({ git, config: cfg(), now: NOW });
  assert.ok(lines.length > 0);
  assert.ok(lines.some((l) => /^Tree: could not resolve/.test(l)));
});

test('only read-only git subcommands are ever invoked', () => {
  const { git } = run(healthyTable({
    'rev-parse --abbrev-ref HEAD': 'HEAD',
    'rev-parse --short HEAD': 'abc1234',
    'rev-list --left-right --count HEAD...origin/main': '0\t5',
  }));
  for (const c of git.calls) assert.ok(READ_ONLY_GIT.has(c.args[0]), `git ${c.args.join(' ')}`);
  assert.deepEqual([...READ_ONLY_GIT].sort(), ['fetch', 'log', 'ls-files', 'rev-list', 'rev-parse', 'status', 'symbolic-ref']);
});

test('a worst case (behind, dirty, 9 STATE files, warnings, guard on) stays under 25 lines', () => {
  const files = Array.from({ length: 9 }, (_, k) => `p${k}/STATE.md`);
  const { lines } = run(healthyTable({
    'status --porcelain': ' M a',
    'fetch origin --quiet': new Error('offline'),
    'rev-list --left-right --count HEAD...origin/main': '0\t7',
    'ls-files -z -- STATE.md */STATE.md': files.join('\x00') + '\x00',
    [STATE_LOG_KEY]: stateLog(files.map((f, k) => [NOW_S - k * 86400, [f]])),
  }), { config: { guard: { enabled: true } }, extra: { decide: goodDecide, configWarnings: ['x'] } });
  assert.ok(lines.length < 25, `${lines.length} lines:\n${lines.join('\n')}`);
});

test('output is factual: no "you must" / "run this" imperatives', () => {
  const { text } = run(healthyTable({ 'status --porcelain': ' M a', 'rev-list --left-right --count HEAD...origin/main': '0\t2' }));
  assert.doesNotMatch(text, /\byou (must|should)\b/i);
});

// ---------------------------------------------------------------------------
// The hook script, for real: never fails a session
// ---------------------------------------------------------------------------

function runScript(dir, stdin) {
  return spawnSync(process.execPath, [SCRIPT], {
    input: stdin,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GIT_CEILING_DIRECTORIES: path.dirname(dir) },
  });
}

test('script: empty non-repo directory -> exit 0, ritual printed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ritual-'));
  try {
    const r = runScript(dir, JSON.stringify({ cwd: dir, hook_event_name: 'SessionStart' }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Guard: off$/m);
    assert.match(r.stdout, /^Tree: could not resolve/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script: garbage on stdin -> still exit 0', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ritual-'));
  try {
    const r = runScript(dir, 'not json at all');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Guard: /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('script: guard enabled in config + a bad key -> Guard: on line and a warnings line', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ritual-'));
  try {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'guardrails.json'), JSON.stringify({ guard: { enabled: true }, colour: 'blue' }));
    const r = runScript(dir, JSON.stringify({ cwd: dir }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Guard: on \(arms: git-writes\)/m);
    assert.match(r.stdout, /^Config warnings: .*unknown key\(s\) ignored: colour/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
