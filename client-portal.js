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

function normalizeCurrencyCode(value) {
  const code = String(value || "").trim().toUpperCase();
  const supported = new Set(["INR", "USD", "GBP", "AUD", "EUR", "CAD"]);
  return supported.has(code) ? code : "INR";
}

function getCurrencyConfig(code) {
  const normalized = normalizeCurrencyCode(code);
  const map = {
    INR: { code: "INR", symbol: "₹", locale: "en-IN" },
    USD: { code: "USD", symbol: "$", locale: "en-US" },
    GBP: { code: "GBP", symbol: "£", locale: "en-GB" },
    AUD: { code: "AUD", symbol: "A$", locale: "en-AU" },
    EUR: { code: "EUR", symbol: "€", locale: "en-IE" },
    CAD: { code: "CAD", symbol: "C$", locale: "en-CA" }
  };
  return map[normalized] || map.INR;
}

function formatTenantMoney(amount, currencyCode) {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    return "—";
  }

  const currency = getCurrencyConfig(currencyCode);
  const formatted = value.toLocaleString(currency.locale, {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  });

  return `${currency.symbol}${formatted}`;
}

function parseDelimitedLine(line) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function parseProductImportText(rawText) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  return lines
    .filter((line, index) => !(index === 0 && line.toLowerCase().startsWith("name,")))
    .map((line) => {
      const [name, price, category, color, productUrl, imageUrl, ...descriptionParts] = parseDelimitedLine(line);
      return {
        name: safeText(name),
        price: Number(price),
        category: safeText(category),
        color: safeText(color),
        product_url: safeText(productUrl),
        image_url: safeText(imageUrl),
        description: safeText(descriptionParts.join(", "))
      };
    })
    .filter((item) => item.name && Number.isFinite(item.price));
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
  const [productsResult, faqsResult, handoffsResult, pendingHandoffsResult, orderIntentsResult, draftOrdersResult, conversationSessions] = await Promise.all([
    supabase.from("products").select("*", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    supabase.from("faqs").select("*", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    supabase.from("handoff_requests").select("*", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    supabase.from("handoff_requests").select("*", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("status", "pending"),
    supabase.from("order_intents").select("*", { count: "exact", head: true }).eq("tenant_id", tenant.id),
    supabase.from("orders").select("*", { count: "exact", head: true }).eq("tenant_id", tenant.id),
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
      admin_connection_confirmed: Boolean(tenant.admin_connection_confirmed),
      client_connection_confirmed: Boolean(tenant.client_connection_confirmed),
      activation_status: tenant.activation_status || "setup_incomplete",
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
      order_intents_count: orderIntentsResult.count || 0,
      draft_orders_count: draftOrdersResult.count || 0,
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
      admin_connection_confirmed: Boolean(tenant.admin_connection_confirmed),
      client_connection_confirmed: Boolean(tenant.client_connection_confirmed),
      hours_completed: Boolean(tenant.response_window_start && tenant.response_window_end),
      catalog_ready: metrics.products_count > 0,
      faq_ready: metrics.faqs_count > 0,
      launch_ready: metrics.products_count > 0 && metrics.faqs_count > 0 && Boolean(tenant.response_window_start && tenant.response_window_end),
      ready_for_client_confirmation: Boolean(tenant.admin_connection_confirmed) && !tenant.client_connection_confirmed
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
    currency_code: normalizeCurrencyCode(payload.currency_code),
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
  const [handoffsResult, orderIntentsResult, ordersResult] = await Promise.all([
    supabase
      .from("handoff_requests")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("order_intents")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("orders")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(100)
  ]);

  if (handoffsResult.error) {
    throw handoffsResult.error;
  }

  if (orderIntentsResult.error) {
    throw orderIntentsResult.error;
  }

  if (ordersResult.error) {
    throw ordersResult.error;
  }

  const handoffs = (handoffsResult.data || []).map((row) => ({
    ...row,
    record_type: "handoff",
    quantity: null
  }));

  const orderIntents = (orderIntentsResult.data || []).map((row) => ({
    ...row,
    record_type: "order_intent"
  }));

  const draftOrders = (ordersResult.data || []).map((row) => ({
    ...row,
    record_type: "draft_order"
  }));

  return handoffs
    .concat(orderIntents)
    .concat(draftOrders)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

async function getClientPerformance(supabase, tenantId) {
  const [conversationSessions, leads, products] = await Promise.all([
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
    leads_generated: leads.length,
    order_intents: leads.filter((row) => row.record_type === "order_intent").length,
    draft_orders: leads.filter((row) => row.record_type === "draft_order").length,
    top_products: topProducts,
    handoff_rate: conversationSessions.length === 0
      ? 0
      : Number(((leads.length / conversationSessions.length) * 100).toFixed(1))
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
      padding: 14px;
    }
    .auth-card {
      width: min(1160px, 100%);
      display: grid;
      grid-template-columns: 110px minmax(0, 1fr) 110px;
      gap: 16px;
      background: rgba(255,255,255,0.74);
      border: 1px solid rgba(125, 105, 213, 0.14);
      border-radius: 34px;
      padding: 16px;
      box-shadow: 0 28px 70px rgba(54, 41, 101, 0.14);
      backdrop-filter: blur(16px);
    }
    .auth-intro {
      padding: 20px 12px;
      background: linear-gradient(180deg, #f5f0ff 0%, #efebf8 100%);
      border-radius: 26px;
      color: var(--text);
      display: flex;
      flex-direction: column;
      gap: 18px;
      justify-content: center;
      align-items: center;
    }
    .auth-vertical {
      display: flex;
      flex-direction: column;
      gap: 12px;
      font-size: 42px;
      line-height: 0.88;
      font-weight: 900;
      letter-spacing: -0.08em;
      color: #564a79;
      text-align: center;
    }
    .auth-vertical span {
      display: grid;
      place-items: center;
      width: 58px;
      height: 58px;
      border-radius: 18px;
      background: rgba(255,255,255,0.92);
      border: 1px solid #e6dbfb;
      box-shadow: 0 12px 28px rgba(89, 79, 119, 0.08);
    }
    .auth-intro-copy {
      display: none;
    }
    .auth-intro h1 {
      margin: 0;
      font-size: 28px;
      line-height: 1.02;
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
      margin-top: 10px;
    }
    .auth-points div {
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(255,255,255,0.12);
      border: 1px solid rgba(255,255,255,0.14);
    }
    .auth-stage {
      display: grid;
      place-items: center;
      padding: 6px 0;
    }
    .auth-stage-card {
      width: min(640px, 100%);
      background: linear-gradient(180deg, #f6f0ff 0%, #f1eaff 100%);
      border-radius: 30px;
      border: 1px solid #e6dbfb;
      box-shadow: 0 24px 58px rgba(53, 40, 95, 0.1);
      padding: 28px;
      display: grid;
      gap: 18px;
    }
    .auth-entry {
      display: grid;
      justify-items: center;
      text-align: center;
      gap: 16px;
    }
    .auth-stage-head {
      display: grid;
      justify-items: center;
      text-align: center;
      gap: 10px;
    }
    .auth-mark {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 999px;
      background: linear-gradient(145deg, #f8f4ff 0%, #ede7fd 100%);
      color: #4c4269;
      font-weight: 800;
      box-shadow: inset 0 0 0 1px #e3daf9;
    }
    .auth-mark-badge {
      width: 42px;
      height: 42px;
      border-radius: 14px;
      display: grid;
      place-items: center;
      background: linear-gradient(145deg, #ffffff 0%, #e9defd 100%);
      color: #4c4269;
      font-size: 20px;
      letter-spacing: -0.08em;
    }
    .auth-stage-head h2 {
      margin: 0;
      font-size: 34px;
      line-height: 1.02;
      letter-spacing: -0.05em;
      color: #2f2942;
    }
    .auth-stage-head p {
      margin: 0;
      max-width: 520px;
      color: var(--muted);
      line-height: 1.65;
    }
    .auth-entry-actions {
      display: inline-flex;
      gap: 12px;
      flex-wrap: wrap;
      justify-content: center;
    }
    .auth-form-shell {
      display: none;
      gap: 16px;
    }
    .auth-form-shell.visible {
      display: grid;
    }
    .auth-form-topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .ghost-btn {
      border: 0;
      background: transparent;
      color: var(--muted);
      font-weight: 700;
      cursor: pointer;
      padding: 8px 0;
    }
    .auth-forms {
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .mini-caption {
      margin-top: -6px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
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
    .auth-right {
      border-radius: 26px;
      background: linear-gradient(180deg, #f5f0ff 0%, #efebf8 100%);
      border: 1px solid #ebe2fb;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px 12px;
    }
    .auth-right-stack {
      display: grid;
      gap: 14px;
      justify-items: center;
      color: #564a79;
      font-weight: 900;
      letter-spacing: -0.08em;
      font-size: 42px;
      line-height: 1;
    }
    .auth-right-stack span {
      display: grid;
      place-items: center;
      width: 58px;
      height: 58px;
      border-radius: 18px;
      background: rgba(255,255,255,0.92);
      border: 1px solid #e6dbfb;
      box-shadow: 0 12px 28px rgba(89, 79, 119, 0.08);
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
    .helper-card {
      border-radius: 18px;
      padding: 14px 16px;
      background: linear-gradient(180deg, #fbf9ff 0%, #f4efff 100%);
      border: 1px solid #e4dbfb;
      color: #544d69;
      font-size: 14px;
      line-height: 1.6;
    }
    .helper-card strong {
      color: #3d345d;
    }
    .confirmation-card {
      border-radius: 18px;
      padding: 18px 20px;
      background: linear-gradient(180deg, #fff9ef 0%, #fff2d8 100%);
      border: 1px solid #efcf82;
      color: #6a4d15;
      box-shadow: 0 18px 40px rgba(182, 133, 32, 0.14);
      display: grid;
      gap: 12px;
    }
    .confirmation-card h4 {
      margin: 0;
      font-size: 20px;
      color: #5f430f;
    }
    .confirmation-card p {
      margin: 0;
      line-height: 1.6;
    }
    .confirmation-meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
    }
    .confirmation-meta .meta-box {
      border-radius: 14px;
      background: rgba(255,255,255,0.72);
      border: 1px solid rgba(202, 161, 62, 0.22);
      padding: 12px;
      display: grid;
      gap: 6px;
    }
    .confirmation-meta .label {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #87631d;
    }
    .confirmation-meta .value {
      font-size: 14px;
      font-weight: 700;
      color: #5f430f;
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
    .logout-btn {
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 14px;
      background: rgba(255,255,255,0.08);
      color: white;
      padding: 12px 14px;
      text-align: left;
      cursor: pointer;
      font-weight: 700;
    }
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
    .refresh-btn:disabled, .primary-btn:disabled, .secondary-btn:disabled, .small-btn:disabled {
      cursor: wait;
      opacity: 0.7;
    }
    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .refresh-status {
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
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
    .stack {
      display: grid;
      gap: 18px;
    }
    .section-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
      flex-wrap: wrap;
    }
    .small-btn {
      border: 0;
      border-radius: 12px;
      padding: 10px 12px;
      font-weight: 700;
      cursor: pointer;
      background: #f1ebff;
      color: #4b4265;
    }
    .small-btn.danger {
      background: #fee2e2;
      color: #991b1b;
    }
    .action-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .management-form {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--line);
      display: grid;
      gap: 12px;
    }
    .management-form.editing {
      padding: 18px;
      border: 1px solid #dfd2fb;
      border-radius: 20px;
      background: linear-gradient(180deg, #fcfaff 0%, #f5efff 100%);
      box-shadow: 0 16px 38px rgba(64, 49, 113, 0.08);
    }
    .edit-state {
      display: none;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 16px;
      background: #efe8ff;
      color: #4e4176;
      font-weight: 700;
    }
    .edit-state.visible {
      display: flex;
    }
    .management-form.hidden,
    .section-summary.hidden {
      display: none;
    }
    .settings-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
    }
    .section-summary {
      margin-top: 16px;
      display: grid;
      gap: 12px;
    }
    .summary-grid-two {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .summary-item {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: linear-gradient(180deg, #fdfbff 0%, #f6f1ff 100%);
      padding: 14px;
    }
    .summary-item .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 700;
    }
    .summary-item .value {
      margin-top: 8px;
      font-size: 15px;
      font-weight: 700;
      line-height: 1.5;
      word-break: break-word;
    }
    .settings-actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
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
    .setup-path {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
      margin-top: 16px;
    }
    .setup-step {
      border-radius: 16px;
      padding: 14px;
      background: linear-gradient(180deg, #fcfbff 0%, #f3effe 100%);
      border: 1px solid #e8e0fb;
    }
    .setup-step .step-no {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: #7d69d5;
      color: white;
      font-size: 12px;
      font-weight: 800;
      margin-bottom: 10px;
    }
    .setup-step h4 {
      margin: 0 0 6px;
      font-size: 15px;
    }
    .setup-step p {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
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
    .progress-strip {
      margin-bottom: 18px;
      padding: 18px;
      border-radius: 22px;
      background: linear-gradient(180deg, #fdfbff 0%, #f4efff 100%);
      border: 1px solid #e6defa;
      box-shadow: var(--shadow);
      display: grid;
      gap: 14px;
    }
    .progress-strip.hidden { display: none; }
    .progress-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      flex-wrap: wrap;
    }
    .progress-copy h3 {
      margin: 4px 0 0;
      font-size: 22px;
    }
    .progress-copy p {
      margin: 8px 0 0;
      color: var(--muted);
      line-height: 1.6;
    }
    .progress-meter {
      display: grid;
      gap: 8px;
    }
    .progress-bar {
      width: 100%;
      height: 10px;
      border-radius: 999px;
      background: #ebe4fa;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(135deg, #8b7ad9 0%, #7464c7 100%);
      transition: width 0.25s ease;
    }
    .progress-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 13px;
      font-weight: 600;
    }
    .progress-checklist {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .progress-check {
      border: 1px solid var(--line);
      border-radius: 16px;
      background: white;
      padding: 14px;
      display: grid;
      gap: 6px;
    }
    .progress-check .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 700;
    }
    .progress-check .value {
      font-size: 15px;
      font-weight: 700;
    }
    .form-head {
      display: grid;
      gap: 6px;
      margin-bottom: 14px;
    }
    .form-head p {
      margin: 0;
    }
    @media (max-width: 980px) {
      .auth-card, .onboarding-hero, .onboarding-grid {
        grid-template-columns: 1fr;
      }
      .auth-vertical {
        flex-direction: row;
        flex-wrap: wrap;
        justify-content: center;
        font-size: 24px;
      }
      .auth-right {
        display: none;
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
        <div class="auth-vertical">
          <span>D</span>
          <span>i</span>
          <span>g</span>
          <span>i</span>
          <span>M</span>
          <span>a</span>
          <span>y</span>
          <span>a</span>
        </div>
      </div>

      <div class="auth-stage">
        <div class="auth-stage-card">
          <div id="auth-entry" class="auth-entry">
            <div class="auth-stage-head">
              <div class="auth-mark">
                <span class="auth-mark-badge">DM</span>
                <span>DigiMaya</span>
              </div>
              <h2>Our DigiMaya</h2>
              <p>Open your DigiMaya workspace to manage setup, products, FAQs, conversations, and leads in one place.</p>
            </div>
            <div class="auth-entry-actions">
              <button id="open-signup" class="primary-btn" type="button">Sign Up</button>
              <button id="open-login" class="secondary-btn" type="button">Log In</button>
            </div>
            <div class="mini-caption">Everything you need to launch DigiMaya for your business starts here.</div>
          </div>
          <div id="auth-form-shell" class="auth-form-shell">
            <div class="auth-form-topbar">
              <div class="auth-tabs">
                <button id="signup-tab" class="active" type="button">Sign Up</button>
                <button id="login-tab" type="button">Log In</button>
              </div>
              <button id="auth-back" class="ghost-btn" type="button">Back</button>
            </div>
            <div id="auth-message" class="auth-message"></div>

            <form id="signup-panel" class="auth-panel">
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
                  <label for="signup-confirm-password">Confirm Password</label>
                  <input id="signup-confirm-password" type="password" name="confirm_password" placeholder="Re-enter your password" required />
                </div>
                <div class="field">
                  <label for="signup-category">Business Category</label>
                  <input id="signup-category" name="business_category" placeholder="Jewelry, Sarees, Fashion" />
                </div>
                <div class="field">
                  <label for="signup-timezone">Timezone</label>
                  <input id="signup-timezone" name="timezone" placeholder="Asia/Kolkata" value="Asia/Kolkata" />
                </div>
                <div class="field">
                  <label for="signup-currency">Selling Currency</label>
                  <select id="signup-currency" name="currency_code">
                    <option value="INR">INR (₹)</option>
                    <option value="USD">USD ($)</option>
                    <option value="GBP">GBP (£)</option>
                    <option value="AUD">AUD (A$)</option>
                    <option value="EUR">EUR (€)</option>
                    <option value="CAD">CAD (C$)</option>
                  </select>
                </div>
              </div>
              <button class="primary-btn" type="submit">Create Your DigiMaya Account</button>
              <div class="muted-note">Create your secure account to manage your setup, catalog, conversations, and leads in one place.</div>
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
              <div class="muted-note">Pick up where you left off and continue your setup, customer conversations, and lead review.</div>
            </form>
          </div>
        </div>
      </div>

      <div class="auth-right">
        <div class="auth-right-stack">
          <span>#</span>
          <span>D</span>
          <span>M</span>
        </div>
      </div>
    </div>
  </section>

  <section id="onboarding-shell" class="onboarding-shell hidden">
    <div class="onboarding-wrap">
      <div class="onboarding-hero">
        <div class="hero-card">
          <div class="eyebrow">DigiMaya Setup</div>
          <h2 id="onboarding-business-name">Finish your onboarding</h2>
          <p>Follow this simple setup path to prepare DigiMaya for your business. Once these essentials are ready, your workspace is ready to launch.</p>
          <div class="setup-path">
            <div class="setup-step">
              <div class="step-no">1</div>
              <h4>Business Details</h4>
              <p>Add your brand, contact, and Instagram setup details.</p>
            </div>
            <div class="setup-step">
              <div class="step-no">2</div>
              <h4>Availability</h4>
              <p>Tell DigiMaya when your team usually responds to warm leads.</p>
            </div>
            <div class="setup-step">
              <div class="step-no">3</div>
              <h4>Catalog + FAQs</h4>
              <p>Give DigiMaya the products and answers your customers ask for most.</p>
            </div>
          </div>
          <div id="onboarding-checklist" class="checklist"></div>
        </div>
        <div class="hero-card">
          <div class="eyebrow">Customer Experience Rule</div>
          <h3>After-hours lead handling</h3>
          <p id="current-off-hours-copy">DigiMaya will capture interest, keep the conversation warm, and let customers know your team will follow up as soon as you’re available.</p>
          <div class="inline-actions">
            <span id="current-onboarding-status" class="status-pill">Setup in progress</span>
          </div>
          <div class="helper-card">
            <strong>Built for a hassle-free launch:</strong> start with the essentials first. You can always improve your catalog, FAQs, and channel connections after the first version is live.
          </div>
          <div id="client-confirmation-card" class="confirmation-card" style="display:none;">
            <div class="eyebrow" style="color:#87631d;">Activation Required</div>
            <h4>Admin approval is complete. Your final confirmation is now needed.</h4>
            <p>DigiMaya has already been connected and approved on the admin side. Confirm from your side to activate your workspace and start live handling for your business.</p>
            <div class="confirmation-meta">
              <div class="meta-box">
                <div class="label">Admin Status</div>
                <div class="value">Confirmed</div>
              </div>
              <div class="meta-box">
                <div class="label">Client Status</div>
                <div class="value">Waiting for your confirmation</div>
              </div>
              <div class="meta-box">
                <div class="label">Activation</div>
                <div class="value">Pending final approval</div>
              </div>
            </div>
            <div class="inline-actions">
              <button id="client-confirm-connection" class="primary-btn" type="button">Confirm Connection</button>
            </div>
          </div>
        </div>
      </div>

      <div id="onboarding-message" class="auth-message"></div>

      <div class="onboarding-grid">
        <form id="business-profile-form" class="hero-card">
          <div class="form-head">
            <div class="eyebrow">Step 1</div>
            <h3>Business Profile</h3>
            <p>Set the essentials DigiMaya needs to represent your business clearly and route leads to the right person.</p>
          </div>
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
              <label for="profile-currency">Selling Currency</label>
              <select id="profile-currency" name="currency_code">
                <option value="INR">INR (₹)</option>
                <option value="USD">USD ($)</option>
                <option value="GBP">GBP (£)</option>
                <option value="AUD">AUD (A$)</option>
                <option value="EUR">EUR (€)</option>
                <option value="CAD">CAD (C$)</option>
              </select>
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
          <div class="form-head">
            <div class="eyebrow">Step 2</div>
            <h3>Availability Rules</h3>
            <p>Set your usual response window so DigiMaya can keep customer expectations clear when your team is offline.</p>
          </div>
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
          <div class="form-head">
            <div class="eyebrow">Step 3</div>
            <h3>Add Product</h3>
            <p>Start with your most important products first. A small high-quality catalog is better than a rushed large one.</p>
          </div>
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
            <div class="field">
              <label for="product-image">Image URL</label>
              <input id="product-image" name="image_url" placeholder="https://image..." />
            </div>
            <div class="field full">
              <label for="product-description">Description</label>
              <textarea id="product-description" name="description"></textarea>
            </div>
          </div>
          <button class="primary-btn" type="submit">Add Product</button>
        </form>

        <form id="product-import-form" class="hero-card">
          <div class="form-head">
            <div class="eyebrow">Faster setup</div>
            <h3>Bulk Import Products</h3>
            <p>Paste one product per line to load your catalog faster. Use this format: name, price, category, color, product_url, image_url, description.</p>
          </div>
          <div class="field-grid">
            <div class="field full">
              <label for="product-import-text">Products to import</label>
              <textarea id="product-import-text" name="products_text" placeholder='Bridal Haram,95,Jewelry,Green,https://store.com/haram,https://store.com/haram.jpg,Grand bridal haram with peacock details&#10;Banarasi Saree,45,Fashion,Yellow Pink,https://store.com/saree,https://store.com/saree.jpg,Banarasi silk saree with stitched blouse'></textarea>
            </div>
          </div>
          <button class="primary-btn" type="submit">Import Products</button>
        </form>

        <form id="faq-form" class="hero-card">
          <div class="form-head">
            <div class="eyebrow">Step 4</div>
            <h3>Add FAQ</h3>
            <p>Add the questions customers ask again and again so DigiMaya can answer with more confidence from day one.</p>
          </div>
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
        <p>Once your business profile, hours, products, and FAQs are in place, DigiMaya can treat your workspace as launch-ready and move you into your dashboard.</p>
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
        <button data-panel="catalog">Catalog</button>
        <button data-panel="faqs">FAQs</button>
        <button data-panel="settings">Settings</button>
        <button data-panel="performance">Performance</button>
      </div>

      <div class="side-card">
        <div class="eyebrow">Need Help?</div>
        <h4>Reach the DigiMaya team</h4>
        <p>If you notice an issue or need changes, contact us directly and we’ll help quickly.</p>
        <a id="support-link" class="support-cta" href="mailto:${supportEmail}?subject=DigiMaya%20Client%20Support">Contact Support</a>
      </div>
      <button id="logout-button" class="logout-btn" type="button">Log Out</button>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <div class="eyebrow">Business Clarity View</div>
          <h2>Your DigiMaya Dashboard</h2>
        </div>
        <div class="topbar-actions">
          <div id="refresh-status" class="refresh-status">Workspace ready</div>
          <button id="refresh" class="refresh-btn">Refresh</button>
        </div>
      </header>

      <div id="error" class="error"></div>
      <section id="onboarding-progress-strip" class="progress-strip hidden"></section>

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
          <h3>Leads & Order Intents</h3>
          <div id="leads-table"></div>
        </div>
      </section>

      <section class="panel" data-panel="catalog">
        <div class="card">
          <div class="toolbar">
            <div>
              <h3>Catalog Manager</h3>
              <div class="muted-note">Add, edit, or remove products anytime after launch.</div>
            </div>
          </div>
          <div id="catalog-table"></div>
          <form id="catalog-management-form" class="management-form">
            <input id="manage-product-id" type="hidden" name="product_id" />
            <div id="catalog-edit-state" class="edit-state" aria-live="polite"></div>
            <div class="field-grid">
              <div class="field">
                <label for="manage-product-name">Product Name</label>
                <input id="manage-product-name" name="name" required />
              </div>
              <div class="field">
                <label for="manage-product-category">Category</label>
                <input id="manage-product-category" name="category" />
              </div>
              <div class="field">
                <label for="manage-product-price">Selling Price</label>
                <input id="manage-product-price" type="number" step="0.01" name="price" required />
              </div>
              <div class="field">
                <label for="manage-product-regular-price">Regular Price</label>
                <input id="manage-product-regular-price" type="number" step="0.01" name="regular_price" />
              </div>
              <div class="field">
                <label for="manage-product-color">Color</label>
                <input id="manage-product-color" name="color" />
              </div>
            <div class="field">
              <label for="manage-product-url">Product URL</label>
              <input id="manage-product-url" name="product_url" />
            </div>
            <div class="field">
              <label for="manage-product-image-url">Image URL</label>
              <input id="manage-product-image-url" name="image_url" />
            </div>
            <div class="field full">
              <label for="manage-product-description">Description</label>
              <textarea id="manage-product-description" name="description"></textarea>
            </div>
          </div>
          <div class="inline-actions">
              <button id="save-product-button" class="primary-btn" type="submit">Save Product</button>
              <button id="cancel-product-edit" class="secondary-btn" type="button">Cancel Edit</button>
          </div>
          </form>
          <div class="card" style="margin-top:16px;">
            <div class="toolbar">
              <div>
                <h3>Quick Import</h3>
                <div class="muted-note">Paste one product per line: name, price, category, color, product_url, image_url, description.</div>
              </div>
            </div>
            <form id="catalog-import-form" class="management-form">
              <div class="field-grid">
                <div class="field full">
                  <label for="catalog-import-text">Bulk product lines</label>
                  <textarea id="catalog-import-text" name="products_text" placeholder='Bridal Haram,95,Jewelry,Green,https://store.com/haram,https://store.com/haram.jpg,Grand bridal haram with peacock details'></textarea>
                </div>
              </div>
              <div class="inline-actions">
                <button class="primary-btn" type="submit">Import Products</button>
              </div>
            </form>
          </div>
        </div>
      </section>

      <section class="panel" data-panel="faqs">
        <div class="card">
          <div class="toolbar">
            <div>
              <h3>FAQ Manager</h3>
              <div class="muted-note">Keep adding, editing, or removing FAQs as your customers ask new questions.</div>
            </div>
          </div>
          <div id="faqs-table"></div>
          <form id="faq-management-form" class="management-form">
            <input id="manage-faq-id" type="hidden" name="faq_id" />
            <div id="faq-edit-state" class="edit-state" aria-live="polite"></div>
            <div class="field-grid">
              <div class="field full">
                <label for="manage-faq-question">Question</label>
                <input id="manage-faq-question" name="question" required />
              </div>
              <div class="field full">
                <label for="manage-faq-answer">Answer</label>
                <textarea id="manage-faq-answer" name="answer" required></textarea>
              </div>
            </div>
            <div class="inline-actions">
              <button id="save-faq-button" class="primary-btn" type="submit">Save FAQ</button>
              <button id="cancel-faq-edit" class="secondary-btn" type="button">Cancel Edit</button>
            </div>
          </form>
        </div>
      </section>

      <section class="panel" data-panel="settings">
        <div class="stack">
          <div class="card">
            <div class="settings-header">
              <div>
                <h3>Profile Settings</h3>
                <div class="muted-note">Review your business and contact details, then update them only when needed.</div>
              </div>
              <button id="edit-profile-settings" class="small-btn" type="button">Edit</button>
            </div>
            <div id="profile-settings-summary" class="section-summary"></div>
            <form id="settings-profile-form" class="management-form hidden">
              <div class="field-grid">
                <div class="field">
                  <label for="settings-business-name">Business Name</label>
                  <input id="settings-business-name" name="business_name" required />
                </div>
                <div class="field">
                  <label for="settings-owner-name">Owner Name</label>
                  <input id="settings-owner-name" name="owner_name" required />
                </div>
                <div class="field">
                  <label for="settings-owner-email">Owner Email</label>
                  <input id="settings-owner-email" type="email" name="owner_email" required />
                </div>
                <div class="field">
                  <label for="settings-timezone">Timezone</label>
                  <input id="settings-timezone" name="timezone" />
                </div>
                <div class="field">
                  <label for="settings-currency">Selling Currency</label>
                  <select id="settings-currency" name="currency_code">
                    <option value="INR">INR (₹)</option>
                    <option value="USD">USD ($)</option>
                    <option value="GBP">GBP (£)</option>
                    <option value="AUD">AUD (A$)</option>
                    <option value="EUR">EUR (€)</option>
                    <option value="CAD">CAD (C$)</option>
                  </select>
                </div>
                <div class="field">
                  <label for="settings-category">Business Category</label>
                  <input id="settings-category" name="business_category" />
                </div>
                <div class="field">
                  <label for="settings-instagram">Instagram Username</label>
                  <input id="settings-instagram" name="instagram_username" />
                </div>
                <div class="field">
                  <label for="settings-facebook-page">Facebook Page Name</label>
                  <input id="settings-facebook-page" name="facebook_page_name" />
                </div>
                <div class="field">
                  <label for="settings-contact-method">Preferred Contact Method</label>
                  <select id="settings-contact-method" name="preferred_contact_method">
                    <option value="email">Email</option>
                    <option value="phone">Phone</option>
                    <option value="whatsapp">WhatsApp</option>
                  </select>
                </div>
                <div class="field">
                  <label for="settings-lead-email">Lead Contact Email</label>
                  <input id="settings-lead-email" type="email" name="lead_contact_email" />
                </div>
                <div class="field">
                  <label for="settings-lead-phone">Lead Contact Phone</label>
                  <input id="settings-lead-phone" name="lead_contact_phone" />
                </div>
              </div>
              <div class="settings-actions">
                <button id="save-profile-settings" class="primary-btn" type="submit">Save Profile Changes</button>
                <button id="cancel-profile-settings" class="secondary-btn" type="button">Cancel</button>
              </div>
            </form>
          </div>

          <div class="card">
            <div class="settings-header">
              <div>
                <h3>Availability Settings</h3>
                <div class="muted-note">Control when your team is available and what DigiMaya says after hours.</div>
              </div>
              <button id="edit-availability-settings" class="small-btn" type="button">Edit</button>
            </div>
            <div id="availability-settings-summary" class="section-summary"></div>
            <form id="settings-availability-form" class="management-form hidden">
              <div class="field-grid">
                <div class="field">
                  <label for="settings-hours-start">Start Time</label>
                  <input id="settings-hours-start" type="time" name="response_window_start" required />
                </div>
                <div class="field">
                  <label for="settings-hours-end">End Time</label>
                  <input id="settings-hours-end" type="time" name="response_window_end" required />
                </div>
                <div class="field full">
                  <label for="settings-hours-reply">After-hours Lead Reply</label>
                  <textarea id="settings-hours-reply" name="off_hours_reply"></textarea>
                </div>
              </div>
              <div class="settings-actions">
                <button id="save-availability-settings" class="primary-btn" type="submit">Save Availability Changes</button>
                <button id="cancel-availability-settings" class="secondary-btn" type="button">Cancel</button>
              </div>
            </form>
          </div>
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
        performance: null,
        settingsEditing: {
          profile: false,
          availability: false
        },
        catalog: {
          products: [],
          faqs: []
        }
      };

      function normalizeCurrencyCode(value) {
        const code = String(value || "").trim().toUpperCase();
        const supported = new Set(["INR", "USD", "GBP", "AUD", "EUR", "CAD"]);
        return supported.has(code) ? code : "INR";
      }

      function getCurrencyConfig(code) {
        const normalized = normalizeCurrencyCode(code);
        const map = {
          INR: { code: "INR", symbol: "₹", locale: "en-IN" },
          USD: { code: "USD", symbol: "$", locale: "en-US" },
          GBP: { code: "GBP", symbol: "£", locale: "en-GB" },
          AUD: { code: "AUD", symbol: "A$", locale: "en-AU" },
          EUR: { code: "EUR", symbol: "€", locale: "en-IE" },
          CAD: { code: "CAD", symbol: "C$", locale: "en-CA" }
        };
        return map[normalized] || map.INR;
      }

      function formatTenantMoney(amount, currencyCode) {
        const value = Number(amount);
        if (!Number.isFinite(value)) {
          return "—";
        }

        const currency = getCurrencyConfig(currencyCode);
        const formatted = value.toLocaleString(currency.locale, {
          minimumFractionDigits: value % 1 === 0 ? 0 : 2,
          maximumFractionDigits: 2
        });

        return currency.symbol + formatted;
      }

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

      function setRefreshState(isLoading, message) {
        const button = document.getElementById("refresh");
        const status = document.getElementById("refresh-status");

        button.disabled = isLoading;
        button.textContent = isLoading ? "Refreshing..." : "Refresh";
        if (message) {
          status.textContent = message;
        }
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
          ["Order Intents", metrics.order_intents_count, "Purchase-ready conversations DigiMaya has structured"],
          ["Draft Orders", metrics.draft_orders_count, "Draft orders DigiMaya has prepared for checkout"],
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

      function renderOnboardingProgressStrip() {
        const strip = document.getElementById("onboarding-progress-strip");
        const tenant = state.overview?.tenant;

        if (!tenant) {
          strip.classList.add("hidden");
          strip.innerHTML = "";
          return;
        }

        const checklist = [
          ["Business Profile", Boolean(tenant.business_name && tenant.owner_name && tenant.owner_email)],
          ["Instagram Setup Started", Boolean(tenant.instagram_connection_status && tenant.instagram_connection_status !== "not_started") || Boolean(tenant.connect_instagram_requested)],
          ["Instagram Connected", Boolean(tenant.instagram_connected)],
          ["Admin Confirmed", Boolean(tenant.admin_connection_confirmed)],
          ["Client Confirmed", Boolean(tenant.client_connection_confirmed)],
          ["Availability Set", Boolean(tenant.response_window_start && tenant.response_window_end)],
          ["Catalog Ready", Number(state.overview?.metrics?.products_count || 0) > 0],
          ["FAQs Ready", Number(state.overview?.metrics?.faqs_count || 0) > 0]
        ];

        const completed = checklist.filter((item) => item[1]).length;
        const total = checklist.length;
        const progress = Math.round((completed / total) * 100);
        const isActive = tenant.activation_status === "active";

        if (isActive) {
          strip.classList.remove("hidden");
          strip.innerHTML =
            '<div class="progress-top">' +
              '<div class="progress-copy">' +
                '<div class="eyebrow">Workspace Status</div>' +
                '<h3>DigiMaya is live for your business</h3>' +
                '<p>Your setup is complete and your workspace is active. You can now focus on conversations, leads, and improving your catalog over time.</p>' +
              '</div>' +
              '<span class="status-pill">Active</span>' +
            '</div>' +
            '<div class="progress-bar"><div class="progress-fill" style="width: 100%;"></div></div>' +
            '<div class="progress-meta"><span>100% complete</span><span>All core setup steps are done</span></div>';
          return;
        }

        strip.classList.remove("hidden");
        strip.innerHTML =
          '<div class="progress-top">' +
            '<div class="progress-copy">' +
              '<div class="eyebrow">Workspace Progress</div>' +
              '<h3>Your DigiMaya setup is ' + progress + '% complete</h3>' +
              '<p>' + progressStripMessage(tenant) + '</p>' +
            '</div>' +
            '<span class="status-pill">' + escapeHtml(String(tenant.activation_status || "setup_incomplete")).replaceAll("_", " ") + '</span>' +
          '</div>' +
          '<div class="progress-meter">' +
            '<div class="progress-bar"><div class="progress-fill" style="width: ' + progress + '%;"></div></div>' +
            '<div class="progress-meta"><span>' + completed + ' of ' + total + ' setup steps complete</span><span>Finish the remaining items to go fully live</span></div>' +
          '</div>' +
          (tenant.admin_connection_confirmed && !tenant.client_connection_confirmed
            ? '<div class="inline-actions"><button id="progress-confirm-connection" class="primary-btn" type="button">Confirm Connection</button></div>'
            : '') +
          '<div class="progress-checklist">' +
            checklist.map((item) => (
              '<div class="progress-check">' +
                '<div class="label">' + item[0] + '</div>' +
                '<div class="value">' + (item[1] ? "Complete" : "Pending") + '</div>' +
              '</div>'
            )).join("") +
          '</div>';
      }

      function progressStripMessage(tenant) {
        if (!tenant.instagram_connected) {
          return "Connect your Instagram account and finish the confirmation steps so DigiMaya can begin handling live business messages.";
        }

        if (!tenant.admin_connection_confirmed) {
          return "Your Instagram connection is in place. DigiMaya is now waiting for an admin check before your workspace can move forward.";
        }

        if (!tenant.client_connection_confirmed) {
          return "Your admin confirmation is complete. Confirm the connection from your side to activate your workspace.";
        }

        if (!(tenant.response_window_start && tenant.response_window_end)) {
          return "Set your availability window so DigiMaya knows when your team is available to respond to leads.";
        }

        if (Number(state.overview?.metrics?.products_count || 0) === 0 || Number(state.overview?.metrics?.faqs_count || 0) === 0) {
          return "Add at least one product and one FAQ so DigiMaya can answer customers with the right business context.";
        }

        return "Your setup is nearly complete. Review the remaining items and activate your workspace when you’re ready.";
      }

      function resetManagedProductForm() {
        document.getElementById("catalog-management-form").reset();
        document.getElementById("manage-product-id").value = "";
        document.getElementById("save-product-button").textContent = "Save Product";
        document.getElementById("catalog-management-form").classList.remove("editing");
        const editState = document.getElementById("catalog-edit-state");
        editState.classList.remove("visible");
        editState.textContent = "";
      }

      function resetManagedFaqForm() {
        document.getElementById("faq-management-form").reset();
        document.getElementById("manage-faq-id").value = "";
        document.getElementById("save-faq-button").textContent = "Save FAQ";
        document.getElementById("faq-management-form").classList.remove("editing");
        const editState = document.getElementById("faq-edit-state");
        editState.classList.remove("visible");
        editState.textContent = "";
      }

      function beginManagedProductEdit(product) {
        if (!product) return;
        document.getElementById("manage-product-id").value = product.id;
        document.getElementById("manage-product-name").value = product.name || "";
        document.getElementById("manage-product-category").value = product.category || "";
        document.getElementById("manage-product-price").value = product.price == null ? "" : product.price;
        document.getElementById("manage-product-regular-price").value = product.regular_price == null ? "" : product.regular_price;
        document.getElementById("manage-product-color").value = product.color || "";
        document.getElementById("manage-product-url").value = product.product_url || "";
        document.getElementById("manage-product-image-url").value = product.image_url || "";
        document.getElementById("manage-product-description").value = product.description || "";
        document.getElementById("save-product-button").textContent = "Update Product";
        const form = document.getElementById("catalog-management-form");
        const editState = document.getElementById("catalog-edit-state");
        form.classList.add("editing");
        editState.textContent = 'Editing product: ' + (product.name || "Untitled product");
        editState.classList.add("visible");
        form.scrollIntoView({ behavior: "smooth", block: "start" });
        document.getElementById("manage-product-name").focus();
      }

      function beginManagedFaqEdit(faq) {
        if (!faq) return;
        document.getElementById("manage-faq-id").value = faq.id;
        document.getElementById("manage-faq-question").value = faq.question || "";
        document.getElementById("manage-faq-answer").value = faq.answer || "";
        document.getElementById("save-faq-button").textContent = "Update FAQ";
        const form = document.getElementById("faq-management-form");
        const editState = document.getElementById("faq-edit-state");
        form.classList.add("editing");
        editState.textContent = 'Editing FAQ: ' + (faq.question || "Untitled FAQ");
        editState.classList.add("visible");
        form.scrollIntoView({ behavior: "smooth", block: "start" });
        document.getElementById("manage-faq-question").focus();
      }

      function syncSettingsFields(tenant) {
        document.getElementById("settings-business-name").value = tenant.business_name || "";
        document.getElementById("settings-owner-name").value = tenant.owner_name || "";
        document.getElementById("settings-owner-email").value = tenant.owner_email || "";
        document.getElementById("settings-timezone").value = tenant.timezone || "Asia/Kolkata";
        document.getElementById("settings-currency").value = normalizeCurrencyCode(tenant.currency_code);
        document.getElementById("settings-category").value = tenant.business_category || "";
        document.getElementById("settings-instagram").value = tenant.instagram_username || "";
        document.getElementById("settings-facebook-page").value = tenant.facebook_page_name || "";
        document.getElementById("settings-contact-method").value = tenant.preferred_contact_method || "email";
        document.getElementById("settings-lead-email").value = tenant.lead_contact_email || "";
        document.getElementById("settings-lead-phone").value = tenant.lead_contact_phone || "";
        document.getElementById("settings-hours-start").value = tenant.response_window_start || "";
        document.getElementById("settings-hours-end").value = tenant.response_window_end || "";
        document.getElementById("settings-hours-reply").value = tenant.off_hours_reply || "";
        renderSettingsSummary(tenant);
        setSettingsEditing("profile", false);
        setSettingsEditing("availability", false);
      }

      function renderSettingsSummary(tenant) {
        document.getElementById("profile-settings-summary").innerHTML =
          '<div class="summary-grid-two">' +
            summaryItem("Business Name", tenant.business_name || "Not added yet") +
            summaryItem("Owner Name", tenant.owner_name || "Not added yet") +
            summaryItem("Login Email", tenant.owner_email || "Not added yet") +
            summaryItem("Timezone", tenant.timezone || "Not added yet") +
            summaryItem("Selling Currency", normalizeCurrencyCode(tenant.currency_code)) +
            summaryItem("Business Category", tenant.business_category || "Not added yet") +
            summaryItem("Instagram Username", tenant.instagram_username || "Not added yet") +
            summaryItem("Facebook Page", tenant.facebook_page_name || "Not added yet") +
            summaryItem("Preferred Contact", tenant.preferred_contact_method || "Not added yet") +
            summaryItem("Lead Email", tenant.lead_contact_email || "Not added yet") +
            summaryItem("Lead Phone", tenant.lead_contact_phone || "Not added yet") +
          '</div>';

        document.getElementById("availability-settings-summary").innerHTML =
          '<div class="summary-grid-two">' +
            summaryItem("Start Time", tenant.response_window_start || "Not set yet") +
            summaryItem("End Time", tenant.response_window_end || "Not set yet") +
            summaryItem("After-hours Reply", tenant.off_hours_reply || "Not set yet") +
          '</div>';
      }

      function summaryItem(label, value) {
        return '<div class="summary-item"><div class="label">' + label + '</div><div class="value">' + escapeHtml(String(value || "—")) + '</div></div>';
      }

      function escapeHtml(value) {
        return String(value || "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function setSettingsEditing(section, isEditing) {
        state.settingsEditing[section] = isEditing;

        const isProfile = section === "profile";
        const form = document.getElementById(isProfile ? "settings-profile-form" : "settings-availability-form");
        const summary = document.getElementById(isProfile ? "profile-settings-summary" : "availability-settings-summary");
        const editButton = document.getElementById(isProfile ? "edit-profile-settings" : "edit-availability-settings");
        const inputSelector = isProfile
          ? "#settings-profile-form input, #settings-profile-form textarea, #settings-profile-form select"
          : "#settings-availability-form input, #settings-availability-form textarea, #settings-availability-form select";

        form.classList.toggle("hidden", !isEditing);
        summary.classList.toggle("hidden", isEditing);
        editButton.textContent = isEditing ? "Editing" : "Edit";
        editButton.disabled = isEditing;

        document.querySelectorAll(inputSelector).forEach((field) => {
          field.disabled = !isEditing;
        });
      }

      function renderOnboarding() {
        const tenant = state.session.tenant;
        const onboarding = state.session.onboarding;
        const statusText =
          tenant.activation_status === "active"
            ? "Active"
            : onboarding.ready_for_client_confirmation
              ? "Waiting for your confirmation"
              : onboarding.launch_ready
                ? "Launch ready"
                : "Setup in progress";

        document.getElementById("onboarding-business-name").textContent = tenant.business_name || "Finish your onboarding";
        document.getElementById("current-off-hours-copy").textContent = tenant.off_hours_reply || "DigiMaya will collect the lead and promise a follow-up when your team is available.";
        document.getElementById("current-onboarding-status").textContent = statusText;

        document.getElementById("profile-business-name").value = tenant.business_name || "";
        document.getElementById("profile-owner-name").value = tenant.owner_name || "";
        document.getElementById("profile-owner-email").value = tenant.owner_email || "";
        document.getElementById("profile-timezone").value = tenant.timezone || "Asia/Kolkata";
        document.getElementById("profile-currency").value = normalizeCurrencyCode(tenant.currency_code);
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
        syncSettingsFields(tenant);

        const checklist = [
          ["Business profile", onboarding.profile_completed],
          ["Instagram setup started", onboarding.instagram_setup_started],
          ["Instagram connected", onboarding.instagram_connected],
          ["Admin confirmed connection", onboarding.admin_connection_confirmed],
          ["Client confirmed connection", onboarding.client_connection_confirmed],
          ["Availability rules", onboarding.hours_completed],
          ["At least one product", onboarding.catalog_ready],
          ["At least one FAQ", onboarding.faq_ready],
          ["Launch readiness", onboarding.launch_ready]
        ];

        document.getElementById("onboarding-checklist").innerHTML = checklist.map(function (item) {
          return '<div class="item"><span>' + item[0] + '</span><span class="badge">' + (item[1] ? "Done" : "Pending") + '</span></div>';
        }).join("");

        const confirmationCard = document.getElementById("client-confirmation-card");
        confirmationCard.style.display = onboarding.ready_for_client_confirmation ? "grid" : "none";
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
          setRefreshState(true, "Loading your workspace...");
          const payload = await fetchJson("/client/session");
          state.session = payload;

          if (shouldShowOnboarding()) {
            renderOnboarding();
            showShell("onboarding");
          } else {
            await loadDashboardData();
            showShell("dashboard");
          }
          setRefreshState(false, "Updated " + new Date().toLocaleTimeString());
        } catch (error) {
          setToken("");
          state.session = null;
          setAuthMessage(error.message, "error");
          showShell("auth");
          setRefreshState(false, "Refresh failed");
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
        setRefreshState(true, "Refreshing live business data...");
        const [overview, conversations, leads, performance, catalog] = await Promise.all([
          fetchJson("/client/overview"),
          fetchJson("/client/conversations"),
          fetchJson("/client/leads"),
          fetchJson("/client/performance"),
          fetchJson("/client/catalog")
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
        state.catalog = {
          products: catalog.products || [],
          faqs: catalog.faqs || []
        };

        syncSettingsFields(state.overview.tenant);
        renderOverview();
        renderOnboardingProgressStrip();
        renderConversations();
        renderLeads();
        renderPerformance();
        renderCatalog();
        renderFaqs();
        resetManagedProductForm();
        resetManagedFaqForm();
        setRefreshState(false, "Updated " + new Date().toLocaleTimeString());
      }

      function renderCatalog() {
        buildTable(
          "catalog-table",
          state.catalog.products,
          [
            { label: "Product", render: (row) => row.name || "—" },
            { label: "Category", render: (row) => row.category || "—" },
            { label: "Price", render: (row) => formatTenantMoney(row.price, state.overview?.tenant?.currency_code) },
            { label: "Color", render: (row) => row.color || "—" },
            { label: "Link", render: (row) => row.product_url ? '<a href="' + row.product_url + '" target="_blank" rel="noreferrer">Open</a>' : "—" },
            { label: "Image", render: (row) => row.image_url ? '<a href="' + row.image_url + '" target="_blank" rel="noreferrer">View</a>' : "—" },
            { label: "Actions", render: (row) => '<div class="action-row"><button class="small-btn" type="button" data-edit-product="' + row.id + '">Edit</button><button class="small-btn danger" type="button" data-delete-product="' + row.id + '">Delete</button></div>' }
          ],
          "No products yet."
        );

        document.querySelectorAll("[data-edit-product]").forEach((button) => {
          button.addEventListener("click", function () {
            const product = state.catalog.products.find((item) => String(item.id) === button.dataset.editProduct);
            beginManagedProductEdit(product);
          });
        });

        document.querySelectorAll("[data-delete-product]").forEach((button) => {
          button.addEventListener("click", async function () {
            if (!window.confirm("Delete this product from your catalog?")) return;
            try {
              await fetchJson("/client/catalog/product/" + button.dataset.deleteProduct, { method: "DELETE" });
              await loadDashboardData();
            } catch (error) {
              setError(error.message);
            }
          });
        });
      }

      function renderFaqs() {
        buildTable(
          "faqs-table",
          state.catalog.faqs,
          [
            { label: "Question", render: (row) => row.question || "—" },
            { label: "Answer", render: (row) => row.answer || "—" },
            { label: "Actions", render: (row) => '<div class="action-row"><button class="small-btn" type="button" data-edit-faq="' + row.id + '">Edit</button><button class="small-btn danger" type="button" data-delete-faq="' + row.id + '">Delete</button></div>' }
          ],
          "No FAQs yet."
        );

        document.querySelectorAll("[data-edit-faq]").forEach((button) => {
          button.addEventListener("click", function () {
            const faq = state.catalog.faqs.find((item) => String(item.id) === button.dataset.editFaq);
            beginManagedFaqEdit(faq);
          });
        });

        document.querySelectorAll("[data-delete-faq]").forEach((button) => {
          button.addEventListener("click", async function () {
            if (!window.confirm("Delete this FAQ?")) return;
            try {
              await fetchJson("/client/catalog/faq/" + button.dataset.deleteFaq, { method: "DELETE" });
              await loadDashboardData();
            } catch (error) {
              setError(error.message);
            }
          });
        });
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
            { label: "Type", render: (row) => row.record_type === "order_intent" ? "Order intent" : (row.record_type === "draft_order" ? "Draft order" : "Handoff") },
            { label: "Customer", render: (row) => row.customer_name || row.session_id || "—" },
            { label: "Interest", render: (row) => row.product_interest || "—" },
            { label: "Qty", render: (row) => row.quantity || "—" },
            { label: "Amount", render: (row) => row.record_type === "draft_order" && row.total_amount != null ? formatTenantMoney(row.total_amount, row.currency_code || state.overview?.tenant?.currency_code) : "—" },
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
            { metric: "Order Intents", value: state.performance.order_intents || 0 },
            { metric: "Draft Orders", value: state.performance.draft_orders || 0 },
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
        document.getElementById("auth-entry").style.display = "none";
        document.getElementById("auth-form-shell").classList.add("visible");
        document.getElementById("signup-tab").classList.toggle("active", name === "signup");
        document.getElementById("login-tab").classList.toggle("active", name === "login");
        document.getElementById("signup-panel").classList.toggle("visible", name === "signup");
        document.getElementById("login-panel").classList.toggle("visible", name === "login");
        setAuthMessage("");
      }

      function showAuthEntry() {
        document.getElementById("auth-entry").style.display = "grid";
        document.getElementById("auth-form-shell").classList.remove("visible");
        document.getElementById("signup-panel").classList.remove("visible");
        document.getElementById("login-panel").classList.remove("visible");
        document.getElementById("signup-tab").classList.remove("active");
        document.getElementById("login-tab").classList.remove("active");
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
          await loadSession();
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

      document.getElementById("open-signup").addEventListener("click", function () {
        openTab("signup");
      });

      document.getElementById("open-login").addEventListener("click", function () {
        openTab("login");
      });

      document.getElementById("auth-back").addEventListener("click", function () {
        showAuthEntry();
      });

      document.getElementById("signup-panel").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          setAuthMessage("");
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          if (payload.password !== payload.confirm_password) {
            throw new Error("Password and confirm password must match");
          }
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

      document.getElementById("logout-button").addEventListener("click", async function () {
        try {
          await postJson("/client/auth/logout");
        } catch (error) {
          // no-op: local logout should still clear the session
        }
        setToken("");
        state.session = null;
        state.catalog = { products: [], faqs: [] };
        showShell("auth");
        showAuthEntry();
        setAuthMessage("You have been logged out.", "success");
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

      document.getElementById("product-import-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          setOnboardingMessage("");
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          await postJson("/client/onboarding/catalog/import", payload);
          event.target.reset();
          setOnboardingMessage("Products imported into your catalog.", "success");
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

      document.getElementById("catalog-management-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          const productId = payload.product_id;
          delete payload.product_id;
          if (productId) {
            await fetchJson("/client/catalog/product/" + productId, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
          } else {
            await postJson("/client/onboarding/catalog/product", payload);
          }
          await loadDashboardData();
        } catch (error) {
          setError(error.message);
        }
      });

      document.getElementById("catalog-import-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          await postJson("/client/onboarding/catalog/import", payload);
          event.target.reset();
          await loadDashboardData();
        } catch (error) {
          setError(error.message);
        }
      });

      document.getElementById("cancel-product-edit").addEventListener("click", function () {
        resetManagedProductForm();
      });

      document.getElementById("faq-management-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          const faqId = payload.faq_id;
          delete payload.faq_id;
          if (faqId) {
            await fetchJson("/client/catalog/faq/" + faqId, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
          } else {
            await postJson("/client/onboarding/catalog/faq", payload);
          }
          await loadDashboardData();
        } catch (error) {
          setError(error.message);
        }
      });

      document.getElementById("cancel-faq-edit").addEventListener("click", function () {
        resetManagedFaqForm();
      });

      document.getElementById("settings-profile-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          await postJson("/client/onboarding/profile", payload);
          await loadSession();
          await loadDashboardData();
          setSettingsEditing("profile", false);
        } catch (error) {
          setError(error.message);
        }
      });

      document.getElementById("settings-availability-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        try {
          const form = new FormData(event.target);
          const payload = Object.fromEntries(form.entries());
          await postJson("/client/onboarding/availability", payload);
          await loadSession();
          await loadDashboardData();
          setSettingsEditing("availability", false);
        } catch (error) {
          setError(error.message);
        }
      });

      document.getElementById("edit-profile-settings").addEventListener("click", function () {
        setSettingsEditing("profile", true);
      });

      document.getElementById("cancel-profile-settings").addEventListener("click", function () {
        if (state.session?.tenant) {
          renderOnboarding();
        }
        setSettingsEditing("profile", false);
      });

      document.getElementById("edit-availability-settings").addEventListener("click", function () {
        setSettingsEditing("availability", true);
      });

      document.getElementById("cancel-availability-settings").addEventListener("click", function () {
        if (state.session?.tenant) {
          renderOnboarding();
        }
        setSettingsEditing("availability", false);
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

      document.getElementById("client-confirm-connection").addEventListener("click", async function () {
        try {
          setOnboardingMessage("");
          await postJson("/client/onboarding/confirm-connection");
          setOnboardingMessage("Your connection is now confirmed and your workspace is active.", "success");
          await loadSession();
        } catch (error) {
          setOnboardingMessage(error.message, "error");
        }
      });

      document.getElementById("onboarding-progress-strip").addEventListener("click", async function (event) {
        const button = event.target.closest("#progress-confirm-connection");
        if (!button) {
          return;
        }

        try {
          button.disabled = true;
          button.textContent = "Confirming...";
          await postJson("/client/onboarding/confirm-connection");
          await loadSession();
        } catch (error) {
          setError(error.message);
          button.disabled = false;
          button.textContent = "Confirm Connection";
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
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store"
    });
    res.type("html").send(buildClientPortalHtml());
  });

  router.post("/auth/signup", async (req, res) => {
    try {
      const businessName = safeText(req.body.business_name);
      const ownerName = safeText(req.body.owner_name);
      const ownerEmail = normalizeEmail(req.body.owner_email);
      const password = safeText(req.body.password);
      const confirmPassword = safeText(req.body.confirm_password);

      if (!businessName || !ownerName || !ownerEmail || !password) {
        return res.status(400).json({ error: "Business name, owner name, email, and password are required" });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: "Password should be at least 8 characters" });
      }

      if (password !== confirmPassword) {
        return res.status(400).json({ error: "Password and confirm password must match" });
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

  router.post("/auth/logout", async (req, res) => {
    res.json({ ok: true });
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

  router.get("/catalog", async (req, res) => {
    try {
      const [productsResult, faqsResult] = await Promise.all([
        supabase
          .from("products")
          .select("*")
          .eq("tenant_id", req.tenant.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("faqs")
          .select("*")
          .eq("tenant_id", req.tenant.id)
          .order("created_at", { ascending: false })
      ]);

      if (productsResult.error) {
        throw productsResult.error;
      }

      if (faqsResult.error) {
        throw faqsResult.error;
      }

      res.json({
        products: productsResult.data || [],
        faqs: faqsResult.data || []
      });
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
        currency_code: normalizeCurrencyCode(req.body.currency_code || req.tenant.currency_code),
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
        image_url: safeText(req.body.image_url),
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

  router.post("/onboarding/catalog/import", async (req, res) => {
    try {
      const rows = parseProductImportText(req.body.products_text);
      if (rows.length === 0) {
        return res.status(400).json({ error: "Add at least one valid product line to import" });
      }

      const insertPayload = rows.map((row) => ({
        tenant_id: req.tenant.id,
        name: row.name,
        description: row.description,
        price: row.price,
        regular_price: null,
        category: row.category,
        in_stock: true,
        sizes_in_stock: [],
        product_url: row.product_url,
        image_url: row.image_url,
        color: row.color
      }));

      const { data, error } = await supabase
        .from("products")
        .insert(insertPayload)
        .select("*");

      if (error) {
        throw error;
      }

      res.status(201).json({ products: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put("/catalog/product/:productId", async (req, res) => {
    try {
      const updatePayload = {
        name: safeText(req.body.name),
        description: safeText(req.body.description),
        price: Number(req.body.price),
        regular_price: req.body.regular_price === "" || req.body.regular_price == null ? null : Number(req.body.regular_price),
        category: safeText(req.body.category),
        color: safeText(req.body.color),
        product_url: safeText(req.body.product_url),
        image_url: safeText(req.body.image_url)
      };

      const { data, error } = await supabase
        .from("products")
        .update(updatePayload)
        .eq("id", req.params.productId)
        .eq("tenant_id", req.tenant.id)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res.json({ product: data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete("/catalog/product/:productId", async (req, res) => {
    try {
      const { error } = await supabase
        .from("products")
        .delete()
        .eq("id", req.params.productId)
        .eq("tenant_id", req.tenant.id);

      if (error) {
        throw error;
      }

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.put("/catalog/faq/:faqId", async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("faqs")
        .update({
          question: safeText(req.body.question),
          answer: safeText(req.body.answer)
        })
        .eq("id", req.params.faqId)
        .eq("tenant_id", req.tenant.id)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res.json({ faq: data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.delete("/catalog/faq/:faqId", async (req, res) => {
    try {
      const { error } = await supabase
        .from("faqs")
        .delete()
        .eq("id", req.params.faqId)
        .eq("tenant_id", req.tenant.id);

      if (error) {
        throw error;
      }

      res.json({ ok: true });
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

  router.post("/onboarding/confirm-connection", async (req, res) => {
    try {
      if (!req.tenant.admin_connection_confirmed) {
        return res.status(400).json({ error: "The DigiMaya admin team has not confirmed your Instagram connection yet" });
      }

      const { data, error } = await supabase
        .from("tenants")
        .update({
          client_connection_confirmed: true,
          activation_status: "active"
        })
        .eq("id", req.tenant.id)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      res.json({ tenant: data, activated: true });
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
