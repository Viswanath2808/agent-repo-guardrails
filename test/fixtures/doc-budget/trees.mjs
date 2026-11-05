// test/fixtures/doc-budget/trees.mjs -- file trees for the doc-budget tests.
//
// Trees are declared as data and written into a fresh temp directory per test
// rather than committed as real files. Two reasons, both practical:
//   1. A committed fixture named CLAUDE.md or STATE.md inside this plugin would
//      be picked up by the host repo's own tooling (and by Claude Code itself,
//      which loads nested CLAUDE.md files) as if it were a real project doc.
//   2. A temp directory is outside any git repository, so the CLI exercises its
//      filesystem-walk path deterministically; the git path is covered by a
//      test that runs `git init` only when git is available.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** `n` lines of `width` chars (plus newline) -- the shape of a wide register table. */
export const doc = (n, width) =>
  Array.from({ length: n }, (_, i) => `| R${i} | ${'x'.repeat(Math.max(0, width - 10))} |`).join('\n') + '\n';

export const TREES = {
  // Every rule matched once, all within budget.
  clean: {
    'CLAUDE.md': doc(40, 60),
    'proj/STATE.md': doc(80, 80),
    'proj/LOG.md': doc(5000, 120),
    'proj/CLAUDE.md': doc(300, 80),
    'group/sub/STATE.md': doc(20, 40),
    'proj/design/notes.md': doc(9000, 200),          // not budgeted
    'node_modules/pkg/STATE.md': doc(999, 999),       // skipped by the walk
  },
  // The measured negative case: lines PASS, bytes FAIL.
  wideState: {
    'CLAUDE.md': doc(40, 60),
    'proj/STATE.md': doc(213, 380),
  },
  // Line budget exceeded on the root file.
  longRouter: {
    'CLAUDE.md': doc(121, 20),
  },
  // Only WARN-band files: exit 0.
  warnOnly: {
    'CLAUDE.md': doc(100, 40),
    'proj/STATE.md': doc(150, 140),
  },
  // No budgeted file at all.
  unrelated: {
    'README.md': doc(10, 10),
    'a/b/c/STATE.md': doc(10, 10),                    // three levels deep: not a project
  },
};

/** Write a tree (plus optional extra files) into a new temp dir; returns {dir, cleanup}. */
export function materialize(tree, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'doc-budget-'));
  for (const [rel, text] of Object.entries({ ...tree, ...extra })) {
    const abs = path.join(dir, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
