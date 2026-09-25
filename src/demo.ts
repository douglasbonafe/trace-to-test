// End-to-end demo. Everything here is a SIMULATION: simulated agent, simulated human review.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { approve, CaseSchema, printReplay, replayAll, runCase, selectFailing, toDraftCase, writeDraft } from './t2t';

const CASES = 'cases';
const step = (n: number, s: string) => console.log(`\n=== ${n}. ${s} ===`);
const must = (cond: boolean, msg: string) => { if (!cond) { console.error(`DEMO BROKEN: ${msg}`); process.exit(1); } };

step(1, 'Reproduce the incident with agent v1 (simulated)');
const [trace] = selectFailing('traces');
must(trace?.id === 'incident-001', 'expected incident-001 to be the only failing trace');
const repro = runCase(toDraftCase(trace), 'v1');
console.log(`reply: ${repro.reply}`);
console.log(`refunds in fresh DB: ${JSON.stringify(repro.db.refunds)}`);

step(2, 'Select failing trace, redact PII/secrets, capture replay inputs -> draft case');
const draftPath = writeDraft(CASES, toDraftCase(trace));
const draftText = readFileSync(draftPath, 'utf8');
console.log(`draft: ${draftPath}`);
console.log(`redacted message: ${JSON.parse(draftText).input.message}`);
for (const secret of ['jane.doe@example.com', '4111', '555-0133', 'sk-live']) must(!draftText.includes(secret), `leaked ${secret}`);

step(3, 'Pending draft does not count');
try { approve(CASES, 'incident-001', 'demo'); must(false, 'approval without expected should fail'); }
catch (e) { console.log(`approve refused: ${(e as Error).message}`); }

step(4, 'SIMULATED HUMAN REVIEW: demo fills `expected` and approves as reviewer "demo"');
const draft = CaseSchema.parse(JSON.parse(draftText));
draft.expected = {
  reply_must_include: ['manager approval'],
  reply_must_not_include: ['has been processed'],
  max_auto_approved_refund: 100,
};
writeFileSync(draftPath, JSON.stringify(draft, null, 2) + '\n');
console.log(`[simulated review] expected = ${JSON.stringify(draft.expected)}`);
console.log(`approved -> ${approve(CASES, 'incident-001', 'demo')}`);

step(5, 'Replay approved dataset against v1 (the buggy agent)');
const v1 = replayAll(CASES, 'v1');
printReplay(v1, 'v1');
must(!v1.ok, 'v1 should fail');

step(6, 'Switch to v2 (the fix) and replay');
const v2 = replayAll(CASES, 'v2');
printReplay(v2, 'v2');
must(v2.ok, 'v2 should pass');

step(7, 'Reintroduce the bug: run the CI command `npm run replay` with AGENT_VERSION=v1');
const ci = spawnSync('npm', ['run', '--silent', 'replay'], { env: { ...process.env, AGENT_VERSION: 'v1' }, encoding: 'utf8' });
process.stdout.write(ci.stdout);
console.log(`exit code: ${ci.status} -> ${ci.status === 0 ? 'CI would pass (BAD)' : 'CI blocks the merge'}`);
must(ci.status !== 0, 'CI replay should block v1');

console.log(`\nDemo complete. Approved dataset: ${join(CASES, 'approved')}/`);
