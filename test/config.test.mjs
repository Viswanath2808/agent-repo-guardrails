// test/config.test.mjs -- lib/config.mjs: defaults, merge, bad input never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, resolveProjectDir, DEFAULTS, CONFIG_RELATIVE_PATH } from '../lib/config.mjs';

function tmpProject(json) {
  const dir = mkdtempSync(path.join(tmpdir(), 'arg-config-'));
  if (json !== undefined) {
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, CONFIG_RELATIVE_PATH), typeof json === 'string' ? json : JSON.stringify(json));
  }
  return dir;
}

test('no file -> defaults, source=defaults, no warnings', () => {
  const dir = tmpProject();
  try {
    const r = loadConfig(dir);
    assert.equal(r.source, 'defaults');
    assert.deepEqual(r.config, DEFAULTS);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.config.guard.enabled, false, 'guard is OFF by default');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('partial file merges over defaults, nested', () => {
  const dir = tmpProject({ defaultBranch: 'trunk', guard: { enabled: true } });
  try {
    const r = loadConfig(dir);
    assert.equal(r.source, 'file');
    assert.equal(r.config.defaultBranch, 'trunk');
    assert.equal(r.config.guard.enabled, true);
    assert.deepEqual(r.config.guard.arms, ['git-writes'], 'untouched nested keys keep defaults');
    assert.deepEqual(r.warnings, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown keys are ignored and named in one warning', () => {
  const dir = tmpProject({ colour: 'blue', guard: { enabled: false, verbose: true } });
  try {
    const r = loadConfig(dir);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /unknown key/);
    assert.match(r.warnings[0], /colour/);
    assert.match(r.warnings[0], /guard\.verbose/);
    assert.equal('colour' in r.config, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('budgets is free-form: labels and knownDebt pass through, no unknown-key warning', () => {
  const dir = tmpProject({ budgets: { 'project STATE': { max: 300 }, knownDebt: { 'apps/x/STATE.md': { bytes: 30000, filed: '2026-10-22' } } } });
  try {
    const r = loadConfig(dir);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.config.budgets['project STATE'].max, 300);
    assert.equal(r.config.budgets.knownDebt['apps/x/STATE.md'].bytes, 30000);
    assert.deepEqual(DEFAULTS.budgets, {}, 'defaults untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('budgets that is not an object falls back to {} with one warning (review finding)', () => {
  for (const bad of ['big', ['project STATE'], null, 7]) {
    const dir = tmpProject({ budgets: bad });
    try {
      const r = loadConfig(dir);
      assert.deepEqual(r.config.budgets, {});
      assert.equal(r.warnings.length, 1, `budgets=${JSON.stringify(bad)}`);
      assert.match(r.warnings[0], /budgets must be an object/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('unparseable JSON -> defaults + warning, never throws', () => {
  const dir = tmpProject('{ not json');
  try {
    const r = loadConfig(dir);
    assert.equal(r.source, 'defaults');
    assert.equal(r.config.guard.enabled, false);
    assert.match(r.warnings[0], /unreadable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('non-object JSON (array) -> defaults + warning', () => {
  const dir = tmpProject([1, 2]);
  try {
    const r = loadConfig(dir);
    assert.equal(r.source, 'defaults');
    assert.match(r.warnings[0], /not a JSON object/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wrong types inside guard fall back safely', () => {
  const dir = tmpProject({ guard: { enabled: 'yes', arms: 'git-writes', protectedPaths: 'x' } });
  try {
    const r = loadConfig(dir);
    assert.equal(r.config.guard.enabled, false, 'a string is not true');
    assert.deepEqual(r.config.guard.arms, ['git-writes']);
    assert.deepEqual(r.config.guard.protectedPaths, []);
    assert.equal(r.warnings.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a non-object guard section ("x", null, 7, []) never throws: default guard + one warning', () => {
  for (const bad of ['x', null, 7, []]) {
    const dir = tmpProject({ guard: bad });
    try {
      const r = loadConfig(dir);
      assert.equal(r.config.guard.enabled, false, `guard=${JSON.stringify(bad)}`);
      assert.deepEqual(r.config.guard.arms, ['git-writes']);
      assert.equal(r.warnings.length, 1);
      assert.match(r.warnings[0], /guard must be an object/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('DEFAULTS is frozen and loadConfig never hands out the shared object', () => {
  assert.ok(Object.isFrozen(DEFAULTS));
  const dir = tmpProject();
  try {
    const r = loadConfig(dir);
    r.config.guard.enabled = true; // mutate the copy
    assert.equal(DEFAULTS.guard.enabled, false);
    assert.equal(loadConfig(dir).config.guard.enabled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolveProjectDir: env wins, then payload.cwd, then process.cwd()', () => {
  const saved = process.env.CLAUDE_PROJECT_DIR;
  try {
    process.env.CLAUDE_PROJECT_DIR = path.join(tmpdir(), 'from-env');
    assert.equal(resolveProjectDir({ cwd: '/elsewhere' }), path.resolve(path.join(tmpdir(), 'from-env')));
    delete process.env.CLAUDE_PROJECT_DIR;
    assert.equal(resolveProjectDir({ cwd: tmpdir() }), path.resolve(tmpdir()));
    assert.equal(resolveProjectDir({}), process.cwd());
    assert.equal(resolveProjectDir(null), process.cwd());
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});
