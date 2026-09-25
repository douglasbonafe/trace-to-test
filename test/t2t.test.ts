import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redact } from '../src/redact';
import { approve, check, replayAll, runCase, selectFailing, toDraftCase, writeDraft, type Case } from '../src/t2t';

const tmp = () => mkdtempSync(join(tmpdir(), 't2t-'));
const draft = () => toDraftCase(selectFailing('traces/incident-001.json')[0]);
const EXPECTED = { reply_must_include: ['manager approval'], reply_must_not_include: ['has been processed'], max_auto_approved_refund: 100 };
const approvedDataset = (c: Case = draft()) => {
  const dir = tmp();
  writeDraft(dir, { ...c, expected: EXPECTED });
  approve(dir, c.id, 'tester');
  return dir;
};

describe('select', () => {
  it('keeps only error/flagged traces from a folder', () => {
    expect(selectFailing('traces').map((t) => t.id)).toEqual(['incident-001']);
  });
});

describe('redaction', () => {
  it('no email, phone, card or api key survives in the draft case', () => {
    const text = JSON.stringify(draft());
    for (const leak of ['jane.doe@example.com', '415', '555-0133', '4111', 'sk-live', 'eyJhbGci']) expect(text).not.toContain(leak);
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.\w+/);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).not.toMatch(/(?:\d[ -]?){12,}/);
    expect(text).toContain('[EMAIL]');
    expect(text).toContain('[CARD]');
    expect(text).toContain('[PHONE]');
  });

  it.each([
    ['mail a.b+c@mail.co.uk now', 'mail [EMAIL] now'],
    ['call 415.555.0133', 'call [PHONE]'],
    ['call (415) 555-0133', 'call [PHONE]'],
    ['call +44 20 7946 0958', 'call +44 20 7946 0958'], // ponytail: documented ceiling, non-NANP formats pass through
    ['card 5500-0000-0000-0004', 'card [CARD]'],
    ['card 378282246310005', 'card [CARD]'],
    ['key sk-proj-abcDEF123456', 'key [API_KEY]'],
    ['Authorization: Bearer abc.def.ghi123', 'Authorization: Bearer [TOKEN]'],
    ['refund $250 on 2026-09-18T14:02:11Z', 'refund $250 on 2026-09-18T14:02:11Z'],
  ])('%s', (input, out) => expect(redact(input)).toBe(out));
});

describe('approval rule', () => {
  it('refuses to approve a draft without expected behavior', () => {
    const dir = tmp();
    writeDraft(dir, draft());
    expect(() => approve(dir, 'incident-001', 'alice')).toThrow(/expected behavior is not filled in/);
    expect(existsSync(join(dir, 'pending', 'incident-001.json'))).toBe(true);
    expect(existsSync(join(dir, 'approved', 'incident-001.json'))).toBe(false);
  });

  it('refuses empty expected and missing reviewer', () => {
    const dir = tmp();
    const p = writeDraft(dir, draft());
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), expected: {} }));
    expect(() => approve(dir, 'incident-001', 'alice')).toThrow(/no assertions/);
    writeDraft(dir, { ...draft(), expected: EXPECTED });
    expect(() => approve(dir, 'incident-001', undefined)).toThrow(/reviewer/);
    expect(() => approve(dir, '../x', 'alice')).toThrow(/invalid case id/);
  });

  it('moves a filled draft to approved with the reviewer recorded', () => {
    const dir = approvedDataset();
    const c = JSON.parse(readFileSync(join(dir, 'approved', 'incident-001.json'), 'utf8'));
    expect(c).toMatchObject({ reviewed: true, reviewer: 'tester' });
    expect(existsSync(join(dir, 'pending', 'incident-001.json'))).toBe(false);
  });
});

describe('replay', () => {
  it('zero approved cases is a failure, pending cases never count', () => {
    const dir = tmp();
    expect(replayAll(dir, 'v2').ok).toBe(false);
    writeDraft(dir, { ...draft(), expected: EXPECTED });
    expect(replayAll(dir, 'v2')).toMatchObject({ ok: false, pending: 1, results: [] });
  });

  it('an approved file with reviewed:false fails', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'approved'));
    writeFileSync(join(dir, 'approved', 'x.json'), JSON.stringify({ ...draft(), id: 'x', expected: EXPECTED }));
    expect(replayAll(dir, 'v2').results[0].failures).toEqual(['not reviewed; cannot count as passing']);
  });

  it('catches the v1 bug and passes on v2', () => {
    const dir = approvedDataset();
    expect(replayAll(dir, 'v1').ok).toBe(false);
    expect(replayAll(dir, 'v2').ok).toBe(true);
  });

  it('isolates each run: fresh DB, captured state untouched', () => {
    const c = { ...draft(), reviewed: true, reviewer: 't', expected: EXPECTED };
    const a = runCase(c, 'v1');
    const b = runCase(c, 'v1');
    expect(c.initial_state.refunds).toEqual([]);
    expect(a.db).not.toBe(b.db);
    expect(a.db.refunds).toHaveLength(1);
    expect(b.db.refunds).toEqual([{ id: 'rf_1', customer_id: 'cus_1001', amount: 250, status: 'approved' }]);
    expect(check(c, 'v2')).toEqual([]); // a prior v1 run leaves no state behind
  });
});
