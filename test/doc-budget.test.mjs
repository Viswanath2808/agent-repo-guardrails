// test/doc-budget.test.mjs -- the doc-size budget gate.
//
// The first verdict case is the negative test the byte budget exists for: a
// state file of 213 lines x ~380 chars (the shape a wide register table had when
// it was measured at 81,654 bytes) PASSES a line-only budget and must FAIL the
// byte budget. The rest pin the known-debt ratchet, the self-deleting debt entry,
// the WARN bands, config overrides, file discovery and the CLI contract.
// Run: node --test plugins/agent-repo-guardrails/test/

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  judge, measure, deadDebt, resolveBudgets, evaluate,
  RULES, KNOWN_DEBT, STATE_MAX_BYTES, STATE_WARN_BYTES,
} from '../lib/doc-budget.mjs';
import { listMarkdown, findGitDir, RepoFilesError } from '../lib/repo-files.mjs';
import { doc, TREES, materialize } from './fixtures/doc-budget/trees.mjs';

// When this suite runs from inside a git hook (pre-push), git has exported
// GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_PREFIX to the process. Every
// git call below -- in-process and in the CLI subprocess -- would then operate
// on the HOST repo instead of the temp tree it is pointed at: a fresh temp
// `git init` re-initialises the host repo and the temp dir reads as "not a
// git repository". Measured 2026-10-22: 3 tests red under pre-push, green
// standalone. Scrub them before anything spawns.
for (const k of Object.keys(process.env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE)$/.test(k)) delete process.env[k];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'scripts', 'doc-budget.mjs');
const STATE = 'proj/STATE.md';
const noDebt = { debt: {} };

const runCli = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const withTree = (tree, extra, fn) => {
  const t = materialize(tree, extra);
  try { return fn(t.dir); } finally { t.cleanup(); }
};
const gitAvailable = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

// --- measure / judge -------------------------------------------------------

test('measure: lines, bytes and longest line', () => {
  assert.deepEqual(measure('ab\ncdef\n'), { lines: 2, bytes: 8, maxLine: 4 });
  assert.deepEqual(measure(''), { lines: 0, bytes: 0, maxLine: 0 });
  assert.deepEqual(measure('no newline'), { lines: 1, bytes: 10, maxLine: 10 });
});

test('measure: bytes are UTF-8 bytes, not characters', () => {
  assert.equal(measure('é\n').bytes, 3);
});

test('NEGATIVE: 213 lines x 380 chars passes the line budget and FAILS the byte budget', () => {
  const r = judge(STATE, doc(213, 380), noDebt);
  assert.equal(r.lines, 213);
  assert.ok(r.lines <= r.max, 'under the line budget');
  assert.ok(r.bytes > STATE_MAX_BYTES, 'over the byte budget');
  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /bytes > 24000/);
  assert.match(r.reason, /longest line 38\d chars/);
});

test('control: 213 lines x 90 chars is under both maxes (line WARN band only)', () => {
  const r = judge(STATE, doc(213, 90), noDebt);
  assert.equal(r.status, 'WARN');
  assert.match(r.reason, /lines, warn at 200/);
  assert.equal(judge(STATE, doc(150, 90), noDebt).status, 'PASS');
});

test('lines over max FAIL first, whatever the bytes', () => {
  const r = judge(STATE, doc(241, 20), noDebt);
  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /241 lines > 240/);
});

test('exactly at the line max is not a FAIL', () => {
  assert.notEqual(judge(STATE, doc(240, 20), noDebt).status, 'FAIL');
});

test('byte WARN band: under max, at or over warnBytes', () => {
  const r = judge(STATE, doc(150, 140), noDebt);
  assert.ok(r.bytes >= STATE_WARN_BYTES && r.bytes <= STATE_MAX_BYTES, `bytes ${r.bytes}`);
  assert.equal(r.status, 'WARN');
  assert.match(r.reason, /bytes, warn at 20000/);
});

test('known debt: at or under its filed size reports DEBT, not FAIL', () => {
  const debt = { [STATE]: { bytes: 52_142, filed: '2026-10-08', owner: 'docs team' } };
  const r = judge(STATE, doc(240, 200), { debt });
  assert.ok(r.bytes <= 52_142 && r.bytes > STATE_MAX_BYTES, `bytes ${r.bytes}`);
  assert.equal(r.status, 'DEBT');
  assert.match(r.reason, /docs team trims it/);
});

test('known debt without an owner still reports DEBT', () => {
  const debt = { [STATE]: { bytes: 52_142, filed: '2026-10-08' } };
  assert.equal(judge(STATE, doc(240, 200), { debt }).status, 'DEBT');
});

test('known debt is a ceiling: growing past the filed size FAILs', () => {
  const debt = { [STATE]: { bytes: 30_000, filed: '2026-10-08' } };
  const r = judge(STATE, doc(240, 200), { debt });
  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /filed ceiling of 30000/);
});

test('known debt is self-deleting: a trimmed file FAILs until its entry goes', () => {
  const debt = { [STATE]: { bytes: 52_142, filed: '2026-10-08' } };
  const r = judge(STATE, doc(150, 90), { debt });
  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /delete its knownDebt entry/);
});

test('known debt never excuses the LINE budget', () => {
  const debt = { [STATE]: { bytes: 99_999, filed: '2026-10-08' } };
  assert.match(judge(STATE, doc(241, 20), { debt }).reason, /lines > 240/);
});

test('dead debt: an entry no budgeted file reached is a FAIL asking for deletion', () => {
  const debt = { 'gone/STATE.md': { bytes: 30_000, filed: '2026-10-08' }, [STATE]: { bytes: 1, filed: '2026-10-08' } };
  const dead = deadDebt([STATE, 'other/STATE.md'], debt);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].file, 'gone/STATE.md');
  assert.equal(dead[0].status, 'FAIL');
  assert.match(dead[0].reason, /delete the entry/i);
  assert.notEqual(dead[0].label, 'project STATE', 'must not count as a STATE match');
  assert.deepEqual(deadDebt([STATE], { [STATE]: debt[STATE] }), []);
});

test('shipped KNOWN_DEBT is empty', () => {
  assert.deepEqual(Object.keys(KNOWN_DEBT), []);
});

test('non-STATE rules carry no byte budget: a 1700-line reference of long lines is PASS', () => {
  const r = judge('proj/CLAUDE.md', doc(1700, 400), noDebt);
  assert.equal(r.maxBytes, null);
  assert.equal(r.status, 'PASS');
  assert.equal(judge('proj/CLAUDE.md', doc(1800, 10), noDebt).status, 'WARN');
  assert.equal(judge('proj/CLAUDE.md', doc(2001, 10), noDebt).status, 'FAIL');
});

test('LOG is unlimited by design', () => {
  assert.equal(judge('proj/LOG.md', doc(9000, 400), noDebt).status, 'UNLIMITED');
  assert.equal(judge('a/b/LOG.md', doc(9000, 400), noDebt).status, 'UNLIMITED');
});

test('root router: line budget only, and matched before the project-reference pattern', () => {
  const r = judge('CLAUDE.md', doc(100, 100), noDebt);
  assert.equal(r.label, 'root router');
  assert.equal(r.status, 'WARN');
  assert.equal(judge('CLAUDE.md', doc(121, 10), noDebt).status, 'FAIL');
  assert.equal(judge('CLAUDE.md', doc(50, 2000), noDebt).status, 'PASS');
});

test('project directories are one or two levels deep', () => {
  assert.equal(judge('a/STATE.md', doc(1, 1), noDebt).label, 'project STATE');
  assert.equal(judge('a/b/STATE.md', doc(1, 1), noDebt).label, 'project STATE');
  assert.equal(judge('a/b/c/STATE.md', doc(1, 1), noDebt), null);
  assert.equal(judge('STATE.md', doc(1, 1), noDebt), null);
});

test('unbudgeted files return null, and near-miss names do not match', () => {
  assert.equal(judge('proj/design/foo.md', doc(500, 500), noDebt), null);
  assert.equal(judge('proj/CHANGELOG.md', doc(500, 500), noDebt), null);
  assert.equal(judge('proj/MY-STATE.md', doc(500, 500), noDebt), null);
  assert.equal(judge('proj/state.md', doc(500, 500), noDebt), null);
});

test('the repo-specific shared-reference rule is not shipped', () => {
  assert.deepEqual(RULES.map((r) => r.label), ['root router', 'project STATE', 'project LOG', 'project reference']);
});

// --- config overrides ------------------------------------------------------

test('resolveBudgets: no config gives the shipped rules and empty debt', () => {
  const { rules, debt, warnings } = resolveBudgets({});
  assert.deepEqual(rules.map((r) => [r.label, r.max, r.maxBytes ?? null]), RULES.map((r) => [r.label, r.max, r.maxBytes ?? null]));
  assert.deepEqual(debt, {});
  assert.deepEqual(warnings, []);
  assert.deepEqual(resolveBudgets(undefined).warnings, []);
});

test('resolveBudgets: an override by label changes only that rule', () => {
  const { rules, warnings } = resolveBudgets({ 'project STATE': { maxBytes: 90_000, warnBytes: 85_000, warnAt: 220 } });
  assert.deepEqual(warnings, []);
  const r = judge(STATE, doc(213, 380), { rules, debt: {} });
  assert.equal(r.status, 'PASS');
  assert.equal(rules.find((x) => x.label === 'root router').max, 120);
  assert.equal(RULES.find((x) => x.label === 'project STATE').maxBytes, STATE_MAX_BYTES, 'shipped rules not mutated');
});

test('resolveBudgets: maxBytes null turns the byte budget off for that label', () => {
  const { rules } = resolveBudgets({ 'project STATE': { maxBytes: null, warnBytes: null } });
  assert.equal(judge(STATE, doc(213, 380), { rules, debt: {} }).status, 'WARN');
});

test('resolveBudgets: unknown label, unknown key and bad values warn and are ignored', () => {
  const { rules, warnings } = resolveBudgets({
    'project STAT': { max: 10 },
    'project STATE': { max: -1, colour: 'red', warnAt: 'many' },
  });
  assert.equal(warnings.length, 4, warnings.join('\n'));
  assert.ok(warnings.some((w) => /unknown label "project STAT"/.test(w)));
  assert.ok(warnings.some((w) => /colour/.test(w)));
  assert.equal(rules.find((x) => x.label === 'project STATE').max, 240);
});

test('resolveBudgets: the LOG rule cannot be given a budget', () => {
  const { rules, warnings } = resolveBudgets({ 'project LOG': { max: 500 } });
  assert.equal(rules.find((x) => x.label === 'project LOG').max, null);
  assert.match(warnings[0], /unlimited by design/);
});

test('resolveBudgets: knownDebt entries are read from config and normalised', () => {
  const { debt, warnings } = resolveBudgets({
    knownDebt: {
      'proj\\STATE.md': { bytes: 30_000, filed: '2026-10-08', owner: 'x' },
      './other/STATE.md': { bytes: 25_000, filed: '2026-10-09' },
      'bad/STATE.md': { bytes: 'lots' },
    },
  });
  assert.deepEqual(Object.keys(debt).sort(), ['other/STATE.md', 'proj/STATE.md']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bad\/STATE\.md/);
});

test('resolveBudgets: a non-object budgets value falls back to defaults without a second warning (the config loader reports it)', () => {
  const { rules, warnings } = resolveBudgets(['nope']);
  assert.equal(rules.length, RULES.length);
  assert.deepEqual(warnings, []);
});

test('known debt filed BELOW the budget: an under-budget file is told to delete the entry, not to move content', () => {
  const debt = { [STATE]: { bytes: 10_000, filed: '2026-10-08' } };
  const r = judge(STATE, doc(100, 150), { debt });           // ~15k bytes, budget 24k
  assert.ok(r.bytes > 10_000 && r.bytes < STATE_MAX_BYTES, `bytes ${r.bytes}`);
  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /delete its knownDebt entry/);
  assert.doesNotMatch(r.reason, /filed ceiling/);
});

test('resolveBudgets: a knownDebt ceiling at or below that label maxBytes warns', () => {
  const { debt, warnings } = resolveBudgets({ knownDebt: { [STATE]: { bytes: 24_000, filed: '2026-10-08' }, 'b/STATE.md': { bytes: 24_001, filed: '2026-10-08' } } });
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /proj\/STATE\.md.*at or below the 24000-byte budget/);
  assert.ok(debt[STATE], 'entry kept so the gate FAILs it');
  // the check uses the overridden budget, not the shipped one
  const o = resolveBudgets({ 'project STATE': { maxBytes: 50_000 }, knownDebt: { [STATE]: { bytes: 40_000, filed: '2026-10-08' } } });
  assert.equal(o.warnings.length, 1);
});

// --- evaluate --------------------------------------------------------------

const evalTree = (tree, opts = {}) => {
  const files = Object.keys(tree).filter((f) => f.endsWith('.md') && !f.startsWith('node_modules/'));
  return evaluate(files, (f) => tree[f], { rules: RULES, debt: {}, ...opts });
};

test('evaluate: clean tree PASSes with every rule matched', () => {
  const s = evalTree(TREES.clean);
  assert.equal(s.failed, 0);
  assert.equal(s.zeroMatch, false);
  assert.deepEqual(s.unmatchedLabels, []);
  assert.equal(s.results.length, 5);
});

test('evaluate: a dead debt entry FAILs even when nothing else matched', () => {
  const s = evalTree(TREES.unrelated, { debt: { 'gone/STATE.md': { bytes: 1, filed: '2026-10-08' } } });
  assert.equal(s.zeroMatch, true);
  assert.equal(s.failed, 1);
});

test('evaluate: a debt entry naming a non-STATE file is dead', () => {
  const s = evalTree(TREES.clean, { debt: { 'proj/CLAUDE.md': { bytes: 1, filed: '2026-10-08' } } });
  assert.equal(s.failed, 1);
  assert.ok(s.results.some((r) => r.label === 'known-debt entry'));
});

test('evaluate: no budgeted file sets zeroMatch and does not fail', () => {
  const s = evalTree(TREES.unrelated);
  assert.equal(s.zeroMatch, true);
  assert.equal(s.failed, 0);
  assert.equal(s.unmatchedLabels.length, RULES.length);
});

test('evaluate: an unreadable file is a FAIL, never a silent skip', () => {
  const s = evaluate(['proj/STATE.md'], () => { throw new Error('EACCES'); }, { rules: RULES, debt: {} });
  assert.equal(s.failed, 1);
  assert.match(s.results[0].reason, /EACCES/);
  assert.doesNotMatch(s.results[0].reason, /stage the deletion/);
});

test('evaluate: a missing listed file FAILs and names the deleted-but-tracked cause', () => {
  const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
  const s = evaluate(['proj/STATE.md'], () => { throw enoent; }, { rules: RULES, debt: {} });
  assert.equal(s.failed, 1);
  assert.match(s.results[0].reason, /deleted but still tracked\? stage the deletion/);
});

test('CLI git mode: a tracked doc removed with plain rm (not staged) FAILs with the stage-the-deletion hint', { skip: !gitAvailable && 'git not on PATH' }, () => {
  withTree(TREES.clean, {}, (dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', 'CLAUDE.md', 'proj/STATE.md'], { cwd: dir });
    rmSync(path.join(dir, 'proj', 'STATE.md'));
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /\[FAIL\] proj\/STATE\.md .*stage the deletion/);
  });
});

// --- repo-files ------------------------------------------------------------

test('listMarkdown walk: forward-slash relative paths, skips node_modules and .git, honours depth', () => {
  withTree(TREES.clean, { '.git-not/x.md': 'x\n', '.git/HEAD.md': 'x\n', 'a/b/c/d/deep.md': 'x\n' }, (dir) => {
    const { files, mode } = listMarkdown(dir, { mode: 'walk', maxDepth: 3 });
    assert.equal(mode, 'walk');
    assert.ok(files.includes('proj/STATE.md'));
    assert.ok(files.includes('group/sub/STATE.md'));
    assert.ok(files.includes('.git-not/x.md'));
    assert.ok(!files.some((f) => f.startsWith('node_modules/')));
    assert.ok(!files.some((f) => f.startsWith('.git/')));
    assert.ok(!files.includes('a/b/c/d/deep.md'), 'beyond maxDepth');
    assert.ok(files.every((f) => !f.includes('\\')));
    assert.deepEqual(files, [...files].sort());
  });
});

test('listMarkdown auto: outside a git repository it walks', () => {
  withTree(TREES.clean, {}, (dir) => {
    assert.equal(findGitDir(dir), null);
    assert.equal(listMarkdown(dir).mode, 'walk');
  });
});

test('listMarkdown git mode on a non-repo throws RepoFilesError', () => {
  withTree(TREES.clean, {}, (dir) => {
    assert.throws(() => listMarkdown(dir, { mode: 'git' }), RepoFilesError);
  });
});

test('listMarkdown auto: inside a git repository it lists TRACKED files only', { skip: !gitAvailable && 'git not on PATH' }, () => {
  withTree(TREES.clean, {}, (dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['add', 'CLAUDE.md', 'proj/STATE.md'], { cwd: dir });
    writeFileSync(path.join(dir, 'proj', 'untracked.md'), 'x\n');
    const { files, mode } = listMarkdown(dir);
    assert.equal(mode, 'git');
    assert.deepEqual(files, ['CLAUDE.md', 'proj/STATE.md']);
    // from a subdirectory, paths are relative to that subdirectory
    assert.deepEqual(listMarkdown(path.join(dir, 'proj')).files, ['STATE.md']);
  });
});

// --- CLI -------------------------------------------------------------------

test('CLI: clean tree exits 0 with a CLEAN result line', () => {
  withTree(TREES.clean, {}, (dir) => {
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /RESULT: CLEAN/);
    assert.match(r.out, /files: filesystem walk/);
    assert.doesNotMatch(r.out, /node_modules/);
  });
});

test('CLI: the wide STATE exits 1 and names the byte budget', () => {
  withTree(TREES.wideState, {}, (dir) => {
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.out, /\[FAIL\] proj\/STATE\.md/);
    assert.match(r.out, /bytes > 24000/);
    assert.match(r.out, /RESULT: 1 FAIL/);
    assert.match(r.out, /MOVING content/);
  });
});

test('CLI: line budget FAIL on the root file exits 1', () => {
  withTree(TREES.longRouter, {}, (dir) => {
    assert.equal(runCli(['--root', dir]).code, 1);
  });
});

test('CLI: WARN only exits 0 and says PASS with WARN', () => {
  withTree(TREES.warnOnly, {}, (dir) => {
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /RESULT: PASS with 2 WARN/);
  });
});

test('CLI: zero-match is loud and exits 0', () => {
  withTree(TREES.unrelated, {}, (dir) => {
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /NO FILE MATCHED ANY BUDGET RULE/);
    assert.match(r.out, /checked nothing/);
  });
});

test('CLI: an empty directory is not a FAIL', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'doc-budget-empty-'));
  try {
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /NO FILE MATCHED ANY BUDGET RULE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: --json emits one parseable object with the exit code', () => {
  withTree(TREES.wideState, {}, (dir) => {
    const r = runCli(['--root', dir, '--json']);
    assert.equal(r.code, 1);
    const j = JSON.parse(r.out);
    assert.equal(j.failed, 1);
    assert.equal(j.exitCode, 1);
    assert.equal(j.mode, 'walk');
    assert.ok(Array.isArray(j.results));
  });
});

test('CLI: --quiet hides PASS lines but keeps FAIL lines and the result', () => {
  withTree({ ...TREES.wideState, 'other/STATE.md': doc(10, 10) }, {}, (dir) => {
    const r = runCli(['--root', dir, '--quiet']);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.out, /\[PASS\]/);
    assert.match(r.out, /\[FAIL\] proj\/STATE\.md/);
    assert.match(r.out, /RESULT:/);
  });
});

test('CLI: config overrides and knownDebt are read from .claude/guardrails.json', () => {
  withTree(TREES.wideState, {}, (dir) => {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const cfg = { budgets: { knownDebt: { 'proj/STATE.md': { bytes: 90_000, filed: '2026-10-08', owner: 'docs team' } } } };
    writeFileSync(path.join(dir, '.claude', 'guardrails.json'), JSON.stringify(cfg));
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[DEBT\] proj\/STATE\.md/);
    assert.match(r.out, /PASS with 1 DEBT/);
  });
});

test('CLI: a label override from .claude/guardrails.json is applied on top of the shipped rules', () => {
  withTree(TREES.wideState, {}, (dir) => {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const cfg = { budgets: { 'project STATE': { maxBytes: 90_000, warnBytes: 85_000, warnAt: 220 } } };
    writeFileSync(path.join(dir, '.claude', 'guardrails.json'), JSON.stringify(cfg));
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[PASS\] proj\/STATE\.md .*budget 240 \/ 90,000 B/);
    assert.match(r.out, /\[PASS\] CLAUDE\.md .*budget 120/);
    assert.doesNotMatch(r.out, /config:/);
  });
});

test('CLI: knownDebt entry {bytes, filed} with no owner field reports DEBT', () => {
  withTree(TREES.wideState, {}, (dir) => {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'guardrails.json'), JSON.stringify({ budgets: { knownDebt: { 'proj/STATE.md': { bytes: 90_000, filed: '2026-10-08' } } } }));
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[DEBT\] proj\/STATE\.md/);
  });
});

test('CLI: knownDebt entry FAILs once the file grows past its ceiling', () => {
  withTree(TREES.wideState, {}, (dir) => {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'guardrails.json'), JSON.stringify({ budgets: { knownDebt: { 'proj/STATE.md': { bytes: 30_000, filed: '2026-10-08' } } } }));
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /filed ceiling of 30000/);
  });
});

test('CLI: knownDebt entry FAILs once the file is trimmed under budget', () => {
  withTree(TREES.clean, {}, (dir) => {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'guardrails.json'), JSON.stringify({ budgets: { knownDebt: { 'proj/STATE.md': { bytes: 30_000, filed: '2026-10-08' } } } }));
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /delete its knownDebt entry/);
  });
});

test('CLI: a dead knownDebt entry exits 1', () => {
  withTree(TREES.clean, {}, (dir) => {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'guardrails.json'), JSON.stringify({ budgets: { knownDebt: { 'gone/STATE.md': { bytes: 1, filed: '2026-10-08' } } } }));
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /DEAD KNOWN-DEBT ENTRY/);
  });
});

test('CLI: config warnings are printed, the run continues', () => {
  withTree(TREES.clean, {}, (dir) => {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'guardrails.json'), JSON.stringify({ budgets: { 'no such label': { max: 1 } } }));
    const r = runCli(['--root', dir]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /config: .*unknown label/);
    assert.doesNotMatch(r.out, /unknown key\(s\) ignored: budgets\./, 'budgets keys are validated by the gate, not reported as unknown');
  });
});

test('CLI: unknown flag and missing --root value exit 2 with usage', () => {
  const a = runCli(['--bogus']);
  assert.equal(a.code, 2);
  assert.match(a.err, /usage/i);
  assert.equal(runCli(['--root']).code, 2);
});

test('CLI: an unreadable root exits 2', () => {
  const r = runCli(['--root', path.join(tmpdir(), 'doc-budget-does-not-exist-' + process.pid)]);
  assert.equal(r.code, 2);
  assert.match(r.err, /root/i);
});

test('CLI: --help exits 0', () => {
  const r = runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage/i);
});
