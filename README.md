# 🤖 Chatbot Backend — AI-Powered Digital Products Assistant

A production-ready AI chatbot backend for a digital products business targeting physical product sellers. Built with Node.js, deployed on Railway, powered by Claude AI.

---

## 📌 Project Status

| Item | Status |
|------|--------|
| Deployment | ✅ Live on Railway |
| All Features | ✅ Passing |
| Git Branches | `main` (production) + `development` |
| Monthly Cost | ~$1–5 (testing) |

**Live URL:** `https://chatbot-backend-production-c000.up.railway.app`

---

## ✨ Features

### Core Chatbot
- AI-powered responses using Claude Sonnet API
- Full conversation context — last 6 messages sent with every request
- Product search from live Supabase database
- FAQ matching before calling AI (cost optimisation)
- Short, precise responses (max 200 tokens)

### Human Handoff
- Detects trigger phrases: "talk to a human", "human agent", etc.
- Logs request to `handoff_requests` table in Supabase
- Sends instant email alert via Resend API

### Purchase Flow
- Detects purchase intent from 15+ trigger phrases
- Offers 4 contact method options: WhatsApp, Text, Phone, Email
- Validates phone numbers using **libphonenumber-js** (Google standard)
- Validates email addresses using RFC-compliant regex
- Handles change of mind — customer can switch method at any point
- For phone calls: collects preferred call time separately
- Saves all contact details to `handoff_requests` table
- Sends agent email alert with customer contact details

---

## 🧱 Tech Stack

| Package | Purpose |
|---------|---------|
| `express` | REST API framework |
| `@supabase/supabase-js` | Database connector |
| `@anthropic-ai/sdk` | Claude AI connector |
| `resend` | Email delivery |
| `libphonenumber-js` | Phone number validation (Google standard) |
| `dotenv` | Environment variable management |
| `cors` | Cross-origin resource sharing |

---

## 🗄️ Database Tables (Supabase)

| Table | Purpose |
|-------|---------|
| `products` | Digital product catalog with pricing and stock |
| `faqs` | Pre-written question and answer pairs |
| `chat_messages` | Full conversation history per session |
| `handoff_requests` | Human agent queue with contact details |

### handoff_requests columns:
`id`, `session_id`, `reason`, `status`, `whatsapp`, `product_interest`, `contact_method`, `contact_detail`, `preferred_time`, `created_at`

---

## 🔌 API Endpoints

### Health Check
```
GET /
```
Returns server status.

---

### Product Search
```
GET /products?search=keyword
```
Searches the product catalog by keyword.

---

### Chat
```
POST /chat
```
Main chatbot endpoint.

**Request:**
```json
{
  "message": "do you offer refunds?",
  "session_id": "unique-session-id"
}
```

**Response:**
```json
{
  "reply": "Yes we offer a 7-day money back guarantee on all products."
}
```

**Processing order:**
1. Save user message to `chat_messages`
2. Check for human handoff triggers
3. Check for existing purchase flow (contact method → contact detail → call time)
4. Check for new purchase intent
5. Load all products + FAQs from Supabase
6. Load last 6 messages for conversation context
7. Call Claude API with full context
8. Save reply to `chat_messages`
9. Return reply

---

### Handoff Queue
```
GET /handoff
```
Returns all pending human handoff requests.

---

## 🛒 Purchase Flow

```
Customer: "I want to buy Inventory Tracker Pro"
Bot:  "How would you prefer our team to contact you?
       1. WhatsApp  2. Text  3. Phone  4. Email"

Customer: "1"
Bot:  "Please share your WhatsApp number with country code, e.g. +91 9876543210"

Customer: "+91 9876543210"   ← validated by libphonenumber-js
Bot:  "Thank you! Our team will message you on WhatsApp within minutes!"
Agent: receives email with contact details
```

**Change of mind:** Customer can type 1, 2, 3 or 4 at any point to switch contact method.

---

## ⚙️ Environment Variables

```env
SUPABASE_URL=https://xxxxxx.supabase.co
SUPABASE_KEY=sb_publishable_xxxxxx
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxx
ALERT_EMAIL=your@gmail.com
RESEND_API_KEY=re_xxxxxx
PORT=3000
```

> ⚠️ Never commit `.env` to GitHub. It is listed in `.gitignore`.

---

## 🚀 Local Setup

```bash
git clone git@github.com:yourusername/chatbot-backend.git
cd chatbot-backend
npm install
# Create .env and fill in your values
node index.js
```

Server runs on `http://localhost:3000`

---

## 🌿 Git Workflow

```bash
# Always develop on development branch
git checkout development

# After testing locally — merge to main
git checkout main
git merge development
git push origin main
# Railway auto-deploys from main
```

---

## ☁️ Deployment

Deployed on **Railway** via GitHub integration. Every push to `main` triggers automatic redeployment.

Environment variables are stored in Railway Variables dashboard — never in code.

---

## 🧪 Test Results

| Feature | Status |
|---------|--------|
| Health check | ✅ Passing |
| Product search | ✅ Passing |
| FAQ matching | ✅ Passing |
| Claude AI responses | ✅ Passing |
| Conversation context | ✅ Passing |
| Human handoff (Supabase) | ✅ Passing |
| Human handoff (Email) | ✅ Passing |
| Purchase intent detection | ✅ Passing |
| WhatsApp contact flow | ✅ Passing |
| Text message contact flow | ✅ Passing |
| Phone call + preferred time flow | ✅ Passing |
| Email contact flow | ✅ Passing |
| Phone validation (libphonenumber) | ✅ Passing |
| Email validation (regex) | ✅ Passing |
| Change of mind handling | ✅ Passing |

---

## 🗺️ Roadmap

- [x] Phase 1 — Accounts and tools setup
- [x] Phase 2 — Database setup (Supabase)
- [x] Phase 3 — Backend API (Railway)
- [x] Phase 4 — Chat widget UI (Vercel)
- [x] Phase 5 — Full system testing
- [ ] Phase 6 — Replace dummy data with real products
- [ ] Phase 7 — Custom domain
- [ ] Phase 8 — Production security lockdown
- [ ] Phase 9 — Cost optimisation (caching)
- [ ] Phase 10 — Agent dashboard

---

## 📁 Project Structure

```
chatbot-backend/
├── index.js          # Main backend application
├── package.json      # Project dependencies
├── package-lock.json # Dependency lock file
├── .gitignore        # Excludes .env and node_modules
└── .env              # Secret keys (never committed)
```

---

## 🔗 Related Repository

- [chatbot-widget](https://github.com/yourusername/chatbot-widget) — Chat widget UI on Vercel

---

## 📄 License

MIT
