const express = require("express");

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

function buildDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MAYA Provider Dashboard</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f5f6fa; color: #1d2433; }
    header { padding: 24px; background: #111827; color: white; }
    main { padding: 24px; max-width: 1200px; margin: 0 auto; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom: 24px; }
    .card { background: white; border-radius: 16px; padding: 18px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08); }
    th, td { padding: 12px 14px; border-bottom: 1px solid #edf2f7; text-align: left; font-size: 14px; vertical-align: top; }
    th { background: #f8fafc; font-weight: 600; }
    .pill { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 12px; }
    .healthy { background: #dcfce7; color: #166534; }
    .needs_setup { background: #fef3c7; color: #92400e; }
    .needs_attention { background: #fee2e2; color: #991b1b; }
    .warnings { color: #6b7280; font-size: 12px; }
    .error { color: #991b1b; white-space: pre-wrap; }
    code { background: #eef2ff; padding: 2px 6px; border-radius: 6px; }
  </style>
</head>
<body>
  <header>
    <h1 style="margin:0 0 8px;">MAYA Provider Dashboard</h1>
    <p style="margin:0; opacity:0.9;">Internal monitoring for tenant health, catalog readiness, message volume, and handoffs.</p>
  </header>
  <main>
    <div id="summary" class="grid"></div>
    <div id="error" class="error"></div>
    <table>
      <thead>
        <tr>
          <th>Tenant</th>
          <th>Health</th>
          <th>Catalog</th>
          <th>Messages</th>
          <th>Handoffs</th>
          <th>Last Activity</th>
        </tr>
      </thead>
      <tbody id="tenant-rows"></tbody>
    </table>
  </main>
  <script>
    const token = new URLSearchParams(window.location.search).get("token");
    const headers = token ? { "x-admin-token": token } : {};

    function renderSummaryCard(label, value) {
      return '<div class="card"><div style="font-size:13px;color:#6b7280;">' + label + '</div><div style="font-size:28px;font-weight:700;margin-top:8px;">' + value + '</div></div>';
    }

    function render() {
      fetch('/admin/overview', { headers })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || 'Failed to load dashboard');
          return payload;
        })
        .then((payload) => {
          document.getElementById('summary').innerHTML = [
            renderSummaryCard('Tenants', payload.summary.tenants_count),
            renderSummaryCard('Active Tenants', payload.summary.active_tenants),
            renderSummaryCard('Products', payload.summary.products_count),
            renderSummaryCard('FAQs', payload.summary.faqs_count),
            renderSummaryCard('Messages', payload.summary.messages_count),
            renderSummaryCard('Pending Handoffs', payload.summary.pending_handoffs)
          ].join('');

          document.getElementById('tenant-rows').innerHTML = payload.tenants.map((tenant) => {
            const lastActivity = tenant.messages.lastInboundAt || tenant.messages.lastReplyAt || '-';
            return '<tr>' +
              '<td><strong>' + tenant.business_name + '</strong><div class="warnings">' + tenant.id + '</div></td>' +
              '<td><span class="pill ' + tenant.health.status + '">' + tenant.health.status.replace('_', ' ') + '</span><div class="warnings">' + (tenant.health.warnings.join(', ') || 'No warnings') + '</div></td>' +
              '<td>' + tenant.catalog.productsCount + ' products<br />' + tenant.catalog.faqsCount + ' FAQs</td>' +
              '<td>' + tenant.messages.inboundCount + ' inbound<br />' + tenant.messages.outboundCount + ' replies</td>' +
              '<td>' + tenant.handoffs.pendingHandoffs + ' pending<br />' + tenant.handoffs.totalHandoffs + ' total</td>' +
              '<td>' + lastActivity + '</td>' +
            '</tr>';
          }).join('');
        })
        .catch((error) => {
          document.getElementById('error').textContent = error.message + '\\n\\nOpen this page with ?token=YOUR_ADMIN_API_TOKEN or send x-admin-token / Bearer token headers.';
        });
    }

    render();
  </script>
</body>
</html>`;
}

function createProviderAdminRouter({ supabase }) {
  const router = express.Router();

  router.get("/dashboard", (req, res) => {
    res.type("html").send(buildDashboardHtml());
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

      res.json({
        summary: {
          tenants_count: tenantsResult.count || 0,
          active_tenants: (tenants || []).filter((tenant) => tenant.active).length,
          products_count: productsResult.count || 0,
          faqs_count: faqsResult.count || 0,
          messages_count: messagesResult.count || 0,
          handoffs_count: handoffsResult.count || 0,
          pending_handoffs: pendingHandoffsResult.count || 0
        },
        tenants: snapshots
      });
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
