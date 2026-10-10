// Stripe API - READ-ONLY: balance, charges, customers, payment intents, subscriptions,
// invoices, products, prices, payouts, disputes, refunds, events. Every operation is a
// GET; nothing here can charge, refund, pay out or change a customer.
//
// Curated from the vendor's OpenAPI document
// https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json (fetched
// 2026-09-30: OpenAPI 3.0.0, API version 2026-09-30.endive, 612 operations); every path,
// method and parameter name below was checked against it (scripts/api-preset-verify.mjs).
// Docs: https://docs.stripe.com/api .
//
// Deliberately left out: every POST/DELETE (refunds, charges, payouts, customer edits are
// money or customer data), the legacy /v1/customers/{customer}/cards|sources|bank_accounts
// reads, and anything that exposes card numbers (Stripe never returns them anyway).
//
// Parameter spelling: Stripe takes nested filters and expansions in bracket form
// (created[gte]=..., expand[]=customer). The vendor spec models those as one `created` /
// `expand` parameter; here the bracket forms are declared as their own parameters so the
// request is built exactly as Stripe reads it. They are the only names the verifier flags
// as "unknown param".

import { definePreset, get, int, multi, num, p, str, type JsonObject, type OpRow } from "./_kit.js";

const LIMIT = () => p("limit", "query", int("How many objects (1 to 100, default 10)"));
const AFTER = () => p("starting_after", "query", str("Cursor: the id of the last object of the previous page"));
const BEFORE = () => p("ending_before", "query", str("Cursor: the id of the first object of the previous page (walks backwards)"));
const EXPAND = () => p("expand[]", "query", multi("Fields to expand into full objects, e.g. customer, latest_charge, data.customer (on lists)"));
const CREATED = (what: string): JsonObject[] => [
  p("created[gte]", "query", num(`Only ${what} created at or after this time (Unix seconds)`)),
  p("created[lte]", "query", num(`Only ${what} created at or before this time (Unix seconds)`)),
];

const LIST_PAGE = { style: "last-id", param: "starting_after", limitParam: "limit", items: "data", more: "has_more", idField: "id" } as const;
const SEARCH_PAGE = { style: "token", param: "page", limitParam: "limit", next: "next_page", items: "data", more: "has_more" } as const;

const byId = (path: string, id: string, summary: string, pathName: string, what: string, keywords: string[] = []): OpRow =>
  get(path, id, summary, [p(pathName, "path", str(`The ${what} id`)), EXPAND()], { tags: [what], keywords, vendor: `GET ${path}` });

const search = (path: string, id: string, what: string, example: string, keywords: string[] = []): OpRow =>
  get(
    path,
    id,
    `Search ${what} with Stripe's query language (${example}); results can lag a minute behind live data`,
    [
      p("query", "query", str(`Search query, fields joined by AND/OR, e.g. ${example}`), true),
      LIMIT(),
      p("page", "query", str("Cursor: next_page from the previous response")),
      EXPAND(),
    ],
    { tags: [what], keywords, paginate: SEARCH_PAGE, vendor: `GET ${path}` },
  );

export default definePreset({
  id: "stripe",
  label: "Stripe",
  blurb: "Your Stripe account, read-only: balance, charges, customers, subscriptions, invoices, payouts, disputes and refunds. Nothing can be charged or refunded from here.",
  connect: "stripe-key",
  oauth: { credentials: ["STRIPE_SECRET_KEY"], scopes: ["a Stripe secret or restricted key (rk_...) with read access to the objects used; restricted keys answer 403 for a resource they were not granted"] },
  baseUrl: "https://api.stripe.com",
  ratePerMin: 600,
  verifyOperationId: "getBalance",
  keywords: ["stripe", "payments", "revenue", "sales", "customers", "subscriptions", "mrr", "payout", "refund", "dispute", "chargeback"],
  domain: "stripe.com",
  source: {
    kind: "vendor-openapi",
    specUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    docsUrl: "https://docs.stripe.com/api",
    fetchedOn: "2026-09-30",
  },
  notes: {
    rateLimits: "Live mode allows about 100 read operations a second (25 in test mode), answered with HTTP 429; the Api tool waits out a short Retry-After and retries. The Search API is limited to about 20 requests a second.",
    pagination: "Lists answer {object:\"list\", data:[...], has_more}; pass pages and the tool follows starting_after (the id of the last object). Search endpoints answer {data, has_more, next_page}; next_page goes back as page.",
    auth: "Authorization: Bearer <secret key> (sk_live_... / sk_test_... or a restricted rk_... key). The key decides live vs test data: a test key sees only test objects.",
    scopes: "A restricted key needs Read on each resource it touches; a missing permission answers 403 naming it.",
    gotchas: [
      "Money amounts are integers in the smallest currency unit (cents for usd): 1999 means 19.99. Zero-decimal currencies (jpy) are whole units.",
      "Timestamps are Unix seconds. Filter ranges use created[gte] / created[lte].",
      "Search is eventually consistent (up to about a minute) and supports only a subset of fields; query strings use quotes: email:\"a@b.com\" AND status:\"active\".",
      "Every operation here is a read. Refunds, charges, payouts and customer edits are deliberately not offered.",
      "A search `limit` is at most 100 and paging uses the opaque next_page cursor, not starting_after.",
    ],
  },
  ops: [
    // ── balance ──
    get("/v1/balance", "getBalance", "The account balance: available and pending amounts per currency", [EXPAND()], {
      tags: ["balance"],
      keywords: ["balance", "how much money", "available balance", "what is my stripe balance"],
      vendor: "GET /v1/balance",
    }),
    get(
      "/v1/balance_transactions",
      "listBalanceTransactions",
      "Every movement on the balance (charge, refund, payout, fee, adjustment) with amount, fee, net and type, newest first",
      [
        p("type", "query", str("Only this kind, e.g. charge, refund, payout, adjustment, stripe_fee")),
        p("payout", "query", str("Only transactions paid out by this payout id (po_...)")),
        p("source", "query", str("Only transactions for this object id (ch_..., re_...)")),
        p("currency", "query", str("Only this currency (three-letter lowercase ISO code)")),
        ...CREATED("transactions"),
        LIMIT(),
        AFTER(),
        BEFORE(),
        EXPAND(),
      ],
      { tags: ["balance"], keywords: ["transactions", "fees paid", "balance history", "ledger"], paginate: LIST_PAGE, vendor: "GET /v1/balance_transactions" },
    ),
    byId("/v1/balance_transactions/{id}", "getBalanceTransaction", "One balance transaction: amount, fee, net, type, and the source object", "id", "balance transaction"),

    // ── charges ──
    get(
      "/v1/charges",
      "listCharges",
      "Charges, newest first: amount, currency, status, paid, refunded, customer, receipt email, failure reason",
      [
        p("customer", "query", str("Only charges of this customer id (cus_...)")),
        p("payment_intent", "query", str("Only charges created by this PaymentIntent id (pi_...)")),
        ...CREATED("charges"),
        LIMIT(),
        AFTER(),
        BEFORE(),
        EXPAND(),
      ],
      { tags: ["charges"], keywords: ["what did I sell today", "what did I sell", "sales today", "recent payments", "charges today", "who paid me", "failed payments"], paginate: LIST_PAGE, vendor: "GET /v1/charges" },
    ),
    byId("/v1/charges/{charge}", "getCharge", "One charge: amount, status, payment method details, outcome, refunds, receipt url", "charge", "charge", ["why did the payment fail"]),
    search("/v1/charges/search", "searchCharges", "charges", "status:\"succeeded\" AND amount>5000 AND created>1788000000", ["find a payment"]),

    // ── customers ──
    get(
      "/v1/customers",
      "listCustomers",
      "Customers, newest first: id, name, email, balance, default payment method",
      [p("email", "query", str("Only customers with exactly this email (case-sensitive)")), ...CREATED("customers"), LIMIT(), AFTER(), BEFORE(), EXPAND()],
      { tags: ["customers"], keywords: ["my customers", "new customers", "customer list"], paginate: LIST_PAGE, vendor: "GET /v1/customers" },
    ),
    byId("/v1/customers/{customer}", "getCustomer", "One customer: name, email, address, balance, default payment method, metadata", "customer", "customer"),
    search("/v1/customers/search", "searchCustomers", "customers", "email:\"jane@example.com\" or name~\"Jane\"", ["find a customer", "look up customer by email"]),
    get(
      "/v1/customers/{customer}/payment_methods",
      "listCustomerPaymentMethods",
      "A customer's saved payment methods (card brand, last4, expiry; never the full number)",
      [
        p("customer", "path", str("The customer id (cus_...)")),
        p("type", "query", str("Only this type, e.g. card, us_bank_account, sepa_debit")),
        LIMIT(),
        AFTER(),
        BEFORE(),
      ],
      { tags: ["customers"], keywords: ["saved cards"], paginate: LIST_PAGE, vendor: "GET /v1/customers/{customer}/payment_methods" },
    ),

    // ── payment intents ──
    get(
      "/v1/payment_intents",
      "listPaymentIntents",
      "PaymentIntents, newest first: amount, currency, status (succeeded, requires_payment_method, canceled ...), customer",
      [p("customer", "query", str("Only this customer id (cus_...)")), ...CREATED("payment intents"), LIMIT(), AFTER(), BEFORE(), EXPAND()],
      { tags: ["payment intents"], keywords: ["payment attempts", "incomplete payments", "abandoned payments"], paginate: LIST_PAGE, vendor: "GET /v1/payment_intents" },
    ),
    byId("/v1/payment_intents/{intent}", "getPaymentIntent", "One PaymentIntent: amount, status, last payment error, charges, customer", "intent", "payment intent"),
    search("/v1/payment_intents/search", "searchPaymentIntents", "payment intents", "status:\"succeeded\" AND metadata[\"order_id\"]:\"6735\"", ["find a payment by order"]),

    // ── subscriptions ──
    get(
      "/v1/subscriptions",
      "listSubscriptions",
      "Subscriptions: customer, status, items with prices, current period, cancel_at_period_end (canceled ones only with status all or canceled)",
      [
        p("status", "query", str("Only this status; the default hides canceled ones", { enum: ["active", "all", "canceled", "ended", "incomplete", "incomplete_expired", "past_due", "paused", "trialing", "unpaid"] })),
        p("customer", "query", str("Only this customer id (cus_...)")),
        p("price", "query", str("Only subscriptions containing this recurring price id (price_...)")),
        p("collection_method", "query", str("charge_automatically or send_invoice", { enum: ["charge_automatically", "send_invoice"] })),
        ...CREATED("subscriptions"),
        LIMIT(),
        AFTER(),
        BEFORE(),
        EXPAND(),
      ],
      { tags: ["subscriptions"], keywords: ["my subscribers", "active subscriptions", "past due subscriptions", "mrr", "who canceled", "churn"], paginate: LIST_PAGE, vendor: "GET /v1/subscriptions" },
    ),
    byId("/v1/subscriptions/{subscription_exposed_id}", "getSubscription", "One subscription: status, items, prices, billing period, trial, cancellation", "subscription_exposed_id", "subscription"),
    search("/v1/subscriptions/search", "searchSubscriptions", "subscriptions", "status:\"active\" AND metadata[\"plan\"]:\"pro\"", ["find a subscription"]),

    // ── invoices ──
    get(
      "/v1/invoices",
      "listInvoices",
      "Invoices: number, customer, status, total, amount due and paid, due date, hosted url",
      [
        p("status", "query", str("Only this status", { enum: ["draft", "open", "paid", "uncollectible", "void"] })),
        p("customer", "query", str("Only this customer id (cus_...)")),
        p("subscription", "query", str("Only this subscription id (sub_...)")),
        p("collection_method", "query", str("charge_automatically or send_invoice", { enum: ["charge_automatically", "send_invoice"] })),
        ...CREATED("invoices"),
        LIMIT(),
        AFTER(),
        BEFORE(),
        EXPAND(),
      ],
      { tags: ["invoices"], keywords: ["unpaid invoices", "open invoices", "overdue invoices", "my invoices"], paginate: LIST_PAGE, vendor: "GET /v1/invoices" },
    ),
    byId("/v1/invoices/{invoice}", "getInvoice", "One invoice: lines, totals, tax, status, payment intent, hosted invoice and PDF urls", "invoice", "invoice"),
    get(
      "/v1/invoices/{invoice}/lines",
      "listInvoiceLines",
      "The line items of one invoice: description, amount, quantity, price",
      [p("invoice", "path", str("The invoice id (in_...)")), LIMIT(), AFTER(), BEFORE(), EXPAND()],
      { tags: ["invoices"], paginate: LIST_PAGE, vendor: "GET /v1/invoices/{invoice}/lines" },
    ),
    search("/v1/invoices/search", "searchInvoices", "invoices", "status:\"open\" AND total>1000", ["find an invoice"]),

    // ── catalog ──
    get(
      "/v1/products",
      "listProducts",
      "Products in the catalog: name, description, active, default price",
      [
        p("active", "query", { type: "boolean", description: "true: only active products; false: only archived ones" }),
        p("ids", "query", multi("Only these product ids (prod_...)")),
        LIMIT(),
        AFTER(),
        BEFORE(),
        EXPAND(),
      ],
      { tags: ["products"], keywords: ["what do I sell", "my products", "product catalog"], paginate: LIST_PAGE, vendor: "GET /v1/products" },
    ),
    byId("/v1/products/{id}", "getProduct", "One product: name, description, images, default price, metadata", "id", "product"),
    search("/v1/products/search", "searchProducts", "products", "active:\"true\" AND name~\"shirt\"", ["find a product"]),
    get(
      "/v1/prices",
      "listPrices",
      "Prices: product, amount, currency, one-time or recurring interval",
      [
        p("product", "query", str("Only prices of this product id (prod_...)")),
        p("active", "query", { type: "boolean", description: "true: only active prices; false: only archived ones" }),
        p("type", "query", str("one_time or recurring", { enum: ["one_time", "recurring"] })),
        p("currency", "query", str("Only this currency (three-letter lowercase ISO code)")),
        p("lookup_keys", "query", multi("Only prices with these lookup keys (up to 10)")),
        LIMIT(),
        AFTER(),
        BEFORE(),
        EXPAND(),
      ],
      { tags: ["prices"], keywords: ["my prices", "pricing"], paginate: LIST_PAGE, vendor: "GET /v1/prices" },
    ),
    byId("/v1/prices/{price}", "getPrice", "One price: amount, currency, recurring interval, product", "price", "price"),

    // ── payouts, disputes, refunds ──
    get(
      "/v1/payouts",
      "listPayouts",
      "Payouts to the bank: amount, currency, status, arrival date, method",
      [
        p("status", "query", str("Only this status: pending, paid, failed or canceled", { enum: ["pending", "paid", "failed", "canceled"] })),
        p("arrival_date[gte]", "query", num("Only payouts arriving at or after this time (Unix seconds)")),
        p("arrival_date[lte]", "query", num("Only payouts arriving at or before this time (Unix seconds)")),
        ...CREATED("payouts"),
        LIMIT(),
        AFTER(),
        BEFORE(),
        EXPAND(),
      ],
      { tags: ["payouts"], keywords: ["when do I get paid", "my payouts", "bank transfers", "next payout"], paginate: LIST_PAGE, vendor: "GET /v1/payouts" },
    ),
    byId("/v1/payouts/{payout}", "getPayout", "One payout: amount, status, arrival date, destination, failure reason", "payout", "payout"),
    get(
      "/v1/disputes",
      "listDisputes",
      "Disputes (chargebacks): amount, reason, status, evidence due date",
      [
        p("charge", "query", str("Only disputes of this charge id (ch_...)")),
        p("payment_intent", "query", str("Only disputes of this PaymentIntent id (pi_...)")),
        ...CREATED("disputes"),
        LIMIT(),
        AFTER(),
        BEFORE(),
        EXPAND(),
      ],
      { tags: ["disputes"], keywords: ["chargebacks", "disputes", "evidence due"], paginate: LIST_PAGE, vendor: "GET /v1/disputes" },
    ),
    byId("/v1/disputes/{dispute}", "getDispute", "One dispute: reason, status, amount, evidence details and the deadline", "dispute", "dispute"),
    get(
      "/v1/refunds",
      "listRefunds",
      "Refunds: amount, currency, status, reason, the charge they belong to",
      [
        p("charge", "query", str("Only refunds of this charge id (ch_...)")),
        p("payment_intent", "query", str("Only refunds of this PaymentIntent id (pi_...)")),
        ...CREATED("refunds"),
        LIMIT(),
        AFTER(),
        BEFORE(),
        EXPAND(),
      ],
      { tags: ["refunds"], keywords: ["refunds", "money I gave back"], paginate: LIST_PAGE, vendor: "GET /v1/refunds" },
    ),
    byId("/v1/refunds/{refund}", "getRefund", "One refund: amount, status, reason, failure reason", "refund", "refund"),

    // ── events and checkout ──
    get(
      "/v1/events",
      "listEvents",
      "Account events of the last 30 days (charge.succeeded, invoice.paid ...): type, created, the object that changed",
      [
        p("type", "query", str("An event name, or a group with * as wildcard, e.g. charge.* or invoice.payment_failed")),
        p("types", "query", multi("Up to 20 event names")),
        p("delivery_success", "query", { type: "boolean", description: "false: only events whose webhook delivery has not succeeded" }),
        ...CREATED("events"),
        LIMIT(),
        AFTER(),
        BEFORE(),
      ],
      { tags: ["events"], keywords: ["what happened in stripe", "recent activity", "webhook events", "failed payments events"], paginate: LIST_PAGE, vendor: "GET /v1/events" },
    ),
    byId("/v1/events/{id}", "getEvent", "One event with its full data.object payload", "id", "event"),
    get(
      "/v1/checkout/sessions",
      "listCheckoutSessions",
      "Checkout Sessions: status, payment status, amount total, customer email, payment link",
      [
        p("status", "query", str("open, complete or expired", { enum: ["complete", "expired", "open"] })),
        p("customer", "query", str("Only this customer id (cus_...)")),
        p("payment_link", "query", str("Only sessions of this payment link (plink_...)")),
        p("subscription", "query", str("Only the session that created this subscription id")),
        ...CREATED("sessions"),
        LIMIT(),
        AFTER(),
        BEFORE(),
        EXPAND(),
      ],
      { tags: ["checkout"], keywords: ["checkout sessions", "who bought", "orders", "abandoned checkouts"], paginate: LIST_PAGE, vendor: "GET /v1/checkout/sessions" },
    ),
    byId("/v1/checkout/sessions/{session}", "getCheckoutSession", "One Checkout Session: totals, customer details, shipping, payment status", "session", "checkout session"),
    get(
      "/v1/checkout/sessions/{session}/line_items",
      "listCheckoutSessionLineItems",
      "What was bought in one Checkout Session: description, quantity, amount",
      [p("session", "path", str("The Checkout Session id (cs_...)")), LIMIT(), AFTER(), BEFORE(), EXPAND()],
      { tags: ["checkout"], keywords: ["what did they buy"], paginate: LIST_PAGE, vendor: "GET /v1/checkout/sessions/{session}/line_items" },
    ),
  ],
  recipes: [
    {
      ask: "how much money is in my Stripe account",
      steps: [{ op: "getBalance", fields: "available,pending", note: "amounts are in the smallest unit (cents); available is what can be paid out now" }],
    },
    {
      ask: "what did I sell today",
      steps: [
        {
          op: "listCharges",
          params: { "created[gte]": 1788048000, limit: 100 },
          fields: "id,amount,currency,status,paid,refunded,created,billing_details.email,description",
          note: "created[gte] = Unix seconds of local midnight today; add them up for succeeded, non-refunded charges and divide by 100 for dollars",
        },
      ],
    },
    {
      ask: "who are my active subscribers",
      steps: [
        {
          op: "listSubscriptions",
          params: { status: "active", limit: 100, "expand[]": ["data.customer"] },
          fields: "id,customer.email,customer.name,items.data.price.unit_amount,items.data.price.recurring.interval,cancel_at_period_end",
          note: "monthly recurring revenue = sum of unit_amount for monthly items (yearly items divided by 12)",
        },
      ],
    },
    {
      ask: "which invoices are unpaid",
      steps: [
        { op: "listInvoices", params: { status: "open", limit: 50 }, fields: "id,number,customer_email,amount_due,currency,due_date,hosted_invoice_url", note: "open = sent and unpaid; past due_date means overdue" },
      ],
    },
    {
      ask: "when is my next payout and how much",
      steps: [{ op: "listPayouts", params: { status: "pending", limit: 5 }, fields: "id,amount,currency,arrival_date,status,method" }],
    },
    {
      ask: "do I have any open disputes",
      steps: [
        { op: "listDisputes", params: { limit: 20 }, fields: "id,amount,currency,reason,status,evidence_details.due_by,charge", note: "status needs_response means evidence is due by evidence_details.due_by (Unix seconds)" },
        { op: "getCharge", params: { charge: "ch_example" }, fields: "id,amount,billing_details.email,description,created", note: "the charge behind a dispute, to see who and what" },
      ],
    },
  ],
  searchChecks: [
    ["how much money is in my stripe balance", "getBalance"],
    ["what did I sell today", "listCharges"],
    ["active subscribers", "listSubscriptions"],
    ["unpaid invoices", "listInvoices"],
    ["when do I get paid", "listPayouts"],
    ["chargebacks", "listDisputes"],
    ["look up customer by email", "searchCustomers"],
    ["refunds", "listRefunds"],
  ],
});
