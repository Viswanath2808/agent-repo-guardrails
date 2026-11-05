// lib/repo-files.mjs -- the one way the plugin asks which markdown files exist.
//
// Two modes, chosen by a FILESYSTEM fact, never by whether a command happened
// to fail:
//   git   -- the root is inside a git work tree (a `.git` entry exists at the
//            root or an ancestor). Files = `git ls-files`: tracked files only,
//            so scratch notes and build output never count against a budget.
//            This is the INDEX, not the working tree: a file deleted with a
//            plain `rm` but not staged, or excluded by a sparse checkout, is
//            still listed. The gate reports it as an unreadable FAIL naming
//            that cause ("deleted but still tracked? stage the deletion") --
//            deliberately not a silent skip.
//   walk  -- no `.git` anywhere above the root. Files = a directory walk,
//            skipping `node_modules` and `.git`, never following symlinks.
//
// WHY NO FALLBACK FROM git TO walk. Measured on a Windows machine where git was
// on PATH inside Git Bash but not in PowerShell: three gates that shelled out to
// `git ls-files` disagreed about what to do when it failed. One aborted
// (correct). One reported an empty list, so every budget matched zero files and
// the gate blamed the docs for a missing executable. The third silently walked
// the filesystem instead and returned a well-formed, confident, WRONG answer --
// different file set, its own exclusion filter dropped, 23 phantom failures. A
// fallback that answers a different question than the one asked is not a
// fallback. So inside a git work tree a failing git is an error (RepoFilesError,
// the CLI exits 2), and the walk is used only where git was never the question.
//
// Callers filter the list themselves with a regex -- deliberately not a glob
// parameter: `git ls-files "*LOG.md"` also matches CHANGELOG.md, exactly the
// kind of near-miss a gate should not silently absorb.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

export class RepoFilesError extends Error {
  constructor(message) { super(message); this.name = 'RepoFilesError'; }
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

/** The nearest `.git` entry (directory, or file for worktrees/submodules) at or above `root`, else null. */
export function findGitDir(root) {
  let dir = path.resolve(root);
  for (;;) {
    const candidate = path.join(dir, '.git');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitMarkdown(root) {
  let out;
  try {
    // -z: NUL-separated and unquoted, so non-ASCII and odd names survive.
    // Paths come back relative to `root`, which may be a subdirectory.
    out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  } catch (e) {
    const detail = e && e.code === 'ENOENT'
      ? 'git is not on PATH for this process (a shell that has it is not enough; the process that runs this script needs it)'
      : String((e && e.stderr) || (e && e.message) || e).trim().split('\n')[0];
    throw new RepoFilesError(`cannot ask git which files are tracked under ${root}: ${detail}. ` +
      'Not falling back to a filesystem walk: inside a git work tree that would answer a different question and report it as this one.');
  }
  return out.split('\0').filter(Boolean).filter((f) => f.endsWith('.md')).sort();
}

function walkMarkdown(root, maxDepth) {
  const files = [];
  const visit = (abs, rel, depth) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || depth >= maxDepth) continue;
        visit(path.join(abs, ent.name), childRel, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        files.push(childRel);
      }
    }
  };
  visit(root, '', 0);
  return files.sort();
}

/**
 * Markdown files under `root`, as sorted forward-slash paths relative to it.
 * @param {string} root
 * @param {{ mode?: 'auto'|'git'|'walk', maxDepth?: number }} [opts] maxDepth = directory levels below root the walk descends (walk mode only).
 * @returns {{ files: string[], mode: 'git'|'walk' }}
 * @throws {RepoFilesError} in git mode when git cannot list the files.
 */
export function listMarkdown(root, { mode = 'auto', maxDepth = Infinity } = {}) {
  const useGit = mode === 'git' || (mode === 'auto' && findGitDir(root) !== null);
  if (useGit) return { files: gitMarkdown(root), mode: 'git' };
  return { files: walkMarkdown(root, maxDepth), mode: 'walk' };
}
