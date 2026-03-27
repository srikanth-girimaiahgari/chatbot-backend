const express = require("express");
const path = require("path");

function requireClientToken(req, res, next) {
  const token = req.query.token || req.headers["x-client-token"] || req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({ error: "Client token is required" });
  }

  req.clientToken = token;
  next();
}

async function resolveTenantByToken(supabase, token) {
  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .eq("client_dashboard_token", token)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

function formatDate(value) {
  return value || null;
}

async function getConversationSessions(supabase, tenantId) {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("session_id, role, content, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(300);

  if (error) {
    throw error;
  }

  const grouped = new Map();
  for (const row of data || []) {
    if (!grouped.has(row.session_id)) {
      grouped.set(row.session_id, []);
    }
    grouped.get(row.session_id).push(row);
  }

  return Array.from(grouped.entries()).map(([sessionId, rows]) => {
    const ordered = [...rows].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const lastRow = ordered[ordered.length - 1];
    const lastUserRow = [...ordered].reverse().find((row) => row.role === "user") || null;
    const lastAssistantRow = [...ordered].reverse().find((row) => row.role === "assistant") || null;

    return {
      session_id: sessionId,
      messages_count: ordered.length,
      last_activity_at: lastRow?.created_at || null,
      latest_customer_message: lastUserRow?.content || null,
      latest_assistant_reply: lastAssistantRow?.content || null
    };
  }).sort((a, b) => new Date(b.last_activity_at || 0) - new Date(a.last_activity_at || 0));
}

async function getClientOverview(supabase, tenant) {
  const [productsResult, faqsResult, handoffsResult, pendingHandoffsResult, conversationSessions] = await Promise.all([
    supabase.from("products").select("*", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    supabase.from("faqs").select("*", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    supabase.from("handoff_requests").select("*", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    supabase.from("handoff_requests").select("*", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("status", "pending"),
    getConversationSessions(supabase, tenant.id)
  ]);

  const activeConversations = conversationSessions.filter((session) => {
    if (!session.last_activity_at) {
      return false;
    }

    const lastActivity = new Date(session.last_activity_at).getTime();
    return Date.now() - lastActivity < 1000 * 60 * 60 * 24 * 7;
  }).length;

  return {
    tenant: {
      id: tenant.id,
      business_name: tenant.business_name,
      plan: tenant.plan,
      instagram_connected: Boolean(tenant.ig_business_id && tenant.ig_access_token),
      whatsapp_connected: Boolean(tenant.wa_phone_number_id && tenant.wa_access_token)
    },
    metrics: {
      total_conversations: conversationSessions.length,
      active_conversations: activeConversations,
      leads_generated: handoffsResult.count || 0,
      pending_handoffs: pendingHandoffsResult.count || 0,
      products_count: productsResult.count || 0,
      faqs_count: faqsResult.count || 0
    },
    latest_conversations: conversationSessions.slice(0, 10)
  };
}

async function getClientLeads(supabase, tenantId) {
  const { data, error } = await supabase
    .from("handoff_requests")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    throw error;
  }

  return data || [];
}

async function getClientPerformance(supabase, tenantId) {
  const [conversationSessions, handoffs, products] = await Promise.all([
    getConversationSessions(supabase, tenantId),
    getClientLeads(supabase, tenantId),
    supabase
      .from("products")
      .select("name, price, category")
      .eq("tenant_id", tenantId)
  ]);

  const productMentions = {};
  for (const session of conversationSessions) {
    const content = ((session.latest_customer_message || "") + " " + (session.latest_assistant_reply || "")).toLowerCase();
    for (const product of products.data || []) {
      if (content.includes(String(product.name || "").toLowerCase())) {
        productMentions[product.name] = (productMentions[product.name] || 0) + 1;
      }
    }
  }

  const topProducts = Object.entries(productMentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, mentions]) => ({ name, mentions }));

  return {
    total_conversations: conversationSessions.length,
    leads_generated: handoffs.length,
    top_products: topProducts,
    handoff_rate: conversationSessions.length === 0
      ? 0
      : Number(((handoffs.length / conversationSessions.length) * 100).toFixed(1))
  };
}

function buildClientPortalHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DigiMaya Client Portal</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f5fb;
      --panel: #ffffff;
      --line: #e9e4f3;
      --text: #282338;
      --muted: #7a738f;
      --brand: #7d69d5;
      --brand-soft: #efeafe;
      --shadow: 0 18px 48px rgba(36, 28, 70, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Inter", ui-sans-serif, system-ui, sans-serif;
      background: radial-gradient(circle at top left, #f4ecff 0%, #fbfaff 35%, var(--bg) 100%);
      color: var(--text);
    }
    .layout {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
    }
    .sidebar {
      padding: 26px 22px;
      background: linear-gradient(180deg, #6f62a1 0%, #8f86b1 100%);
      color: white;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .brand {
      width: 84px;
      height: 84px;
      border-radius: 24px;
      display: grid;
      place-items: center;
      background: linear-gradient(145deg, #ffffff 0%, #f0ebff 45%, #dbd3f8 100%);
      color: #4c4269;
      font-size: 36px;
      font-weight: 900;
      letter-spacing: -0.08em;
      box-shadow: 0 14px 36px rgba(41, 31, 89, 0.18);
    }
    .sidebar h1, .topbar h2, h3 { margin: 0; }
    .eyebrow {
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 11px;
      font-weight: 700;
      color: rgba(255,255,255,0.72);
    }
    .sidebar p {
      margin: 10px 0 0;
      color: rgba(255,255,255,0.84);
      line-height: 1.5;
    }
    .nav { display: grid; gap: 8px; }
    .nav button {
      border: 0;
      border-radius: 14px;
      background: rgba(255,255,255,0.12);
      color: white;
      padding: 12px 14px;
      text-align: left;
      cursor: pointer;
    }
    .nav button.active { background: rgba(255,255,255,0.22); }
    .side-card {
      border-radius: 18px;
      padding: 14px;
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.14);
    }
    .side-card h4 { margin: 0 0 8px; }
    .main {
      padding: 28px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 18px;
    }
    .topbar h2 {
      margin-top: 6px;
      font-size: 28px;
    }
    .refresh-btn {
      border: 0;
      border-radius: 14px;
      background: linear-gradient(135deg, #8b7ad9 0%, #7464c7 100%);
      color: white;
      padding: 12px 16px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 12px 24px rgba(116, 100, 199, 0.2);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin-bottom: 18px;
    }
    .card, .metric {
      background: var(--panel);
      border: 1px solid rgba(17,24,39,0.04);
      border-radius: 22px;
      box-shadow: var(--shadow);
    }
    .metric {
      padding: 18px;
    }
    .metric .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .metric .value {
      margin-top: 8px;
      font-size: 30px;
      font-weight: 800;
    }
    .metric .note {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
    }
    .panel { display: none; }
    .panel.visible { display: block; }
    .card { padding: 18px; }
    .section-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 12px 10px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    tr:last-child td { border-bottom: 0; }
    .empty {
      min-height: 160px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 16px;
      text-align: center;
      padding: 20px;
    }
    .support-cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-top: 10px;
      padding: 12px 14px;
      border-radius: 14px;
      background: rgba(255,255,255,0.14);
      color: white;
      text-decoration: none;
      font-weight: 700;
    }
    .error {
      display: none;
      margin-bottom: 18px;
      border-radius: 16px;
      padding: 14px 16px;
      background: #fee2e2;
      color: #991b1b;
      white-space: pre-wrap;
    }
    .error.visible { display: block; }
    @media (max-width: 980px) {
      .layout { grid-template-columns: 1fr; }
      .section-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand">DM</div>
      <div class="eyebrow">DigiMaya Client Portal</div>
      <h1 id="tenant-name">Your Business</h1>
      <p>See the conversations, leads, and product interest DigiMaya is generating for your business.</p>

      <div class="nav">
        <button class="active" data-panel="overview">Overview</button>
        <button data-panel="conversations">Conversations</button>
        <button data-panel="leads">Leads</button>
        <button data-panel="performance">Performance</button>
      </div>

      <div class="side-card">
        <div class="eyebrow">Need Help?</div>
        <h4>Reach the DigiMaya team</h4>
        <p>If you notice an issue or need changes, contact us directly and we’ll help quickly.</p>
        <a id="support-link" class="support-cta" href="mailto:inthepursuit.0112@gmail.com?subject=DigiMaya%20Client%20Support">Contact Support</a>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <div class="eyebrow">Business Clarity View</div>
          <h2>Your DigiMaya Dashboard</h2>
        </div>
        <button id="refresh" class="refresh-btn">Refresh</button>
      </header>

      <div id="error" class="error"></div>

      <section class="panel visible" data-panel="overview">
        <div id="metrics" class="grid"></div>
        <div class="section-grid">
          <div class="card">
            <h3>Latest Conversations</h3>
            <div id="overview-conversations"></div>
          </div>
          <div class="card">
            <h3>Top Product Interest</h3>
            <div id="overview-performance"></div>
          </div>
        </div>
      </section>

      <section class="panel" data-panel="conversations">
        <div class="card">
          <h3>Recent Conversations</h3>
          <div id="conversations-table"></div>
        </div>
      </section>

      <section class="panel" data-panel="leads">
        <div class="card">
          <h3>Generated Leads</h3>
          <div id="leads-table"></div>
        </div>
      </section>

      <section class="panel" data-panel="performance">
        <div class="card">
          <h3>Performance Review</h3>
          <div id="performance-table"></div>
        </div>
      </section>
    </main>
  </div>

  <script>
    (function () {
      const token = new URLSearchParams(window.location.search).get("token");
      const headers = token ? { "x-client-token": token } : {};

      const state = {
        overview: null,
        conversations: [],
        leads: [],
        performance: null
      };

      function setError(message) {
        const el = document.getElementById("error");
        if (!message) {
          el.classList.remove("visible");
          el.textContent = "";
          return;
        }
        el.classList.add("visible");
        el.textContent = message;
      }

      function fetchJson(path) {
        return fetch(path, { headers }).then(async (response) => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(payload.error || ("Request failed: " + response.status));
          }
          return payload;
        });
      }

      function formatDate(value) {
        if (!value) return "—";
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
      }

      function buildTable(targetId, rows, columns, emptyMessage) {
        const target = document.getElementById(targetId);
        if (!rows || rows.length === 0) {
          target.innerHTML = '<div class="empty">' + emptyMessage + '</div>';
          return;
        }

        target.innerHTML = '<table><thead><tr>' +
          columns.map((column) => '<th>' + column.label + '</th>').join("") +
          '</tr></thead><tbody>' +
          rows.map((row) => '<tr>' + columns.map((column) => '<td>' + column.render(row) + '</td>').join("") + '</tr>').join("") +
          '</tbody></table>';
      }

      function renderOverview() {
        const metrics = state.overview.metrics;
        document.getElementById("tenant-name").textContent = state.overview.tenant.business_name;

        const cards = [
          ["Conversations", metrics.total_conversations, "Customer conversations tracked for your business"],
          ["Active Conversations", metrics.active_conversations, "Conversations active in the last 7 days"],
          ["Leads Generated", metrics.leads_generated, "Customers who reached a handoff or lead stage"],
          ["Pending Handoffs", metrics.pending_handoffs, "Leads waiting for your team"],
          ["Products", metrics.products_count, "Products available in your catalog"],
          ["FAQs", metrics.faqs_count, "FAQ entries powering DigiMaya replies"]
        ];

        document.getElementById("metrics").innerHTML = cards.map((card) => {
          return '<div class="metric"><div class="label">' + card[0] + '</div><div class="value">' + card[1] + '</div><div class="note">' + card[2] + '</div></div>';
        }).join("");

        buildTable(
          "overview-conversations",
          state.overview.latest_conversations,
          [
            { label: "Session", render: (row) => row.session_id },
            { label: "Latest Customer Message", render: (row) => row.latest_customer_message || "—" },
            { label: "Last Activity", render: (row) => formatDate(row.last_activity_at) }
          ],
          "No tenant-scoped conversation history yet."
        );

        const topProducts = state.performance.top_products || [];
        buildTable(
          "overview-performance",
          topProducts,
          [
            { label: "Product", render: (row) => row.name },
            { label: "Mentions", render: (row) => row.mentions }
          ],
          "No product trend data yet."
        );
      }

      function renderConversations() {
        buildTable(
          "conversations-table",
          state.conversations,
          [
            { label: "Session", render: (row) => row.session_id },
            { label: "Customer", render: (row) => row.latest_customer_message || "—" },
            { label: "DigiMaya Reply", render: (row) => row.latest_assistant_reply || "—" },
            { label: "Messages", render: (row) => row.messages_count },
            { label: "Last Activity", render: (row) => formatDate(row.last_activity_at) }
          ],
          "No tenant-scoped conversations yet."
        );
      }

      function renderLeads() {
        buildTable(
          "leads-table",
          state.leads,
          [
            { label: "Date", render: (row) => formatDate(row.created_at) },
            { label: "Customer", render: (row) => row.customer_name || row.session_id || "—" },
            { label: "Interest", render: (row) => row.product_interest || "—" },
            { label: "Contact Method", render: (row) => row.contact_method || "—" },
            { label: "Contact", render: (row) => row.contact_detail || "—" },
            { label: "Status", render: (row) => row.status || "—" }
          ],
          "No leads captured yet."
        );
      }

      function renderPerformance() {
        buildTable(
          "performance-table",
          [
            { metric: "Total Conversations", value: state.performance.total_conversations },
            { metric: "Leads Generated", value: state.performance.leads_generated },
            { metric: "Handoff Rate", value: state.performance.handoff_rate + "%" }
          ].concat((state.performance.top_products || []).map((row) => ({
            metric: "Top Product: " + row.name,
            value: row.mentions + " mentions"
          }))),
          [
            { label: "Metric", render: (row) => row.metric },
            { label: "Value", render: (row) => row.value }
          ],
          "No performance data yet."
        );
      }

      async function loadAll() {
        try {
          setError("");
          const [overview, conversations, leads, performance] = await Promise.all([
            fetchJson("/client/overview"),
            fetchJson("/client/conversations"),
            fetchJson("/client/leads"),
            fetchJson("/client/performance")
          ]);

          state.overview = overview;
          state.conversations = conversations.conversations || [];
          state.leads = leads.leads || [];
          state.performance = performance.performance || {
            total_conversations: 0,
            leads_generated: 0,
            top_products: [],
            handoff_rate: 0
          };

          renderOverview();
          renderConversations();
          renderLeads();
          renderPerformance();
        } catch (error) {
          setError(error.message + "\\n\\nOpen the portal with ?token=YOUR_CLIENT_DASHBOARD_TOKEN");
        }
      }

      document.querySelectorAll(".nav button").forEach((button) => {
        button.addEventListener("click", function () {
          document.querySelectorAll(".nav button").forEach((item) => item.classList.remove("active"));
          button.classList.add("active");
          document.querySelectorAll(".panel").forEach((panel) => {
            panel.classList.toggle("visible", panel.dataset.panel === button.dataset.panel);
          });
        });
      });

      document.getElementById("refresh").addEventListener("click", loadAll);
      loadAll();
    })();
  </script>
</body>
</html>`;
}

function createClientPortalRouter({ supabase }) {
  const router = express.Router();
  const portalHtmlPath = path.join(__dirname, "client-portal.html");

  router.get("/", (req, res) => {
    res.sendFile(portalHtmlPath);
  });

  router.use(requireClientToken);

  router.use(async (req, res, next) => {
    try {
      const tenant = await resolveTenantByToken(supabase, req.clientToken);
      if (!tenant) {
        return res.status(401).json({ error: "Invalid client token" });
      }

      req.tenant = tenant;
      next();
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/overview", async (req, res) => {
    try {
      const payload = await getClientOverview(supabase, req.tenant);
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/conversations", async (req, res) => {
    try {
      const conversations = await getConversationSessions(supabase, req.tenant.id);
      res.json({ conversations: conversations.slice(0, 100) });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/leads", async (req, res) => {
    try {
      const leads = await getClientLeads(supabase, req.tenant.id);
      res.json({ leads });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/performance", async (req, res) => {
    try {
      const performance = await getClientPerformance(supabase, req.tenant.id);
      res.json({ performance });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  createClientPortalRouter
};
