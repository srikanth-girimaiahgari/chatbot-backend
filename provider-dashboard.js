(function () {
  const token = new URLSearchParams(window.location.search).get("token");
  const headers = token ? { "x-admin-token": token } : {};

  const state = {
    overview: null,
    handoffs: [],
    activity: [],
    selectedTenantId: null
  };

  const errorBanner = document.getElementById("error-banner");
  const authStatus = document.getElementById("auth-status");
  const refreshButton = document.getElementById("refresh-button");
  const refreshStatus = document.getElementById("refresh-status");

  function setError(message) {
    if (!message) {
      errorBanner.classList.add("hidden");
      errorBanner.textContent = "";
      return;
    }

    errorBanner.textContent = message;
    errorBanner.classList.remove("hidden");
  }

  function formatDate(value) {
    if (!value) {
      return "—";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return value;
    }

    return date.toLocaleString();
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

  function setRefreshState(isLoading, message) {
    if (refreshButton) {
      refreshButton.disabled = isLoading;
      refreshButton.textContent = isLoading ? "Refreshing..." : "Refresh Data";
    }

    if (refreshStatus && message) {
      refreshStatus.textContent = message;
    }
  }

  function postJson(path, body) {
    return fetch(path, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers),
      body: JSON.stringify(body || {})
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || ("Request failed: " + response.status));
      }
      return payload;
    });
  }

  function renderSummaryCards(summary) {
    const summaryGrid = document.getElementById("summary-grid");
    const cards = [
      ["Tenants", summary.tenants_count, "Connected businesses managed by your service"],
      ["Active Tenants", summary.active_tenants, "Tenants currently marked active"],
      ["Products", summary.products_count, "Catalog entries across all tenants"],
      ["FAQs", summary.faqs_count, "Knowledge base entries across all tenants"],
      ["Messages", summary.messages_count, "Tracked messages currently in the backend"],
      ["Order Intents", summary.order_intents_count || 0, "Purchase-ready conversations DigiMaya has structured"],
      ["Draft Orders", summary.orders_count || 0, "Draft orders DigiMaya has already prepared"],
      ["Pending Handoffs", summary.pending_handoffs, "Customer conversations waiting for manual follow-up"]
    ];

    summaryGrid.innerHTML = cards.map(function ([label, value, note]) {
      return '<div class="summary-card">' +
        '<div class="eyebrow">' + label + '</div>' +
        '<div class="summary-value">' + value + '</div>' +
        '<div class="summary-note">' + note + '</div>' +
      '</div>';
    }).join("");
  }

  function renderHealthList(tenants) {
    const healthList = document.getElementById("health-list");
    const needsAttention = tenants.filter((tenant) => tenant.health.status !== "healthy");

    if (needsAttention.length === 0) {
      healthList.innerHTML = '<div class="empty-state">All tenants look healthy right now.</div>';
      return;
    }

    healthList.innerHTML = needsAttention.map((tenant) => {
      return '<div class="health-item">' +
        '<div class="tenant-name">' + tenant.business_name + '</div>' +
        '<div style="margin-top:8px;"><span class="status-pill ' + tenant.health.status + '">' + tenant.health.status.replace(/_/g, " ") + '</span></div>' +
        '<div class="subtext" style="margin-top:10px;">Warnings: ' + (tenant.health.warnings.join(", ") || "None") + '</div>' +
      '</div>';
    }).join("");
  }

  function renderPreviewTable(targetId, rows, columns, emptyMessage) {
    const target = document.getElementById(targetId);
    if (!rows || rows.length === 0) {
      target.innerHTML = '<div class="empty-state">' + emptyMessage + '</div>';
      return;
    }

    const header = '<thead><tr>' + columns.map((column) => '<th>' + column.label + '</th>').join("") + '</tr></thead>';
    const body = '<tbody>' + rows.map((row) => {
      return '<tr>' + columns.map((column) => '<td>' + column.render(row) + '</td>').join("") + '</tr>';
    }).join("") + '</tbody>';

    target.innerHTML = '<table>' + header + body + '</table>';
  }

  function renderTenantsTable(tenants) {
    renderPreviewTable(
      "tenants-table",
      tenants,
      [
        { label: "Tenant", render: (tenant) => '<div class="tenant-name">' + tenant.business_name + '</div><div class="subtext">' + tenant.id + '</div>' },
        { label: "Health", render: (tenant) => '<span class="status-pill ' + tenant.health.status + '">' + tenant.health.status.replace(/_/g, " ") + '</span><div class="subtext">' + (tenant.health.warnings.join(", ") || "No warnings") + '</div>' },
        { label: "Catalog", render: (tenant) => tenant.catalog.productsCount + ' products<br />' + tenant.catalog.faqsCount + ' FAQs' },
        { label: "Messages", render: (tenant) => tenant.messages.inboundCount + ' inbound<br />' + tenant.messages.outboundCount + ' replies' },
        { label: "Execution", render: (tenant) => (tenant.order_intents.totalOrderIntents || 0) + ' order intents<br />' + (tenant.orders.totalOrders || 0) + ' draft orders' },
        { label: "Last Activity", render: (tenant) => formatDate(tenant.messages.lastInboundAt || tenant.messages.lastReplyAt) }
      ],
      "No tenants found."
    );

    const table = document.querySelector("#tenants-table table");
    if (!table) {
      return;
    }

    const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
    bodyRows.forEach((row, index) => {
      row.classList.add("tenant-row");
      row.addEventListener("click", function () {
        loadTenantDetail(tenants[index].id);
      });
    });
  }

  function renderTenantDetail(payload) {
    const container = document.getElementById("tenant-detail");
    const title = document.getElementById("tenant-detail-title");
    const tenant = payload.tenant;
    title.textContent = tenant.business_name;

    container.classList.remove("empty-state");
    container.innerHTML =
      '<div class="activation-card">' +
        '<div class="eyebrow">Activation Flow</div>' +
        '<h4 style="margin:8px 0 6px;">Instagram connection confirmation</h4>' +
        '<div class="subtext">Admin confirms the Instagram connection first. After that, the client sees their final confirmation step and can activate their workspace.</div>' +
        '<div class="activation-status">' +
          '<span class="status-pill ' + (tenant.instagram_connected ? "healthy" : "needs_setup") + '">Instagram ' + (tenant.instagram_connected ? "connected" : "not connected") + '</span>' +
          '<span class="status-pill ' + (tenant.admin_connection_confirmed ? "healthy" : "needs_attention") + '">Admin ' + (tenant.admin_connection_confirmed ? "confirmed" : "pending") + '</span>' +
          '<span class="status-pill ' + (tenant.client_connection_confirmed ? "healthy" : "needs_attention") + '">Client ' + (tenant.client_connection_confirmed ? "confirmed" : "pending") + '</span>' +
          '<span class="status-pill ' + (tenant.activation_status === "active" ? "healthy" : "needs_attention") + '">' + escapeHtml(String(tenant.activation_status || "setup_incomplete")).replaceAll("_", " ") + '</span>' +
        '</div>' +
        (!tenant.admin_connection_confirmed
          ? '<div class="card-actions" style="margin-top:14px;"><button id="confirm-connection-button" class="button-primary" type="button">Confirm Connection</button></div>'
          : "") +
      '</div>' +
      '<div class="tenant-detail-grid">' +
        renderDetailChip("Health", tenant.health.status.replace(/_/g, " ")) +
        renderDetailChip("Products", tenant.catalog.productsCount) +
        renderDetailChip("FAQs", tenant.catalog.faqsCount) +
        renderDetailChip("Shopify", tenant.shopify_connected ? "connected" : "not connected") +
        renderDetailChip("Shopify Webhooks", String(tenant.shopify_webhook_status || "not_configured").replaceAll("_", " ")) +
        renderDetailChip("Order Intents", tenant.order_intents.totalOrderIntents || 0) +
        renderDetailChip("Draft Orders", tenant.orders.totalOrders || 0) +
        renderDetailChip("Pending Handoffs", tenant.handoffs.pendingHandoffs) +
        renderDetailChip("Inbound", tenant.messages.inboundCount) +
        renderDetailChip("Replies", tenant.messages.outboundCount) +
      '</div>' +
      '<div class="detail-meta-grid">' +
        renderMetaCard("Owner", tenant.owner_name || "Not provided") +
        renderMetaCard("Login Email", tenant.owner_email || "Not provided") +
        renderMetaCard("Onboarding", String(tenant.onboarding_status || "signup_pending").replaceAll("_", " ")) +
        renderMetaCard("Shopify Store", tenant.shopify_store_domain || "Not connected") +
        renderMetaCard("Shopify Status", String(tenant.shopify_connection_status || "not_connected").replaceAll("_", " ")) +
        renderMetaCard("Last Shopify Webhook", formatDate(tenant.shopify_last_webhook_at)) +
        renderMetaCard("Created", formatDate(tenant.created_at)) +
      '</div>' +
      '<div class="subtext">Warnings: ' + (tenant.health.warnings.join(", ") || "No warnings") + '</div>' +
      '<div class="detail-section">' +
        '<h4>Recent Messages</h4>' +
        buildMiniTable(payload.recent_messages, [
          { label: "When", render: (row) => formatDate(row.created_at) },
          { label: "Role", render: (row) => row.role },
          { label: "Content", render: (row) => escapeHtml(String(row.content || "")).slice(0, 180) }
        ], "No recent messages with tenant attribution yet.") +
      '</div>' +
      '<div class="detail-section">' +
        '<h4>Recent Order Intents</h4>' +
        buildMiniTable(payload.recent_order_intents, [
          { label: "When", render: (row) => formatDate(row.created_at) },
          { label: "Customer", render: (row) => escapeHtml(String(row.customer_name || row.session_id || "—")) },
          { label: "Product", render: (row) => escapeHtml(String(row.product_interest || "—")) },
          { label: "Qty", render: (row) => row.quantity || "—" },
          { label: "Status", render: (row) => row.status || "—" }
        ], "No structured order intents for this tenant yet.") +
      '</div>' +
      '<div class="detail-section">' +
        '<h4>Recent Draft Orders</h4>' +
        buildMiniTable(payload.recent_orders, [
          { label: "When", render: (row) => formatDate(row.created_at) },
          { label: "Order Ref", render: (row) => escapeHtml(String(row.order_reference || "—")) },
          { label: "Customer", render: (row) => escapeHtml(String(row.customer_name || row.session_id || "—")) },
          { label: "Product", render: (row) => escapeHtml(String(row.product_interest || "—")) },
          { label: "Qty", render: (row) => row.quantity || "—" },
          { label: "Amount", render: (row) => row.total_amount != null ? escapeHtml(String(row.total_amount)) + " " + escapeHtml(String(row.currency_code || "")) : "—" },
          { label: "Payment", render: (row) => row.payment_status || "—" },
          { label: "Status", render: (row) => row.status || "—" }
        ], "No draft orders for this tenant yet.") +
      '</div>' +
      '<div class="detail-section">' +
        '<h4>Recent Order Items</h4>' +
        buildMiniTable(payload.recent_order_items, [
          { label: "Order", render: (row) => escapeHtml(String(row.order_id || "—")).slice(0, 8) },
          { label: "Product", render: (row) => escapeHtml(String(row.product_name || "—")) },
          { label: "Qty", render: (row) => row.quantity || "—" },
          { label: "Unit Price", render: (row) => row.unit_price != null ? escapeHtml(String(row.unit_price)) : "—" },
          { label: "Line Total", render: (row) => row.line_total != null ? escapeHtml(String(row.line_total)) : "—" }
        ], "No order items for this tenant yet.") +
      '</div>' +
      '<div class="detail-section">' +
        '<h4>Recent Handoffs</h4>' +
        buildMiniTable(payload.recent_handoffs, [
          { label: "When", render: (row) => formatDate(row.created_at) },
          { label: "Reason", render: (row) => row.reason || "—" },
          { label: "Status", render: (row) => row.status || "—" },
          { label: "Product", render: (row) => escapeHtml(String(row.product_interest || "—")) }
        ], "No handoffs for this tenant yet.") +
      '</div>' +
      '<div class="detail-section">' +
        '<h4>Catalog Snapshot</h4>' +
        buildMiniTable(payload.products, [
          { label: "Product", render: (row) => escapeHtml(row.name) },
          { label: "Price", render: (row) => row.price },
          { label: "Stock", render: (row) => row.in_stock ? "In stock" : "Out of stock" },
          { label: "Link", render: (row) => row.product_url ? '<a href="' + row.product_url + '" target="_blank" rel="noreferrer">Open</a>' : "—" },
          { label: "Shopify Variant", render: (row) => row.shopify_variant_gid ? escapeHtml(String(row.shopify_variant_gid)).slice(-18) : "—" }
        ], "No products loaded for this tenant.") +
      '</div>';

    const confirmButton = document.getElementById("confirm-connection-button");
    if (confirmButton) {
      confirmButton.addEventListener("click", async function () {
        try {
          await postJson("/admin/tenants/" + tenant.id + "/confirm-connection");
          await loadAll();
        } catch (error) {
          setError(error.message);
        }
      });
    }
  }

  function renderDetailChip(label, value) {
    return '<div class="detail-chip"><span class="label">' + label + '</span><span class="value">' + value + '</span></div>';
  }

  function renderMetaCard(label, value) {
    return '<div class="detail-meta-card"><div class="meta-label">' + label + '</div><div class="meta-value">' + escapeHtml(String(value || "—")) + '</div></div>';
  }

  function buildMiniTable(rows, columns, emptyMessage) {
    if (!rows || rows.length === 0) {
      return '<div class="empty-state">' + emptyMessage + '</div>';
    }

    return '<div class="list-table compact-table"><table><thead><tr>' +
      columns.map((column) => '<th>' + column.label + '</th>').join("") +
      '</tr></thead><tbody>' +
      rows.map((row) => '<tr>' + columns.map((column) => '<td>' + column.render(row) + '</td>').join("") + '</tr>').join("") +
      '</tbody></table></div>';
  }

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function renderHandoffs(rows) {
    renderPreviewTable(
      "handoffs-table",
      rows,
      [
        { label: "When", render: (row) => formatDate(row.created_at) },
        { label: "Session", render: (row) => row.session_id || "—" },
        { label: "Reason", render: (row) => row.reason || "—" },
        { label: "Status", render: (row) => row.status || "—" },
        { label: "Product", render: (row) => escapeHtml(String(row.product_interest || "—")) },
        { label: "Contact", render: (row) => escapeHtml(String(row.contact_detail || "—")) }
      ],
      "No handoffs yet."
    );
  }

  function renderActivity(rows) {
    renderPreviewTable(
      "activity-table",
      rows,
      [
        { label: "When", render: (row) => formatDate(row.created_at) },
        { label: "Tenant", render: (row) => row.tenant_id || "—" },
        { label: "Session", render: (row) => row.session_id || "—" },
        { label: "Role", render: (row) => row.role || "—" },
        { label: "Content", render: (row) => escapeHtml(String(row.content || "")).slice(0, 180) }
      ],
      "No recent activity yet."
    );
  }

  function switchPanel(section) {
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.classList.toggle("active", button.dataset.section === section);
    });

    document.querySelectorAll(".panel").forEach((panel) => {
      panel.classList.toggle("visible", panel.dataset.panel === section);
    });
  }

  function wireNavigation() {
    document.querySelectorAll(".nav-item").forEach((button) => {
      button.addEventListener("click", function () {
        switchPanel(button.dataset.section);
      });
    });
  }

  function wireRefresh() {
    document.getElementById("refresh-button").addEventListener("click", function () {
      loadAll();
    });
  }

  function wireAutoRefresh() {
    window.setInterval(function () {
      if (!document.hidden) {
        loadAll();
      }
    }, 15000);

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        loadAll();
      }
    });
  }

  async function loadTenantDetail(tenantId) {
    try {
      state.selectedTenantId = tenantId;
      const payload = await fetchJson("/admin/tenants/" + tenantId);
      renderTenantDetail(payload);
    } catch (error) {
      setError(error.message);
    }
  }

  async function loadAll() {
    try {
      setRefreshState(true, "Refreshing live data...");
      setError("");
      authStatus.textContent = token ? "Token detected" : "Token missing";

      const [overview, handoffs, activity] = await Promise.all([
        fetchJson("/admin/overview"),
        fetchJson("/admin/handoffs"),
        fetchJson("/admin/activity")
      ]);

      state.overview = overview;
      state.handoffs = handoffs.handoffs || [];
      state.activity = activity.messages || [];

      renderSummaryCards(overview.summary);
      renderHealthList(overview.tenants);
      renderTenantsTable(overview.tenants);
      renderHandoffs(state.handoffs.slice(0, 20));
      renderActivity(state.activity.slice(0, 40));
      renderPreviewTable(
        "handoff-preview",
        state.handoffs.slice(0, 5),
        [
          { label: "Tenant", render: (row) => row.tenant_id || "—" },
          { label: "Reason", render: (row) => row.reason || "—" },
          { label: "Status", render: (row) => row.status || "—" }
        ],
        "No handoffs yet."
      );

      if (!state.selectedTenantId && overview.tenants[0]) {
        await loadTenantDetail(overview.tenants[0].id);
      } else if (state.selectedTenantId) {
        await loadTenantDetail(state.selectedTenantId);
      }

      setRefreshState(false, "Updated " + new Date().toLocaleTimeString());
    } catch (error) {
      setError(error.message + "\n\nOpen this page with ?token=YOUR_ADMIN_API_TOKEN or use the x-admin-token header.");
      authStatus.textContent = "Check token";
      setRefreshState(false, "Refresh failed");
    }
  }

  wireNavigation();
  wireRefresh();
  wireAutoRefresh();
  loadAll();
})();
