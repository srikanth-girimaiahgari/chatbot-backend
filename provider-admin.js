const express = require("express");
const path = require("path");

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
  const [catalogCounts, messageMetrics, handoffMetrics] = await Promise.all([
    getTenantCatalogCounts(supabase, tenant.id),
    getTenantMessageMetrics(supabase, tenant.id),
    getTenantHandoffMetrics(supabase, tenant.id)
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
    active: tenant.active,
    plan: tenant.plan,
    instagram_connected: Boolean(tenant.ig_business_id && tenant.ig_access_token),
    whatsapp_connected: Boolean(tenant.wa_phone_number_id && tenant.wa_access_token),
    catalog: catalogCounts,
    messages: messageMetrics,
    handoffs: handoffMetrics,
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
        last_handoff_at: tenant.handoffs.lastHandoffAt || ""
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
      const [tenantsResult, productsResult, faqsResult, messagesResult, handoffsResult, pendingHandoffsResult] = await Promise.all([
        supabase.from("tenants").select("*", { count: "exact", head: true }),
        supabase.from("products").select("*", { count: "exact", head: true }),
        supabase.from("faqs").select("*", { count: "exact", head: true }),
        supabase.from("chat_messages").select("*", { count: "exact", head: true }),
        supabase.from("handoff_requests").select("*", { count: "exact", head: true }),
        supabase.from("handoff_requests").select("*", { count: "exact", head: true }).eq("status", "pending")
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
      const [tenantsResult, productsResult, faqsResult, messagesResult, handoffsResult, pendingHandoffsResult] = await Promise.all([
        supabase.from("tenants").select("*", { count: "exact", head: true }),
        supabase.from("products").select("*", { count: "exact", head: true }),
        supabase.from("faqs").select("*", { count: "exact", head: true }),
        supabase.from("chat_messages").select("*", { count: "exact", head: true }),
        supabase.from("handoff_requests").select("*", { count: "exact", head: true }),
        supabase.from("handoff_requests").select("*", { count: "exact", head: true }).eq("status", "pending")
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

      const [recentMessagesResult, recentHandoffsResult, topProductsResult, topFaqsResult] = await Promise.all([
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
          .from("products")
          .select("id,name,price,in_stock,regular_price,discount_percentage,product_url,color")
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

  return router;
}

module.exports = {
  createProviderAdminRouter
};
