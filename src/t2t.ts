// Trace to Test: failing trace -> redacted draft case -> human approval -> isolated replay.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { DbSchema, runAgent, type Version } from './agent';
import { redactDeep } from './redact';

// Langfuse-like trace shape (the real source would be a Langfuse/OTel export; here it's a JSON file).
const TraceSchema = z.object({
  id: z.string(),
  status: z.string(),
  timestamp: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  input: z.object({ customer_id: z.string(), message: z.string() }),
  observations: z.array(z.object({ type: z.string(), name: z.string(), input: z.unknown(), output: z.unknown() })),
  state_snapshot: DbSchema,
}).passthrough();
type Trace = z.infer<typeof TraceSchema>;

const ExpectedSchema = z.object({
  reply_must_include: z.array(z.string()).default([]),
  reply_must_not_include: z.array(z.string()).default([]),
  max_auto_approved_refund: z.number().optional(),
}).refine(
  (e) => e.reply_must_include.length + e.reply_must_not_include.length > 0 || e.max_auto_approved_refund !== undefined,
  'expected has no assertions',
);

const DocSchema = z.object({ id: z.string(), text: z.string() });
export const CaseSchema = z.object({
  id: z.string().regex(/^[\w-]+$/),
  source_trace: z.string(),
  trace_timestamp: z.string(),
  reviewed: z.boolean(),
  reviewer: z.string().nullable(),
  note: z.string(),
  input: z.object({ customer_id: z.string(), message: z.string() }),
  docs: z.array(DocSchema),
  initial_state: DbSchema,
  recorded: z.object({ tool_calls: z.array(z.object({ name: z.string(), input: z.unknown(), output: z.unknown() })), reply: z.string() }),
  expected: ExpectedSchema.nullable(),
});
export type Case = z.infer<typeof CaseSchema>;

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []);

// 1. select failing traces (a file or a folder; keep status "error" or metadata.flagged)
export function selectFailing(path: string): Trace[] {
  const files = statSync(path).isDirectory() ? jsonFiles(path).map((f) => join(path, f)) : [path];
  return files
    .map((f) => TraceSchema.parse(readJson(f)))
    .filter((t) => t.status === 'error' || t.metadata.flagged === true);
}

// 2 + 3. redact, then capture only what replay needs (input, docs, tools, initial state)
export function toDraftCase(raw: Trace): Case {
  const t = redactDeep(raw);
  return CaseSchema.parse({
    id: t.id,
    source_trace: t.id,
    trace_timestamp: t.timestamp,
    reviewed: false,
    reviewer: null,
    note: 'DRAFT: a human must fill `expected` (what the agent SHOULD have done), then run t2t:approve.',
    input: t.input,
    docs: t.observations.filter((o) => o.type === 'retrieval').flatMap((o) => o.output as unknown[]),
    initial_state: t.state_snapshot,
    recorded: {
      tool_calls: t.observations.filter((o) => o.type === 'tool').map(({ name, input, output }) => ({ name, input, output })),
      reply: String(t.observations.findLast((o) => o.type === 'generation')?.output ?? ''),
    },
    expected: null,
  });
}

// 4a. write draft to cases/pending
export function writeDraft(casesDir: string, c: Case): string {
  const dir = join(casesDir, 'pending');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${c.id}.json`);
  writeJson(p, c);
  return p;
}

// 4b. approve: pending -> approved, only with a reviewer and a filled-in expected
export function approve(casesDir: string, id: string, reviewer: string | undefined): string {
  if (!/^[\w-]+$/.test(id)) throw new Error(`invalid case id: ${id}`);
  if (!reviewer?.trim()) throw new Error('--reviewer <name> is required');
  const src = join(casesDir, 'pending', `${id}.json`);
  if (!existsSync(src)) throw new Error(`no pending case ${id}`);
  const c = CaseSchema.parse(readJson(src));
  if (!c.expected) throw new Error(`${id}: expected behavior is not filled in; a human must define it before approval`);
  const dir = join(casesDir, 'approved');
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, `${id}.json`);
  writeJson(dst, { ...c, reviewed: true, reviewer: reviewer.trim(), note: 'Approved regression case. Edit via a reviewed PR only.' });
  rmSync(src); // move semantics: the draft is now the approved case
  return dst;
}

// 5. replay one case in isolation: fresh DB cloned from the captured state + fresh mocked tools
export function runCase(c: Case, version: Version) {
  const db = structuredClone(c.initial_state);
  const out = runAgent(version, c.input, c.docs, db);
  return { ...out, db };
}

export function check(c: Case, version: Version): string[] {
  if (!c.reviewed || !c.expected) return ['not reviewed; cannot count as passing'];
  const { reply, db } = runCase(c, version);
  const e = c.expected;
  const r = reply.toLowerCase();
  const failures: string[] = [];
  for (const s of e.reply_must_include) if (!r.includes(s.toLowerCase())) failures.push(`reply missing "${s}"`);
  for (const s of e.reply_must_not_include) if (r.includes(s.toLowerCase())) failures.push(`reply contains forbidden "${s}"`);
  if (e.max_auto_approved_refund !== undefined) {
    for (const rf of db.refunds) {
      if (rf.status === 'approved' && rf.amount > e.max_auto_approved_refund) {
        failures.push(`refund ${rf.id} of $${rf.amount} auto-approved (limit $${e.max_auto_approved_refund})`);
      }
    }
  }
  return failures;
}

export function replayAll(casesDir: string, version: Version) {
  const pending = jsonFiles(join(casesDir, 'pending')).length;
  const results = jsonFiles(join(casesDir, 'approved')).map((f) => {
    const c = CaseSchema.parse(readJson(join(casesDir, 'approved', f)));
    return { id: c.id, failures: check(c, version) };
  });
  // Zero approved cases is a failure: "green because nothing ran" is not green.
  const ok = results.length > 0 && results.every((r) => r.failures.length === 0);
  return { ok, results, pending };
}

export function printReplay(r: ReturnType<typeof replayAll>, version: Version) {
  console.log(`replay against agent ${version} (simulated)`);
  for (const x of r.results) console.log(`  ${x.failures.length ? 'FAIL' : 'PASS'} ${x.id}${x.failures.map((f) => `\n       - ${f}`).join('')}`);
  if (r.pending) console.log(`  (${r.pending} pending case(s) not counted: unreviewed cases never pass)`);
  if (!r.results.length) console.log('  FAIL: 0 approved cases; an empty dataset is not a green build');
  const passed = r.results.filter((x) => !x.failures.length).length;
  console.log(`${r.ok ? 'OK' : 'BLOCKED'}: ${passed}/${r.results.length} approved cases passed`);
}

function main(argv: string[]) {
  const cases = process.env.T2T_CASES_DIR ?? 'cases';
  const version = (process.env.AGENT_VERSION ?? 'v2') as Version;
  const [cmd, arg] = argv;
  if (cmd === 'capture') {
    if (!arg) throw new Error('usage: npm run t2t -- <trace.json | traces-dir>');
    const traces = selectFailing(arg);
    if (!traces.length) throw new Error(`no failing (status=error / flagged) traces in ${arg}`);
    for (const t of traces) console.log(`draft written: ${writeDraft(cases, toDraftCase(t))} (reviewed: false, expected: null)`);
  } else if (cmd === 'approve') {
    const reviewer = argv[argv.indexOf('--reviewer') + 1];
    console.log(`approved -> ${approve(cases, arg, argv.includes('--reviewer') ? reviewer : undefined)}`);
  } else if (cmd === 'replay') {
    if (version !== 'v1' && version !== 'v2') throw new Error(`AGENT_VERSION must be v1 or v2, got ${version}`);
    const r = replayAll(cases, version);
    printReplay(r, version);
    process.exitCode = r.ok ? 0 : 1;
  } else {
    throw new Error('usage: t2t.ts capture <path> | approve <id> --reviewer <name> | replay');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
