#!/usr/bin/env node
// scripts/guard.mjs -- PreToolUse hook: the optional guard.
//
// stdin JSON -> loadConfig(resolveProjectDir(payload)) -> decide() -> exit code.
//   exit 0  allow, SILENT: no stdout, no stderr.
//   exit 2  BLOCK: stderr becomes the agent's feedback. This is the only exit
//           code that stops the tool call.
// Any OTHER exit code is a non-blocking error under the hooks contract -- it
// FAILS OPEN (measured: an earlier version with a static import of a broken
// decision module died before any try block ran, exited 1, and the tool call
// went through). So while the guard is enabled, every failure path ends in
// exit 2. While it is disabled, every path ends in exit 0: a disabled guard
// must be a true no-op, broken modules included.
//
// The guard is OFF unless <project>/.claude/guardrails.json sets
// "guard": { "enabled": true }.
//
// stderr is written with fs.writeSync: on Windows, when stderr is a pipe,
// process.stderr.write() can return before the bytes are flushed and an exit
// right after it can lose the reason (measured). Every path sets
// process.exitCode and returns, never process.exit(), so pipes drain.

import { readFileSync, writeSync } from 'node:fs';
import path from 'node:path';

const HAND_OVER = {
  'git-writes': 'Hand this command to a human to run; read-only forms are allowed.',
  'protected-paths': 'Hand this change to a human; the guard keeps the agent out of its own configuration and the paths listed in guard.protectedPaths.',
  'fail-closed': 'The command could not be classified safely. Split it into plain commands, or hand it to a human.',
};

// The parsed payload, kept so the last-resort handler can still find the
// project directory.
let parsedPayload = null;

// Never throws: if stderr is closed (EPIPE) the reason is lost, but the
// verdict is not -- a throw here would reach the top level and exit 1, which
// fails OPEN (independent review).
function block(reason, arm) {
  const tag = arm ? ` [${arm}]` : '';
  const tail = HAND_OVER[arm] || HAND_OVER['fail-closed'];
  try {
    writeSync(2, `agent-repo-guardrails guard BLOCKED${tag}: ${reason}\n${tail}\n`);
  } catch {
    // nothing left to report to; the exit code still blocks
  }
  return 2;
}

// If lib/config.mjs itself cannot load, decide "is the guard on?" by reading
// the file directly -- the one question that picks fail-open (off) or
// fail-closed (on).
function enabledFallback(payload) {
  const fromEnv = process.env.CLAUDE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR.trim();
  const dir = fromEnv || (payload && typeof payload.cwd === 'string' && payload.cwd) || process.cwd();
  try {
    const cfg = JSON.parse(readFileSync(path.join(dir, '.claude', 'guardrails.json'), 'utf8'));
    return !!(cfg && cfg.guard && cfg.guard.enabled === true);
  } catch {
    return false;
  }
}

async function main() {
  let raw = null;
  let readError = null;
  try { raw = readFileSync(0, 'utf8'); } catch (e) { readError = e; }

  let payload = null;
  let parseError = null;
  if (raw !== null) {
    try { payload = JSON.parse(raw); parsedPayload = payload; } catch (e) { parseError = e; }
  }

  let config;
  let projectDir;
  try {
    const { loadConfig, resolveProjectDir } = await import(new URL('../lib/config.mjs', import.meta.url));
    projectDir = resolveProjectDir(payload);
    ({ config } = loadConfig(projectDir));
  } catch (e) {
    if (!enabledFallback(payload)) return 0;
    return block(`config module failed to load -- guard error, refusing by default (${e && e.message ? e.message : e})`, 'fail-closed');
  }

  if (!config || !config.guard || config.guard.enabled !== true) return 0;

  if (readError) return block(`could not read stdin -- guard error, refusing by default (${readError.message})`, 'fail-closed');
  if (parseError) return block(`stdin was not valid JSON -- guard error, refusing by default (${parseError.message})`, 'fail-closed');

  let decide;
  try {
    ({ decide } = await import(new URL('../lib/decide.mjs', import.meta.url)));
  } catch (e) {
    return block(`decision module failed to load -- guard error, refusing by default (${e && e.message ? e.message : e})`, 'fail-closed');
  }

  let verdict;
  try {
    verdict = decide({ tool_name: payload && payload.tool_name, tool_input: payload && payload.tool_input, projectDir }, config);
  } catch (e) {
    return block(`internal error deciding -- refusing by default (${e && e.message ? e.message : e})`, 'fail-closed');
  }
  if (verdict && verdict.allow === true) return 0;
  return block((verdict && verdict.reason) || 'refused with no reason -- guard error', verdict && verdict.arm);
}

try {
  process.exitCode = await main();
} catch (e) {
  // Last resort. Unreachable by design; if it is reached, honour the
  // enabled/disabled split rather than exiting with a code that fails open.
  process.exitCode = enabledFallback(parsedPayload) ? block(`unexpected guard error (${e && e.message ? e.message : e})`, 'fail-closed') : 0;
}
