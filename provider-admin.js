const express = require("express");
const path = require("path");
const {
  fetchTenantShopifyProducts,
  createTenantShopifyCartFromOrder,
  createTenantShopifyCartFromIntent,
  updateTenantShopifyCartFromOrder,
  getTenantShopifyCheckoutUrl
} = require("./shopify-service");

function formatTimestamp(value) {
  return value || null;
}

function requireAdminToken(req, res, next) {
  const configuredToken = process.env.ADMIN_API_TOKEN;
  if (!configuredToken) {
    return res.status(503).json({
      error: "ADMIN_API_TOKEN is not configured"
    });
  }

  const bearer = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : null;
  const headerToken = req.headers["x-admin-token"];
  const queryToken = req.query.token;
  const providedToken = bearer || headerToken || queryToken;

  if (providedToken !== configuredToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

async function getTenantCatalogCounts(supabase, tenantId) {
  const [productsResult, faqsResult] = await Promise.all([
    supabase.from("products").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
    supabase.from("faqs").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId)
  ]);

  return {
    productsCount: productsResult.count || 0,
    faqsCount: faqsResult.count || 0
  };
}

async function getTenantMessageMetrics(supabase, tenantId) {
  const [messagesResult, inboundRecentResult, outboundRecentResult] = await Promise.all([
    supabase
      .from("chat_messages")
      .select("id, role, created_at", { count: "exact" })
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("chat_messages")
      .select("created_at")
      .eq("tenant_id", tenantId)
      .eq("role", "user")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("chat_messages")
      .select("created_at")
      .eq("tenant_id", tenantId)
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
  ]);

  const rows = messagesResult.data || [];
  const inboundCount = rows.filter((row) => row.role === "user").length;
  const outboundCount = rows.filter((row) => row.role === "assistant").length;

  return {
    totalMessages: messagesResult.count || 0,
    inboundCount,
    outboundCount,
    lastInboundAt: formatTimestamp(inboundRecentResult.data?.created_at),
    lastReplyAt: formatTimestamp(outboundRecentResult.data?.created_at)
  };
}

async function getTenantHandoffMetrics(supabase, tenantId) {
  const [handoffsResult, pendingResult] = await Promise.all([
    supabase
      .from("handoff_requests")
      .select("id, status, created_at", { count: "exact" })
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("handoff_requests")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
  ]);

  return {
    totalHandoffs: handoffsResult.count || 0,
    pendingHandoffs: pendingResult.count || 0,
    lastHandoffAt: formatTimestamp(handoffsResult.data?.[0]?.created_at || null)
  };
}

async function getTenantOrderIntentMetrics(supabase, tenantId) {
  const { data, count, error } = await supabase
    .from("order_intents")
    .select("id, created_at", { count: "exact" })
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    throw error;
  }

  return {
    totalOrderIntents: count || 0,
    lastOrderIntentAt: formatTimestamp(data?.[0]?.created_at || null)
  };
}

async function getTenantOrderMetrics(supabase, tenantId) {
  const { data, count, error } = await supabase
    .from("orders")
    .select("id, created_at", { count: "exact" })
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    throw error;
  }

  return {
    totalOrders: count || 0,
    lastOrderAt: formatTimestamp(data?.[0]?.created_at || null)
  };
}

function buildTenantHealth({ tenant, catalogCounts, messageMetrics, handoffMetrics }) {
  const warnings = [];

  if (!tenant.ig_business_id || !tenant.ig_access_token) {
    warnings.push("instagram_not_connected");
  }

  if (catalogCounts.productsCount === 0) {
    warnings.push("no_products");
  }

  if (catalogCounts.faqsCount === 0) {
    warnings.push("no_faqs");
  }

  if (messageMetrics.inboundCount > 0 && messageMetrics.outboundCount === 0) {
    warnings.push("inbound_without_replies");
  }

  if (messageMetrics.totalMessages === 0) {
    warnings.push("no_message_history");
  }

  const status = warnings.length === 0
    ? "healthy"
    : warnings.some((warning) => ["instagram_not_connected", "no_products", "no_faqs"].includes(warning))
      ? "needs_setup"
      : "needs_attention";

  return {
    status,
    warnings
  };
}

async function buildTenantSnapshot(supabase, tenant) {
  const [catalogCounts, messageMetrics, handoffMetrics, orderIntentMetrics, orderMetrics] = await Promise.all([
    getTenantCatalogCounts(supabase, tenant.id),
    getTenantMessageMetrics(supabase, tenant.id),
    getTenantHandoffMetrics(supabase, tenant.id),
    getTenantOrderIntentMetrics(supabase, tenant.id),
    getTenantOrderMetrics(supabase, tenant.id)
  ]);

  const health = buildTenantHealth({
    tenant,
    catalogCounts,
    messageMetrics,
    handoffMetrics
  });

  return {
    id: tenant.id,
    business_name: tenant.business_name,
    owner_name: tenant.owner_name || null,
    owner_email: tenant.owner_email || null,
    active: tenant.active,
    plan: tenant.plan,
    onboarding_status: tenant.onboarding_status || "signup_pending",
    activation_status: tenant.activation_status || "setup_incomplete",
    admin_connection_confirmed: Boolean(tenant.admin_connection_confirmed),
    client_connection_confirmed: Boolean(tenant.client_connection_confirmed),
    created_at: formatTimestamp(tenant.created_at),
    instagram_connected: Boolean(tenant.ig_business_id && tenant.ig_access_token),
    whatsapp_connected: Boolean(tenant.wa_phone_number_id && tenant.wa_access_token),
    shopify_connected: Boolean(tenant.shopify_store_domain && tenant.shopify_storefront_access_token),
    shopify_store_domain: tenant.shopify_store_domain || null,
    shopify_connection_status: tenant.shopify_connection_status || "not_connected",
    shopify_webhook_status: tenant.shopify_webhook_status || "not_configured",
    shopify_connected_at: formatTimestamp(tenant.shopify_connected_at),
    shopify_last_webhook_at: formatTimestamp(tenant.shopify_last_webhook_at),
    catalog: catalogCounts,
    messages: messageMetrics,
    handoffs: handoffMetrics,
    order_intents: orderIntentMetrics,
    orders: orderMetrics,
    health
  };
}

function buildSheetsExportPayload({ summary, tenants }) {
  const exportedAt = new Date().toISOString();

  return {
    exported_at: exportedAt,
    summary,
    sheets: {
      tenants: tenants.map((tenant) => ({
        tenant_id: tenant.id,
        business_name: tenant.business_name,
        active: tenant.active,
        plan: tenant.plan,
        instagram_connected: tenant.instagram_connected,
        whatsapp_connected: tenant.whatsapp_connected,
        products_count: tenant.catalog.productsCount,
        faqs_count: tenant.catalog.faqsCount,
        health_status: tenant.health.status,
        warnings: tenant.health.warnings.join(", "),
        last_inbound_at: tenant.messages.lastInboundAt || "",
        last_reply_at: tenant.messages.lastReplyAt || "",
        total_messages: tenant.messages.totalMessages,
        inbound_count: tenant.messages.inboundCount,
        outbound_count: tenant.messages.outboundCount,
        total_handoffs: tenant.handoffs.totalHandoffs,
        pending_handoffs: tenant.handoffs.pendingHandoffs,
        last_handoff_at: tenant.handoffs.lastHandoffAt || ""
      })),
      health: tenants.map((tenant) => ({
        tenant_id: tenant.id,
        business_name: tenant.business_name,
        health_status: tenant.health.status,
        warnings: tenant.health.warnings.join(", "),
        setup_ready: tenant.catalog.productsCount > 0 && tenant.catalog.faqsCount > 0 && tenant.instagram_connected,
        instagram_connected: tenant.instagram_connected,
        whatsapp_connected: tenant.whatsapp_connected,
        products_count: tenant.catalog.productsCount,
        faqs_count: tenant.catalog.faqsCount,
        total_messages: tenant.messages.totalMessages
      })),
      messages: tenants.map((tenant) => ({
        tenant_id: tenant.id,
        business_name: tenant.business_name,
        total_messages: tenant.messages.totalMessages,
        inbound_count: tenant.messages.inboundCount,
        outbound_count: tenant.messages.outboundCount,
        last_inbound_at: tenant.messages.lastInboundAt || "",
        last_reply_at: tenant.messages.lastReplyAt || ""
      })),
      handoffs: tenants.map((tenant) => ({
        tenant_id: tenant.id,
        business_name: tenant.business_name,
        pending_handoffs: tenant.handoffs.pendingHandoffs,
        total_handoffs: tenant.handoffs.totalHandoffs,
        last_handoff_at: tenant.handoffs.lastHandoffAt || "",
        total_order_intents: tenant.order_intents.totalOrderIntents,
        last_order_intent_at: tenant.order_intents.lastOrderIntentAt || "",
        total_orders: tenant.orders.totalOrders,
        last_order_at: tenant.orders.lastOrderAt || ""
      })),
      daily_summary: [
        {
          exported_at: exportedAt,
          tenants_count: summary.tenants_count,
          active_tenants: summary.active_tenants,
          products_count: summary.products_count,
          faqs_count: summary.faqs_count,
          messages_count: summary.messages_count,
          handoffs_count: summary.handoffs_count,
          order_intents_count: summary.order_intents_count,
          orders_count: summary.orders_count,
          pending_handoffs: summary.pending_handoffs,
          tenants_needing_attention: tenants.filter((tenant) => tenant.health.status !== "healthy").length
        }
      ]
    }
  };
}

function createProviderAdminRouter({ supabase }) {
  const router = express.Router();
  const dashboardHtmlPath = path.join(__dirname, "provider-dashboard.html");
  const dashboardCssPath = path.join(__dirname, "provider-dashboard.css");
  const dashboardJsPath = path.join(__dirname, "provider-dashboard.js");

  router.get("/dashboard", (req, res) => {
    res.sendFile(dashboardHtmlPath);
  });

  router.get("/assets/dashboard.css", (req, res) => {
    res.type("text/css").sendFile(dashboardCssPath);
  });

  router.get("/assets/dashboard.js", (req, res) => {
    res.type("application/javascript").sendFile(dashboardJsPath);
  });

  router.use(requireAdminToken);

  router.get("/overview", async (req, res) => {
    try {
      const [tenantsResult, productsResult, faqsResult, messagesResult, handoffsResult, pendingHandoffsResult, orderIntentsResult, ordersResult] = await Promise.all([
        supabase.from("tenants").select("*", { count: "exact", head: true }),
        supabase.from("products").select("*", { count: "exact", head: true }),
        supabase.from("faqs").select("*", { count: "exact", head: true }),
        supabase.from("chat_messages").select("*", { count: "exact", head: true }),
        supabase.from("handoff_requests").select("*", { count: "exact", head: true }),
        supabase.from("handoff_requests").select("*", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("order_intents").select("*", { count: "exact", head: true }),
        supabase.from("orders").select("*", { count: "exact", head: true })
      ]);

      const { data: tenants, error: tenantsError } = await supabase
        .from("tenants")
        .select("*")
        .order("created_at", { ascending: true });

      if (tenantsError) {
        throw tenantsError;
      }

      const snapshots = await Promise.all((tenants || []).map((tenant) => buildTenantSnapshot(supabase, tenant)));
      const summary = {
        tenants_count: tenantsResult.count || 0,
        active_tenants: (tenants || []).filter((tenant) => tenant.active).length,
        products_count: productsResult.count || 0,
        faqs_count: faqsResult.count || 0,
        messages_count: messagesResult.count || 0,
        handoffs_count: handoffsResult.count || 0,
        order_intents_count: orderIntentsResult.count || 0,
        orders_count: ordersResult.count || 0,
        pending_handoffs: pendingHandoffsResult.count || 0
      };

      res.json({
        summary,
        tenants: snapshots
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/exports/google-sheets", async (req, res) => {
    try {
      const [tenantsResult, productsResult, faqsResult, messagesResult, handoffsResult, pendingHandoffsResult, orderIntentsResult, ordersResult] = await Promise.all([
        supabase.from("tenants").select("*", { count: "exact", head: true }),
        supabase.from("products").select("*", { count: "exact", head: true }),
        supabase.from("faqs").select("*", { count: "exact", head: true }),
        supabase.from("chat_messages").select("*", { count: "exact", head: true }),
        supabase.from("handoff_requests").select("*", { count: "exact", head: true }),
        supabase.from("handoff_requests").select("*", { count: "exact", head: true }).eq("status", "pending"),
        supabase.from("order_intents").select("*", { count: "exact", head: true }),
        supabase.from("orders").select("*", { count: "exact", head: true })
      ]);

      const { data: tenants, error } = await supabase
        .from("tenants")
        .select("*")
        .order("created_at", { ascending: true });

      if (error) {
        throw error;
      }

      const snapshots = await Promise.all((tenants || []).map((tenant) => buildTenantSnapshot(supabase, tenant)));
      const summary = {
        tenants_count: tenantsResult.count || 0,
        active_tenants: (tenants || []).filter((tenant) => tenant.active).length,
        products_count: productsResult.count || 0,
        faqs_count: faqsResult.count || 0,
        messages_count: messagesResult.count || 0,
        handoffs_count: handoffsResult.count || 0,
        order_intents_count: orderIntentsResult.count || 0,
        orders_count: ordersResult.count || 0,
        pending_handoffs: pendingHandoffsResult.count || 0
      };

      res.json(buildSheetsExportPayload({
        summary,
        tenants: snapshots
      }));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/tenants", async (req, res) => {
    try {
      const { data: tenants, error } = await supabase
        .from("tenants")
        .select("*")
        .order("created_at", { ascending: true });

      if (error) {
        throw error;
      }

      const snapshots = await Promise.all((tenants || []).map((tenant) => buildTenantSnapshot(supabase, tenant)));
      res.json({ tenants: snapshots });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/tenants/:tenantId", async (req, res) => {
    try {
      const { tenantId } = req.params;
      const tenantResult = await supabase
        .from("tenants")
        .select("*")
        .eq("id", tenantId)
        .maybeSingle();

      if (tenantResult.error) {
        throw tenantResult.error;
      }

      if (!tenantResult.data) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const tenant = tenantResult.data;
      const snapshot = await buildTenantSnapshot(supabase, tenant);

      const [recentMessagesResult, recentHandoffsResult, recentOrderIntentsResult, recentOrdersResult, recentOrderItemsResult, topProductsResult, topFaqsResult] = await Promise.all([
        supabase
          .from("chat_messages")
          .select("id, session_id, role, content, created_at, tenant_id")
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("handoff_requests")
          .select("*")
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("order_intents")
          .select("*")
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("orders")
          .select("*")
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(20),
        supabase
          .from("order_items")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50),
        supabase
          .from("products")
          .select("id,name,price,in_stock,regular_price,discount_percentage,product_url,image_url,color,shopify_product_gid,shopify_variant_gid,shopify_inventory_item_gid,shopify_synced_at")
          .eq("tenant_id", tenantId)
          .order("price", { ascending: false })
          .limit(20),
        supabase
          .from("faqs")
          .select("id,question,answer")
          .eq("tenant_id", tenantId)
          .limit(20)
      ]);

      res.json({
        tenant: snapshot,
        recent_messages: recentMessagesResult.data || [],
        recent_handoffs: recentHandoffsResult.data || [],
        recent_order_intents: recentOrderIntentsResult.data || [],
        recent_orders: recentOrdersResult.data || [],
        recent_order_items: (recentOrderItemsResult.data || []).filter((item) =>
          (recentOrdersResult.data || []).some((order) => order.id === item.order_id)
        ),
        products: topProductsResult.data || [],
        faqs: topFaqsResult.data || []
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/tenants/:tenantId/confirm-connection", async (req, res) => {
    try {
      const { tenantId } = req.params;
      const { data, error } = await supabase
        .from("tenants")
        .update({
          admin_connection_confirmed: true,
          activation_status: "awaiting_client_confirmation"
        })
        .eq("id", tenantId)
        .select("id,business_name,admin_connection_confirmed,client_connection_confirmed,activation_status")
        .single();

      if (error) {
        throw error;
      }

      res.json({ tenant: data, confirmed: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/handoffs", async (req, res) => {
    try {
      let query = supabase
        .from("handoff_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

      if (req.query.tenant_id) {
        query = query.eq("tenant_id", req.query.tenant_id);
      }

      if (req.query.status) {
        query = query.eq("status", req.query.status);
      }

      const { data, error } = await query;
      if (error) {
        throw error;
      }

      res.json({ handoffs: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/activity", async (req, res) => {
    try {
      let query = supabase
        .from("chat_messages")
        .select("id, session_id, role, content, created_at, tenant_id")
        .order("created_at", { ascending: false })
        .limit(100);

      if (req.query.tenant_id) {
        query = query.eq("tenant_id", req.query.tenant_id);
      }

      const { data, error } = await query;
      if (error) {
        throw error;
      }

      res.json({ messages: data || [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/tenants/:tenantId/shopify/config", async (req, res) => {
    try {
      const { tenantId } = req.params;
      const { data, error } = await supabase
        .from("tenants")
        .select("id,business_name,shopify_store_domain,shopify_connection_status,shopify_webhook_status,shopify_connected_at,shopify_last_sync_at,shopify_last_webhook_at,shopify_default_location_gid,shopify_storefront_access_token,shopify_admin_access_token,shopify_webhook_secret")
        .eq("id", tenantId)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      res.json({
        tenant_id: data.id,
        business_name: data.business_name,
        shopify_store_domain: data.shopify_store_domain || null,
        shopify_connection_status: data.shopify_connection_status || "not_connected",
        shopify_webhook_status: data.shopify_webhook_status || "not_configured",
        shopify_connected_at: formatTimestamp(data.shopify_connected_at),
        shopify_last_sync_at: formatTimestamp(data.shopify_last_sync_at),
        shopify_last_webhook_at: formatTimestamp(data.shopify_last_webhook_at),
        shopify_default_location_gid: data.shopify_default_location_gid || null,
        storefront_token_configured: Boolean(data.shopify_storefront_access_token),
        admin_token_configured: Boolean(data.shopify_admin_access_token),
        webhook_secret_configured: Boolean(data.shopify_webhook_secret)
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.patch("/tenants/:tenantId/shopify/config", async (req, res) => {
    try {
      const { tenantId } = req.params;
      const updates = {};
      const allowedFields = [
        "shopify_store_domain",
        "shopify_storefront_access_token",
        "shopify_admin_access_token",
        "shopify_webhook_secret",
        "shopify_connection_status",
        "shopify_webhook_status",
        "shopify_default_location_gid"
      ];

      allowedFields.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
          updates[field] = req.body[field];
        }
      });

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No Shopify config fields were provided" });
      }

      const hasStoreConnection =
        (typeof updates.shopify_store_domain === "string" ? updates.shopify_store_domain : undefined) ||
        (typeof updates.shopify_storefront_access_token === "string" ? updates.shopify_storefront_access_token : undefined);

      if (hasStoreConnection) {
        updates.shopify_connected_at = new Date().toISOString();
        if (!updates.shopify_connection_status) {
          updates.shopify_connection_status = "configured";
        }
      }

      const { data, error } = await supabase
        .from("tenants")
        .update(updates)
        .eq("id", tenantId)
        .select("id,business_name,shopify_store_domain,shopify_connection_status,shopify_webhook_status,shopify_connected_at,shopify_last_webhook_at,shopify_default_location_gid,shopify_storefront_access_token,shopify_admin_access_token,shopify_webhook_secret")
        .single();

      if (error) {
        throw error;
      }

      res.json({
        tenant_id: data.id,
        business_name: data.business_name,
        shopify_store_domain: data.shopify_store_domain || null,
        shopify_connection_status: data.shopify_connection_status || "not_connected",
        shopify_webhook_status: data.shopify_webhook_status || "not_configured",
        shopify_connected_at: formatTimestamp(data.shopify_connected_at),
        shopify_last_webhook_at: formatTimestamp(data.shopify_last_webhook_at),
        shopify_default_location_gid: data.shopify_default_location_gid || null,
        storefront_token_configured: Boolean(data.shopify_storefront_access_token),
        admin_token_configured: Boolean(data.shopify_admin_access_token),
        webhook_secret_configured: Boolean(data.shopify_webhook_secret)
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.patch("/tenants/:tenantId/products/:productId/shopify-mapping", async (req, res) => {
    try {
      const { tenantId, productId } = req.params;
      const updates = {};
      const allowedFields = [
        "shopify_product_gid",
        "shopify_variant_gid",
        "shopify_inventory_item_gid"
      ];

      allowedFields.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
          updates[field] = req.body[field];
        }
      });

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No Shopify mapping fields were provided" });
      }

      updates.shopify_synced_at = new Date().toISOString();

      const { data, error } = await supabase
        .from("products")
        .update(updates)
        .eq("tenant_id", tenantId)
        .eq("id", productId)
        .select("id,tenant_id,name,shopify_product_gid,shopify_variant_gid,shopify_inventory_item_gid,shopify_synced_at")
        .single();

      if (error) {
        throw error;
      }

      res.json({ product: data });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/tenants/:tenantId/shopify/products", async (req, res) => {
    try {
      const { tenantId } = req.params;
      const result = await fetchTenantShopifyProducts({
        supabase,
        tenantId,
        limit: req.query.limit
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/tenants/:tenantId/shopify/carts/from-order/:orderId", async (req, res) => {
    try {
      const { tenantId, orderId } = req.params;
      const result = await createTenantShopifyCartFromOrder({
        supabase,
        tenantId,
        orderId,
        sessionId: req.body?.session_id,
        channel: req.body?.channel
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post("/tenants/:tenantId/shopify/carts/from-intent", async (req, res) => {
    try {
      const { tenantId } = req.params;
      const productInterest = String(req.body?.product_interest || "").trim();
      const quantity = Number(req.body?.quantity || 1);

      if (!productInterest) {
        return res.status(400).json({
          error: "product_interest is required"
        });
      }

      const result = await createTenantShopifyCartFromIntent({
        supabase,
        tenantId,
        orderId: req.body?.order_id || null,
        sessionId: req.body?.session_id || null,
        channel: req.body?.channel || "instagram",
        productInterest,
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.patch("/tenants/:tenantId/shopify/carts/:cartId/from-order/:orderId", async (req, res) => {
    try {
      const { tenantId, cartId, orderId } = req.params;
      const result = await updateTenantShopifyCartFromOrder({
        supabase,
        tenantId,
        localCartId: cartId,
        orderId
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.get("/tenants/:tenantId/shopify/carts/:cartId/checkout", async (req, res) => {
    try {
      const { tenantId, cartId } = req.params;
      const result = await getTenantShopifyCheckoutUrl({
        supabase,
        tenantId,
        localCartId: cartId
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  createProviderAdminRouter
};
