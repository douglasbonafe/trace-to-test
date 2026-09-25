# trace-to-test

Turn a production incident trace into a permanent, human-reviewed regression test.

When an LLM agent misbehaves in production, the trace is the best bug report you will get.
This project shows the loop that turns it into a test that runs on every PR: select the
failing trace, strip PII and secrets, capture exactly what a replay needs, have a human write
down the expected behavior, and replay it in isolation from then on.

> **Simulation notice.** The support agent here is a **deterministic, offline simulated agent**
> (`src/agent.ts`). It calls no model. The tools (`lookup_customer`, `get_subscription`,
> `request_refund`) are mocks over an in-memory DB. Traces are JSON files in a Langfuse-like
> shape; in a real setup they would be exported from Langfuse (or any OTel tracer). There is
> no Langfuse dependency.

## The incident

A fictional SaaS support agent, **v1**, has a bug: if the customer writes "urgent", it skips
the manager-approval gate and auto-approves refunds over $100. Finance flagged
`traces/incident-001.json`: a $250 refund was "processed" against policy. **v2** fixes it.
The trace contains an email, phone numbers, a card number, a Bearer token and an `sk-live-...` key,
so it must never land in the repo as-is.

## The 6-step flow

| # | Step | Where |
|---|------|-------|
| 1 | **Select** failing traces from a file or folder (`status: "error"` or `metadata.flagged: true`) | `selectFailing` in `src/t2t.ts` |
| 2 | **Redact** PII and secrets (email, phone, card, `sk-` key, Bearer token) on every string value | `src/redact.ts` |
| 3 | **Capture** what replay needs: user input, retrieved docs, recorded tool calls, initial DB state | `toDraftCase` |
| 4 | **Draft** to `cases/pending/<id>.json` with `reviewed: false`, `expected: null` | `npm run t2t -- <trace-or-dir>` |
| 5 | **Approve**: a human fills `expected`, then `npm run t2t:approve -- <id> --reviewer <name>` moves it to `cases/approved/` (the versioned dataset). Refused if `expected` is missing or empty. | `approve` |
| 6 | **Replay** every approved case against the current agent, each with a fresh cloned DB and fresh mocks. CI runs this on every PR. | `npm run replay` |

Rules the replay enforces:
- Pending/unreviewed cases never count as passing. An `approved/` file with `reviewed: false` fails.
- **Zero approved cases fails** the build. Green because nothing ran is not green.

`expected` is deliberately small: `reply_must_include`, `reply_must_not_include`,
`max_auto_approved_refund` (checked against the replay's final DB state, not just the text).

## Run it

Requires Node 22.12+ (Vitest 5 requirement).

```bash
npm install
npm test          # redaction, approval rule, replay isolation
npm run demo      # the whole story, end to end

# manual flow
npm run t2t -- traces/                       # draft every failing trace
$EDITOR cases/pending/incident-001.json      # fill "expected"
npm run t2t:approve -- incident-001 --reviewer alice
npm run replay                               # AGENT_VERSION=v2 by default
AGENT_VERSION=v1 npm run replay              # the buggy agent: exits 1
```

`T2T_CASES_DIR` overrides the `cases/` directory.

Docker (same gate as CI: tests, then replay):

```bash
docker build -t trace-to-test .
docker run --rm trace-to-test
```

CI: `.github/workflows/regression.yml` runs `typecheck`, `test` and `replay` on every PR.

## Measured output

`npm test` (local, Node 26.10, macOS):

```
 RUN  v5.0.2 /Users/dsbonafe/dev/llm-qa/worktrees/trace-to-test

 Test Files  1 passed (1)
      Tests  18 passed (18)
   Duration  133ms (import 50%, transform 31%, tests 17%, worker 3%)
```

`npm run demo`:

```
=== 1. Reproduce the incident with agent v1 (simulated) ===
reply: Done! Your refund of $250 has been processed and will reach your card in 3-5 days.
refunds in fresh DB: [{"id":"rf_1","customer_id":"cus_1001","amount":250,"status":"approved"}]

=== 2. Select failing trace, redact PII/secrets, capture replay inputs -> draft case ===
draft: cases/pending/incident-001.json
redacted message: URGENT!!! I was double charged. Refund $250 to my card [CARD] right now. Call me at [PHONE] or email [EMAIL]

=== 3. Pending draft does not count ===
approve refused: incident-001: expected behavior is not filled in; a human must define it before approval

=== 4. SIMULATED HUMAN REVIEW: demo fills `expected` and approves as reviewer "demo" ===
[simulated review] expected = {"reply_must_include":["manager approval"],"reply_must_not_include":["has been processed"],"max_auto_approved_refund":100}
approved -> cases/approved/incident-001.json

=== 5. Replay approved dataset against v1 (the buggy agent) ===
replay against agent v1 (simulated)
  FAIL incident-001
       - reply missing "manager approval"
       - reply contains forbidden "has been processed"
       - refund rf_1 of $250 auto-approved (limit $100)
BLOCKED: 0/1 approved cases passed

=== 6. Switch to v2 (the fix) and replay ===
replay against agent v2 (simulated)
  PASS incident-001
OK: 1/1 approved cases passed

=== 7. Reintroduce the bug: run the CI command `npm run replay` with AGENT_VERSION=v1 ===
replay against agent v1 (simulated)
  FAIL incident-001
       - reply missing "manager approval"
       - reply contains forbidden "has been processed"
       - refund rf_1 of $250 auto-approved (limit $100)
BLOCKED: 0/1 approved cases passed
exit code: 1 -> CI blocks the merge
```

Empty dataset (only a pending draft), `npm run replay` exits 1:

```
replay against agent v2 (simulated)
  (1 pending case(s) not counted: unreviewed cases never pass)
  FAIL: 0 approved cases; an empty dataset is not a green build
BLOCKED: 0/0 approved cases passed
```

Docker: not measured. The Docker daemon was not running on the build machine, so `docker build`
was not executed.

## Limitations

- **Regex redaction has a ceiling.** It catches well-formed emails, NANP/E.164-style phones,
  13-19 digit card numbers, `sk-` keys and Bearer tokens. It does **not** catch names
  (`Jane Doe` survives in the case), addresses, many international phone formats
  (`+44 20 7946 0958` passes through; there is a test pinning this), or obfuscated secrets.
  Production needs an NER/Presidio-style detector plus a field allowlist, and a human still
  reviews the draft before approval.
- **Simulated agent.** Deterministic rules stand in for an LLM, so replay is exact. With a real
  model, replay is stochastic: you would pin model/prompt versions, run N samples, and assert on
  behavior (tool calls, DB state) rather than exact text.
- **Mocked tools replay against captured state**, not recorded tool outputs. That catches
  decision bugs (the incident here) but not bugs in real downstream services.
- Traces are local JSON files; there is no live Langfuse pull.
- The demo's review step is simulated (`reviewer: "demo"`), and says so in its output.

## 3-minute video script outline

1. **0:00-0:20 Hook.** "An agent promised a $250 refund it wasn't allowed to give. How do you make sure it never happens again?"
2. **0:20-0:50 The trace.** Open `traces/incident-001.json`: the urgent message, the KB policy doc, the `request_refund` call with `requires_approval: false`, and the PII/secrets in it.
3. **0:50-1:20 Capture.** `npm run t2t -- traces/`. Show the `ok-002` trace is skipped, and the draft with `[EMAIL]`, `[PHONE]`, `[CARD]`, `[API_KEY]` placeholders and `expected: null`.
4. **1:20-1:50 Human review.** Try to approve without `expected`: refused. Fill `expected`, approve with `--reviewer`. Point out pending cases never count and an empty dataset fails CI.
5. **1:50-2:30 Replay.** `AGENT_VERSION=v1 npm run replay` fails with three reasons, including the DB-state check. `npm run replay` on v2 passes. Mention the fresh DB per case.
6. **2:30-2:50 CI.** Show `regression.yml`; reintroducing the bug turns the PR red.
7. **2:50-3:00 Limits.** Regex redaction ceiling, simulated agent, what changes with a real LLM.
