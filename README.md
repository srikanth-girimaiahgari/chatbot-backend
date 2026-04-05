# DigiMaya

DigiMaya is a multi-tenant AI system for online product businesses. Its job is to handle Instagram DMs, use each business's own catalog and FAQs, qualify buying intent, and now turn purchase-ready conversations into structured draft orders.

## 20% Logic

The simplest way to understand DigiMaya is this:

- Instagram is the customer conversation lane
- DigiMaya is the digital employee working inside that lane
- each client keeps their own business data, catalog, and rules
- the system is moving from "replying to DMs" to "operating the sales flow"

Right now DigiMaya already handles:

- tenant-specific DM replies
- client onboarding and settings
- provider monitoring
- hot lead and anti-loop protection
- structured order intents
- draft orders
- multi-item order lines

What is deliberately paused:

- live payment-link generation
- payment confirmation webhooks
- stock deduction after payment

That pause is intentional. Payment is the highest-risk layer, so the product is being built in the right order: conversation first, order structure second, money third.

## What Is Live Today

- Multi-tenant Instagram DM routing
- Tenant-specific product and FAQ replies
- Provider admin dashboard
- Google Sheets export for operational review
- Client portal with signup, login, onboarding, and settings
- Editable catalog and FAQ management
- Currency-aware product pricing
- Hot lead alerts
- Anti-loop protection
- Product links and image URLs
- Bulk product import
- Structured `order_intents`
- Draft `orders`
- Multi-item `order_items`

## What Is In Development

- Payment-link generation from draft orders
- Payment confirmation and paid-order state
- Exception-only escalation for non-standard orders

## Product Shape

DigiMaya is not being built as "another website chat tool."

The product wedge is:

- DM-first
- commerce-first
- multi-business
- digital-employee behavior

That means DigiMaya is strongest when it can do normal business work without the owner stepping in every time.

## Core User Flows

### 1. Business onboarding

Client can:

- sign up
- log in
- add business profile
- set working hours
- add products
- add FAQs
- request Instagram setup help

### 2. Customer conversation

When a customer messages on Instagram:

1. Meta sends the message to DigiMaya
2. DigiMaya finds the correct tenant
3. DigiMaya loads that tenant's products, FAQs, and business rules
4. MAYA replies using the tenant's own information
5. if the conversation becomes purchase-ready, DigiMaya creates:
   - `order_intent`
   - `order`
   - `order_items` when multiple products are involved

### 3. Provider operations

The provider dashboard shows:

- tenant health
- catalog and FAQ counts
- message activity
- handoffs
- order-intent counts
- draft-order counts

## Current Commerce Model

### Order intent

When a buying conversation becomes clear enough, DigiMaya captures:

- customer name
- occasion
- contact method
- contact detail
- product interest
- quantity

That becomes a structured `order_intent`.

### Draft order

Then DigiMaya creates a draft `order`.

The order stores:

- order reference
- tenant
- customer details
- product interest
- quantity
- payment readiness fields

### Multi-item order lines

Real online buyers often want more than one item. Because of that, DigiMaya now uses:

- `orders` as the order header
- `order_items` as the individual cart lines

This avoids the old mistake of treating three different products as one product with quantity three.

## Tech Stack

- `Node.js`
- `Express`
- `Supabase`
- `Anthropic`
- `Resend`
- `Railway`
- `Google Apps Script` for Sheets sync

## Main Tables

### Existing operating tables

- `tenants`
- `products`
- `faqs`
- `chat_messages`
- `handoff_requests`

### Digital-employee commerce tables

- `order_intents`
- `orders`
- `order_items`

## Important Routes

### Public / channel routes

- `GET /`
- `GET /webhook`
- `POST /webhook`
- `POST /whatsapp/webhook`
- `POST /chat`

### Client portal

- `GET /client`
- `GET /client/overview`
- `GET /client/conversations`
- `GET /client/leads`
- `GET /client/performance`

### Provider admin

- `GET /admin/dashboard`
- `GET /admin/overview`
- `GET /admin/tenants`
- `GET /admin/tenants/:tenantId`
- `GET /admin/exports/google-sheets`

## Environment Variables

Core app:

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
ADMIN_API_TOKEN=
CLIENT_PORTAL_SECRET=
VERIFY_TOKEN=
PORT=3000
```

Email / alerts:

```env
RESEND_API_KEY=
ALERT_EMAIL=
```

Optional or future payment layer:

```env
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
```

Important:

- `.env` should never be committed
- client-specific secrets should not go in `.env`
- if DigiMaya later connects client payment accounts, those should be stored per tenant, server-side only

## Local Setup

```bash
git clone <repo-url>
cd chatbot-backend
npm install
```

Create `.env`, then run:

```bash
node index.js
```

## Branch Workflow

Development happens on:

- `development`

Production deploys from:

- `main`

Recommended flow:

1. build and test on `development`
2. verify behavior
3. merge to `main`
4. Railway deploys from `main`

## SQL Migrations Added During DigiMaya Growth

Important recent SQL files:

- `sql/client-portal-onboarding.sql`
- `sql/digimaya-order-intents.sql`
- `sql/digimaya-draft-orders.sql`
- `sql/digimaya-payment-ready-orders.sql`
- `sql/digimaya-order-items.sql`

Run these in Supabase SQL Editor when introducing the matching feature.

## Operational Notes

- Google Sheets sync is now best treated as a reporting layer, not the source of truth
- provider dashboard is the operational control room
- website chat is not a current priority
- WhatsApp is intentionally held behind Instagram while business ownership and Meta setup are clarified

## Honest Product Status

DigiMaya is already operational as:

- a multi-tenant Instagram DM system
- a client onboarding platform
- a provider operations platform
- an early commerce operator through order intents and draft orders

DigiMaya is not yet fully operational as:

- a complete payment-handling digital employee
- a post-payment fulfillment engine
- a full online business operating system

That is the right state for now. The foundation is real, and the next layers are being added carefully instead of being rushed.

## Documentation

Project documentation lives in:

- `docs/DigiMaya_Guide.html`
- `docs/DigiMaya_Build_Log.html`
- `docs/DigiMaya_Behind_The_Scenes.html`

The build log should be updated whenever a meaningful product step changes from idea to live behavior.
