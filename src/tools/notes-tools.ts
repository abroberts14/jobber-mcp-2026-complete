/**
 * Notes Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27. Jobber has no single `Note`
 * type or root `noteCreate`/`noteEdit`/`noteDelete` mutation — notes are
 * modelled per parent instead, mirroring how line items work:
 *   - Types: ClientNote, JobNote, QuoteNote, InvoiceNote, RequestNote (all
 *     implement `NoteInterface` and share identical fields: id, message,
 *     pinned, createdAt, lastEditedAt, createdBy, lastEditedBy, linkedTo,
 *     fileAttachments).
 *   - Mutations are parent-scoped:
 *       clientCreateNote / clientEditNote / clientDeleteNote / clientNoteAddAttachment
 *       jobCreateNote    / jobEditNote    / jobDeleteNote    / jobNoteAddAttachment
 *       quoteCreateNote  / quoteEditNote
 *       invoiceCreateNote/ invoiceEditNote
 *       requestCreateNote/ requestEditNote
 *   - Only client and job notes can be deleted or have attachments added
 *     after creation — there is no quoteDeleteNote/invoiceDeleteNote/
 *     requestDeleteNote and no quoteNoteAddAttachment/invoiceNoteAddAttachment/
 *     requestNoteAddAttachment. `delete_note` and `add_note_attachment` only
 *     accept `parent: 'client' | 'job'`; anything else is rejected by the
 *     input schema itself.
 *   - `*EditNoteInput` is keyed purely by `noteId` (no parent id argument on
 *     the mutation), but the parent is still needed as a discriminator to
 *     pick the right mutation (jobEditNote vs quoteEditNote, etc.) and to
 *     filter which `linkedTo` keys are valid.
 *   - `linkedTo` shapes differ per parent: ClientNoteLinkInput accepts
 *     invoices/jobs/quotes/requests, JobNoteLinkInput only invoices,
 *     QuoteNoteLinkInput invoices/jobs, RequestNoteLinkInput invoices/jobs/
 *     quotes, and InvoiceCreateNoteInput/InvoiceEditNoteInput have no
 *     `linkedTo` field at all (invoice notes cannot be linked to anything).
 *
 * The read side is the hard part: `Job.notes`, `Quote.notes`,
 * `Invoice.notes`, and `Request.notes` each return a *NoteUnionConnection*
 * (a client note can surface on a linked job, etc.), so their `nodes` are
 * unions and must be selected with inline fragments per member — there is
 * no shared `message`/`pinned` field directly on the union. Only
 * `Client.notes` is a plain `ClientNoteConnection` (client notes are never
 * polymorphic — a client only ever has its own notes). The union
 * memberships, verified against the schema, are:
 *   JobNoteUnion     = ClientNote | JobNote | QuoteNote | RequestNote
 *   InvoiceNoteUnion = ClientNote | InvoiceNote | JobNote | QuoteNote | RequestNote
 *   QuoteNoteUnion   = ClientNote | QuoteNote | RequestNote
 *   RequestNoteUnion = ClientNote | RequestNote
 */

import { z } from 'zod';
import { JobberClient } from '../clients/jobber.js';

const PARENTS = ['client', 'job', 'quote', 'invoice', 'request'] as const;
type ParentType = (typeof PARENTS)[number];

// Only client and job notes support deletion and post-creation attachments.
const DELETE_AND_ATTACH_PARENTS = ['client', 'job'] as const;
type DeleteAttachParent = (typeof DELETE_AND_ATTACH_PARENTS)[number];

const PAGE_INFO = `
  pageInfo {
    hasNextPage
    endCursor
  }
  totalCount
`;

const USER_ERRORS = `
  userErrors {
    message
    path
  }
`;

/** Fields shared by ClientNote/JobNote/QuoteNote/InvoiceNote/RequestNote via NoteInterface. */
const NOTE_FIELDS = `
  id
  message
  pinned
  createdAt
  lastEditedAt
  createdBy {
    __typename
    ... on User {
      id
      userName: name {
        first
        last
        full
      }
    }
    ... on Client {
      id
      clientName: name
    }
    ... on Application {
      id
      appName: name
      displayName
    }
  }
  lastEditedBy {
    ${JobberClient.userFields}
  }
  linkedTo {
    invoices
    jobs
    quotes
    requests
  }
  fileAttachments(first: 20) {
    nodes {
      id
      fileName
      contentType
      fileSize
      url
      downloadUrl
      status
    }
  }
`;

/** Concrete note types each parent's *NoteUnionConnection may return (verified against the schema). */
const NOTE_UNION_MEMBERS: Record<ParentType, string[]> = {
  client: [], // unused: Client.notes is a plain ClientNoteConnection, not a union
  job: ['ClientNote', 'JobNote', 'QuoteNote', 'RequestNote'],
  quote: ['ClientNote', 'QuoteNote', 'RequestNote'],
  invoice: ['ClientNote', 'InvoiceNote', 'JobNote', 'QuoteNote', 'RequestNote'],
  request: ['ClientNote', 'RequestNote'],
};

/** Keys each parent's *NoteLinkInput actually accepts (invoice notes accept none). */
const LINKED_TO_KEYS: Record<ParentType, string[]> = {
  client: ['invoices', 'jobs', 'quotes', 'requests'],
  job: ['invoices'],
  quote: ['invoices', 'jobs'],
  invoice: [],
  request: ['invoices', 'jobs', 'quotes'],
};

function pickKeys(source: Record<string, any>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Build the `nodes { ... }` inner selection for a *NoteUnionConnection. */
function unionNoteSelection(members: string[]): string {
  return `
    __typename
    ${members.map((m) => `... on ${m} {\n      ${NOTE_FIELDS}\n    }`).join('\n')}
  `;
}

const attachmentSchema = z.object({
  url: z.string().optional().describe('Publicly reachable URL of the file to attach'),
  signedBlobId: z
    .string()
    .optional()
    .describe('ActiveStorage signed blob ID of an already-uploaded file; takes precedence over url if both are given'),
});

const linkedToSchema = z
  .object({
    invoices: z.boolean().optional(),
    jobs: z.boolean().optional(),
    quotes: z.boolean().optional(),
    requests: z.boolean().optional(),
  })
  .optional()
  .describe(
    'Which related record types this note should also surface against. Accepted keys vary by parent: client accepts invoices/jobs/quotes/requests, job accepts only invoices, quote accepts invoices/jobs, request accepts invoices/jobs/quotes, and invoice accepts none (invoice notes cannot be linked). Keys not accepted by the chosen parent are silently dropped.'
  );

export const notesTools = {
  list_notes: {
    description:
      "List notes on a client, job, quote, invoice, or request. Client notes come back as a plain list. Job/quote/invoice/request notes are polymorphic — a client note (or, for invoices, even a job/quote/request note) can surface there too — so each entry includes __typename identifying its real underlying note type (ClientNote/JobNote/QuoteNote/InvoiceNote/RequestNote).",
    inputSchema: z.object({
      parent: z.enum(PARENTS),
      parentId: z.string().describe('EncodedId of the client/job/quote/invoice/request'),
      limit: z.number().default(50),
      cursor: z.string().optional(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const parent = args.parent as ParentType;

      if (parent === 'client') {
        const query = `
          query ListClientNotes($id: EncodedId!, $first: Int, $after: String) {
            client(id: $id) {
              notes(first: $first, after: $after) {
                nodes {
                  __typename
                  ${NOTE_FIELDS}
                }
                ${PAGE_INFO}
              }
            }
          }
        `;
        const data = await client.query(query, {
          id: args.parentId,
          first: args.limit,
          after: args.cursor,
        });
        return {
          parent,
          notes: data.client?.notes?.nodes ?? [],
          pageInfo: data.client?.notes?.pageInfo,
          totalCount: data.client?.notes?.totalCount,
        };
      }

      const selection = unionNoteSelection(NOTE_UNION_MEMBERS[parent]);
      const query = `
        query List${capitalize(parent)}Notes($id: EncodedId!, $first: Int, $after: String) {
          ${parent}(id: $id) {
            notes(first: $first, after: $after) {
              nodes {
                ${selection}
              }
              ${PAGE_INFO}
            }
          }
        }
      `;
      const data = await client.query(query, {
        id: args.parentId,
        first: args.limit,
        after: args.cursor,
      });
      const parentData = data[parent];
      return {
        parent,
        notes: parentData?.notes?.nodes ?? [],
        pageInfo: parentData?.notes?.pageInfo,
        totalCount: parentData?.notes?.totalCount,
      };
    },
  },

  create_note: {
    description:
      'Create a note on a client, job, quote, invoice, or request. All five parents support this. `attachments` accepts files by URL or ActiveStorage signedBlobId; `linkedTo` controls which related record types the note also surfaces against (invoice notes cannot be linked to anything — see linkedTo for accepted keys per parent).',
    inputSchema: z.object({
      parent: z.enum(PARENTS),
      parentId: z.string().describe('EncodedId of the client/job/quote/invoice/request the note is created on'),
      message: z.string(),
      pinned: z.boolean().optional(),
      attachments: z.array(attachmentSchema).optional(),
      linkedTo: linkedToSchema,
    }),
    execute: async (client: JobberClient, args: any) => {
      const parent = args.parent as ParentType;

      const input: Record<string, unknown> = { message: args.message };
      if (args.pinned !== undefined) input.pinned = args.pinned;
      if (args.attachments?.length) input.attachments = args.attachments;
      if (args.linkedTo) {
        const linkedTo = pickKeys(args.linkedTo, LINKED_TO_KEYS[parent]);
        if (Object.keys(linkedTo).length > 0) input.linkedTo = linkedTo;
      }

      switch (parent) {
        case 'client': {
          const mutation = `
            mutation CreateClientNote($clientId: EncodedId!, $input: ClientCreateNoteInput!) {
              clientCreateNote(clientId: $clientId, input: $input) {
                clientNote {
                  ${NOTE_FIELDS}
                }
                client {
                  id
                  name
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { clientId: args.parentId, input });
          if (data.clientCreateNote.userErrors?.length > 0) {
            throw new Error(`Note creation failed: ${data.clientCreateNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, note: data.clientCreateNote.clientNote, client: data.clientCreateNote.client };
        }

        case 'job': {
          const mutation = `
            mutation CreateJobNote($jobId: EncodedId!, $input: JobCreateNoteInput!) {
              jobCreateNote(jobId: $jobId, input: $input) {
                jobNote {
                  ${NOTE_FIELDS}
                }
                job {
                  id
                  jobNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { jobId: args.parentId, input });
          if (data.jobCreateNote.userErrors?.length > 0) {
            throw new Error(`Note creation failed: ${data.jobCreateNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, note: data.jobCreateNote.jobNote, job: data.jobCreateNote.job };
        }

        case 'quote': {
          const mutation = `
            mutation CreateQuoteNote($quoteId: EncodedId!, $input: QuoteCreateNoteInput!) {
              quoteCreateNote(quoteId: $quoteId, input: $input) {
                quoteNote {
                  ${NOTE_FIELDS}
                }
                quote {
                  id
                  quoteNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { quoteId: args.parentId, input });
          if (data.quoteCreateNote.userErrors?.length > 0) {
            throw new Error(`Note creation failed: ${data.quoteCreateNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, note: data.quoteCreateNote.quoteNote, quote: data.quoteCreateNote.quote };
        }

        case 'invoice': {
          const mutation = `
            mutation CreateInvoiceNote($invoiceId: EncodedId!, $input: InvoiceCreateNoteInput!) {
              invoiceCreateNote(invoiceId: $invoiceId, input: $input) {
                invoiceNote {
                  ${NOTE_FIELDS}
                }
                invoice {
                  id
                  invoiceNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { invoiceId: args.parentId, input });
          if (data.invoiceCreateNote.userErrors?.length > 0) {
            throw new Error(`Note creation failed: ${data.invoiceCreateNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, note: data.invoiceCreateNote.invoiceNote, invoice: data.invoiceCreateNote.invoice };
        }

        case 'request': {
          const mutation = `
            mutation CreateRequestNote($requestId: EncodedId!, $input: RequestCreateNoteInput!) {
              requestCreateNote(requestId: $requestId, input: $input) {
                requestNote {
                  ${NOTE_FIELDS}
                }
                request {
                  id
                  title
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { requestId: args.parentId, input });
          if (data.requestCreateNote.userErrors?.length > 0) {
            throw new Error(`Note creation failed: ${data.requestCreateNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, note: data.requestCreateNote.requestNote, request: data.requestCreateNote.request };
        }
      }
    },
  },

  edit_note: {
    description:
      "Edit an existing note on a client, job, quote, invoice, or request. Jobber's edit mutations are keyed purely by noteId (no separate parent id argument) — `parent` here only selects which mutation to call and which linkedTo keys are valid. Only the fields you pass are changed; message/pinned overwrite, while attachmentsToAdd/attachmentsToDelete adjust file attachments incrementally.",
    inputSchema: z.object({
      parent: z.enum(PARENTS),
      noteId: z.string(),
      message: z.string().optional(),
      pinned: z.boolean().optional(),
      attachmentsToAdd: z.array(attachmentSchema).optional(),
      attachmentsToDelete: z.array(z.string()).optional().describe('EncodedIds of existing note file attachments to remove'),
      linkedTo: linkedToSchema,
    }),
    execute: async (client: JobberClient, args: any) => {
      const parent = args.parent as ParentType;

      const input: Record<string, unknown> = { noteId: args.noteId };
      if (args.message !== undefined) input.message = args.message;
      if (args.pinned !== undefined) input.pinned = args.pinned;
      if (args.attachmentsToAdd?.length) input.attachmentsToAdd = args.attachmentsToAdd;
      if (args.attachmentsToDelete?.length) input.attachmentsToDelete = args.attachmentsToDelete;
      if (args.linkedTo) {
        const linkedTo = pickKeys(args.linkedTo, LINKED_TO_KEYS[parent]);
        if (Object.keys(linkedTo).length > 0) input.linkedTo = linkedTo;
      }

      switch (parent) {
        case 'client': {
          const mutation = `
            mutation EditClientNote($input: ClientEditNoteInput!) {
              clientEditNote(input: $input) {
                clientNote {
                  ${NOTE_FIELDS}
                }
                client {
                  id
                  name
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { input });
          if (data.clientEditNote.userErrors?.length > 0) {
            throw new Error(`Note edit failed: ${data.clientEditNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, note: data.clientEditNote.clientNote, client: data.clientEditNote.client };
        }

        case 'job': {
          const mutation = `
            mutation EditJobNote($input: JobEditNoteInput!) {
              jobEditNote(input: $input) {
                jobNote {
                  ${NOTE_FIELDS}
                }
                job {
                  id
                  jobNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { input });
          if (data.jobEditNote.userErrors?.length > 0) {
            throw new Error(`Note edit failed: ${data.jobEditNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, note: data.jobEditNote.jobNote, job: data.jobEditNote.job };
        }

        case 'quote': {
          const mutation = `
            mutation EditQuoteNote($input: QuoteEditNoteInput!) {
              quoteEditNote(input: $input) {
                quoteNote {
                  ${NOTE_FIELDS}
                }
                quote {
                  id
                  quoteNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { input });
          if (data.quoteEditNote.userErrors?.length > 0) {
            throw new Error(`Note edit failed: ${data.quoteEditNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, note: data.quoteEditNote.quoteNote, quote: data.quoteEditNote.quote };
        }

        case 'invoice': {
          const mutation = `
            mutation EditInvoiceNote($input: InvoiceEditNoteInput!) {
              invoiceEditNote(input: $input) {
                invoiceNote {
                  ${NOTE_FIELDS}
                }
                invoice {
                  id
                  invoiceNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { input });
          if (data.invoiceEditNote.userErrors?.length > 0) {
            throw new Error(`Note edit failed: ${data.invoiceEditNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, note: data.invoiceEditNote.invoiceNote, invoice: data.invoiceEditNote.invoice };
        }

        case 'request': {
          const mutation = `
            mutation EditRequestNote($input: RequestEditNoteInput!) {
              requestEditNote(input: $input) {
                requestNote {
                  ${NOTE_FIELDS}
                }
                request {
                  id
                  title
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { input });
          if (data.requestEditNote.userErrors?.length > 0) {
            throw new Error(`Note edit failed: ${data.requestEditNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, note: data.requestEditNote.requestNote, request: data.requestEditNote.request };
        }
      }
    },
  },

  delete_note: {
    description:
      'Delete a note. Jobber only exposes a delete mutation for client and job notes (clientDeleteNote / jobDeleteNote) — quote, invoice, and request notes have no delete mutation at all and cannot be removed via the API once created; edit_note is the closest available action (e.g. clear the message).',
    inputSchema: z.object({
      parent: z.enum(DELETE_AND_ATTACH_PARENTS),
      noteId: z.string(),
    }),
    execute: async (client: JobberClient, args: any) => {
      const parent = args.parent as DeleteAttachParent;

      switch (parent) {
        case 'client': {
          const mutation = `
            mutation DeleteClientNote($input: ClientDeleteNoteInput!) {
              clientDeleteNote(input: $input) {
                deletedNote {
                  id
                }
                client {
                  id
                  name
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { input: { noteId: args.noteId } });
          if (data.clientDeleteNote.userErrors?.length > 0) {
            throw new Error(`Note deletion failed: ${data.clientDeleteNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, deletedNote: data.clientDeleteNote.deletedNote, client: data.clientDeleteNote.client };
        }

        case 'job': {
          const mutation = `
            mutation DeleteJobNote($input: JobDeleteNoteInput!) {
              jobDeleteNote(input: $input) {
                deletedNote {
                  id
                }
                job {
                  id
                  jobNumber
                }
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, { input: { noteId: args.noteId } });
          if (data.jobDeleteNote.userErrors?.length > 0) {
            throw new Error(`Note deletion failed: ${data.jobDeleteNote.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, deletedNote: data.jobDeleteNote.deletedNote, job: data.jobDeleteNote.job };
        }
      }
    },
  },

  add_note_attachment: {
    description:
      'Attach one or more files to an existing note. Jobber only exposes this for client and job notes (clientNoteAddAttachment / jobNoteAddAttachment) — quote, invoice, and request notes can only receive attachments at creation time via create_note\'s `attachments`, since there is no quoteNoteAddAttachment/invoiceNoteAddAttachment/requestNoteAddAttachment mutation. Returns the URLs of attachments that are queued for processing, not the finished note (Jobber processes uploads asynchronously).',
    inputSchema: z.object({
      parent: z.enum(DELETE_AND_ATTACH_PARENTS),
      parentId: z.string().describe('EncodedId of the client/job the note belongs to'),
      noteId: z.string(),
      attachments: z.array(attachmentSchema).min(1),
    }),
    execute: async (client: JobberClient, args: any) => {
      const parent = args.parent as DeleteAttachParent;

      switch (parent) {
        case 'client': {
          const mutation = `
            mutation AddClientNoteAttachment($clientId: EncodedId!, $noteId: EncodedId!, $noteAddAttachmentAttributes: [NoteAttachmentAttributes!]!) {
              clientNoteAddAttachment(clientId: $clientId, noteId: $noteId, noteAddAttachmentAttributes: $noteAddAttachmentAttributes) {
                attachmentsToBeAdded
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            clientId: args.parentId,
            noteId: args.noteId,
            noteAddAttachmentAttributes: args.attachments,
          });
          if (data.clientNoteAddAttachment.userErrors?.length > 0) {
            throw new Error(`Adding attachment failed: ${data.clientNoteAddAttachment.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, attachmentsToBeAdded: data.clientNoteAddAttachment.attachmentsToBeAdded };
        }

        case 'job': {
          const mutation = `
            mutation AddJobNoteAttachment($jobId: EncodedId!, $noteId: EncodedId!, $noteAddAttachmentAttributes: [NoteAttachmentAttributes!]!) {
              jobNoteAddAttachment(jobId: $jobId, noteId: $noteId, noteAddAttachmentAttributes: $noteAddAttachmentAttributes) {
                attachmentsToBeAdded
                ${USER_ERRORS}
              }
            }
          `;
          const data = await client.mutate(mutation, {
            jobId: args.parentId,
            noteId: args.noteId,
            noteAddAttachmentAttributes: args.attachments,
          });
          if (data.jobNoteAddAttachment.userErrors?.length > 0) {
            throw new Error(`Adding attachment failed: ${data.jobNoteAddAttachment.userErrors.map((e: any) => e.message).join(', ')}`);
          }
          return { parent, attachmentsToBeAdded: data.jobNoteAddAttachment.attachmentsToBeAdded };
        }
      }
    },
  },
};
