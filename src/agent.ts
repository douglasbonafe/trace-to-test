// SIMULATED AGENT: a deterministic, offline stand-in for an LLM support agent.
// No model is called. It exists so the trace -> test -> replay loop can be shown end to end.
import { z } from 'zod';

export const DbSchema = z.object({
  customers: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
  subscriptions: z.array(z.object({ customer_id: z.string(), plan: z.string(), monthly_price: z.number() }).passthrough()),
  refunds: z.array(z.object({ id: z.string(), customer_id: z.string(), amount: z.number(), status: z.string() })),
});
export type Db = z.infer<typeof DbSchema>;
export type Doc = { id: string; text: string };
export type ToolCall = { name: string; input: unknown; output: unknown };
export type Version = 'v1' | 'v2';

export const APPROVAL_THRESHOLD = 100;

// Mocked tools bound to one in-memory DB. Every call is logged (that log is what a tracer would record).
export function makeTools(db: Db, log: ToolCall[]) {
  const tool = <I, O>(name: string, fn: (i: I) => O) => (input: I): O => {
    const output = fn(input);
    log.push({ name, input, output });
    return output;
  };
  return {
    lookup_customer: tool('lookup_customer', ({ customer_id }: { customer_id: string }) =>
      db.customers.find((c) => c.id === customer_id) ?? null),
    get_subscription: tool('get_subscription', ({ customer_id }: { customer_id: string }) =>
      db.subscriptions.find((s) => s.customer_id === customer_id) ?? null),
    request_refund: tool('request_refund', (i: { customer_id: string; amount: number; requires_approval: boolean }) => {
      const refund = {
        id: `rf_${db.refunds.length + 1}`,
        customer_id: i.customer_id,
        amount: i.amount,
        status: i.requires_approval ? 'pending_approval' : 'approved',
      };
      db.refunds.push(refund);
      return refund;
    }),
  };
}

export function runAgent(version: Version, input: { customer_id: string; message: string }, docs: Doc[], db: Db) {
  const toolCalls: ToolCall[] = [];
  const tools = makeTools(db, toolCalls);
  const customer = tools.lookup_customer({ customer_id: input.customer_id });
  if (!customer) return { reply: "I couldn't find your account.", toolCalls };
  const sub = tools.get_subscription({ customer_id: customer.id });

  const amount = Number(input.message.match(/\$\s?(\d+(?:\.\d+)?)/)?.[1]);
  if (!/refund/i.test(input.message) || !amount) {
    return { reply: `Hi ${customer.name}, how can I help with your ${sub?.plan ?? 'account'}?`, toolCalls };
  }

  const urgent = /urgent/i.test(input.message);
  // v1 BUG (the incident): an "urgent" message skips the manager-approval gate. v2 always enforces it.
  const requires_approval = amount > APPROVAL_THRESHOLD && !(version === 'v1' && urgent);
  const refund = tools.request_refund({ customer_id: customer.id, amount, requires_approval });

  const cite = docs.some((d) => d.id === 'kb-refund-policy') ? ' (see kb-refund-policy)' : '';
  const reply = refund.status === 'approved'
    ? `Done! Your refund of $${amount} has been processed and will reach your card in 3-5 days.`
    : `Refunds over $${APPROVAL_THRESHOLD} need manager approval${cite}. I've opened request ${refund.id} for $${amount}; you'll hear back within 2 business days.`;
  return { reply, toolCalls };
}
