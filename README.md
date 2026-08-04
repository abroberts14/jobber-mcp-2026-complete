# Jobber MCP Server

A comprehensive Model Context Protocol (MCP) server for the Jobber field service management platform. This server provides 96 GraphQL-powered tools and 15 React-based applications for complete business operations management.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Configuration](#configuration)
- [Available Tools (96)](#available-tools)
  - [Client Management (7 tools)](#client-management)
  - [Job Management (8 tools)](#job-management)
  - [Quote Management (8 tools)](#quote-management)
  - [Invoice Management (7 tools)](#invoice-management)
  - [Scheduling & Visits (6 tools)](#scheduling--visits)
  - [Team Management (4 tools)](#team-management)
  - [Expense Tracking (5 tools)](#expense-tracking)
  - [Product Catalog (5 tools)](#product-catalog)
  - [Service Requests (6 tools)](#service-requests)
  - [Reporting & Analytics (3 tools)](#reporting--analytics)
  - [Property Management (6 tools)](#property-management)
  - [Timesheet Management (7 tools)](#timesheet-management)
  - [Line Items (8 tools)](#line-items)
  - [Form Builder (8 tools)](#form-builder)
  - [Tax Management (8 tools)](#tax-management)
- [React Applications (15)](#react-applications)
- [Usage Examples](#usage-examples)
- [GraphQL API](#graphql-api)
- [Development](#development)
- [License](#license)

## Overview

The Jobber MCP Server enables AI assistants and automation tools to interact with Jobber's complete field service management platform. It supports:

- **Client & Property Management**: Track customers, properties, and service history
- **Job Lifecycle**: From quotes to completion with full workflow support
- **Scheduling**: Manage visits, assignments, and team calendars
- **Invoicing**: Create, send, and track payments
- **Team Management**: Monitor team performance, timesheets, and utilization
- **Forms**: Build custom forms and capture submissions
- **Reporting**: Generate business insights and analytics

## Installation

```bash
npm install @mcpengine/jobber-server
```

Or install from source:

```bash
git clone https://github.com/BusyBee3333/mcpengine.git
cd mcpengine/servers/jobber
npm install
npm run build
```

## Configuration

Jobber has no static API keys or personal access tokens. Every request is
authenticated with an OAuth 2.0 access token that expires after 60 minutes, so
the server needs your app credentials plus a refresh token and handles the
refresh cycle itself.

**1. Register an app** at [developer.getjobber.com](https://developer.getjobber.com)
and note the client ID and client secret. Add a redirect URI —
`http://localhost:3000/callback` works for local use.

**2. Create your `.env`:**

```bash
cp .env.example .env
```

Fill in `JOBBER_CLIENT_ID`, `JOBBER_CLIENT_SECRET`, and `JOBBER_REDIRECT_URI`.

**3. Authorize once:**

```bash
npm run authorize
```

This opens Jobber's consent screen, captures the authorization code on the
redirect, exchanges it for tokens, and prints a `JOBBER_REFRESH_TOKEN` to paste
into `.env`.

If your redirect URI goes through a tunnel (ngrok and friends) rather than
`localhost`, set `JOBBER_CALLBACK_PORT` to the port the tunnel forwards to and
the code is still captured automatically. Without it, the CLI prompts you to
paste the `code` parameter from the redirect URL.

**4. Run the server.** It exchanges the refresh token for an access token on
demand and retries once on a `401`.

### Token rotation

Jobber rotates the refresh token on every refresh, so the value in `.env` is
single-use. The server writes each new pair to `~/.jobber-mcp/tokens.json`
(override with `JOBBER_TOKEN_STORE`) and prefers that store over `.env` at
startup. If the store is deleted, re-run `npm run authorize`.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `JOBBER_CLIENT_ID` | yes | App client ID |
| `JOBBER_CLIENT_SECRET` | yes | App client secret |
| `JOBBER_REFRESH_TOKEN` | yes | Bootstrap refresh token from `npm run authorize` |
| `JOBBER_REDIRECT_URI` | for authorize | Must match the URI registered on the app |
| `JOBBER_CALLBACK_PORT` | no | Local port to catch the redirect on when tunnelling |
| `JOBBER_ACCESS_TOKEN` | no | Skip the first refresh if you already hold one |
| `JOBBER_TOKEN_STORE` | no | Rotated-token cache path |
| `JOBBER_API_URL` | no | GraphQL endpoint override |
| `JOBBER_OAUTH_URL` | no | OAuth endpoint override |
| `JOBBER_GRAPHQL_VERSION` | no | `X-JOBBER-GRAPHQL-VERSION` header |

## Available Tools

### Client Management

**7 tools** for managing customer relationships:

1. **list_clients** - List all clients with optional filtering
   - Parameters: `isArchived`, `limit`, `cursor`
   - Returns paginated client list with contact details

2. **get_client** - Get a specific client by ID
   - Parameters: `clientId`
   - Returns full client details including contact info and billing address

3. **create_client** - Create a new client
   - Parameters: `firstName`, `lastName`, `companyName`, `email`, `phone`, `billingAddress`
   - Returns newly created client

4. **update_client** - Update existing client information
   - Parameters: `clientId`, `firstName`, `lastName`, `companyName`, `email`, `phone`, `billingAddress`
   - Returns updated client

5. **archive_client** - Archive a client
   - Parameters: `clientId`
   - Returns archived client status

6. **search_clients** - Search clients by name, email, or phone
   - Parameters: `query`, `limit`
   - Returns matching clients

7. **list_client_properties** - List all properties for a client
   - Parameters: `clientId`, `limit`, `cursor`
   - Returns paginated property list

### Job Management

**8 tools** for complete job lifecycle management:

1. **list_jobs** - List all jobs with filtering
   - Parameters: `status`, `clientId`, `limit`, `cursor`
   - Returns paginated job list with status and details

2. **get_job** - Get detailed job information
   - Parameters: `jobId`
   - Returns complete job details including line items and visits

3. **create_job** - Create a new job
   - Parameters: `title`, `description`, `clientId`, `propertyId`, `startAt`, `endAt`
   - Returns newly created job

4. **update_job** - Update job information
   - Parameters: `jobId`, `title`, `description`, `startAt`, `endAt`, `status`
   - Returns updated job

5. **close_job** - Mark a job as complete
   - Parameters: `jobId`
   - Returns closed job status

6. **create_job_visit** - Schedule a visit for a job
   - Parameters: `jobId`, `title`, `startAt`, `endAt`, `assignedUserIds`
   - Returns created visit

7. **list_job_visits** - List all visits for a job
   - Parameters: `jobId`, `limit`, `cursor`
   - Returns paginated visit list

8. **list_job_line_items** - List all line items on a job
   - Parameters: `jobId`, `limit`, `cursor`
   - Returns job line items with pricing

### Quote Management

**8 tools** for creating and managing quotes:

1. **list_quotes** - List all quotes
   - Parameters: `status`, `clientId`, `limit`, `cursor`
   - Returns paginated quote list

2. **get_quote** - Get detailed quote information
   - Parameters: `quoteId`
   - Returns complete quote with line items

3. **create_quote** - Create a new quote
   - Parameters: `title`, `message`, `clientId`, `propertyId`
   - Returns newly created quote

4. **update_quote** - Update quote details
   - Parameters: `quoteId`, `title`, `message`, `status`
   - Returns updated quote

5. **send_quote** - Send quote to client
   - Parameters: `quoteId`, `recipientEmail`
   - Returns send status

6. **approve_quote** - Approve a quote
   - Parameters: `quoteId`
   - Returns approved quote

7. **convert_quote_to_job** - Convert approved quote to job
   - Parameters: `quoteId`
   - Returns created job

8. **list_quote_line_items** - List all line items on a quote
   - Parameters: `quoteId`, `limit`, `cursor`
   - Returns quote line items

### Invoice Management

**7 tools** for billing and payments:

1. **list_invoices** - List all invoices
   - Parameters: `status`, `clientId`, `limit`, `cursor`
   - Returns paginated invoice list

2. **get_invoice** - Get detailed invoice information
   - Parameters: `invoiceId`
   - Returns complete invoice with line items and payments

3. **create_invoice** - Create a new invoice
   - Parameters: `jobId`, `subject`, `message`, `issueDate`, `dueDate`
   - Returns newly created invoice

4. **send_invoice** - Send invoice to client
   - Parameters: `invoiceId`, `recipientEmail`
   - Returns send status

5. **mark_invoice_paid** - Mark invoice as paid
   - Parameters: `invoiceId`, `amount`, `paymentDate`, `method`
   - Returns payment record

6. **create_payment** - Record a payment
   - Parameters: `invoiceId`, `amount`, `paymentDate`, `method`, `reference`
   - Returns payment details

7. **list_invoice_payments** - List payments for an invoice
   - Parameters: `invoiceId`, `limit`, `cursor`
   - Returns payment history

### Scheduling & Visits

**6 tools** for managing schedules and field visits:

1. **list_visits** - List all scheduled visits
   - Parameters: `startDate`, `endDate`, `status`, `limit`, `cursor`
   - Returns paginated visit list

2. **get_visit** - Get detailed visit information
   - Parameters: `visitId`
   - Returns complete visit details with assignments

3. **create_visit** - Create a new visit
   - Parameters: `jobId`, `title`, `startAt`, `endAt`, `assignedUserIds`
   - Returns created visit

4. **update_visit** - Update visit details
   - Parameters: `visitId`, `title`, `startAt`, `endAt`, `status`
   - Returns updated visit

5. **complete_visit** - Mark visit as complete
   - Parameters: `visitId`, `completionNotes`
   - Returns completed visit

6. **list_visit_assignments** - List team member assignments for visits
   - Parameters: `visitId`, `limit`
   - Returns assigned team members

### Team Management

**4 tools** for managing your field service team:

1. **list_users** - List all team members
   - Parameters: `isActive`, `limit`, `cursor`
   - Returns paginated user list

2. **get_user** - Get detailed user information
   - Parameters: `userId`
   - Returns user details and role information

3. **get_team_utilization_report** - Get team utilization metrics
   - Parameters: `startDate`, `endDate`, `userIds`
   - Returns utilization statistics

4. **get_user_timesheet** - Get timesheet for a user
   - Parameters: `userId`, `startDate`, `endDate`
   - Returns time entries and totals

### Expense Tracking

**5 tools** for managing business expenses:

1. **list_expenses** - List all expenses
   - Parameters: `status`, `userId`, `startDate`, `endDate`, `limit`, `cursor`
   - Returns paginated expense list

2. **get_expense** - Get detailed expense information
   - Parameters: `expenseId`
   - Returns expense details with attachments

3. **create_expense** - Create a new expense
   - Parameters: `description`, `amount`, `category`, `date`, `userId`
   - Returns created expense

4. **update_expense** - Update expense details
   - Parameters: `expenseId`, `description`, `amount`, `category`, `status`
   - Returns updated expense

5. **delete_expense** - Delete an expense
   - Parameters: `expenseId`
   - Returns deletion confirmation

### Product Catalog

**5 tools** for managing products and services:

1. **list_products** - List all products
   - Parameters: `isActive`, `limit`, `cursor`
   - Returns paginated product list

2. **get_product** - Get detailed product information
   - Parameters: `productId`
   - Returns product details with pricing

3. **create_product** - Create a new product
   - Parameters: `name`, `description`, `unitPrice`, `unit`, `taxable`
   - Returns created product

4. **update_product** - Update product details
   - Parameters: `productId`, `name`, `description`, `unitPrice`, `isActive`
   - Returns updated product

5. **delete_product** - Delete a product
   - Parameters: `productId`
   - Returns deletion confirmation

### Service Requests

**6 tools** for managing incoming service requests:

1. **list_requests** - List all service requests
   - Parameters: `status`, `limit`, `cursor`
   - Returns paginated request list

2. **get_request** - Get detailed request information
   - Parameters: `requestId`
   - Returns request details and contact info

3. **create_request** - Create a new service request
   - Parameters: `title`, `description`, `clientName`, `clientEmail`, `clientPhone`
   - Returns created request

4. **update_request** - Update request status and details
   - Parameters: `requestId`, `status`, `notes`
   - Returns updated request

5. **convert_request_to_quote** - Convert request to quote
   - Parameters: `requestId`
   - Returns created quote

6. **convert_request_to_job** - Convert request directly to job
   - Parameters: `requestId`
   - Returns created job

### Reporting & Analytics

**3 tools** for business intelligence:

1. **get_revenue_report** - Generate revenue report
   - Parameters: `startDate`, `endDate`, `groupBy`
   - Returns revenue metrics and trends

2. **get_job_profit_report** - Get job profitability analysis
   - Parameters: `startDate`, `endDate`, `clientId`
   - Returns profit margins and costs

3. **get_team_utilization_report** - Analyze team productivity
   - Parameters: `startDate`, `endDate`, `userIds`
   - Returns utilization percentages and billable hours

### Property Management

**6 tools** for managing service locations:

1. **list_properties** - List all properties
   - Parameters: `clientId`, `limit`, `cursor`
   - Returns paginated property list

2. **get_property** - Get detailed property information
   - Parameters: `propertyId`
   - Returns property details and address

3. **create_property** - Create a new property
   - Parameters: `clientId`, `address`, `city`, `province`, `postalCode`, `country`
   - Returns created property

4. **update_property** - Update property details
   - Parameters: `propertyId`, `address`, `city`, `province`, `postalCode`
   - Returns updated property

5. **delete_property** - Delete a property
   - Parameters: `propertyId`
   - Returns deletion confirmation

6. **set_default_property** - Set default property for a client
   - Parameters: `clientId`, `propertyId`
   - Returns updated client

### Timesheet Management

**7 tools** for tracking team time:

1. **list_time_entries** - List all time entries
   - Parameters: `userId`, `startDate`, `endDate`, `limit`, `cursor`
   - Returns paginated time entry list

2. **get_time_entry** - Get detailed time entry information
   - Parameters: `timeEntryId`
   - Returns time entry with job details

3. **create_time_entry** - Create a new time entry
   - Parameters: `userId`, `jobId`, `startTime`, `endTime`, `description`
   - Returns created time entry

4. **update_time_entry** - Update time entry details
   - Parameters: `timeEntryId`, `startTime`, `endTime`, `description`
   - Returns updated time entry

5. **delete_time_entry** - Delete a time entry
   - Parameters: `timeEntryId`
   - Returns deletion confirmation

6. **stop_time_entry** - Stop a running time entry
   - Parameters: `timeEntryId`
   - Returns stopped time entry

7. **get_user_timesheet** - Get complete timesheet for a user
   - Parameters: `userId`, `startDate`, `endDate`
   - Returns all time entries and totals

### Line Items

**8 tools** for managing quote/job/invoice line items:

1. **create_job_line_item** - Add line item to job
   - Parameters: `jobId`, `name`, `description`, `quantity`, `unitPrice`
   - Returns created line item

2. **create_quote_line_item** - Add line item to quote
   - Parameters: `quoteId`, `name`, `description`, `quantity`, `unitPrice`
   - Returns created line item

3. **create_invoice_line_item** - Add line item to invoice
   - Parameters: `invoiceId`, `name`, `description`, `quantity`, `unitPrice`
   - Returns created line item

4. **update_line_item** - Update line item details
   - Parameters: `lineItemId`, `name`, `description`, `quantity`, `unitPrice`
   - Returns updated line item

5. **delete_line_item** - Delete a line item
   - Parameters: `lineItemId`
   - Returns deletion confirmation

6. **reorder_line_items** - Change line item order
   - Parameters: `lineItemIds` (ordered array)
   - Returns reordered items

7. **duplicate_line_item** - Copy a line item
   - Parameters: `lineItemId`
   - Returns duplicated item

8. **bulk_update_line_items** - Update multiple line items
   - Parameters: `updates` (array of updates)
   - Returns updated items

### Form Builder

**8 tools** for creating and managing custom forms:

1. **list_forms** - List all forms
   - Parameters: `limit`, `cursor`
   - Returns paginated form list

2. **get_form** - Get form definition
   - Parameters: `formId`
   - Returns form with all fields

3. **create_form** - Create a new form
   - Parameters: `name`, `fields` (array)
   - Returns created form

4. **update_form** - Update form definition
   - Parameters: `formId`, `name`, `fields`
   - Returns updated form

5. **delete_form** - Delete a form
   - Parameters: `formId`
   - Returns deletion confirmation

6. **submit_form** - Submit form data
   - Parameters: `formId`, `data` (field values)
   - Returns submission record

7. **list_form_submissions** - List all submissions for a form
   - Parameters: `formId`, `limit`, `cursor`
   - Returns paginated submissions

8. **get_form_submission** - Get detailed submission
   - Parameters: `submissionId`
   - Returns submission with all field values

### Tax Management

**8 tools** for managing taxes and tax calculations:

1. **list_taxes** - List all tax rates
   - Parameters: `isActive`, `limit`, `cursor`
   - Returns paginated tax list

2. **get_tax** - Get tax details
   - Parameters: `taxId`
   - Returns tax rate and settings

3. **create_tax** - Create a new tax
   - Parameters: `name`, `rate`, `isCompound`
   - Returns created tax

4. **update_tax** - Update tax details
   - Parameters: `taxId`, `name`, `rate`, `isActive`
   - Returns updated tax

5. **delete_tax** - Delete a tax
   - Parameters: `taxId`
   - Returns deletion confirmation

6. **apply_tax_to_line_item** - Apply tax to a line item
   - Parameters: `lineItemId`, `taxId`
   - Returns updated line item

7. **remove_tax_from_line_item** - Remove tax from line item
   - Parameters: `lineItemId`, `taxId`
   - Returns updated line item

8. **calculate_tax_total** - Calculate total tax amount
   - Parameters: `lineItemIds`, `taxIds`
   - Returns calculated tax breakdown

## React Applications

### 15 Interactive Web Applications

All applications are built with React 18, TypeScript, and Tailwind CSS. Each app is production-ready and fully functional.

#### 1. Client Dashboard
**Path**: `src/ui/react-app/src/apps/client-dashboard/`

View and manage all clients with revenue and job statistics. Features:
- Client list with search and filtering
- Revenue tracking per client
- Job count and status overview
- Quick access to client details

#### 2. Client Detail
**Path**: `src/ui/react-app/src/apps/client-detail/`

Comprehensive client profile view with:
- Complete contact information
- Property list
- Job history
- Revenue metrics
- Quick actions for creating quotes/jobs

#### 3. Expense Manager
**Path**: `src/ui/react-app/src/apps/expense-manager/`

Track and approve team expenses:
- Filter by status (pending/approved/rejected)
- Category-based organization
- Attachment support
- Approval workflow

#### 4. Financial Dashboard
**Path**: `src/ui/react-app/src/apps/financial-dashboard/`

Business financial overview:
- Total revenue and expenses
- Net profit calculation
- Outstanding vs paid invoices
- Monthly growth metrics
- Collection rate tracking

#### 5. Form Builder
**Path**: `src/ui/react-app/src/apps/form-builder/`

Visual form designer with:
- Drag-and-drop field management
- Multiple field types (text, select, textarea, checkbox, date)
- Required field configuration
- Live preview
- Form submission handling

#### 6. Invoice Dashboard
**Path**: `src/ui/react-app/src/apps/invoice-dashboard/`

Invoice management interface:
- Invoice list with status filtering
- Payment tracking
- Quick send and payment actions
- Client and amount details

#### 7. Job Board
**Path**: `src/ui/react-app/src/apps/job-board/`

Visual job management board:
- Kanban-style job organization
- Status-based filtering (quoted, scheduled, in progress, completed)
- Job cards with key metrics
- Quick status updates

#### 8. Job Detail
**Path**: `src/ui/react-app/src/apps/job-detail/`

Comprehensive job view:
- Job information and timeline
- Line items and pricing
- Visit schedule
- Client and property details
- Status management

#### 9. Property Map
**Path**: `src/ui/react-app/src/apps/property-map/`

Geographic property visualization:
- Interactive map view
- Property markers with job counts
- Property list panel
- Client information
- Click to select and view details

#### 10. Quote Builder
**Path**: `src/ui/react-app/src/apps/quote-builder/`

Create and edit quotes:
- Client selection
- Line item management
- Pricing calculator
- Tax application
- Quote preview

#### 11. Request Inbox
**Path**: `src/ui/react-app/src/apps/request-inbox/`

Service request management:
- Request status workflow (new, contacted, quoted, converted)
- Priority indicators
- Client contact information
- Quick actions (contact, quote, convert)

#### 12. Schedule Calendar
**Path**: `src/ui/react-app/src/apps/schedule-calendar/`

Visual scheduling interface:
- Day/week calendar view
- Visit timeline visualization
- Team member assignments
- Status tracking (scheduled, in progress, completed)
- Time slot management

#### 13. Team Overview
**Path**: `src/ui/react-app/src/apps/team-overview/`

Team performance dashboard:
- Team member list
- Active and completed job counts
- Weekly hours tracking
- Availability status
- Performance metrics

#### 14. Timesheet Grid
**Path**: `src/ui/react-app/src/apps/timesheet-grid/`

Time entry management:
- Tabular timesheet view
- Approval workflow
- Filter by status (pending/approved)
- Employee and job details
- Hours calculation

#### 15. Visit Tracker
**Path**: `src/ui/react-app/src/apps/visit-tracker/`

Field visit tracking:
- Visit status workflow (scheduled, en route, in progress, completed)
- Client and location details
- Team assignments
- Notes and completion tracking
- Quick status updates

## Usage Examples

### Basic Connection

```typescript
import { JobberServer } from '@mcpengine/jobber-server';

const server = new JobberServer();
await server.run();
```

### Create Client and Job

```typescript
// Create a new client
const client = await tools.create_client({
  firstName: "John",
  lastName: "Doe",
  companyName: "Doe Enterprises",
  email: "john@doeenterprises.com",
  phone: "555-0123"
});

// Create a job for the client
const job = await tools.create_job({
  title: "HVAC Installation",
  description: "Install new heating system",
  clientId: client.id,
  startAt: "2024-02-20T09:00:00Z",
  endAt: "2024-02-20T17:00:00Z"
});
```

### Generate Quote and Convert to Job

```typescript
// Create a quote
const quote = await tools.create_quote({
  title: "Kitchen Renovation",
  message: "As discussed, here is your quote",
  clientId: "client_123"
});

// Add line items
await tools.create_quote_line_item({
  quoteId: quote.id,
  name: "Cabinet Installation",
  quantity: 1,
  unitPrice: 2500
});

// Send to client
await tools.send_quote({
  quoteId: quote.id,
  recipientEmail: "client@example.com"
});

// After approval, convert to job
const job = await tools.convert_quote_to_job({
  quoteId: quote.id
});
```

### Track Team Time

```typescript
// Start time entry
const timeEntry = await tools.create_time_entry({
  userId: "user_123",
  jobId: "job_456",
  startTime: "2024-02-15T09:00:00Z",
  description: "Installation work"
});

// Stop when complete
await tools.stop_time_entry({
  timeEntryId: timeEntry.id
});

// Get user timesheet
const timesheet = await tools.get_user_timesheet({
  userId: "user_123",
  startDate: "2024-02-12",
  endDate: "2024-02-18"
});
```

### Generate Reports

```typescript
// Revenue report
const revenue = await tools.get_revenue_report({
  startDate: "2024-01-01",
  endDate: "2024-01-31",
  groupBy: "week"
});

// Team utilization
const utilization = await tools.get_team_utilization_report({
  startDate: "2024-02-01",
  endDate: "2024-02-29",
  userIds: ["user_1", "user_2", "user_3"]
});
```

## GraphQL API

This server uses Jobber's GraphQL API. All tools execute GraphQL queries and mutations against the Jobber platform.

### Authentication

Requests are authenticated with an OAuth 2.0 bearer token. Jobber access tokens
expire after 60 minutes; the server refreshes them automatically using the
client credentials and refresh token from [Configuration](#configuration).

### Rate Limiting

Jobber implements rate limiting on API requests. This server respects those limits. For high-volume operations, consider:
- Batching requests
- Implementing retry logic
- Using pagination cursors

### API Documentation

For complete Jobber GraphQL API documentation, visit:
https://developer.getjobber.com/docs/

## Development

### Build from Source

```bash
# Clone repository
git clone https://github.com/BusyBee3333/mcpengine.git
cd mcpengine/servers/jobber

# Install dependencies
npm install

# Build TypeScript
npm run build

# Run in development mode
npm run dev
```

### TypeScript Compilation

```bash
# Type check without emitting
npx tsc --noEmit

# Build with source maps
npm run build
```

### Project Structure

```
jobber/
├── src/
│   ├── index.ts              # Entry point
│   ├── server.ts             # MCP server implementation
│   ├── clients/
│   │   └── jobber.ts         # GraphQL client
│   ├── tools/                # 15 tool modules (96 total tools)
│   │   ├── clients-tools.ts
│   │   ├── jobs-tools.ts
│   │   ├── quotes-tools.ts
│   │   ├── invoices-tools.ts
│   │   ├── scheduling-tools.ts
│   │   ├── team-tools.ts
│   │   ├── expenses-tools.ts
│   │   ├── products-tools.ts
│   │   ├── requests-tools.ts
│   │   ├── reporting-tools.ts
│   │   ├── properties-tools.ts
│   │   ├── timesheets-tools.ts
│   │   ├── line-items-tools.ts
│   │   ├── forms-tools.ts
│   │   └── taxes-tools.ts
│   └── ui/
│       └── react-app/
│           └── src/
│               └── apps/      # 15 React applications
│                   ├── client-dashboard/
│                   ├── client-detail/
│                   ├── expense-manager/
│                   ├── financial-dashboard/
│                   ├── form-builder/
│                   ├── invoice-dashboard/
│                   ├── job-board/
│                   ├── job-detail/
│                   ├── property-map/
│                   ├── quote-builder/
│                   ├── request-inbox/
│                   ├── schedule-calendar/
│                   ├── team-overview/
│                   ├── timesheet-grid/
│                   └── visit-tracker/
├── dist/                      # Compiled JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

### Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details

---

**Built with ❤️ using:**
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Jobber GraphQL API](https://developer.getjobber.com/)
- TypeScript 5.7+
- React 18+
- Zod for validation

**Part of the MCPEngine project** - A comprehensive collection of MCP servers for business platforms.

For issues and support, visit: https://github.com/BusyBee3333/mcpengine/issues
