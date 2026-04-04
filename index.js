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
const {
  buildMayaSystemPrompt,
  findMatchingProducts,
  buildProductResponse,
  buildBudgetRecommendationResponse
} = require("./maya-sales-agent");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY;

if (!supabaseKey) {
  throw new Error("Supabase key is not configured");
}

const supabase = createClient(process.env.SUPABASE_URL, supabaseKey);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

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
    const payload = {
      tenant_id: tenant.id,
      order_intent_id: orderIntentId || null,
      session_id: sessionId,
      channel,
      customer_name: intent.customerName || null,
      contact_method: intent.contactMethod || null,
      contact_detail: intent.contactDetail || null,
      product_interest: intent.productInterest || null,
      quantity: intent.quantity || 1,
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

    return data;
  } catch (error) {
    console.error("Draft order capture error:", error.message);
    return null;
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

    const { data: products } = await supabase.from("products").select("*").eq("tenant_id", tenant.id).eq("in_stock", true);
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

    const directReply = getDirectProductReply(products, messageText, tenant) || getDirectBudgetReply(products, messageText, tenant);
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

    // Handle handoff trigger
    const orderIntent = parsePurchaseIntentPayload(reply);
    if (orderIntent) {
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
      reply = applyLeadAvailabilityReply(reply.split("HANDOFF_READY|")[0].trim(), tenant);
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

    const { data: products } = await supabase.from("products").select("*").eq("tenant_id", tenant.id).eq("in_stock", true);
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

    const directReply = getDirectProductReply(products, messageText, tenant) || getDirectBudgetReply(products, messageText, tenant);
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

    // Handle handoff trigger
    const orderIntent = parsePurchaseIntentPayload(reply);
    if (orderIntent) {
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
      reply = applyLeadAvailabilityReply(reply.split("HANDOFF_READY|")[0].trim(), tenant);
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
    let query = supabase.from("products").select("*");
    if (search) { query = query.ilike("name", "%" + search + "%"); }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ products: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

app.post("/chat", async (req, res) => {
  const { message, session_id } = req.body;
  if (!message || !session_id) {
    return res.status(400).json({ error: "message and session_id are required" });
  }

  try {
    await supabase.from("chat_messages").insert({ session_id, role: "user", content: message });

    const { data: products } = await supabase.from("products").select("*").eq("in_stock", true);
    const { data: faqs } = await supabase.from("faqs").select("*");
    const { data: recentChats } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", session_id)
      .order("created_at", { ascending: false })
      .limit(10);

    const matchedProducts = findMatchingProducts(products, message);

    if (detectAutomationLoop(recentChats, message)) {
      const loopReply = "Happy to help when you're ready with a specific product, price, image, or order question.";
      await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: loopReply });
      return res.json({ reply: loopReply });
    }

    const directReply = getDirectProductReply(products, message, {}) || getDirectBudgetReply(products, message, {});
    if (directReply) {
      await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: directReply });
      return res.json({ reply: directReply });
    }

    const conversationHistory = buildConversationHistory(recentChats, message);
    const systemPrompt = buildMayaSystemPrompt({
      products,
      faqs,
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
        tenant: { id: null },
        sessionId,
        channel: "website",
        latestMessage: message,
        intent: orderIntent
      });
      await upsertDraftOrder({
        tenant: { id: null },
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

    await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
    res.json({ reply });

  } catch (err) {
    res.status(500).json({ error: err.message });
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
