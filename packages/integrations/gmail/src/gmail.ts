import type { Action, Atom } from "@workflow/core";
import { z } from "zod";
import {
  type ArcadeToolOptions,
  type ArcadeToolResult,
  createArcadeToolAction,
  createArcadeToolAtom,
  type MaybeHandle,
} from "./arcade";

export const GMAIL_TOOL_VERSION = "5.2.0";

export const gmailDateRangeSchema = z.enum([
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "this_month",
  "last_month",
  "this_year",
]);
export type GmailDateRange = z.infer<typeof gmailDateRangeSchema>;

export const gmailContentTypeSchema = z.enum(["plain", "html"]);
export type GmailContentType = z.infer<typeof gmailContentTypeSchema>;

export const gmailReplyToWhomSchema = z.enum([
  "every_recipient",
  "only_the_sender",
]);
export type GmailReplyToWhom = z.infer<typeof gmailReplyToWhomSchema>;

export type GmailJsonObject = Record<string, unknown>;

export type GmailToolOptions = ArcadeToolOptions;
export type GmailToolAction<Value = GmailJsonObject> = Action<
  ArcadeToolResult<Value>
>;
export type GmailToolAtom<Value = GmailJsonObject> = Atom<
  ArcadeToolResult<Value>
>;

type StringList = string[];
type Resolvable<T> = MaybeHandle<T>;

const jsonObjectSchema: z.ZodType<GmailJsonObject> = z
  .object({})
  .catchall(z.unknown());

const stringListSchema = z.array(z.string());

export type ChangeEmailLabelsInput = {
  email_id: string;
  labels_to_add: StringList;
  labels_to_remove: StringList;
};
export type ChangeEmailLabelsOptions = GmailToolOptions & {
  emailId: Resolvable<string>;
  labelsToAdd: Resolvable<StringList>;
  labelsToRemove: Resolvable<StringList>;
};
const changeEmailLabelsInputSchema = z.object({
  email_id: z.string(),
  labels_to_add: stringListSchema,
  labels_to_remove: stringListSchema,
});

export function changeEmailLabels(
  opts: ChangeEmailLabelsOptions,
): GmailToolAction {
  return gmailTool({
    toolName: "Gmail.ChangeEmailLabels",
    inputSchema: changeEmailLabelsInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: {
      email_id: opts.emailId,
      labels_to_add: opts.labelsToAdd,
      labels_to_remove: opts.labelsToRemove,
    },
  });
}

export type CreateLabelInput = { label_name: string };
export type CreateLabelOptions = GmailToolOptions & {
  labelName: Resolvable<string>;
};
const createLabelInputSchema = z.object({ label_name: z.string() });

export function createLabel(opts: CreateLabelOptions): GmailToolAction {
  return gmailTool({
    toolName: "Gmail.CreateLabel",
    inputSchema: createLabelInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: { label_name: opts.labelName },
  });
}

export type DeleteDraftEmailInput = { draft_email_id: string };
export type DeleteDraftEmailOptions = GmailToolOptions & {
  draftEmailId: Resolvable<string>;
};
const deleteDraftEmailInputSchema = z.object({ draft_email_id: z.string() });

export function deleteDraftEmail(
  opts: DeleteDraftEmailOptions,
): GmailToolAction<string> {
  return gmailTool({
    toolName: "Gmail.DeleteDraftEmail",
    inputSchema: deleteDraftEmailInputSchema,
    outputSchema: z.string(),
    opts,
    input: { draft_email_id: opts.draftEmailId },
  });
}

export type GetThreadInput = { thread_id: string };
export type GetThreadOptions = GmailToolOptions & {
  threadId: Resolvable<string>;
};
const getThreadInputSchema = z.object({ thread_id: z.string() });

export function getThread(opts: GetThreadOptions): GmailToolAtom {
  return gmailAtomTool({
    toolName: "Gmail.GetThread",
    inputSchema: getThreadInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: { thread_id: opts.threadId },
  });
}

export type ListDraftEmailsInput = { n_drafts?: number };
export type ListDraftEmailsOptions = GmailToolOptions & {
  nDrafts?: Resolvable<number | undefined>;
};
const listDraftEmailsInputSchema = z.object({
  n_drafts: z.number().int().min(1).max(100).optional(),
});

export function listDraftEmails(
  opts: ListDraftEmailsOptions = {},
): GmailToolAtom {
  return gmailAtomTool({
    toolName: "Gmail.ListDraftEmails",
    inputSchema: listDraftEmailsInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: { n_drafts: opts.nDrafts },
  });
}

export type ListEmailsInput = { n_emails?: number };
export type ListEmailsOptions = GmailToolOptions & {
  nEmails?: Resolvable<number | undefined>;
};
const listEmailsInputSchema = z.object({
  n_emails: z.number().int().min(1).max(100).optional(),
});

export function listEmails(opts: ListEmailsOptions = {}): GmailToolAtom {
  return gmailAtomTool({
    toolName: "Gmail.ListEmails",
    inputSchema: listEmailsInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: { n_emails: opts.nEmails },
  });
}

export type ListEmailsByHeaderInput = {
  sender?: string;
  recipient?: string;
  subject?: string;
  body?: string;
  date_range?: GmailDateRange;
  label?: string;
  max_results?: number;
};
export type ListEmailsByHeaderOptions = GmailToolOptions & {
  sender?: Resolvable<string | undefined>;
  recipient?: Resolvable<string | undefined>;
  subject?: Resolvable<string | undefined>;
  body?: Resolvable<string | undefined>;
  dateRange?: Resolvable<GmailDateRange | undefined>;
  label?: Resolvable<string | undefined>;
  maxResults?: Resolvable<number | undefined>;
};
const listEmailsByHeaderInputSchema = z.object({
  sender: z.string().optional(),
  recipient: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  date_range: gmailDateRangeSchema.optional(),
  label: z.string().optional(),
  max_results: z.number().int().min(1).max(100).optional(),
});

export function listEmailsByHeader(
  opts: ListEmailsByHeaderOptions = {},
): GmailToolAtom {
  return gmailAtomTool({
    toolName: "Gmail.ListEmailsByHeader",
    inputSchema: listEmailsByHeaderInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: {
      sender: opts.sender,
      recipient: opts.recipient,
      subject: opts.subject,
      body: opts.body,
      date_range: opts.dateRange,
      label: opts.label,
      max_results: opts.maxResults,
    },
  });
}

export type ListLabelsInput = Record<string, never>;
export type ListLabelsOptions = GmailToolOptions;
const emptyInputSchema = z.object({});

export function listLabels(opts: ListLabelsOptions = {}): GmailToolAtom {
  return gmailAtomTool({
    toolName: "Gmail.ListLabels",
    inputSchema: emptyInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: {},
  });
}

export type ListThreadsInput = {
  page_token?: string;
  max_results?: number;
  include_spam_trash?: boolean;
};
export type ListThreadsOptions = GmailToolOptions & {
  pageToken?: Resolvable<string | undefined>;
  maxResults?: Resolvable<number | undefined>;
  includeSpamTrash?: Resolvable<boolean | undefined>;
};
const listThreadsInputSchema = z.object({
  page_token: z.string().optional(),
  max_results: z.number().int().min(1).max(100).optional(),
  include_spam_trash: z.boolean().optional(),
});

export function listThreads(opts: ListThreadsOptions = {}): GmailToolAtom {
  return gmailAtomTool({
    toolName: "Gmail.ListThreads",
    inputSchema: listThreadsInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: {
      page_token: opts.pageToken,
      max_results: opts.maxResults,
      include_spam_trash: opts.includeSpamTrash,
    },
  });
}

export type ReplyInput = {
  body: string;
  reply_to_message_id: string;
  reply_to_whom?: GmailReplyToWhom;
  cc?: StringList;
  bcc?: StringList;
  content_type?: GmailContentType;
};
export type ReplyOptions = GmailToolOptions & {
  body: Resolvable<string>;
  replyToMessageId: Resolvable<string>;
  replyToWhom?: Resolvable<GmailReplyToWhom | undefined>;
  cc?: Resolvable<StringList | undefined>;
  bcc?: Resolvable<StringList | undefined>;
  contentType?: Resolvable<GmailContentType | undefined>;
};
const replyInputSchema = z.object({
  body: z.string(),
  reply_to_message_id: z.string(),
  reply_to_whom: gmailReplyToWhomSchema.optional(),
  cc: stringListSchema.optional(),
  bcc: stringListSchema.optional(),
  content_type: gmailContentTypeSchema.optional(),
});

export function replyToEmail(opts: ReplyOptions): GmailToolAction {
  return gmailTool({
    toolName: "Gmail.ReplyToEmail",
    inputSchema: replyInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: replyInput(opts),
  });
}

export type SearchThreadsInput = ListThreadsInput & {
  label_ids?: StringList;
  sender?: string;
  recipient?: string;
  subject?: string;
  body?: string;
  date_range?: GmailDateRange;
};
export type SearchThreadsOptions = ListThreadsOptions & {
  labelIds?: Resolvable<StringList | undefined>;
  sender?: Resolvable<string | undefined>;
  recipient?: Resolvable<string | undefined>;
  subject?: Resolvable<string | undefined>;
  body?: Resolvable<string | undefined>;
  dateRange?: Resolvable<GmailDateRange | undefined>;
};
const searchThreadsInputSchema = listThreadsInputSchema.extend({
  label_ids: stringListSchema.optional(),
  sender: z.string().optional(),
  recipient: z.string().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  date_range: gmailDateRangeSchema.optional(),
});

export function searchThreads(opts: SearchThreadsOptions = {}): GmailToolAtom {
  return gmailAtomTool({
    toolName: "Gmail.SearchThreads",
    inputSchema: searchThreadsInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: {
      page_token: opts.pageToken,
      max_results: opts.maxResults,
      include_spam_trash: opts.includeSpamTrash,
      label_ids: opts.labelIds,
      sender: opts.sender,
      recipient: opts.recipient,
      subject: opts.subject,
      body: opts.body,
      date_range: opts.dateRange,
    },
  });
}

export type SendDraftEmailInput = { email_id: string };
export type SendDraftEmailOptions = GmailToolOptions & {
  emailId: Resolvable<string>;
};
const sendDraftEmailInputSchema = z.object({ email_id: z.string() });

export function sendDraftEmail(opts: SendDraftEmailOptions): GmailToolAction {
  return gmailTool({
    toolName: "Gmail.SendDraftEmail",
    inputSchema: sendDraftEmailInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: { email_id: opts.emailId },
  });
}

export type SendEmailInput = {
  subject: string;
  body: string;
  recipient: string;
  cc?: StringList;
  bcc?: StringList;
  content_type?: GmailContentType;
};
export type SendEmailOptions = GmailToolOptions & {
  subject: Resolvable<string>;
  body: Resolvable<string>;
  recipient: Resolvable<string>;
  cc?: Resolvable<StringList | undefined>;
  bcc?: Resolvable<StringList | undefined>;
  contentType?: Resolvable<GmailContentType | undefined>;
};
const sendEmailInputSchema = z.object({
  subject: z.string(),
  body: z.string(),
  recipient: z.string(),
  cc: stringListSchema.optional(),
  bcc: stringListSchema.optional(),
  content_type: gmailContentTypeSchema.optional(),
});

export function sendEmail(opts: SendEmailOptions): GmailToolAction {
  return gmailTool({
    toolName: "Gmail.SendEmail",
    inputSchema: sendEmailInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: {
      subject: opts.subject,
      body: opts.body,
      recipient: opts.recipient,
      cc: opts.cc,
      bcc: opts.bcc,
      content_type: opts.contentType,
    },
  });
}

export type TrashEmailInput = { email_id: string };
export type TrashEmailOptions = GmailToolOptions & {
  emailId: Resolvable<string>;
};
const trashEmailInputSchema = z.object({ email_id: z.string() });

export function trashEmail(opts: TrashEmailOptions): GmailToolAction {
  return gmailTool({
    toolName: "Gmail.TrashEmail",
    inputSchema: trashEmailInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: { email_id: opts.emailId },
  });
}

export type UpdateDraftEmailInput = {
  draft_email_id: string;
  subject?: string;
  body?: string;
  recipient?: string;
  cc?: StringList;
  bcc?: StringList;
};
export type UpdateDraftEmailOptions = GmailToolOptions & {
  draftEmailId: Resolvable<string>;
  subject?: Resolvable<string | undefined>;
  body?: Resolvable<string | undefined>;
  recipient?: Resolvable<string | undefined>;
  cc?: Resolvable<StringList | undefined>;
  bcc?: Resolvable<StringList | undefined>;
};
const updateDraftEmailInputSchema = z.object({
  draft_email_id: z.string(),
  subject: z.string().optional(),
  body: z.string().optional(),
  recipient: z.string().optional(),
  cc: stringListSchema.optional(),
  bcc: stringListSchema.optional(),
});

export function updateDraftEmail(
  opts: UpdateDraftEmailOptions,
): GmailToolAction {
  return gmailTool({
    toolName: "Gmail.UpdateDraftEmail",
    inputSchema: updateDraftEmailInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: {
      draft_email_id: opts.draftEmailId,
      subject: opts.subject,
      body: opts.body,
      recipient: opts.recipient,
      cc: opts.cc,
      bcc: opts.bcc,
    },
  });
}

export type WhoAmIInput = Record<string, never>;
export type WhoAmIOptions = GmailToolOptions;

export function whoAmI(opts: WhoAmIOptions = {}): GmailToolAtom {
  return gmailAtomTool({
    toolName: "Gmail.WhoAmI",
    inputSchema: emptyInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: {},
  });
}

export type WriteDraftEmailInput = SendEmailInput;
export type WriteDraftEmailOptions = SendEmailOptions;

export function writeDraftEmail(opts: WriteDraftEmailOptions): GmailToolAction {
  return gmailTool({
    toolName: "Gmail.WriteDraftEmail",
    inputSchema: sendEmailInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: {
      subject: opts.subject,
      body: opts.body,
      recipient: opts.recipient,
      cc: opts.cc,
      bcc: opts.bcc,
      content_type: opts.contentType,
    },
  });
}

export type WriteDraftReplyEmailInput = ReplyInput;
export type WriteDraftReplyEmailOptions = ReplyOptions;

export function writeDraftReplyEmail(
  opts: WriteDraftReplyEmailOptions,
): GmailToolAction {
  return gmailTool({
    toolName: "Gmail.WriteDraftReplyEmail",
    inputSchema: replyInputSchema,
    outputSchema: jsonObjectSchema,
    opts,
    input: replyInput(opts),
  });
}

function gmailTool<Input extends Record<string, unknown>, Value>(args: {
  toolName: string;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Value>;
  opts: GmailToolOptions;
  input: { [K in keyof Input]: MaybeHandle<Input[K]> | undefined };
}): Action<ArcadeToolResult<Value>> {
  return createArcadeToolAction({
    ...args,
    defaultToolVersion: GMAIL_TOOL_VERSION,
  });
}

function gmailAtomTool<Input extends Record<string, unknown>, Value>(args: {
  toolName: string;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Value>;
  opts: GmailToolOptions;
  input: { [K in keyof Input]: MaybeHandle<Input[K]> | undefined };
}): Atom<ArcadeToolResult<Value>> {
  return createArcadeToolAtom({
    ...args,
    defaultToolVersion: GMAIL_TOOL_VERSION,
  });
}

function replyInput(opts: ReplyOptions): {
  [K in keyof ReplyInput]: MaybeHandle<ReplyInput[K]> | undefined;
} {
  return {
    body: opts.body,
    reply_to_message_id: opts.replyToMessageId,
    reply_to_whom: opts.replyToWhom,
    cc: opts.cc,
    bcc: opts.bcc,
    content_type: opts.contentType,
  };
}
