const crypto = require("crypto");
const express = require("express");

function getClientPortalSecret() {
  return process.env.CLIENT_PORTAL_SECRET || process.env.ADMIN_API_TOKEN || process.env.VERIFY_TOKEN || "digimaya_client_portal_dev_secret";
}

function createRandomClientDashboardToken() {
  return `dm_client_${crypto.randomBytes(18).toString("hex")}`;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const iterations = 120000;
  const digest = crypto.pbkdf2Sync(password, salt, iterations, 64, "sha512").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${digest}`;
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash || !passwordHash.startsWith("pbkdf2$")) {
    return false;
  }

  const parts = passwordHash.split("$");
  if (parts.length !== 4) {
    return false;
  }

  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expectedDigest = parts[3];
  const actualDigest = crypto.pbkdf2Sync(password, salt, iterations, 64, "sha512").toString("hex");

  return crypto.timingSafeEqual(Buffer.from(actualDigest, "hex"), Buffer.from(expectedDigest, "hex"));
}

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function signClientSession(tenant) {
  const payload = {
    tenant_id: tenant.id,
    owner_email: tenant.owner_email || "",
    exp: Date.now() + (1000 * 60 * 60 * 24 * 14)
  };

  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = encodeBase64Url(
    crypto.createHmac("sha256", getClientPortalSecret()).update(encodedPayload).digest()
  );

  return `dmc_${encodedPayload}.${signature}`;
}

function verifyClientSession(token) {
  if (!token || !token.startsWith("dmc_")) {
    return null;
  }

  const raw = token.slice(4);
  const [encodedPayload, signature] = raw.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = encodeBase64Url(
    crypto.createHmac("sha256", getClientPortalSecret()).update(encodedPayload).digest()
  );

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(encodedPayload));
    if (!payload.exp || payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch (error) {
    return null;
  }
}
function requireClientToken(req, res, next) {
  const token = req.query.token || req.headers["x-client-token"] || req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({ error: "Client token is required" });
  }

  req.clientToken = token;
  next();
}

async function resolveTenantByToken(supabase, token) {
  const session = verifyClientSession(token);
  if (session?.tenant_id) {
    const { data, error } = await supabase
      .from("tenants")
      .select("*")
      .eq("id", session.tenant_id)
      .maybeSingle();

    if (error) {
      throw error;
    }

    return data;
  }

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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function safeText(value) {
  return String(value || "").trim();
}

function buildDefaultOffHoursReply(tenant) {
  return tenant.off_hours_reply || "Our team is currently offline, but DigiMaya has noted your message and we’ll get back to you as soon as we’re available.";
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
      owner_name: tenant.owner_name || null,
      owner_email: tenant.owner_email || null,
      plan: tenant.plan,
      timezone: tenant.timezone || null,
      business_category: tenant.business_category || null,
      facebook_page_name: tenant.facebook_page_name || null,
      instagram_connection_status: tenant.instagram_connection_status || "not_started",
      connect_instagram_requested: Boolean(tenant.connect_instagram_requested),
      connect_instagram_notes: tenant.connect_instagram_notes || null,
      onboarding_status: tenant.onboarding_status || "signup_pending",
      instagram_connected: Boolean(tenant.ig_business_id && tenant.ig_access_token),
      whatsapp_connected: Boolean(tenant.wa_phone_number_id && tenant.wa_access_token),
      response_window_start: tenant.response_window_start || null,
      response_window_end: tenant.response_window_end || null,
      lead_contact_email: tenant.lead_contact_email || null,
      lead_contact_phone: tenant.lead_contact_phone || null,
      preferred_contact_method: tenant.preferred_contact_method || null,
      off_hours_reply: buildDefaultOffHoursReply(tenant)
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

async function getClientSessionPayload(supabase, tenant) {
  const overview = await getClientOverview(supabase, tenant);
  const metrics = overview.metrics;

  return {
    authenticated: true,
    tenant: overview.tenant,
    onboarding: {
      status: overview.tenant.onboarding_status,
      profile_completed: Boolean(tenant.owner_name && tenant.owner_email && tenant.business_name),
      instagram_setup_started: Boolean(tenant.instagram_username || tenant.facebook_page_name || tenant.connect_instagram_requested),
      instagram_connected: Boolean(tenant.ig_business_id && tenant.ig_access_token),
      hours_completed: Boolean(tenant.response_window_start && tenant.response_window_end),
      catalog_ready: metrics.products_count > 0,
      faq_ready: metrics.faqs_count > 0,
      launch_ready: metrics.products_count > 0 && metrics.faqs_count > 0 && Boolean(tenant.response_window_start && tenant.response_window_end)
    },
    metrics
  };
}

async function createTenantAccount(supabase, payload) {
  const ownerEmail = normalizeEmail(payload.owner_email);
  const existingTenant = await supabase
    .from("tenants")
    .select("id")
    .eq("owner_email", ownerEmail)
    .maybeSingle();

  if (existingTenant.error) {
    throw existingTenant.error;
  }

  if (existingTenant.data) {
    return { error: "An account with this email already exists", status: 409 };
  }

  const insertPayload = {
    business_name: safeText(payload.business_name),
    owner_name: safeText(payload.owner_name),
    owner_email: ownerEmail,
    password_hash: hashPassword(payload.password),
    plan: "starter",
    active: true,
    timezone: safeText(payload.timezone) || "Asia/Kolkata",
    business_category: safeText(payload.business_category),
    onboarding_status: "profile_pending",
    preferred_contact_method: "email",
    lead_contact_email: ownerEmail,
    client_dashboard_token: createRandomClientDashboardToken()
  };

  const { data, error } = await supabase
    .from("tenants")
    .insert(insertPayload)
    .select("*")
    .single();

  if (error) {
    throw error;
  }

  return { data, status: 201 };
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
  const supportEmail = process.env.ALERT_EMAIL || "inthepursuit.0112@gmail.com";
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
    .auth-shell {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 28px;
    }
    .auth-card {
      width: min(960px, 100%);
      display: grid;
      grid-template-columns: 1.05fr 1fr;
      gap: 0;
      background: rgba(255,255,255,0.88);
      border: 1px solid rgba(125, 105, 213, 0.14);
      border-radius: 28px;
      overflow: hidden;
      box-shadow: 0 28px 70px rgba(54, 41, 101, 0.14);
      backdrop-filter: blur(16px);
    }
    .auth-intro {
      padding: 34px;
      background: linear-gradient(180deg, #7666bf 0%, #9088b5 100%);
      color: white;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .auth-intro h1 {
      margin: 0;
      font-size: 34px;
      line-height: 1.06;
      letter-spacing: -0.04em;
    }
    .auth-intro p {
      margin: 0;
      color: rgba(255,255,255,0.84);
      line-height: 1.6;
    }
    .auth-points {
      display: grid;
      gap: 10px;
      margin-top: auto;
    }
    .auth-points div {
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.14);
    }
    .auth-forms {
      padding: 30px;
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .auth-tabs {
      display: inline-flex;
      padding: 5px;
      border-radius: 14px;
      background: #f1ecfa;
      width: fit-content;
    }
    .auth-tabs button {
      border: 0;
      background: transparent;
      padding: 10px 14px;
      border-radius: 10px;
      color: var(--muted);
      font-weight: 700;
      cursor: pointer;
    }
    .auth-tabs button.active {
      background: white;
      color: var(--text);
      box-shadow: 0 8px 16px rgba(74, 59, 129, 0.08);
    }
    .auth-panel {
      display: none;
      gap: 12px;
    }
    .auth-panel.visible {
      display: grid;
    }
    .field-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .field {
      display: grid;
      gap: 8px;
    }
    .field.full {
      grid-column: 1 / -1;
    }
    label {
      font-size: 13px;
      font-weight: 700;
      color: #4b4265;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid #ddd6f0;
      border-radius: 14px;
      padding: 12px 14px;
      background: white;
      color: var(--text);
      font: inherit;
    }
    textarea {
      min-height: 110px;
      resize: vertical;
    }
    .primary-btn, .secondary-btn {
      border: 0;
      border-radius: 14px;
      padding: 12px 16px;
      font-weight: 700;
      cursor: pointer;
    }
    .primary-btn {
      background: linear-gradient(135deg, #8b7ad9 0%, #7464c7 100%);
      color: white;
      box-shadow: 0 12px 24px rgba(116, 100, 199, 0.2);
    }
    .secondary-btn {
      background: #f2eefb;
      color: #4b4265;
    }
    .muted-note {
      font-size: 13px;
      color: var(--muted);
      line-height: 1.5;
    }
    .auth-message {
      display: none;
      border-radius: 14px;
      padding: 12px 14px;
      font-size: 14px;
      line-height: 1.5;
    }
    .auth-message.visible {
      display: block;
    }
    .auth-message.error {
      background: #fee2e2;
      color: #991b1b;
    }
    .auth-message.success {
      background: #dcfce7;
      color: #166534;
    }
    .layout {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 280px minmax(0, 1fr);
    }
    .layout.hidden, .auth-shell.hidden, .onboarding-shell.hidden {
      display: none;
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
    .onboarding-shell {
      min-height: 100vh;
      padding: 28px;
    }
    .onboarding-wrap {
      max-width: 1180px;
      margin: 0 auto;
      display: grid;
      gap: 18px;
    }
    .onboarding-hero {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 18px;
    }
    .hero-card {
      background: var(--panel);
      border: 1px solid rgba(17,24,39,0.04);
      border-radius: 24px;
      box-shadow: var(--shadow);
      padding: 22px;
    }
    .hero-card h2, .hero-card h3 {
      margin: 0;
    }
    .hero-card p {
      color: var(--muted);
      line-height: 1.6;
    }
    .checklist {
      display: grid;
      gap: 10px;
      margin-top: 16px;
    }
    .checklist .item {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 14px;
      border-radius: 14px;
      background: var(--brand-soft);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 700;
      background: #ede9fe;
      color: #5b46b1;
    }
    .onboarding-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }
    .inline-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 700;
      background: #efeafe;
      color: #5b46b1;
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
      .auth-card, .onboarding-hero, .onboarding-grid {
        grid-template-columns: 1fr;
      }
      .layout { grid-template-columns: 1fr; }
      .section-grid { grid-template-columns: 1fr; }
      .field-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <section id="auth-shell" class="auth-shell">
    <div class="auth-card">
      <div class="auth-intro">
        <div class="brand">DM</div>
        <div class="eyebrow">DigiMaya Client Setup</div>
        <h1>Turn your DMs into organised leads.</h1>
        <p>Create your DigiMaya account, connect your business details, set your response hours, and start feeding MAYA your catalog and FAQs.</p>
        <div class="auth-points">
          <div>Clients sign up with their business email and password.</div>
          <div>Onboarding collects brand details, response windows, products, and FAQs.</div>
          <div>DigiMaya respects after-hours rules and promises follow-up instead of pretending your team is awake.</div>
        </div>
      </div>

      <div class="auth-forms">
        <div class="auth-tabs">
          <button id="signup-tab" class="active" type="button">Sign Up</button>
          <button id="login-tab" type="button">Log In</button>
        </div>

        <div id="auth-message" class="auth-message"></div>

        <form id="signup-panel" class="auth-panel visible">
          <div class="field-grid">
            <div class="field">
              <label for="signup-business-name">Business Name</label>
              <input id="signup-business-name" name="business_name" placeholder="Mad4Madams" required />
            </div>
            <div class="field">
              <label for="signup-owner-name">Owner Name</label>
              <input id="signup-owner-name" name="owner_name" placeholder="Priya Sharma" required />
            </div>
            <div class="field">
              <label for="signup-owner-email">Business Email</label>
              <input id="signup-owner-email" type="email" name="owner_email" placeholder="owner@brand.com" required />
            </div>
            <div class="field">
              <label for="signup-password">Password</label>
              <input id="signup-password" type="password" name="password" placeholder="Choose a secure password" required />
            </div>
            <div class="field">
              <label for="signup-category">Business Category</label>
              <input id="signup-category" name="business_category" placeholder="Jewelry, Sarees, Fashion" />
            </div>
            <div class="field">
              <label for="signup-timezone">Timezone</label>
              <input id="signup-timezone" name="timezone" placeholder="Asia/Kolkata" value="Asia/Kolkata" />
            </div>
          </div>
          <button class="primary-btn" type="submit">Create DigiMaya Account</button>
          <div class="muted-note">This creates the tenant account, your client login, and your private DigiMaya workspace.</div>
        </form>

        <form id="login-panel" class="auth-panel">
          <div class="field-grid">
            <div class="field full">
              <label for="login-email">Business Email</label>
              <input id="login-email" type="email" name="owner_email" placeholder="owner@brand.com" required />
            </div>
            <div class="field full">
              <label for="login-password">Password</label>
              <input id="login-password" type="password" name="password" placeholder="Enter your password" required />
            </div>
          </div>
          <button class="primary-btn" type="submit">Log In to DigiMaya</button>
          <div class="muted-note">After login, you’ll land in onboarding until your brand profile, hours, catalog, and FAQs are ready.</div>
        </form>
      </div>
    </div>
  </section>

  <section id="onboarding-shell" class="onboarding-shell hidden">
    <div class="onboarding-wrap">
      <div class="onboarding-hero">
        <div class="hero-card">
          <div class="eyebrow">DigiMaya Setup</div>
          <h2 id="onboarding-business-name">Finish your onboarding</h2>
          <p>Before MAYA goes fully live, fill in your business profile, tell us when your team is available to respond to hot leads, and add your products and FAQs.</p>
          <div id="onboarding-checklist" class="checklist"></div>
        </div>
        <div class="hero-card">
          <div class="eyebrow">Current Rule</div>
          <h3>After-hours behavior</h3>
          <p id="current-off-hours-copy">DigiMaya will collect the lead and promise a follow-up when your team is available.</p>
          <div class="inline-actions">
            <span id="current-onboarding-status" class="status-pill">Setup in progress</span>
          </div>
        </div>
      </div>

      <div id="onboarding-message" class="auth-message"></div>

      <div class="onboarding-grid">
        <form id="business-profile-form" class="hero-card">
          <div class="eyebrow">Step 1</div>
          <h3>Business Profile</h3>
          <p>Tell DigiMaya who should receive leads and what kind of business you run.</p>
          <div class="field-grid">
            <div class="field">
              <label for="profile-business-name">Business Name</label>
              <input id="profile-business-name" name="business_name" required />
            </div>
            <div class="field">
              <label for="profile-owner-name">Owner Name</label>
              <input id="profile-owner-name" name="owner_name" required />
            </div>
            <div class="field">
              <label for="profile-owner-email">Owner Email</label>
              <input id="profile-owner-email" type="email" name="owner_email" required />
            </div>
            <div class="field">
              <label for="profile-timezone">Timezone</label>
              <input id="profile-timezone" name="timezone" placeholder="Asia/Kolkata" />
            </div>
            <div class="field">
              <label for="profile-category">Business Category</label>
              <input id="profile-category" name="business_category" placeholder="Jewelry, Sarees, Fashion" />
            </div>
            <div class="field">
              <label for="profile-instagram">Instagram Username</label>
              <input id="profile-instagram" name="instagram_username" placeholder="@yourbrand" />
            </div>
            <div class="field">
              <label for="profile-facebook-page">Facebook Page Name</label>
              <input id="profile-facebook-page" name="facebook_page_name" placeholder="Your Facebook Page" />
            </div>
            <div class="field">
              <label for="profile-instagram-status">Instagram Connection Status</label>
              <select id="profile-instagram-status" name="instagram_connection_status">
                <option value="not_started">Not started</option>
                <option value="details_added">Details added</option>
                <option value="pending_support">Need DigiMaya help</option>
                <option value="connected">Connected</option>
              </select>
            </div>
            <div class="field">
              <label for="profile-lead-email">Lead Contact Email</label>
              <input id="profile-lead-email" type="email" name="lead_contact_email" placeholder="sales@brand.com" />
            </div>
            <div class="field">
              <label for="profile-lead-phone">Lead Contact Phone</label>
              <input id="profile-lead-phone" name="lead_contact_phone" placeholder="+91..." />
            </div>
            <div class="field full">
              <label for="profile-connect-instagram">Do you want DigiMaya to help connect Instagram?</label>
              <select id="profile-connect-instagram" name="connect_instagram_requested">
                <option value="false">No, not yet</option>
                <option value="true">Yes, please help me connect it</option>
              </select>
            </div>
            <div class="field full">
              <label for="profile-connect-notes">Instagram setup notes</label>
              <textarea id="profile-connect-notes" name="connect_instagram_notes" placeholder="Share anything important here, like your Instagram handle, Facebook Page name, or whether you want a guided setup call."></textarea>
            </div>
            <div class="field full">
              <label for="profile-contact-method">Preferred Contact Method</label>
              <select id="profile-contact-method" name="preferred_contact_method">
                <option value="email">Email</option>
                <option value="phone">Phone</option>
                <option value="whatsapp">WhatsApp</option>
              </select>
            </div>
          </div>
          <button class="primary-btn" type="submit">Save Business Profile</button>
        </form>

        <form id="availability-form" class="hero-card">
          <div class="eyebrow">Step 2</div>
          <h3>Availability Rules</h3>
          <p>Tell DigiMaya when your team normally responds so hot leads get the right promise instead of a fake “we’re online now” response.</p>
          <div class="field-grid">
            <div class="field">
              <label for="hours-start">Start Time</label>
              <input id="hours-start" type="time" name="response_window_start" required />
            </div>
            <div class="field">
              <label for="hours-end">End Time</label>
              <input id="hours-end" type="time" name="response_window_end" required />
            </div>
            <div class="field full">
              <label for="hours-reply">After-hours Lead Reply</label>
              <textarea id="hours-reply" name="off_hours_reply" placeholder="Thanks for reaching out. Our team is currently offline, but DigiMaya has shared your interest and we’ll get back to you as soon as we’re available."></textarea>
            </div>
          </div>
          <button class="primary-btn" type="submit">Save Availability Rules</button>
        </form>

        <form id="product-form" class="hero-card">
          <div class="eyebrow">Step 3</div>
          <h3>Add Product</h3>
          <p>Add products one by one for now. We can add CSV import later.</p>
          <div class="field-grid">
            <div class="field">
              <label for="product-name">Product Name</label>
              <input id="product-name" name="name" required />
            </div>
            <div class="field">
              <label for="product-category">Category</label>
              <input id="product-category" name="category" placeholder="Fashion - Saree" />
            </div>
            <div class="field">
              <label for="product-price">Selling Price</label>
              <input id="product-price" type="number" step="0.01" name="price" required />
            </div>
            <div class="field">
              <label for="product-regular-price">Regular Price</label>
              <input id="product-regular-price" type="number" step="0.01" name="regular_price" />
            </div>
            <div class="field">
              <label for="product-color">Color</label>
              <input id="product-color" name="color" placeholder="Green, Yellow" />
            </div>
            <div class="field">
              <label for="product-link">Product URL</label>
              <input id="product-link" name="product_url" placeholder="https://..." />
            </div>
            <div class="field full">
              <label for="product-description">Description</label>
              <textarea id="product-description" name="description"></textarea>
            </div>
          </div>
          <button class="primary-btn" type="submit">Add Product</button>
        </form>

        <form id="faq-form" class="hero-card">
          <div class="eyebrow">Step 4</div>
          <h3>Add FAQ</h3>
          <p>Feed DigiMaya the questions you answer repeatedly so the assistant can reply like your team would.</p>
          <div class="field-grid">
            <div class="field full">
              <label for="faq-question">Question</label>
              <input id="faq-question" name="question" required />
            </div>
            <div class="field full">
              <label for="faq-answer">Answer</label>
              <textarea id="faq-answer" name="answer" required></textarea>
            </div>
          </div>
          <button class="primary-btn" type="submit">Add FAQ</button>
        </form>
      </div>

      <div class="hero-card">
        <div class="eyebrow">Final Step</div>
        <h3>When you’re ready</h3>
        <p>Once your business profile, hours, products, and FAQs are in place, DigiMaya can treat your workspace as launch-ready.</p>
        <div class="inline-actions">
          <button id="mark-launch-ready" class="primary-btn" type="button">Mark Launch Ready</button>
          <button id="go-to-dashboard" class="secondary-btn" type="button">Open Client Dashboard</button>
        </div>
      </div>
    </div>
  </section>

  <div id="app-shell" class="layout hidden">
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
        <a id="support-link" class="support-cta" href="mailto:${supportEmail}?subject=DigiMaya%20Client%20Support">Contact Support</a>
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
      const storageKey = "digimaya_client_portal_token";
      const queryToken = new URLSearchParams(window.location.search).get("token");
      let token = queryToken || window.localStorage.getItem(storageKey) || "";

      const state = {
        session: null,
        overview: null,
        conversations: [],
        leads: [],
        performance: null
      };

      function getAuthHeaders() {
        return token ? { "x-client-token": token } : {};
      }

      function setToken(nextToken) {
        token = nextToken || "";
        if (token) {
          window.localStorage.setItem(storageKey, token);
        } else {
          window.localStorage.removeItem(storageKey);
        }
      }

      function showShell(name) {
        document.getElementById("auth-shell").classList.toggle("hidden", name !== "auth");
        document.getElementById("onboarding-shell").classList.toggle("hidden", name !== "onboarding");
        document.getElementById("app-shell").classList.toggle("hidden", name !== "dashboard");
      }

      function setAuthMessage(message, type) {
        const el = document.getElementById("auth-message");
        if (!message) {
          el.className = "auth-message";
          el.textContent = "";
          return;
        }
        el.className = "auth-message visible " + (type || "error");
        el.textContent = message;
      }

      function setOnboardingMessage(message, type) {
        const el = document.getElementById("onboarding-message");
        if (!message) {
          el.className = "auth-message";
          el.textContent = "";
          return;
        }
        el.className = "auth-message visible " + (type || "error");
        el.textContent = message;
      }

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

      function fetchJson(path, options) {
        const requestOptions = Object.assign({}, options || {});
        requestOptions.headers = Object.assign({}, getAuthHeaders(), requestOptions.headers || {});
        return fetch(path, requestOptions).then(async (response) => {
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

      function renderOnboarding() {
        const tenant = state.session.tenant;
        const onboarding = state.session.onboarding;
        document.getElementById("onboarding-business-name").textContent = tenant.business_name || "Finish your onboarding";
        document.getElementById("current-off-hours-copy").textContent = tenant.off_hours_reply || "DigiMaya will collect the lead and promise a follow-up when your team is available.";
        document.getElementById("current-onboarding-status").textContent = onboarding.launch_ready ? "Launch ready" : "Setup in progress";

        document.getElementById("profile-business-name").value = tenant.business_name || "";
        document.getElementById("profile-owner-name").value = tenant.owner_name || "";
        document.getElementById("profile-owner-email").value = tenant.owner_email || "";
        document.getElementById("profile-timezone").value = tenant.timezone || "Asia/Kolkata";
        document.getElementById("profile-category").value = tenant.business_category || "";
        document.getElementById("profile-instagram").value = tenant.instagram_username || "";
        document.getElementById("profile-facebook-page").value = tenant.facebook_page_name || "";
        document.getElementById("profile-instagram-status").value = tenant.instagram_connection_status || "not_started";
        document.getElementById("profile-lead-email").value = tenant.lead_contact_email || "";
        document.getElementById("profile-lead-phone").value = tenant.lead_contact_phone || "";
        document.getElementById("profile-connect-instagram").value = tenant.connect_instagram_requested ? "true" : "false";
        document.getElementById("profile-connect-notes").value = tenant.connect_instagram_notes || "";
        document.getElementById("profile-contact-method").value = tenant.preferred_contact_method || "email";
        document.getElementById("hours-start").value = tenant.response_window_start || "";
        document.getElementById("hours-end").value = tenant.response_window_end || "";
        document.getElementById("hours-reply").value = tenant.off_hours_reply || "";

        const checklist = [
          ["Business profile", onboarding.profile_completed],
          ["Instagram setup started", onboarding.instagram_setup_started],
          ["Instagram connected", onboarding.instagram_connected],
          ["Availability rules", onboarding.hours_completed],
          ["At least one product", onboarding.catalog_ready],
          ["At least one FAQ", onboarding.faq_ready],
          ["Launch readiness", onboarding.launch_ready]
        ];

        document.getElementById("onboarding-checklist").innerHTML = checklist.map(function (item) {
          return '<div class="item"><span>' + item[0] + '</span><span class="badge">' + (item[1] ? "Done" : "Pending") + '</span></div>';
        }).join("");
      }

      function shouldShowOnboarding() {
        if (!state.session) return false;
        return !state.session.onboarding.launch_ready;
      }

      async function loadSession() {
        if (!token) {
          state.session = null;
          showShell("auth");
          return;
        }

        try {
          const payload = await fetchJson("/client/session");
          state.session = payload;

          if (shouldShowOnboarding()) {
            renderOnboarding();
            showShell("onboarding");
          } else {
            await loadDashboardData();
            showShell("dashboard");
          }
        } catch (error) {
          setToken("");
          state.session = null;
          setAuthMessage(error.message, "error");
          showShell("auth");
        }
      }

      async function postJson(path, body) {
        return fetchJson(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {})
        });
      }

      async function loadDashboardData() {
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

      function openTab(name) {
        document.getElementById("signup-tab").classList.toggle("active", name === "signup");
        document.getElementById("login-tab").classList.toggle("active", name === "login");
        document.getElementById("signup-panel").classList.toggle("visible", name === "signup");
        document.getElementById("login-panel").classList.toggle("visible", name === "login");
        setAuthMessage("");
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

      document.getElementById("refresh").addEventListener("click", async function () {
        try {
          await loadDashboardData();
        } catch (error) {
          setError(error.message);
        }
      });

      document.getElementById("signup-tab").addEventListener("click", function () {
        openTab("signup");
      });

      document.getElementById("login-tab").addEventListener("click", function () {
        openTab("login");
      });

      document.getElementById("signup-panel").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          setAuthMessage("");
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          const response = await postJson("/client/auth/signup", payload);
          setToken(response.token);
          setAuthMessage("Your DigiMaya account is ready. Let’s finish onboarding.", "success");
          await loadSession();
        } catch (error) {
          setAuthMessage(error.message, "error");
        }
      });

      document.getElementById("login-panel").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          setAuthMessage("");
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          const response = await postJson("/client/auth/login", payload);
          setToken(response.token);
          await loadSession();
        } catch (error) {
          setAuthMessage(error.message, "error");
        }
      });

      document.getElementById("business-profile-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          setOnboardingMessage("");
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          await postJson("/client/onboarding/profile", payload);
          setOnboardingMessage("Business profile saved.", "success");
          await loadSession();
        } catch (error) {
          setOnboardingMessage(error.message, "error");
        }
      });

      document.getElementById("availability-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          setOnboardingMessage("");
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          await postJson("/client/onboarding/availability", payload);
          setOnboardingMessage("Availability rules saved.", "success");
          await loadSession();
        } catch (error) {
          setOnboardingMessage(error.message, "error");
        }
      });

      document.getElementById("product-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          setOnboardingMessage("");
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          await postJson("/client/onboarding/catalog/product", payload);
          event.target.reset();
          setOnboardingMessage("Product added to your catalog.", "success");
          await loadSession();
        } catch (error) {
          setOnboardingMessage(error.message, "error");
        }
      });

      document.getElementById("faq-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          setOnboardingMessage("");
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          await postJson("/client/onboarding/catalog/faq", payload);
          event.target.reset();
          setOnboardingMessage("FAQ added for DigiMaya.", "success");
          await loadSession();
        } catch (error) {
          setOnboardingMessage(error.message, "error");
        }
      });

      document.getElementById("mark-launch-ready").addEventListener("click", async function () {
        try {
          setOnboardingMessage("");
          await postJson("/client/onboarding/complete");
          setOnboardingMessage("Your workspace is marked launch-ready.", "success");
          await loadSession();
        } catch (error) {
          setOnboardingMessage(error.message, "error");
        }
      });

      document.getElementById("go-to-dashboard").addEventListener("click", async function () {
        try {
          await loadDashboardData();
          showShell("dashboard");
        } catch (error) {
          setOnboardingMessage(error.message, "error");
        }
      });

      loadSession();
    })();
  </script>
</body>
</html>`;
}

function createClientPortalRouter({ supabase, resend }) {
  const router = express.Router();

  router.get("/", (req, res) => {
    res.type("html").send(buildClientPortalHtml());
  });

  router.post("/auth/signup", async (req, res) => {
    try {
      const businessName = safeText(req.body.business_name);
      const ownerName = safeText(req.body.owner_name);
      const ownerEmail = normalizeEmail(req.body.owner_email);
      const password = safeText(req.body.password);

      if (!businessName || !ownerName || !ownerEmail || !password) {
        return res.status(400).json({ error: "Business name, owner name, email, and password are required" });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: "Password should be at least 8 characters" });
      }

      const result = await createTenantAccount(supabase, req.body);
      if (result.error) {
        return res.status(result.status || 400).json({ error: result.error });
      }

      const token = signClientSession(result.data);
      res.status(result.status || 201).json({
        token,
        tenant: {
          id: result.data.id,
          business_name: result.data.business_name,
          owner_email: result.data.owner_email
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/auth/login", async (req, res) => {
    try {
      const ownerEmail = normalizeEmail(req.body.owner_email);
      const password = safeText(req.body.password);

      if (!ownerEmail || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const { data: tenant, error } = await supabase
        .from("tenants")
        .select("*")
        .eq("owner_email", ownerEmail)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!tenant || !verifyPassword(password, tenant.password_hash)) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const token = signClientSession(tenant);
      res.json({
        token,
        tenant: {
          id: tenant.id,
          business_name: tenant.business_name,
          owner_email: tenant.owner_email
        }
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
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

  router.get("/session", async (req, res) => {
    try {
      const payload = await getClientSessionPayload(supabase, req.tenant);
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/onboarding/profile", async (req, res) => {
    try {
      const requestedInstagramHelp = String(req.body.connect_instagram_requested) === "true";
      const updatePayload = {
        business_name: safeText(req.body.business_name) || req.tenant.business_name,
        owner_name: safeText(req.body.owner_name) || req.tenant.owner_name,
        owner_email: normalizeEmail(req.body.owner_email) || req.tenant.owner_email,
        timezone: safeText(req.body.timezone) || req.tenant.timezone || "Asia/Kolkata",
        business_category: safeText(req.body.business_category) || req.tenant.business_category,
        instagram_username: safeText(req.body.instagram_username) || req.tenant.instagram_username,
        facebook_page_name: safeText(req.body.facebook_page_name) || req.tenant.facebook_page_name,
        instagram_connection_status: safeText(req.body.instagram_connection_status) || req.tenant.instagram_connection_status || "details_added",
        connect_instagram_requested: requestedInstagramHelp,
        connect_instagram_notes: safeText(req.body.connect_instagram_notes) || req.tenant.connect_instagram_notes,
        lead_contact_email: normalizeEmail(req.body.lead_contact_email) || req.tenant.lead_contact_email || req.tenant.owner_email,
        lead_contact_phone: safeText(req.body.lead_contact_phone) || req.tenant.lead_contact_phone,
        preferred_contact_method: safeText(req.body.preferred_contact_method) || req.tenant.preferred_contact_method || "email",
        onboarding_status: "hours_pending"
      };

      const { data, error } = await supabase
        .from("tenants")
        .update(updatePayload)
        .eq("id", req.tenant.id)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      if (requestedInstagramHelp && !req.tenant.connect_instagram_requested && process.env.ALERT_EMAIL) {
        await resend.emails.send({
          from: "onboarding@resend.dev",
          to: process.env.ALERT_EMAIL,
          subject: `Instagram setup help requested — ${data.business_name}`,
          text: [
            `Business: ${data.business_name}`,
            `Owner: ${data.owner_name || "—"}`,
            `Email: ${data.owner_email || "—"}`,
            `Instagram: ${data.instagram_username || "—"}`,
            `Facebook Page: ${data.facebook_page_name || "—"}`,
            `Notes: ${data.connect_instagram_notes || "—"}`
          ].join("\n")
        });
      }

      res.json({ tenant: data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/onboarding/availability", async (req, res) => {
    try {
      const start = safeText(req.body.response_window_start);
      const end = safeText(req.body.response_window_end);

      if (!start || !end) {
        return res.status(400).json({ error: "Start time and end time are required" });
      }

      const { data, error } = await supabase
        .from("tenants")
        .update({
          response_window_start: start,
          response_window_end: end,
          off_hours_reply: safeText(req.body.off_hours_reply) || buildDefaultOffHoursReply(req.tenant),
          onboarding_status: "catalog_pending"
        })
        .eq("id", req.tenant.id)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res.json({ tenant: data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/onboarding/catalog/product", async (req, res) => {
    try {
      const name = safeText(req.body.name);
      const price = Number(req.body.price);

      if (!name || Number.isNaN(price)) {
        return res.status(400).json({ error: "Product name and price are required" });
      }

      const insertPayload = {
        tenant_id: req.tenant.id,
        name,
        description: safeText(req.body.description),
        price,
        regular_price: req.body.regular_price === "" || req.body.regular_price == null ? null : Number(req.body.regular_price),
        category: safeText(req.body.category),
        in_stock: true,
        sizes_in_stock: [],
        product_url: safeText(req.body.product_url),
        color: safeText(req.body.color)
      };

      const { data, error } = await supabase
        .from("products")
        .insert(insertPayload)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res.status(201).json({ product: data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/onboarding/catalog/faq", async (req, res) => {
    try {
      const question = safeText(req.body.question);
      const answer = safeText(req.body.answer);

      if (!question || !answer) {
        return res.status(400).json({ error: "Question and answer are required" });
      }

      const { data, error } = await supabase
        .from("faqs")
        .insert({
          tenant_id: req.tenant.id,
          question,
          answer
        })
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res.status(201).json({ faq: data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/onboarding/complete", async (req, res) => {
    try {
      const session = await getClientSessionPayload(supabase, req.tenant);
      const onboarding = session.onboarding;

      if (!onboarding.profile_completed || !onboarding.hours_completed || !onboarding.catalog_ready || !onboarding.faq_ready) {
        return res.status(400).json({ error: "Complete your profile, hours, products, and FAQs before marking launch-ready" });
      }

      const { data, error } = await supabase
        .from("tenants")
        .update({ onboarding_status: "launch_ready" })
        .eq("id", req.tenant.id)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res.json({ tenant: data, launch_ready: true });
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
