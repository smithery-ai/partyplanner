import { atom, input, secret } from "@workflow/core";
import { z } from "zod";

export const invoice = input(
  "invoice",
  z.object({
    vendor: z.string(),
    amountUsd: z.number(),
    department: z.string(),
    hasPurchaseOrder: z.boolean().default(false),
  }),
  { description: "Vendor invoice submitted for payment." },
);

export const financeApproval = input.deferred(
  "financeApproval",
  z.object({
    approved: z.boolean(),
    approver: z.string(),
  }),
  { description: "Finance approval for invoices above policy thresholds." },
);

export const paymentAuthorization = input.deferred(
  "paymentAuthorization",
  z.object({
    approved: z.boolean(),
    batchId: z.string().describe("Payment batch identifier."),
  }),
  { description: "Final payment authorization before using payment secrets." },
);

export const paymentToken = secret("paymentToken", {
  description: "Payment processor token used after approval.",
});

export const policyCheck = atom(
  (get) => {
    const i = get(invoice);
    return {
      needsApproval: i.amountUsd >= 5000 || !i.hasPurchaseOrder,
      reason: !i.hasPurchaseOrder ? "missing-po" : "amount-threshold",
    };
  },
  { name: "policyCheck" },
);

export const approveInvoice = atom(
  (get) => {
    const policy = get(policyCheck);
    if (!policy.needsApproval) return { approved: true, approver: "policy" };
    const approval = get(financeApproval);
    if (!approval.approved) return get.skip("Finance rejected the invoice.");
    return approval;
  },
  { name: "approveInvoice" },
);

export const schedulePayment = atom(
  (get) => {
    const approval = get(approveInvoice);
    const authorization = get(paymentAuthorization);
    if (!authorization.approved) {
      return get.skip("Payment authorization was rejected.");
    }
    const token = get(paymentToken);
    if (token.trim().length === 0) {
      throw new Error("Payment token was not provided.");
    }
    const i = get(invoice);
    return {
      vendor: i.vendor,
      amountUsd: i.amountUsd,
      department: i.department,
      approvedBy: approval.approver,
      batchId: authorization.batchId,
      paymentCredential: "paymentToken",
    };
  },
  { name: "schedulePayment" },
);
