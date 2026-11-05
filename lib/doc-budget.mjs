// lib/doc-budget.mjs -- size budgets for the docs an agent reads every session,
// and the verdict for one doc. Pure: no filesystem, no process state.
//
// THE FILE LAYOUT IT ASSUMES. A repo root carries a router `CLAUDE.md` (loaded
// into every session), and each project directory -- one or two levels below
// the root, e.g. `billing/` or `apps/billing/` -- carries:
//   STATE.md   the always-current state, read IN FULL at session start
//   LOG.md     append-only history, grepped, never read whole
//   CLAUDE.md  durable reference, read section by section
// Budgets are matched by PATTERN, so a new project is covered the day its
// directory exists, with no registration step to forget. The 1-or-2-level depth
// is deliberate and measured: a one-level-only pattern silently stopped matching
// the moment a reorganisation moved projects under a parent folder, and the gate
// went green while the three biggest docs left its scope.
//
// WHY A BYTE BUDGET BESIDE THE LINE BUDGET. Size is the right proxy because a
// state file is read in full every session -- but a line budget is evaded by
// making lines longer, and wide register tables did exactly that without anyone
// deciding to. Measured 2026-10-08 on three real state files:
//
//     file A   213 lines  PASS on lines   81,654 bytes   longest line  5,019
//     file B   240 lines  PASS on lines   52,142 bytes   longest line 10,048
//     file C   198 lines  PASS on lines   16,136 bytes   longest line    157
//
// File A was ~26.5k tokens -- over the Read tool's 25k-token page cap, so "read
// in full" silently took three reads, while the gate said PASS. A gate that
// cannot fail on the thing it exists to prevent is worse than none, because
// green reads as evidence. Bytes are what a session pays; the byte budget is
// 240 lines x ~100 chars = 24,000 bytes, which every other state file in that
// repo sat under on the day it was set (largest 19.3k).
//
// BUDGETS ARE DELIBERATELY ASYMMETRIC, matching each file's read pattern. Raising
// a `max` is a decision to pay a bigger context tax on EVERY future session;
// the fix for a FAIL is to MOVE content (settled narrative to the LOG), not to
// raise the number. Overrides exist (config `budgets`, keyed by label) for file
// layouts this plugin cannot predict -- not for silencing a FAIL.
//
// KNOWN DEBT, not a raised budget. A state file already over the byte budget on
// the day you adopt this gate can be filed in config `budgets.knownDebt` with
// its MEASURED size, which becomes a CEILING:
//
//   "budgets": { "knownDebt": {
//     "apps/billing/STATE.md": { "bytes": 52142, "filed": "2026-10-08", "owner": "billing" }
//   } }
//
// It reports DEBT instead of FAIL until it grows past that size (FAIL) or drops
// under budget (FAIL: delete the entry -- a self-deleting allowlist). A session
// that trims it but stays over budget re-files the LOWER number, so the ceiling
// only moves down. An entry whose file no longer exists under a byte-budgeted
// rule is a dead entry -- FAIL (see deadDebt). The shipped set is empty.

export const STATE_MAX_BYTES = 24_000;
export const STATE_WARN_BYTES = 20_000;

/** `<dir>/<name>.md` or `<dir>/<dir>/<name>.md`, forward-slash relative paths. */
const P = (name) => new RegExp(`^(?:[^/]+/){1,2}${name}\\.md$`);

// First matching rule wins, so order matters: the root router is listed before
// the project-reference pattern.
export const RULES = Object.freeze([
  Object.freeze({
    match: (f) => f === 'CLAUDE.md',
    label: 'root router',
    max: 120,
    warnAt: 100,
    why: 'loaded into every session -- routing and global rules only, no project detail',
  }),
  Object.freeze({
    match: (f) => P('STATE').test(f),
    label: 'project STATE',
    max: 240,
    warnAt: 200,
    maxBytes: STATE_MAX_BYTES,
    warnBytes: STATE_WARN_BYTES,
    why: 'read IN FULL at session start -- settled narrative belongs in that project LOG.md',
  }),
  Object.freeze({
    match: (f) => P('LOG').test(f),
    label: 'project LOG',
    max: null, // unlimited BY DESIGN -- a growing LOG is the system working
    why: 'append-only, grepped never read -- a growing LOG is the system working correctly',
  }),
  Object.freeze({
    match: (f) => P('CLAUDE').test(f),
    label: 'project reference',
    max: 2000,
    warnAt: 1800,
    why: 'durable reference, read section by section (never whole) -- generous by design',
  }),
]);

/** Shipped empty. User entries come from config `budgets.knownDebt`. */
export const KNOWN_DEBT = Object.freeze({});

const DEBT_LABEL = 'known-debt entry';
const OVERRIDE_KEYS = ['max', 'warnAt', 'maxBytes', 'warnBytes'];
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBudgetNumber = (v) => Number.isInteger(v) && v > 0;
const normPath = (p) => String(p).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');

export function measure(text) {
  const parts = text.split('\n');
  const lines = text.length === 0 ? 0 : parts.length - (text.endsWith('\n') ? 1 : 0);
  let maxLine = 0;
  for (const l of parts) if (l.length > maxLine) maxLine = l.length;
  return { lines, bytes: Buffer.byteLength(text, 'utf8'), maxLine };
}

/**
 * Apply config `budgets` to the shipped rules.
 * Shape: { "<rule label>": { max?, warnAt?, maxBytes?, warnBytes? }, knownDebt?: { "<path>": { bytes, filed, owner? } } }
 * Every value is a positive integer; `null` turns that limit off (except on the
 * LOG rule, which has no limit to turn on). Anything else warns and is ignored --
 * a bad config never breaks the gate and never silently loosens it.
 * @returns {{ rules: object[], debt: object, warnings: string[] }}
 */
export function resolveBudgets(budgets) {
  const warnings = [];
  const rules = RULES.map((r) => ({ ...r }));
  const debt = {};
  if (budgets === undefined || budgets === null) return { rules, debt, warnings };
  // A non-object `budgets` is reported once, by lib/config.mjs; here it just
  // means "use the shipped budgets" (no second warning line).
  if (!isPlainObject(budgets)) return { rules, debt, warnings };
  const labels = rules.map((r) => r.label);
  for (const [key, value] of Object.entries(budgets)) {
    if (key === 'knownDebt') {
      if (!isPlainObject(value)) { warnings.push('budgets.knownDebt must be an object keyed by file path -- ignored'); continue; }
      for (const [file, entry] of Object.entries(value)) {
        if (!isPlainObject(entry) || !isBudgetNumber(entry.bytes) || typeof entry.filed !== 'string') {
          warnings.push(`budgets.knownDebt["${file}"] needs { "bytes": <positive integer>, "filed": "<date>" } -- ignored`);
          continue;
        }
        debt[normPath(file)] = { bytes: entry.bytes, filed: entry.filed, owner: typeof entry.owner === 'string' ? entry.owner : null };
      }
      continue;
    }
    const rule = rules.find((r) => r.label === key);
    if (!rule) { warnings.push(`budgets: unknown label "${key}" ignored (labels: ${labels.join(', ')}, knownDebt)`); continue; }
    if (!isPlainObject(value)) { warnings.push(`budgets["${key}"] must be an object -- ignored`); continue; }
    if (rule.max === null) { warnings.push(`budgets["${key}"] ignored: that file is unlimited by design (append-only history is grepped, not read)`); continue; }
    for (const [k, v] of Object.entries(value)) {
      if (!OVERRIDE_KEYS.includes(k)) { warnings.push(`budgets["${key}"].${k}: unknown key ignored (keys: ${OVERRIDE_KEYS.join(', ')})`); continue; }
      if (v !== null && !isBudgetNumber(v)) { warnings.push(`budgets["${key}"].${k}: must be a positive integer or null -- ignored`); continue; }
      if (k === 'max' && v === null) { warnings.push(`budgets["${key}"].max: null would make it unlimited -- ignored`); continue; }
      rule[k] = v;
    }
  }
  // A ceiling at or below its rule's byte budget excuses nothing: the entry is
  // kept (so the gate FAILs it with "delete the entry"), and the config says so.
  for (const [file, d] of Object.entries(debt)) {
    const rule = rules.find((r) => r.match(file));
    if (rule && rule.maxBytes != null && d.bytes <= rule.maxBytes) {
      warnings.push(`budgets.knownDebt["${file}"]: ceiling ${d.bytes} is at or below the ${rule.maxBytes}-byte budget for "${rule.label}" -- a known-debt entry is only for a file OVER budget; delete it`);
    }
  }
  return { rules, debt, warnings };
}

/**
 * Debt entries that no byte-budgeted file reached: moved, deleted, renamed, or
 * not a state file at all. Silent otherwise -- the absence-reported-as-presence
 * shape. Own label on purpose: a dead entry must never count as a STATE match.
 */
export function deadDebt(seenFiles, debt = KNOWN_DEBT) {
  const seen = new Set(seenFiles);
  return Object.keys(debt).filter((f) => !seen.has(f)).map((file) => ({
    file, status: 'FAIL', label: DEBT_LABEL, lines: null,
    reason: `budgets.knownDebt names \`${file}\`, which is not a byte-budgeted file here -- moved, deleted or renamed; delete the entry in .claude/guardrails.json`,
  }));
}

/** The verdict for one doc. `null` when no rule matches (not budgeted). */
export function judge(file, text, { rules = RULES, debt = KNOWN_DEBT } = {}) {
  const rule = rules.find((r) => r.match(file));
  if (!rule) return null;
  const m = measure(text);
  const base = { file, ...m, max: rule.max, warnAt: rule.warnAt ?? null, maxBytes: rule.maxBytes ?? null, warnBytes: rule.warnBytes ?? null, label: rule.label, why: rule.why };

  if (rule.max === null) return { ...base, status: 'UNLIMITED' };
  if (m.lines > rule.max) return { ...base, status: 'FAIL', reason: `${m.lines} lines > ${rule.max}` };

  const d = debt[file];
  if (rule.maxBytes != null) {
    if (d) {
      // "Within budget" is checked FIRST: a file under budget needs its entry
      // deleted whatever the ceiling says -- including a ceiling mis-filed
      // below the budget, which would otherwise read as "grew, move content".
      if (m.bytes <= rule.maxBytes) {
        return { ...base, status: 'FAIL', reason: `${m.bytes} bytes is within the ${rule.maxBytes}-byte budget -- delete its knownDebt entry in .claude/guardrails.json (self-deleting allowlist)` };
      }
      if (m.bytes > d.bytes) {
        return { ...base, status: 'FAIL', reason: `${m.bytes} bytes > its filed ceiling of ${d.bytes} (${d.filed}) -- move content; a ceiling is never re-filed upward` };
      }
      const who = d.owner ? `${d.owner} trims it` : 'trim it';
      return { ...base, status: 'DEBT', reason: `${m.bytes} bytes, over the ${rule.maxBytes}-byte budget; ceiling ${d.bytes} filed ${d.filed} -- ${who} and re-files the lower number if still over` };
    }
    if (m.bytes > rule.maxBytes) {
      return { ...base, status: 'FAIL', reason: `${m.bytes} bytes > ${rule.maxBytes} (longest line ${m.maxLine} chars) -- the line budget is ${rule.max}, and bytes are what a session pays` };
    }
  }

  if (rule.warnAt != null && m.lines >= rule.warnAt) return { ...base, status: 'WARN', reason: `${m.lines} lines, warn at ${rule.warnAt}` };
  if (rule.warnBytes != null && m.bytes >= rule.warnBytes) return { ...base, status: 'WARN', reason: `${m.bytes} bytes, warn at ${rule.warnBytes}` };
  return { ...base, status: 'PASS' };
}

/**
 * Judge a list of files. `read(file)` returns its text; a throw is a FAIL for
 * that file, never a silent skip.
 * @returns {{ results, failed, warned, debted, zeroMatch, unmatchedLabels }}
 */
export function evaluate(files, read, { rules = RULES, debt = KNOWN_DEBT } = {}) {
  const results = [];
  for (const raw of files) {
    const file = normPath(raw);
    const rule = rules.find((r) => r.match(file));
    if (!rule) continue;
    let text;
    try { text = read(raw); } catch (e) {
      // In git mode the list is the INDEX: a doc deleted with a plain `rm` but
      // not staged, or hidden by a sparse checkout, is listed and then cannot be
      // read. That stays a FAIL (never a silent skip) with the likely cause named.
      const msg = String(e && e.message || e).split('\n')[0];
      const hint = e && e.code === 'ENOENT' ? ' -- deleted but still tracked? stage the deletion (or check a sparse checkout)' : '';
      results.push({ file, status: 'FAIL', label: rule.label, lines: null, maxBytes: rule.maxBytes ?? null, why: rule.why, reason: `unreadable: ${msg}${hint}` });
      continue;
    }
    results.push(judge(file, text, { rules, debt }));
  }
  const unmatchedLabels = rules.filter((r) => !results.some((x) => x.label === r.label)).map((r) => r.label);
  const zeroMatch = results.length === 0;
  // Debt keys are checked against files under a byte-budgeted rule only: an
  // entry for any other file (or for a rule whose byte budget is off) is dead.
  const byteRuled = results.filter((r) => r.maxBytes != null).map((r) => r.file);
  for (const r of deadDebt(byteRuled, debt)) results.push(r);
  results.sort((a, b) => a.file.localeCompare(b.file));
  const count = (s) => results.filter((r) => r.status === s).length;
  return { results, failed: count('FAIL'), warned: count('WARN'), debted: count('DEBT'), zeroMatch, unmatchedLabels };
}

/** Human-readable report lines for an evaluate() summary. */
export function formatReport(summary, { quiet = false, root = '.', mode = 'walk', warnings = [] } = {}) {
  const out = [];
  const pad = (s, n) => String(s).padEnd(n);
  out.push('');
  out.push('================================================================');
  out.push(' doc-budget -- size budgets for the docs an agent reads');
  out.push('================================================================');
  out.push(` root: ${root}`);
  out.push(` files: ${mode === 'git' ? 'tracked by git (git ls-files)' : 'filesystem walk (not a git repository)'}`);
  for (const w of warnings) out.push(` config: ${w}`);

  if (summary.zeroMatch) {
    out.push(' ----------------------------------------------------------------');
    out.push(' NO FILE MATCHED ANY BUDGET RULE -- this run checked nothing.');
    out.push('   Expected: CLAUDE.md at the root, and <project>/STATE.md, LOG.md,');
    out.push('   CLAUDE.md one or two directories down. An empty repo is not a');
    out.push('   FAIL, but "nothing failed" is not "everything passed" either.');
  }

  for (const r of summary.results) {
    if (quiet && (r.status === 'PASS' || r.status === 'UNLIMITED')) continue;
    if (r.label === DEBT_LABEL) {
      out.push(` [FAIL] ${pad(r.file, 30)} DEAD KNOWN-DEBT ENTRY`);
      out.push(`        ^ ${r.reason}`);
      continue;
    }
    if (r.status === 'UNLIMITED') {
      out.push(` [----] ${pad(r.file, 30)} ${pad(r.lines + ' lines', 12)} unlimited by design`);
      continue;
    }
    const tag = `[${r.status}]`;
    if (r.lines == null) {
      out.push(` ${tag} ${pad(r.file, 30)} ${r.reason}`);
      continue;
    }
    const size = r.maxBytes == null
      ? `${pad(r.lines + ' lines', 12)} budget ${r.max}`
      : `${pad(r.lines + ' lines', 12)} ${pad(r.bytes.toLocaleString('en-US') + ' B', 10)} budget ${r.max} / ${r.maxBytes.toLocaleString('en-US')} B`;
    out.push(` ${tag} ${pad(r.file, 30)} ${size}`);
    if (r.status !== 'PASS') {
      out.push(`        ^ ${r.why}`);
      if (r.reason) out.push(`        ^ ${r.reason}`);
    }
  }

  if (!summary.zeroMatch && summary.unmatchedLabels.length) {
    // Informational, not a FAIL: a repo may legitimately have no LOG yet. The
    // line is printed on every run so a pattern that stopped matching after a
    // directory move is visible rather than silently absent.
    out.push(` note: matched zero files: ${summary.unmatchedLabels.join(', ')}`);
  }

  out.push(' ----------------------------------------------------------------');
  const { failed, warned, debted } = summary;
  const dead = summary.results.filter((r) => r.label === DEBT_LABEL || /knownDebt/.test(r.reason || '')).filter((r) => r.status === 'FAIL').length;
  const overBudget = failed - dead;
  if (failed === 0 && warned === 0 && debted === 0) {
    out.push(summary.zeroMatch ? ' RESULT: NOTHING CHECKED -- no budgeted file found.' : ' RESULT: CLEAN -- every budgeted doc is within budget.');
  } else if (failed === 0) {
    const parts = [];
    if (warned) parts.push(`${warned} WARN`);
    if (debted) parts.push(`${debted} DEBT`);
    out.push(` RESULT: PASS with ${parts.join(' + ')}.`);
    if (warned) out.push('         WARN: approaching budget -- start moving settled narrative into that project LOG.md before it FAILs.');
    if (debted) out.push('         DEBT: over budget, filed in budgets.knownDebt -- its owner trims it; this line repeats until they do.');
  } else {
    out.push(` RESULT: ${failed} FAIL.`);
    if (overBudget > 0) {
      out.push(`   ${overBudget} over budget: fix by MOVING content, not by raising the number:`);
      out.push('     * dated/settled narrative      -> <project>/LOG.md (append-only)');
      out.push('     * durable non-dated facts      -> <project>/CLAUDE.md (reference)');
      out.push('     * per-feature design detail    -> <project>/design/*.md');
      out.push('   Keep in STATE only: live counts, the pending queue, open questions,');
      out.push('   and the session-start steps.');
    }
    if (dead) out.push(`   ${dead} knownDebt problem(s): the reason line above says which entry to delete or which file grew.`);
  }
  out.push('================================================================');
  out.push('');
  return out;
}
