/**
 * Forms Tools for Jobber MCP Server
 *
 * Written against Jobber GraphQL 2026-07-27.
 *
 * INVESTIGATION RESULT: this module is intentionally EMPTY. Jobber's public
 * API does not expose "Form" as a queryable resource at all:
 *   - Query root has no `forms`, `form`, `formSubmissions`, or
 *     `formSubmission` field. (Confirmed against the full list of Query
 *     root fields in schema/jobber-schema.graphql / jobber-schema.json —
 *     nothing form-related exists there.)
 *   - Mutation root has no `formCreate`, `formUpdate`, `formDelete`, or
 *     `formSubmissionCreate`. There is no way to define a form or record a
 *     submission through this API.
 *   - `Job.jobFormIds` and `JobEditInput.jobFormIds` / the identically named
 *     field on `JobCreateAttributes` are WRITE-ONLY: they exist on the
 *     create/edit input types, but `type Job` itself has no `jobFormIds` (or
 *     any other forms-related) field to read them back.
 *   - The one real forms-adjacent capability is the mutation
 *     `requestEditJobForms(requestId: EncodedId!, input: FormAttachmentInput)`,
 *     which attaches/detaches form TEMPLATE ids (`FormAttachmentInput { formIds:
 *     [EncodedId!]! }`) on a Request. It is entirely write-only and blind:
 *     there is no query anywhere in the schema that lists form templates, so
 *     a caller has no way to discover which `EncodedId`s are valid, and no
 *     way to read back what's currently attached to a request or job. `Visit`
 *     exposes `incompleteJobFormsCount: Int!`, a bare count with no
 *     supporting detail.
 *   - `RequestDetailsInput.form: FormInput!` (nested `FormSectionInput` /
 *     `FormItemInput`) lets an external app attach freeform Q&A answers when
 *     creating a Request via `requestCreate`, but this is a Request-creation
 *     concern (owned by requests-tools.ts), not a standalone forms resource,
 *     and again has no corresponding read path.
 *
 * Net result: there is no read path for forms anywhere in the schema, which
 * was the bar set for keeping this module alive. Every tool that used to
 * live here (list_forms, get_form, create_form, update_form, delete_form,
 * submit_form, list_form_submissions, get_form_submission) called
 * queries/mutations that do not exist and has been deleted rather than kept
 * around throwing a "not supported" error at runtime.
 *
 * If Jobber's API ever adds a real forms query surface, or if
 * `requestEditJobForms` should be exposed despite being blind/write-only,
 * reintroduce tools here against the real schema.
 */

// Intentionally empty: see module doc comment above. Exported as an object
// so `src/server.ts`'s `...formsTools` spread keeps compiling; there is
// nothing to register.
export const formsTools = {};
