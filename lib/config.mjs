// lib/config.mjs -- the one place the plugin reads user configuration.
//
// Config file: <projectDir>/.claude/guardrails.json (optional). Absent, or
// unparseable, means DEFAULTS -- the plugin never fails because of its own
// config. An unparseable file is reported through `warnings` so the
// session-start ritual can print one line about it; nothing else changes.
//
// projectDir resolution (hooks): CLAUDE_PROJECT_DIR, else the hook payload's
// `cwd`, else process.cwd(). Measured 2026-10-22: CLAUDE_PROJECT_DIR is set
// for plugin hooks and equals the worktree the session started in.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const CONFIG_RELATIVE_PATH = path.join('.claude', 'guardrails.json');

export const DEFAULTS = Object.freeze({
  // Git branch the ritual compares against. null = detect from
  // refs/remotes/origin/HEAD, falling back to 'main'.
  defaultBranch: null,
  // Optional markdown file holding a table `| <worktree-dir-name> | <role> |`;
  // the ritual prints this tree's role when a row matches. null = skip.
  roleMap: null,
  // Doc-size budgets, keyed by label. Values override the shipped defaults in
  // lib/doc-budget.mjs. The README says: prefer moving content to a log over
  // raising a number -- the override exists for file layouts we cannot predict.
  budgets: {},
  guard: {
    // OFF by default: a reader who installs a plugin and immediately cannot
    // commit learns only to uninstall it. Enabling is a deliberate second step.
    enabled: false,
    // Arms to run when enabled. 'git-writes' is the generic one (the agent
    // hands every git/gh write to a human). Others may be added by lib/decide.mjs.
    arms: ['git-writes'],
    // Paths (relative to projectDir) the agent may not edit when the guard is
    // on; the plugin's own config file is always included.
    protectedPaths: [],
  },
});

export function resolveProjectDir(payload) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  if (payload && typeof payload.cwd === 'string' && payload.cwd.trim()) return path.resolve(payload.cwd);
  return process.cwd();
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Subtrees whose keys are the USER's vocabulary (budget labels, debt paths):
// passed through as-is, never reported as unknown. Found by the README author
// exercising loadConfig before the gate existed: `budgets.<label>` was dropped
// with an "unknown key" warning because DEFAULTS.budgets is {}.
const FREE_FORM = new Set(['budgets']);

function merge(defaults, user, prefix = '') {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(user || {})) {
    if (!(k in defaults)) continue; // unknown keys are ignored, reported by unknownKeys()
    if (FREE_FORM.has(prefix + k)) { out[k] = isPlainObject(v) ? structuredClone(v) : defaults[k]; continue; }
    out[k] = isPlainObject(defaults[k]) && isPlainObject(v) ? merge(defaults[k], v, prefix + k + '.') : v;
  }
  return out;
}

/** Keys present in the user file that the plugin does not know -- for one warning line. */
function unknownKeys(defaults, user, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(user || {})) {
    if (!(k in defaults)) { out.push(prefix + k); continue; }
    if (FREE_FORM.has(prefix + k)) continue;
    if (isPlainObject(defaults[k]) && isPlainObject(v)) out.push(...unknownKeys(defaults[k], v, prefix + k + '.'));
  }
  return out;
}

/**
 * Load config for a project directory.
 * @returns {{ config: object, source: 'defaults'|'file', file: string, warnings: string[] }}
 */
export function loadConfig(projectDir) {
  const file = path.join(projectDir, CONFIG_RELATIVE_PATH);
  const warnings = [];
  if (!existsSync(file)) return { config: structuredClone(DEFAULTS), source: 'defaults', file, warnings };
  let user;
  try {
    user = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    warnings.push(`guardrails.json unreadable (${e.message.split('\n')[0]}) -- using defaults`);
    return { config: structuredClone(DEFAULTS), source: 'defaults', file, warnings };
  }
  if (!isPlainObject(user)) {
    warnings.push('guardrails.json is not a JSON object -- using defaults');
    return { config: structuredClone(DEFAULTS), source: 'defaults', file, warnings };
  }
  const unknown = unknownKeys(DEFAULTS, user);
  if (unknown.length) warnings.push(`guardrails.json: unknown key(s) ignored: ${unknown.join(', ')}`);
  const config = merge(structuredClone(DEFAULTS), user);
  // A non-object `guard` ("x", null, 7, []) would make the checks below throw
  // on property access. Found in review: the header promises "never fails
  // because of its own config", and a thrown loadConfig silently turned the
  // whole session-start ritual into one error line.
  if ('budgets' in user && !isPlainObject(user.budgets)) {
    warnings.push('budgets must be an object keyed by label -- ignored');
  }
  if (!isPlainObject(config.guard)) {
    warnings.push('guard must be an object -- using the default guard section (guard off)');
    config.guard = structuredClone(DEFAULTS.guard);
  }
  if (!Array.isArray(config.guard.arms)) { warnings.push('guard.arms must be an array -- using default'); config.guard.arms = [...DEFAULTS.guard.arms]; }
  if (!Array.isArray(config.guard.protectedPaths)) { warnings.push('guard.protectedPaths must be an array -- using default'); config.guard.protectedPaths = []; }
  if (typeof config.guard.enabled !== 'boolean') { warnings.push('guard.enabled must be true/false -- treating as false'); config.guard.enabled = false; }
  return { config, source: 'file', file, warnings };
}
