#!/usr/bin/env node
// scripts/session-start.mjs -- SessionStart hook: prints the ritual
// (lib/ritual.mjs) to stdout, which Claude Code adds to the model's context.
//
// MUST NEVER fail the session. Every git call is wrapped, the network call
// (git fetch) is time-bounded so an offline machine still starts, and the
// script exits 0 on every path -- a session's own preamble must never be the
// reason it cannot start. The exit code is set with process.exitCode, never
// process.exit(): exiting early can cut off stdout before a pipe has drained.
//
// Wired by hooks/hooks.json (SessionStart, matcher "startup|clear").

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { buildStatus } from '../lib/ritual.mjs';
import { loadConfig, resolveProjectDir } from '../lib/config.mjs';

function readPayload() {
  try {
    if (process.stdin.isTTY) return {}; // run by hand in a terminal: nothing to read
    const text = readFileSync(0, 'utf8');
    const p = text.trim() ? JSON.parse(text) : {};
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {}; // a malformed payload changes nothing but the project-dir fallback
  }
}

function makeGit(cwd) {
  return (args, opts = {}) => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: opts.timeout ?? 3000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // A fetch that wants credentials must fail, not wait for a prompt
        // nobody will answer.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }).trim();
    } catch (e) {
      if (e && e.code === 'ETIMEDOUT') throw new Error(`timed out after ${opts.timeout ?? 3000} ms`);
      // ENOENT is raised both when the git executable is missing AND when the
      // cwd does not exist (a bad CLAUDE_PROJECT_DIR); say which (review finding).
      if (e && e.code === 'ENOENT') {
        throw new Error(existsSync(cwd) ? 'git not found on PATH' : `project directory does not exist: ${cwd}`);
      }
      const stderr = e && e.stderr ? String(e.stderr).trim().split(/\r?\n/).find(Boolean) : '';
      throw new Error(stderr || (e && e.message ? e.message.split('\n')[0] : String(e)));
    }
  };
}

async function main() {
  const payload = readPayload();
  const projectDir = resolveProjectDir(payload);
  const { config, warnings } = loadConfig(projectDir);

  let decide;
  let decideError;
  if (config.guard && config.guard.enabled === true) {
    try {
      const mod = await import('../lib/decide.mjs');
      if (typeof mod.decide === 'function') decide = mod.decide;
      else decideError = 'lib/decide.mjs has no decide() export';
    } catch (e) {
      decideError = `lib/decide.mjs not loaded: ${e && e.message ? e.message.split('\n')[0] : e}`;
    }
  }

  return buildStatus({
    git: makeGit(projectDir),
    config,
    now: Date.now(),
    configWarnings: warnings,
    projectDir,
    readFile: (f) => readFileSync(f, 'utf8'),
    decide,
    decideError,
  });
}

let lines;
try {
  lines = await main();
} catch (e) {
  lines = [`session-start: unexpected error, ritual stopped early (${e && e.message ? e.message.split('\n')[0] : e})`];
}
process.stdout.write(lines.join('\n') + '\n');
process.exitCode = 0;
