require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const { connectCall } = require("./call-agent");
const { router: smsAgent, init: initSmsAgent } = require("./sms-agent");
const { createProviderAdminRouter } = require("./provider-admin");
const { createClientPortalRouter } = require("./client-portal");
const { createShopifyWebhookRouter } = require("./shopify-webhooks");
const { fetchTenantShopifyProducts, createTenantShopifyCartFromIntent, buildShopifyShortTitle } = require("./shopify-service");
const {
  buildMayaSystemPrompt,
  findMatchingProducts,
  buildProductResponse,
  buildBudgetRecommendationResponse,
  buildCollectionResponse,
  buildCategoryListingResponse,
  buildBrowseListingResponse
} = require("./maya-sales-agent");

const app = express();
app.use(cors());

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY;

if (!supabaseKey) {
  throw new Error("Supabase key is not configured");
}

const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

app.use("/webhooks", createShopifyWebhookRouter({ supabase }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

initSmsAgent(supabase, anthropic, require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN));
app.use("/admin", createProviderAdminRouter({ supabase }));
app.use("/client", createClientPortalRouter({ supabase, resend }));

function buildConversationHistory(recentChats, latestMessage) {
  const history = recentChats
    ? recentChats.reverse().map((m) => ({ role: m.role, content: m.content }))
    : [];

  history.push({ role: "user", content: latestMessage });
  return history;
}

function getDirectProductReply(products, latestMessage, tenant) {
  const matches = findMatchingProducts(products, latestMessage);
  if (matches.length !== 1) {
    return null;
  }

  return buildProductResponse(matches[0], latestMessage, tenant);
}

function getDirectBudgetReply(products, latestMessage, tenant) {
  return buildBudgetRecommendationResponse(products, latestMessage, tenant);
}

function getDirectCollectionReply(products, latestMessage, tenant) {
  return buildCollectionResponse(products, latestMessage, tenant);
}

function getDirectCategoryReply(products, latestMessage) {
  return buildCategoryListingResponse(products, latestMessage);
}

function getDirectBrowseReply(products, latestMessage) {
  return buildBrowseListingResponse(products, latestMessage);
}

function parseTimeParts(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})/);
  if (!match) {
    return null;
  }

  return {
    hours: Number(match[1]),
    minutes: Number(match[2])
  };
}

function isWithinTenantResponseWindow(tenant) {
  const start = parseTimeParts(tenant.response_window_start);
  const end = parseTimeParts(tenant.response_window_end);
  if (!start || !end) {
    return true;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone || "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(new Date());
  const currentHours = Number(parts.find((part) => part.type === "hour")?.value || "0");
  const currentMinutes = Number(parts.find((part) => part.type === "minute")?.value || "0");
  const currentTotal = currentHours * 60 + currentMinutes;
  const startTotal = start.hours * 60 + start.minutes;
  const endTotal = end.hours * 60 + end.minutes;

  if (startTotal <= endTotal) {
    return currentTotal >= startTotal && currentTotal <= endTotal;
  }

  return currentTotal >= startTotal || currentTotal <= endTotal;
}

function applyLeadAvailabilityReply(reply, tenant) {
  if (isWithinTenantResponseWindow(tenant)) {
    return reply;
  }

  const offHoursReply = tenant.off_hours_reply || "Our team is currently offline, but DigiMaya has noted your message and we’ll get back to you as soon as we’re available.";
  return `${reply}\n\n${offHoursReply}`.trim();
}

function normalizeMessageForChecks(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLowInformationMessage(message) {
  const normalized = normalizeMessageForChecks(message);
  if (!normalized) return true;
  const genericPhrases = [
    "hi",
    "hello",
    "hey",
    "price",
    "details",
    "send details",
    "more details",
    "ok",
    "okay",
    "yes",
    "send",
    "info"
  ];
  return normalized.split(" ").length <= 3 || genericPhrases.includes(normalized);
}

function detectAutomationLoop(recentChats, latestMessage) {
  const recentUserMessages = [latestMessage]
    .concat((recentChats || []).filter((chat) => chat.role === "user").map((chat) => chat.content))
    .slice(0, 4)
    .map(normalizeMessageForChecks)
    .filter(Boolean);

  if (recentUserMessages.length < 3) {
    return false;
  }

  const uniqueMessages = new Set(recentUserMessages);
  const allLowInformation = recentUserMessages.every(isLowInformationMessage);
  const mostlyRepeated = uniqueMessages.size <= 2;

  return allLowInformation && mostlyRepeated;
}

function countLeadSignals(message) {
  const normalized = normalizeMessageForChecks(message);
  const signals = [
    "price",
    "cost",
    "how much",
    "buy",
    "order",
    "payment",
    "available",
    "delivery",
    "shipping",
    "link",
    "image",
    "photo",
    "picture",
    "size",
    "color",
    "reserve",
    "urgent",
    "call",
    "whatsapp"
  ];

  return signals.reduce((total, signal) => total + (normalized.includes(signal) ? 1 : 0), 0);
}

function parseQuantity(value) {
  const match = String(value || "").match(/\d+/);
  const quantity = match ? Number(match[0]) : 1;
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
}

function parsePurchaseIntentPayload(reply) {
  if (!reply.includes("HANDOFF_READY|")) {
    return null;
  }

  const parts = reply.split("HANDOFF_READY|")[1].split("|");
  return {
    customerName: parts[0] || "",
    occasion: parts[1] || "",
    contactMethod: parts[2] || "",
    contactDetail: parts[3] || "",
    productInterest: parts[4] || "",
    quantity: parseQuantity(parts[5])
  };
}

function parseShoppingIntentPayload(reply) {
  const match = String(reply || "").match(/SHOPPING_INTENT_JSON:(\{[\s\S]*\})\s*$/);
  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[1]);
    return {
      action: String(parsed.action || "").trim(),
      productInterest: String(parsed.product_interest || "").trim(),
      quantity: parseQuantity(parsed.quantity),
      customerName: String(parsed.customer_name || "").trim(),
      occasion: String(parsed.occasion || "").trim(),
      contactMethod: String(parsed.contact_method || "").trim(),
      contactDetail: String(parsed.contact_detail || "").trim()
    };
  } catch (error) {
    console.error("Shopping intent parse error:", error.message);
    return null;
  }
}

function stripAssistantControlMarkers(reply) {
  return String(reply || "")
    .replace(/HANDOFF_READY\|[^\n]*/g, "")
    .replace(/SHOPPING_INTENT_JSON:(\{[\s\S]*\})\s*$/g, "")
    .trim();
}

function normalizeLookupText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitRequestedProducts(productInterest) {
  return String(productInterest || "")
    .split(/,|\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function resolveTenantForScopedRequest({ tenantId, sourceLabel }) {
  const normalizedTenantId = String(tenantId || "").trim();
  if (normalizedTenantId) {
    const { data: tenant, error } = await supabase
      .from("tenants")
      .select("*")
      .eq("id", normalizedTenantId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!tenant) {
      throw createHttpError(404, `Tenant not found for ${sourceLabel}`);
    }

    return tenant;
  }

  const { data: tenants, error } = await supabase
    .from("tenants")
    .select("*")
    .limit(2);

  if (error) {
    throw error;
  }

  if ((tenants || []).length === 1) {
    return tenants[0];
  }

  if ((tenants || []).length === 0) {
    throw createHttpError(404, `No tenants configured for ${sourceLabel}`);
  }

  throw createHttpError(400, `${sourceLabel} requires tenant_id because multiple tenants are configured`);
}

function getScopedTenantId(req) {
  return (
    req.body?.tenant_id ||
    req.query?.tenant_id ||
    req.headers["x-tenant-id"] ||
    ""
  );
}

function mapShopifyProductsForConversation(products = []) {
  return (products || []).map((product) => {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const firstAvailableVariant = variants.find((variant) => variant.available_for_sale) || variants[0] || null;
    const shortName = product.short_title || buildShopifyShortTitle(product.title) || product.title;

    return {
      name: shortName,
      full_name: product.title,
      description: variants.length
        ? `Available variants: ${variants.slice(0, 6).map((variant) => variant.title).join(", ")}`
        : "Available on Shopify",
      price: firstAvailableVariant?.price_amount ?? 0,
      in_stock: Boolean((product.total_inventory ?? 0) > 0 || firstAvailableVariant?.available_for_sale),
      sizes_in_stock: variants.map((variant) => variant.title).filter(Boolean),
      product_url: product.online_store_url || null,
      image_url: null,
      category: [],
      style: [],
      occasion: []
    };
  });
}

async function loadTenantConversationCatalog(tenant) {
  const { data: localProducts, error: localProductsError } = await supabase
    .from("products")
    .select("*")
    .eq("tenant_id", tenant.id)
    .eq("in_stock", true);

  if (localProductsError) {
    throw localProductsError;
  }

  const localCatalog = localProducts || [];
  if (localCatalog.length > 0 || !tenant?.shopify_store_domain || !tenant?.shopify_storefront_access_token) {
    return localCatalog;
  }

  const shopifyCatalog = await fetchTenantShopifyProducts({
    supabase,
    tenantId: tenant.id,
    limit: 25
  });

  return mapShopifyProductsForConversation(shopifyCatalog.products || []);
}

function resolveProductAgainstCatalog(products, productInterest) {
  if (!productInterest) {
    return null;
  }

  const rows = products || [];
  const normalizedInterest = normalizeLookupText(productInterest);
  const exact = rows.find((product) => {
    const normalizedName = normalizeLookupText(product.name);
    const normalizedFullName = normalizeLookupText(product.full_name);
    return normalizedName === normalizedInterest || normalizedFullName === normalizedInterest;
  });
  if (exact) {
    return exact;
  }

  return rows.find((product) => {
    const normalizedName = normalizeLookupText(product.name);
    const normalizedFullName = normalizeLookupText(product.full_name);
    return (
      normalizedInterest.includes(normalizedName) ||
      normalizedName.includes(normalizedInterest) ||
      normalizedInterest.includes(normalizedFullName) ||
      normalizedFullName.includes(normalizedInterest)
    );
  }) || null;
}

async function resolveProductsForIntent(tenantId, productInterest, requestedQuantity) {
  if (!tenantId || !productInterest) {
    return [];
  }

  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, price")
      .eq("tenant_id", tenantId)
      .eq("in_stock", true)
      .limit(100);

    if (error) {
      throw error;
    }

    const requestedItems = splitRequestedProducts(productInterest);
    const resolvedItems = requestedItems
      .map((requestedName) => {
        const matchedProduct = resolveProductAgainstCatalog(products || [], requestedName);
        if (!matchedProduct) {
          return null;
        }

        return {
          requested_name: requestedName,
          product_id: matchedProduct.id,
          product_name: matchedProduct.name,
          quantity: 1,
          unit_price: matchedProduct.price == null ? null : Number(matchedProduct.price)
        };
      })
      .filter(Boolean);

    if (resolvedItems.length > 1 && requestedQuantity && requestedQuantity !== resolvedItems.length) {
      const firstItem = resolvedItems[0];
      resolvedItems.splice(0, resolvedItems.length, {
        ...firstItem,
        requested_name: productInterest,
        quantity: requestedQuantity
      });
    }

    if (resolvedItems.length === 1) {
      resolvedItems[0].quantity = requestedQuantity || resolvedItems[0].quantity;
    }

    return resolvedItems.map((item) => ({
      ...item,
      line_total: item.unit_price == null ? null : Number((item.unit_price * item.quantity).toFixed(2))
    }));
  } catch (error) {
    console.error("Product resolution error:", error.message);
    return [];
  }
}

async function notifyLeadOwners(subject, text, tenant) {
  const recipients = Array.from(new Set(
    [tenant.lead_contact_email, tenant.owner_email, process.env.ALERT_EMAIL]
      .filter(Boolean)
  ));

  if (recipients.length === 0) {
    return;
  }

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: recipients,
    subject,
    text
  });
}

async function upsertOrderIntent({ tenant, sessionId, channel, latestMessage, intent }) {
  try {
    if (!tenant?.id) {
      return null;
    }

    const unresolvedStatuses = ["captured", "contact_collected", "awaiting_payment", "draft"];
    const now = new Date().toISOString();
    const payload = {
      tenant_id: tenant.id,
      session_id: sessionId,
      channel,
      customer_name: intent.customerName || null,
      occasion: intent.occasion || null,
      contact_method: intent.contactMethod || null,
      contact_detail: intent.contactDetail || null,
      product_interest: intent.productInterest || null,
      quantity: intent.quantity || 1,
      source_message: latestMessage,
      updated_at: now
    };

    const { data: existingIntent, error: fetchError } = await supabase
      .from("order_intents")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("session_id", sessionId)
      .in("status", unresolvedStatuses)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      throw fetchError;
    }

    if (existingIntent?.id) {
      const { data, error } = await supabase
        .from("order_intents")
        .update(payload)
        .eq("id", existingIntent.id)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      return data;
    }

    const { data, error } = await supabase
      .from("order_intents")
      .insert({
        ...payload,
        status: "captured",
        created_at: now
      })
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    return data;
  } catch (error) {
    console.error("Order intent capture error:", error.message);
    return null;
  }
}

async function upsertDraftOrder({ tenant, sessionId, channel, latestMessage, intent, orderIntentId }) {
  try {
    if (!tenant?.id) {
      return null;
    }

    const unresolvedStatuses = ["draft", "awaiting_payment", "payment_sent"];
    const now = new Date().toISOString();
    const resolvedItems = await resolveProductsForIntent(tenant.id, intent.productInterest, intent.quantity || 1);
    const totalQuantity = resolvedItems.length > 0
      ? resolvedItems.reduce((sum, item) => sum + (item.quantity || 0), 0)
      : (intent.quantity || 1);
    const totalAmount = resolvedItems.length > 0 && resolvedItems.every((item) => item.line_total != null)
      ? Number(resolvedItems.reduce((sum, item) => sum + item.line_total, 0).toFixed(2))
      : null;
    const primaryItem = resolvedItems.length === 1 ? resolvedItems[0] : null;
    const payload = {
      tenant_id: tenant.id,
      order_intent_id: orderIntentId || null,
      session_id: sessionId,
      channel,
      customer_name: intent.customerName || null,
      contact_method: intent.contactMethod || null,
      contact_detail: intent.contactDetail || null,
      product_interest: intent.productInterest || null,
      quantity: totalQuantity,
      product_id: primaryItem?.product_id || null,
      currency_code: tenant.currency_code || "INR",
      unit_price: primaryItem?.unit_price ?? null,
      total_amount: totalAmount,
      payment_status: "not_started",
      source_message: latestMessage,
      updated_at: now
    };

    const { data: existingOrder, error: fetchError } = await supabase
      .from("orders")
      .select("id")
      .eq("tenant_id", tenant.id)
      .eq("session_id", sessionId)
      .in("status", unresolvedStatuses)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fetchError) {
      throw fetchError;
    }

    if (existingOrder?.id) {
      const { data, error } = await supabase
        .from("orders")
        .update(payload)
        .eq("id", existingOrder.id)
        .select("*")
        .single();

      if (error) {
        throw error;
      }

      await supabase.from("order_items").delete().eq("order_id", data.id);
      if (resolvedItems.length > 0) {
        const { error: itemsError } = await supabase
          .from("order_items")
          .insert(resolvedItems.map((item) => ({
            order_id: data.id,
            product_id: item.product_id || null,
            product_name: item.product_name || item.requested_name,
            quantity: item.quantity || 1,
            unit_price: item.unit_price,
            line_total: item.line_total
          })));

        if (itemsError) {
          throw itemsError;
        }
      }

      return data;
    }

    const { data, error } = await supabase
      .from("orders")
      .insert({
        ...payload,
        status: "draft",
        created_at: now
      })
      .select("*")
      .single();

    if (error) {
      throw error;
    }

    if (resolvedItems.length > 0) {
      const { error: itemsError } = await supabase
        .from("order_items")
        .insert(resolvedItems.map((item) => ({
          order_id: data.id,
          product_id: item.product_id || null,
          product_name: item.product_name || item.requested_name,
          quantity: item.quantity || 1,
          unit_price: item.unit_price,
          line_total: item.line_total
        })));

      if (itemsError) {
        throw itemsError;
      }
    }

    return data;
  } catch (error) {
    console.error("Draft order capture error:", error.message);
    return null;
  }
}

function tenantSupportsShopifyCheckout(tenant) {
  return Boolean(tenant?.shopify_store_domain && tenant?.shopify_storefront_access_token);
}

function buildShopifyCheckoutReply(order, checkoutUrl, cart) {
  const totalLabel = order?.total_amount && order?.currency_code
    ? `${order.currency_code} ${Number(order.total_amount).toFixed(2)}`
    : cart?.total_amount && cart?.currency_code
      ? `${cart.currency_code} ${Number(cart.total_amount).toFixed(2)}`
      : "the total shown at checkout";

  return `Perfect, here’s your checkout link:\n${checkoutUrl}\nTotal: ${totalLabel}\nPayment confirms the order.`;
}

async function maybeCreateShopifyCheckout({
  tenant,
  sessionId,
  channel,
  latestMessage,
  orderIntent,
  shoppingIntent
}) {
  if (!tenantSupportsShopifyCheckout(tenant)) {
    return { success: false, reason: "shopify_not_configured" };
  }

  if (!shoppingIntent || shoppingIntent.action !== "create_checkout") {
    return { success: false, reason: "no_checkout_action" };
  }

  const normalizedIntent = {
    customerName: shoppingIntent.customerName || orderIntent?.customerName || "",
    occasion: shoppingIntent.occasion || orderIntent?.occasion || "",
    contactMethod: shoppingIntent.contactMethod || orderIntent?.contactMethod || "",
    contactDetail: shoppingIntent.contactDetail || orderIntent?.contactDetail || "",
    productInterest: shoppingIntent.productInterest || orderIntent?.productInterest || "",
    quantity: shoppingIntent.quantity || orderIntent?.quantity || 1
  };

  if (!normalizedIntent.productInterest) {
    return { success: false, reason: "missing_product_interest" };
  }

  const savedOrderIntent = await upsertOrderIntent({
    tenant,
    sessionId,
    channel,
    latestMessage,
    intent: normalizedIntent
  });

  const savedOrder = await upsertDraftOrder({
    tenant,
    sessionId,
    channel,
    latestMessage,
    intent: normalizedIntent,
    orderIntentId: savedOrderIntent?.id
  });

  if (!savedOrder?.id) {
    return { success: false, reason: "draft_order_failed" };
  }

  try {
    const checkout = await createTenantShopifyCartFromIntent({
      supabase,
      tenantId: tenant.id,
      orderId: savedOrder.id,
      sessionId,
      channel
      ,
      productInterest: normalizedIntent.productInterest,
      quantity: normalizedIntent.quantity
    });

    if (!checkout?.cart?.shopify_checkout_url) {
      return { success: false, reason: "missing_checkout_url", order: savedOrder };
    }

    await supabase
      .from("orders")
      .update({
        status: "checkout_ready",
        updated_at: new Date().toISOString()
      })
      .eq("id", savedOrder.id);

    return {
      success: true,
      order: checkout.order || savedOrder,
      cart: checkout.cart,
      checkoutUrl: checkout.cart.shopify_checkout_url
    };
  } catch (error) {
    console.error("Shopify checkout creation error:", error.message);
    return { success: false, reason: error.message, order: savedOrder };
  }
}

async function maybeCreateHotLeadAlert({ sessionId, tenant, latestMessage, recentChats, matchedProducts, channel }) {
  const totalTurns = (recentChats?.length || 0) + 1;
  const signalCount = countLeadSignals(latestMessage);
  const shouldAlert = totalTurns >= 10 || signalCount >= 3;

  if (!shouldAlert) {
    return;
  }

  const { data: existingAlert, error: existingError } = await supabase
    .from("handoff_requests")
    .select("id")
    .eq("tenant_id", tenant.id)
    .eq("session_id", sessionId)
    .eq("reason", "hot_lead")
    .eq("status", "pending")
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  if (existingAlert) {
    return;
  }

  const productInterest = matchedProducts?.[0]?.name || "";
  const reason = totalTurns >= 10 ? "Conversation crossed 10 turns" : "Strong buyer intent detected";

  await supabase.from("handoff_requests").insert({
    session_id: sessionId,
    reason: "hot_lead",
    status: "pending",
    product_interest: productInterest,
    tenant_id: tenant.id
  });

  await notifyLeadOwners(
    `Hot lead for ${tenant.business_name}`,
    [
      `Channel: ${channel}`,
      `Business: ${tenant.business_name}`,
      `Reason: ${reason}`,
      `Latest message: ${latestMessage}`,
      `Product interest: ${productInterest || "Not identified yet"}`
    ].join("\n"),
    tenant
  );
}

app.get("/", (req, res) => {
  res.json({ status: "Chatbot backend is running!" });
});

const VERIFY_TOKEN      = process.env.VERIFY_TOKEN || "maya_verify_token";
const IG_ACCESS_TOKEN   = process.env.IG_ACCESS_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN   = process.env.WA_ACCESS_TOKEN;

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified ✅");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("Webhook event received:", JSON.stringify(body, null, 2));

  // Must respond 200 quickly so Meta doesn't retry
  res.sendStatus(200);

  // ── Instagram DMs ────────────────────────────────────────────────
 // ── Instagram DMs ────────────────────────────────────────────────
if (body.object === "instagram") {
  for (const entry of body.entry || []) {

    // Look up which tenant owns this Instagram account
  const { data: tenant, error } = await supabase
  .from("tenants")
  .select("*")
  .eq("ig_business_id", entry.id)
  .maybeSingle();
console.log("Searching for ig_business_id:", JSON.stringify(entry.id));
console.log("Tenant lookup — entry.id:", entry.id, "| tenant found:", tenant?.business_name, "| error:", error?.message);
    if (!tenant) {
      console.log(`[Instagram] No tenant found for ig_business_id: ${entry.id}`);
      continue;
    }

    for (const event of entry.messaging || []) {
      const senderId    = event.sender?.id;
      const messageText = event.message?.text;
      if (event.message?.is_echo) continue;
      if (!messageText) continue;
      console.log(`[Instagram] Message from ${senderId} → tenant: ${tenant.business_name}`);
      const mayaReply = await getMayaReplyForInstagram(senderId, messageText, tenant);
      await sendReply(senderId, mayaReply, tenant.ig_access_token);
    }
  }
  return;
}
  
 // ── WhatsApp Business DMs ────────────────────────────────────────
if (body.object === "whatsapp_business_account") {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "messages") continue;

      // Look up which tenant owns this WhatsApp number
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      const { data: tenant } = await supabase
        .from("tenants")
        .select("*")
        .eq("wa_phone_number_id", phoneNumberId)
        .maybeSingle();

      if (!tenant) {
        console.log(`[WhatsApp] No tenant found for phone_number_id: ${phoneNumberId}`);
        continue;
      }

      const messages = change.value?.messages || [];
      for (const msg of messages) {
        if (msg.type !== "text") continue;
        const senderPhone = msg.from;
        const messageText = msg.text?.body;
        if (!messageText) continue;
        console.log(`[WhatsApp] Message from ${senderPhone} → tenant: ${tenant.business_name}`);
        const mayaReply = await getMayaReplyForWhatsApp(senderPhone, messageText, tenant);
        await sendWhatsAppReply(senderPhone, mayaReply, tenant.wa_access_token, tenant.wa_phone_number_id);
      }
    }
  }
  return;
}
});

async function getMayaReplyForInstagram(senderId, messageText, tenant) {
  try {
    // Get or build conversation history from Supabase
    const { data: recentChats } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", senderId)
      .order("created_at", { ascending: false })
      .limit(10);

    // Save incoming message
    await supabase.from("chat_messages").insert({
      session_id: senderId,
      role: "user",
      content: messageText,
      tenant_id: tenant.id,
    });

    const products = await loadTenantConversationCatalog(tenant);
    const { data: faqs }     = await supabase.from("faqs").select("*").eq("tenant_id", tenant.id);
    const matchedProducts = findMatchingProducts(products, messageText);

    if (detectAutomationLoop(recentChats, messageText)) {
      const loopReply = "Happy to help when you're ready with a specific product, price, image, or order question.";
      await supabase.from("chat_messages").insert({
        session_id: senderId,
        role: "assistant",
        content: loopReply,
        tenant_id: tenant.id,
      });
      return loopReply;
    }

    await maybeCreateHotLeadAlert({
      sessionId: senderId,
      tenant,
      latestMessage: messageText,
      recentChats,
      matchedProducts,
      channel: "Instagram DM"
    });

    const directReply =
      getDirectCategoryReply(products, messageText) ||
      getDirectBrowseReply(products, messageText) ||
      getDirectProductReply(products, messageText, tenant) ||
      getDirectBudgetReply(products, messageText, tenant) ||
      getDirectCollectionReply(products, messageText, tenant);
    if (directReply) {
      await supabase.from("chat_messages").insert({
        session_id: senderId,
        role: "assistant",
        content: directReply,
        tenant_id: tenant.id,
      });
      return directReply;
    }

    const conversationHistory = buildConversationHistory(recentChats, messageText);
    const systemPrompt = buildMayaSystemPrompt({
      products,
      faqs,
      tenant,
      contextLabel: "Instagram DM",
      recentChats: recentChats || [],
      latestMessage: messageText
    });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: systemPrompt,
      messages: conversationHistory,
    });

    let reply = response.content[0].text;
    const shoppingIntent = parseShoppingIntentPayload(reply);
    const orderIntent = parsePurchaseIntentPayload(reply);
    const cleanReply = stripAssistantControlMarkers(reply);

    if (shoppingIntent?.action === "create_checkout") {
      const checkout = await maybeCreateShopifyCheckout({
        tenant,
        sessionId: senderId,
        channel: "instagram",
        latestMessage: messageText,
        orderIntent,
        shoppingIntent
      });

      if (checkout.success && checkout.checkoutUrl) {
        reply = buildShopifyCheckoutReply(checkout.order, checkout.checkoutUrl, checkout.cart);
      } else if (orderIntent) {
        const savedOrderIntent = await upsertOrderIntent({
          tenant,
          sessionId: senderId,
          channel: "instagram",
          latestMessage: messageText,
          intent: orderIntent
        });
        await upsertDraftOrder({
          tenant,
          sessionId: senderId,
          channel: "instagram",
          latestMessage: messageText,
          intent: orderIntent,
          orderIntentId: savedOrderIntent?.id
        });
        reply = applyLeadAvailabilityReply(cleanReply, tenant);
      } else {
        reply = applyLeadAvailabilityReply(cleanReply, tenant);
      }
    } else if (orderIntent) {
      const savedOrderIntent = await upsertOrderIntent({
        tenant,
        sessionId: senderId,
        channel: "instagram",
        latestMessage: messageText,
        intent: orderIntent
      });
      await upsertDraftOrder({
        tenant,
        sessionId: senderId,
        channel: "instagram",
        latestMessage: messageText,
        intent: orderIntent,
        orderIntentId: savedOrderIntent?.id
      });
      reply = applyLeadAvailabilityReply(cleanReply, tenant);
    }

    // Save MAYA's reply to history
    await supabase.from("chat_messages").insert({
      session_id: senderId,
      role: "assistant",
      content: reply,
      tenant_id: tenant.id,
    });

    return reply;

  } catch (err) {
    console.error("MAYA reply error:", err.message);
    return "Hey! Thanks for reaching out 👋 I'll have someone from the team get back to you shortly!";
  }
}

async function sendReply(recipientId, text, accessToken) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    });

    const options = {
      hostname: "graph.instagram.com",
      path: `/v21.0/me/messages?access_token=${accessToken}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const https = require("https");
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        console.log("Reply sent:", data);
        resolve();
      });
    });

    req.on("error", (err) => {
      console.error("Failed to send reply:", err.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

// ── WhatsApp: Maya AI reply ───────────────────────────────────────────────────
async function getMayaReplyForWhatsApp(senderPhone, messageText, tenant) {
  // Use "wa_" prefix so WhatsApp sessions never collide with Instagram sessions
  const sessionId = "wa_" + senderPhone;

  try {
    const { data: recentChats } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(10);

    await supabase.from("chat_messages").insert({
      session_id: sessionId,
      role: "user",
      content: messageText,
      tenant_id: tenant.id,
    });

    const products = await loadTenantConversationCatalog(tenant);
    const { data: faqs }     = await supabase.from("faqs").select("*").eq("tenant_id", tenant.id);
    const matchedProducts = findMatchingProducts(products, messageText);

    if (detectAutomationLoop(recentChats, messageText)) {
      const loopReply = "Happy to help when you're ready with a specific product, price, image, or order question.";
      await supabase.from("chat_messages").insert({
        session_id: sessionId,
        role: "assistant",
        content: loopReply,
        tenant_id: tenant.id,
      });
      return loopReply;
    }

    await maybeCreateHotLeadAlert({
      sessionId,
      tenant,
      latestMessage: messageText,
      recentChats,
      matchedProducts,
      channel: "WhatsApp"
    });

    const directReply =
      getDirectCategoryReply(products, messageText) ||
      getDirectBrowseReply(products, messageText) ||
      getDirectProductReply(products, messageText, tenant) ||
      getDirectBudgetReply(products, messageText, tenant) ||
      getDirectCollectionReply(products, messageText, tenant);
    if (directReply) {
      await supabase.from("chat_messages").insert({
        session_id: sessionId,
        role: "assistant",
        content: directReply,
        tenant_id: tenant.id,
      });
      return directReply;
    }

    const conversationHistory = buildConversationHistory(recentChats, messageText);
    const systemPrompt = buildMayaSystemPrompt({
      products,
      faqs,
      tenant,
      contextLabel: "WhatsApp",
      recentChats: recentChats || [],
      latestMessage: messageText
    });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: systemPrompt,
      messages: conversationHistory,
    });

    let reply = response.content[0].text;
    const shoppingIntent = parseShoppingIntentPayload(reply);
    const orderIntent = parsePurchaseIntentPayload(reply);
    const cleanReply = stripAssistantControlMarkers(reply);

    if (shoppingIntent?.action === "create_checkout") {
      const checkout = await maybeCreateShopifyCheckout({
        tenant,
        sessionId,
        channel: "whatsapp",
        latestMessage: messageText,
        orderIntent,
        shoppingIntent
      });

      if (checkout.success && checkout.checkoutUrl) {
        reply = buildShopifyCheckoutReply(checkout.order, checkout.checkoutUrl, checkout.cart);
      } else if (orderIntent) {
        const savedOrderIntent = await upsertOrderIntent({
          tenant,
          sessionId,
          channel: "whatsapp",
          latestMessage: messageText,
          intent: orderIntent
        });
        await upsertDraftOrder({
          tenant,
          sessionId,
          channel: "whatsapp",
          latestMessage: messageText,
          intent: orderIntent,
          orderIntentId: savedOrderIntent?.id
        });
        reply = applyLeadAvailabilityReply(cleanReply, tenant);
      } else {
        reply = applyLeadAvailabilityReply(cleanReply, tenant);
      }
    } else if (orderIntent) {
      const savedOrderIntent = await upsertOrderIntent({
        tenant,
        sessionId,
        channel: "whatsapp",
        latestMessage: messageText,
        intent: orderIntent
      });
      await upsertDraftOrder({
        tenant,
        sessionId,
        channel: "whatsapp",
        latestMessage: messageText,
        intent: orderIntent,
        orderIntentId: savedOrderIntent?.id
      });
      reply = applyLeadAvailabilityReply(cleanReply, tenant);
    }

    await supabase.from("chat_messages").insert({
      session_id: sessionId,
      role: "assistant",
      content: reply,
      tenant_id: tenant.id,
    });

    return reply;

  } catch (err) {
    console.error("MAYA WhatsApp reply error:", err.message);
    return "Hey! Thanks for reaching out 👋 I'll have someone from our team get back to you shortly!";
  }
}

// ── WhatsApp: send reply via Cloud API ───────────────────────────────────────
async function sendWhatsAppReply(toPhone, text, accessToken, phoneNumberId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "text",
      text: { body: text },
    });

    const options = {
      hostname: "graph.facebook.com",
      path: `/v21.0/${phoneNumberId}/messages`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${accessToken}`,
      },
    };

    const https = require("https");
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        console.log("WhatsApp reply sent:", data);
        resolve();
      });
    });

    req.on("error", (err) => {
      console.error("Failed to send WhatsApp reply:", err.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

app.get("/products", async (req, res) => {
  const { search } = req.query;
  try {
    const tenant = await resolveTenantForScopedRequest({
      tenantId: getScopedTenantId(req),
      sourceLabel: "/products"
    });

    let query = supabase.from("products").select("*").eq("tenant_id", tenant.id);
    if (search) { query = query.ilike("name", "%" + search + "%"); }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ tenant_id: tenant.id, products: data });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.use("/", smsAgent);

app.post("/call/connect", require("./call-agent").handleConnect);

app.delete("/cleanup/:session_id", async (req, res) => {
  const { session_id } = req.params;
  await supabase.from("handoff_requests").delete().eq("session_id", session_id);
  await supabase.from("chat_messages").delete().eq("session_id", session_id);
  res.json({ message: "Session cleaned up: " + session_id });
});

app.post("/dev/tenants/:tenantId/chat", async (req, res) => {
  const { tenantId } = req.params;
  const { message, session_id, channel } = req.body || {};

  if (!message || !session_id) {
    return res.status(400).json({ error: "message and session_id are required" });
  }

  try {
    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .select("*")
      .eq("id", tenantId)
      .maybeSingle();

    if (tenantError) {
      throw tenantError;
    }

    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found" });
    }

    const normalizedChannel = String(channel || "instagram").toLowerCase();
    let reply;
    let effectiveSessionId = session_id;

    if (normalizedChannel === "whatsapp") {
      const senderPhone = String(session_id || "").replace(/^wa_/, "");
      effectiveSessionId = senderPhone;
      reply = await getMayaReplyForWhatsApp(senderPhone, message, tenant);
    } else {
      reply = await getMayaReplyForInstagram(session_id, message, tenant);
    }

    res.json({
      tenant_id: tenant.id,
      channel: normalizedChannel,
      session_id: normalizedChannel === "whatsapp" ? `wa_${effectiveSessionId}` : effectiveSessionId,
      reply
    });
  } catch (err) {
    console.error("Dev tenant chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/chat", async (req, res) => {
  const { message, session_id } = req.body;
  if (!message || !session_id) {
    return res.status(400).json({ error: "message and session_id are required" });
  }

  try {
    const tenant = await resolveTenantForScopedRequest({
      tenantId: getScopedTenantId(req),
      sourceLabel: "/chat"
    });

    await supabase.from("chat_messages").insert({
      session_id,
      role: "user",
      content: message,
      tenant_id: tenant.id
    });

    const { data: products } = await supabase
      .from("products")
      .select("*")
      .eq("tenant_id", tenant.id)
      .eq("in_stock", true);
    const { data: faqs } = await supabase
      .from("faqs")
      .select("*")
      .eq("tenant_id", tenant.id);
    const { data: recentChats } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", session_id)
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(10);

    const matchedProducts = findMatchingProducts(products, message);

    if (detectAutomationLoop(recentChats, message)) {
      const loopReply = "Happy to help when you're ready with a specific product, price, image, or order question.";
      await supabase.from("chat_messages").insert({
        session_id,
        role: "assistant",
        content: loopReply,
        tenant_id: tenant.id
      });
      return res.json({ tenant_id: tenant.id, reply: loopReply });
    }

    const directReply =
      getDirectCategoryReply(products, message) ||
      getDirectBrowseReply(products, message) ||
      getDirectProductReply(products, message, tenant) ||
      getDirectBudgetReply(products, message, tenant) ||
      getDirectCollectionReply(products, message, tenant);

    if (directReply) {
      await supabase.from("chat_messages").insert({
        session_id,
        role: "assistant",
        content: directReply,
        tenant_id: tenant.id
      });
      return res.json({ tenant_id: tenant.id, reply: directReply });
    }

    const conversationHistory = buildConversationHistory(recentChats, message);
    const systemPrompt = buildMayaSystemPrompt({
      products,
      faqs,
      tenant,
      contextLabel: "Website chat",
      recentChats: recentChats || [],
      latestMessage: message
    });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: conversationHistory,
      system: systemPrompt,
    });

    let reply = response.content[0].text;

    const orderIntent = parsePurchaseIntentPayload(reply);
    if (orderIntent) {
      const savedOrderIntent = await upsertOrderIntent({
        tenant,
        sessionId,
        channel: "website",
        latestMessage: message,
        intent: orderIntent
      });
      await upsertDraftOrder({
        tenant,
        sessionId,
        channel: "website",
        latestMessage: message,
        intent: orderIntent,
        orderIntentId: savedOrderIntent?.id
      });
      reply = reply.split("HANDOFF_READY|")[0].trim();
    }

    if (reply.includes("HUMAN_HANDOFF|")) {
      await supabase.from("handoff_requests").insert({
        session_id,
        tenant_id: tenant.id,
        reason: "customer_request",
        status: "pending",
      });

      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: process.env.ALERT_EMAIL,
        subject: "Human Handoff Request",
        text: "A customer needs human support.\nSession: " + session_id,
      });

      reply = reply.split("HUMAN_HANDOFF|")[0].trim();
    }

    await supabase.from("chat_messages").insert({
      session_id,
      role: "assistant",
      content: reply,
      tenant_id: tenant.id
    });
    res.json({ tenant_id: tenant.id, reply });

  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get("/handoff", async (req, res) => {
  try {
    const { data, error } = await supabase.from("handoff_requests").select("*").eq("status", "pending").order("created_at", { ascending: true });
    if (error) throw error;
    res.json({ queue: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log("Chatbot backend is running!");
});
