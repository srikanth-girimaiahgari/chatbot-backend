const crypto = require("crypto");
const express = require("express");

function timingSafeEqualBase64(a, b) {
  try {
    const left = Buffer.from(String(a || ""), "utf8");
    const right = Buffer.from(String(b || ""), "utf8");
    if (left.length !== right.length) {
      return false;
    }
    return crypto.timingSafeEqual(left, right);
  } catch (error) {
    return false;
  }
}

function computeShopifyHmac(secret, rawBody) {
  return crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
}

function extractWebhookContext(req) {
  return {
    topic: req.headers["x-shopify-topic"] || "unknown",
    storeDomain: String(req.headers["x-shopify-shop-domain"] || "").toLowerCase(),
    webhookEventId: req.headers["x-shopify-event-id"] || req.headers["x-shopify-webhook-id"] || null,
    receivedHmac: req.headers["x-shopify-hmac-sha256"] || ""
  };
}

async function findTenantForWebhook(supabase, storeDomain) {
  if (!storeDomain) {
    return null;
  }

  const { data, error } = await supabase
    .from("tenants")
    .select("id,business_name,shopify_store_domain,shopify_webhook_secret,shopify_webhook_status")
    .eq("shopify_store_domain", storeDomain)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

function resolveWebhookSecret(tenant) {
  return tenant?.shopify_webhook_secret || process.env.SHOPIFY_WEBHOOK_SECRET || null;
}

function normalizePayload(rawBody) {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    return {
      _parse_error: error.message,
      _raw: rawBody.toString("utf8")
    };
  }
}

function getPayloadOrderId(payload) {
  if (!payload) {
    return null;
  }
  return payload.admin_graphql_api_id || (payload.id ? String(payload.id) : null);
}

function getPayloadOrderNumber(payload) {
  if (!payload) {
    return null;
  }
  return payload.order_number != null
    ? String(payload.order_number)
    : payload.name || null;
}

function normalizeFinancialStatus(payload) {
  return String(
    payload?.financial_status ||
    payload?.display_financial_status ||
    payload?.payment_status ||
    ""
  ).toLowerCase();
}

function extractNoteAttributes(payload) {
  const raw = payload?.note_attributes || payload?.noteAttributes || [];
  if (!Array.isArray(raw)) {
    return {};
  }

  return raw.reduce((acc, entry) => {
    const key = entry?.name || entry?.key;
    const value = entry?.value;
    if (key) {
      acc[String(key)] = value == null ? "" : String(value);
    }
    return acc;
  }, {});
}

async function updateOrderFromWebhook({
  supabase,
  tenant,
  topic,
  payload
}) {
  const attributes = extractNoteAttributes(payload);
  const linkedOrderId = attributes.digimaya_order_id || null;

  if (!linkedOrderId) {
    return {
      matched: false,
      reason: "No digimaya_order_id found in Shopify order attributes"
    };
  }

  const financialStatus = normalizeFinancialStatus(payload);
  const shopifyOrderId = getPayloadOrderId(payload);
  const shopifyOrderNumber = getPayloadOrderNumber(payload);
  const isPaidEvent = topic === "orders/paid" || financialStatus === "paid";
  const nextStatus = isPaidEvent ? "confirmed" : "order_created";
  const nextPaymentStatus = isPaidEvent
    ? "paid"
    : financialStatus || "pending";
  const timestamp = new Date().toISOString();

  const updatePayload = {
    status: nextStatus,
    payment_status: nextPaymentStatus,
    shopify_order_id: shopifyOrderId,
    shopify_order_number: shopifyOrderNumber,
    updated_at: timestamp
  };

  if (isPaidEvent) {
    updatePayload.confirmed_at = timestamp;
  }

  const { data: updatedOrder, error: orderError } = await supabase
    .from("orders")
    .update(updatePayload)
    .eq("tenant_id", tenant.id)
    .eq("id", linkedOrderId)
    .select("id,status,payment_status,shopify_order_id,shopify_order_number,confirmed_at")
    .maybeSingle();

  if (orderError) {
    throw orderError;
  }

  if (!updatedOrder) {
    return {
      matched: false,
      reason: `Linked DigiMaya order ${linkedOrderId} was not found for tenant`
    };
  }

  const cartUpdate = {
    status: isPaidEvent ? "paid" : "order_created",
    shopify_order_id: shopifyOrderId,
    updated_at: timestamp
  };

  if (topic === "orders/create" || isPaidEvent) {
    cartUpdate.checkout_completed_at = timestamp;
  }

  if (isPaidEvent) {
    cartUpdate.paid_at = timestamp;
  }

  const { error: cartError } = await supabase
    .from("shopify_carts")
    .update(cartUpdate)
    .eq("tenant_id", tenant.id)
    .eq("order_id", linkedOrderId);

  if (cartError) {
    throw cartError;
  }

  return {
    matched: true,
    order: updatedOrder
  };
}

async function logWebhookEvent({
  supabase,
  tenant,
  topic,
  storeDomain,
  webhookEventId,
  hmacVerified,
  payload,
  status,
  processingError
}) {
  const { error } = await supabase
    .from("shopify_webhook_events")
    .insert({
      tenant_id: tenant?.id || null,
      topic,
      shopify_store_domain: storeDomain || "unknown",
      webhook_event_id: webhookEventId,
      hmac_verified: Boolean(hmacVerified),
      payload,
      status,
      processing_error: processingError || null,
      processed_at: new Date().toISOString()
    });

  if (error) {
    throw error;
  }

  if (tenant?.id && hmacVerified) {
    const { error: tenantError } = await supabase
      .from("tenants")
      .update({
        shopify_webhook_status: "verified",
        shopify_last_webhook_at: new Date().toISOString()
      })
      .eq("id", tenant.id);

    if (tenantError) {
      throw tenantError;
    }
  }
}

function createShopifyWebhookRouter({ supabase }) {
  const router = express.Router();

  router.post("/shopify", express.raw({ type: "application/json" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const payload = normalizePayload(rawBody);
    const { topic, storeDomain, webhookEventId, receivedHmac } = extractWebhookContext(req);

    try {
      const tenant = await findTenantForWebhook(supabase, storeDomain);

      if (!tenant) {
        await logWebhookEvent({
          supabase,
          tenant: null,
          topic,
          storeDomain,
          webhookEventId,
          hmacVerified: false,
          payload,
          status: "rejected",
          processingError: "No tenant found for Shopify store domain"
        });

        return res.status(404).json({ error: "No tenant found for Shopify store domain" });
      }

      const secret = resolveWebhookSecret(tenant);
      if (!secret) {
        await logWebhookEvent({
          supabase,
          tenant,
          topic,
          storeDomain,
          webhookEventId,
          hmacVerified: false,
          payload,
          status: "rejected",
          processingError: "Shopify webhook secret is not configured"
        });

        return res.status(503).json({ error: "Shopify webhook secret is not configured" });
      }

      const expectedHmac = computeShopifyHmac(secret, rawBody);
      const verified = timingSafeEqualBase64(receivedHmac, expectedHmac);

      if (!verified) {
        await logWebhookEvent({
          supabase,
          tenant,
          topic,
          storeDomain,
          webhookEventId,
          hmacVerified: false,
          payload,
          status: "rejected",
          processingError: "Invalid Shopify HMAC"
        });

        return res.status(401).json({ error: "Invalid Shopify HMAC" });
      }

      const confirmation = await updateOrderFromWebhook({
        supabase,
        tenant,
        topic,
        payload
      });

      await logWebhookEvent({
        supabase,
        tenant,
        topic,
        storeDomain,
        webhookEventId,
        hmacVerified: true,
        payload,
        status: confirmation.matched ? "processed" : "verified",
        processingError: confirmation.matched ? null : confirmation.reason
      });

      return res.status(200).json({
        received: true,
        verified: true,
        topic,
        store_domain: storeDomain,
        tenant_id: tenant.id,
        matched_order: confirmation.matched,
        order_id: confirmation.order?.id || null,
        order_status: confirmation.order?.status || null,
        payment_status: confirmation.order?.payment_status || null
      });
    } catch (error) {
      console.error("Shopify webhook error:", error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  createShopifyWebhookRouter
};
