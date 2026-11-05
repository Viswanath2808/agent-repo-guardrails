#!/usr/bin/env node
// scripts/doc-budget.mjs -- the doc-size budget gate, as a CLI.
//
//   node scripts/doc-budget.mjs [--root <dir>] [--json] [--quiet]
//
// Exit codes:
//   0  PASS, WARN or DEBT -- also when no file matched any rule (an empty repo
//      is not a FAIL; the report says loudly that nothing was checked)
//   1  any FAIL: a doc over its line or byte budget, a known-debt file that
//      grew or shrank under budget, a dead known-debt entry, an unreadable doc
//   2  usage error, unreadable root, or git unusable inside a git work tree
//
// The script sets process.exitCode and returns, never process.exit(): a hard
// exit can cut off piped stdout before it drains, and the JSON form exists to
// be piped.
//
// Budgets, the known-debt mechanism and why bytes are measured beside lines:
// lib/doc-budget.mjs. File discovery and why there is no git-to-walk fallback:
// lib/repo-files.mjs. Overrides: `budgets` in <root>/.claude/guardrails.json.

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { resolveBudgets, evaluate, formatReport } from '../lib/doc-budget.mjs';
import { listMarkdown, RepoFilesError } from '../lib/repo-files.mjs';

const USAGE = 'usage: node scripts/doc-budget.mjs [--root <dir>] [--json] [--quiet]';

// Rules match files at most two directories below the root.
const WALK_DEPTH = 2;

function parseArgs(argv) {
  const opts = { root: process.cwd(), json: false, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--root') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: '--root needs a directory' };
      opts.root = v;
    } else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length);
    else return { error: `unknown argument: ${a}` };
  }
  return { opts };
}

/** Run the gate; returns the exit code. `out`/`err` take one line each. */
export function main(argv, { out = (s) => process.stdout.write(s + '\n'), err = (s) => process.stderr.write(s + '\n') } = {}) {
  const { opts, error } = parseArgs(argv);
  if (error) { err(`doc-budget: ${error}`); err(USAGE); return 2; }
  if (opts.help) { out(USAGE); return 0; }

  const root = path.resolve(opts.root);
  try {
    if (!statSync(root).isDirectory()) throw new Error('not a directory');
  } catch (e) {
    err(`doc-budget: cannot read root ${root}: ${e.code || e.message}`);
    return 2;
  }

  let listing;
  try {
    listing = listMarkdown(root, { maxDepth: WALK_DEPTH });
  } catch (e) {
    if (e instanceof RepoFilesError) { err(`doc-budget: PRECONDITION FAILED -- ${e.message}`); return 2; }
    throw e;
  }

  // config.budgets is passed through free-form by loadConfig; resolveBudgets()
  // validates it and warns on any label, key or value it does not know.
  const { config, warnings: configWarnings } = loadConfig(root);
  const { rules, debt, warnings: budgetWarnings } = resolveBudgets(config.budgets);
  const warnings = [...configWarnings, ...budgetWarnings];

  const summary = evaluate(listing.files, (f) => readFileSync(path.join(root, ...f.split('/')), 'utf8'), { rules, debt });
  const exitCode = summary.failed > 0 ? 1 : 0;

  if (opts.json) {
    out(JSON.stringify({ root, mode: listing.mode, ...summary, warnings, exitCode }, null, 2));
  } else {
    for (const line of formatReport(summary, { quiet: opts.quiet, root, mode: listing.mode, warnings })) out(line);
  }
  return exitCode;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`doc-budget: unexpected error: ${e && e.stack || e}\n`);
    process.exitCode = 2;
  }
}
