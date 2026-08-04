/**
 * Jobber API Types
 */

export interface JobberConfig {
  clientId: string;
  clientSecret: string;
  /** Long-lived refresh token from the initial authorization code exchange. */
  refreshToken: string;
  /** Optional access token to start with. Refreshed automatically once it expires. */
  accessToken?: string;
  apiUrl?: string;
  oauthUrl?: string;
  graphqlVersion?: string;
  /** Called whenever Jobber rotates the refresh token, so it can be persisted. */
  onTokensRefreshed?: (tokens: JobberTokens) => void | Promise<void>;
}

export interface JobberTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor?: string;
  endCursor?: string;
}

export interface Connection<T> {
  edges: Array<{ node: T; cursor: string }>;
  pageInfo: PageInfo;
  totalCount?: number;
}

// Client Types
export interface Client {
  id: string;
  firstName: string;
  lastName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  billingAddress?: Address;
  properties?: Property[];
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Property {
  id: string;
  address: Address;
  client: Client;
  isDefault: boolean;
}

export interface Address {
  street1?: string;
  street2?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
}

// Job Types
export interface Job {
  id: string;
  jobNumber: string;
  title: string;
  description?: string;
  client: Client;
  property?: Property;
  status: JobStatus;
  visits?: Visit[];
  lineItems?: LineItem[];
  total?: Money;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export type JobStatus = 
  | "ACTION_REQUIRED"
  | "ACTIVE"
  | "CANCELLED"
  | "COMPLETED"
  | "LATE"
  | "REQUIRES_INVOICING";

// Quote Types
export interface Quote {
  id: string;
  quoteNumber: string;
  title: string;
  client: Client;
  property?: Property;
  status: QuoteStatus;
  lineItems?: LineItem[];
  total?: Money;
  sentAt?: string;
  approvedAt?: string;
  createdAt: string;
  expiresAt?: string;
}

export type QuoteStatus =
  | "DRAFT"
  | "SENT"
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "CONVERTED"
  | "EXPIRED";

// Invoice Types
export interface Invoice {
  id: string;
  invoiceNumber: string;
  subject: string;
  client: Client;
  job?: Job;
  status: InvoiceStatus;
  lineItems?: LineItem[];
  subtotal?: Money;
  total?: Money;
  amountPaid?: Money;
  amountDue?: Money;
  sentAt?: string;
  dueDate?: string;
  createdAt: string;
}

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "VIEWED"
  | "PAID"
  | "PARTIALLY_PAID"
  | "OVERDUE"
  | "BAD_DEBT";

export interface Payment {
  id: string;
  amount: Money;
  paymentMethod: string;
  paidOn: string;
  invoice: Invoice;
}

// Visit/Scheduling Types
export interface Visit {
  id: string;
  title: string;
  job?: Job;
  startAt: string;
  endAt: string;
  assignedUsers?: User[];
  status: VisitStatus;
  completedAt?: string;
  notes?: string;
}

export type VisitStatus =
  | "UNSCHEDULED"
  | "SCHEDULED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED";

// Line Item Types
export interface LineItem {
  id: string;
  name: string;
  description?: string;
  quantity: number;
  unitPrice?: Money;
  total?: Money;
  productOrService?: Product;
}

// Product/Service Types
export interface Product {
  id: string;
  name: string;
  description?: string;
  unitPrice?: Money;
  type: "PRODUCT" | "SERVICE";
  isArchived: boolean;
}

// Team Types
export interface User {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  isActive: boolean;
}

export interface TimeEntry {
  id: string;
  user: User;
  visit?: Visit;
  startAt: string;
  endAt?: string;
  duration?: number;
  notes?: string;
}

// Expense Types
export interface Expense {
  id: string;
  description: string;
  amount: Money;
  category?: string;
  date: string;
  user?: User;
  job?: Job;
  receipt?: string;
}

// Request Types
export interface Request {
  id: string;
  title: string;
  description?: string;
  client?: Client;
  status: RequestStatus;
  createdAt: string;
}

export type RequestStatus =
  | "NEW"
  | "IN_PROGRESS"
  | "CONVERTED"
  | "CLOSED";

// Money Type
export interface Money {
  amount: number;
  currency: string;
}

// GraphQL Query Variables
export interface PaginationVariables {
  first?: number;
  after?: string;
  last?: number;
  before?: string;
}

export interface ClientInput {
  firstName: string;
  lastName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  billingAddress?: AddressInput;
}

export interface AddressInput {
  street1?: string;
  street2?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
}

export interface JobInput {
  title: string;
  description?: string;
  clientId: string;
  propertyId?: string;
}

export interface QuoteInput {
  title: string;
  clientId: string;
  propertyId?: string;
  lineItems?: LineItemInput[];
}

export interface LineItemInput {
  name: string;
  description?: string;
  quantity: number;
  unitPrice?: number;
  productId?: string;
}

export interface VisitInput {
  title: string;
  jobId?: string;
  startAt: string;
  endAt: string;
  userIds?: string[];
}

export interface ExpenseInput {
  description: string;
  amount: number;
  category?: string;
  date: string;
  jobId?: string;
}
