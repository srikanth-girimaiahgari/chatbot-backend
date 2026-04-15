const https = require("https");

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

function buildShopifyShortTitle(title) {
  const raw = String(title || "").trim();
  if (!raw) {
    return "";
  }

  const cleaned = raw
    .replace(/\s*[-|/].*$/, "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\b(with|for|set of|pack of)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return raw;
  }

  const words = cleaned.split(" ");
  if (words.length <= 6) {
    return cleaned;
  }

  return words.slice(0, 6).join(" ");
}

function normalizeShopifyDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

function buildShopifyApiUrl(domain) {
  const normalizedDomain = normalizeShopifyDomain(domain);
  if (!normalizedDomain) {
    throw new Error("Shopify store domain is not configured");
  }

  return `https://${normalizedDomain}/api/2025-01/graphql.json`;
}

function buildCartAttributes({ tenantId, orderId, sessionId, channel, productInterest }) {
  return [
    ["digimaya_tenant_id", tenantId],
    ["digimaya_order_id", orderId],
    ["digimaya_session_id", sessionId],
    ["digimaya_channel", channel],
    ["digimaya_product_interest", productInterest]
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => ({
      key,
      value: String(value)
    }));
}

function shopifyGraphqlRequest({ domain, storefrontToken, query, variables }) {
  const url = buildShopifyApiUrl(domain);
  const body = JSON.stringify({ query, variables: variables || {} });

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Shopify-Storefront-Access-Token": storefrontToken
        }
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if (response.statusCode >= 400) {
              return reject(new Error(`Shopify API error: ${response.statusCode} ${JSON.stringify(parsed)}`));
            }
            if (parsed.errors?.length) {
              return reject(new Error(`Shopify GraphQL error: ${JSON.stringify(parsed.errors)}`));
            }
            resolve(parsed.data || {});
          } catch (error) {
            reject(new Error(`Shopify response parse failed: ${error.message}`));
          }
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

async function getTenantShopifyConfig(supabase, tenantId) {
  const { data, error } = await supabase
    .from("tenants")
    .select("id,business_name,shopify_store_domain,shopify_storefront_access_token,shopify_admin_access_token,shopify_connection_status")
    .eq("id", tenantId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Tenant not found");
  }

  if (!data.shopify_store_domain || !data.shopify_storefront_access_token) {
    throw new Error("Shopify storefront credentials are not configured for this tenant");
  }

  return {
    tenantId: data.id,
    businessName: data.business_name,
    domain: normalizeShopifyDomain(data.shopify_store_domain),
    storefrontToken: data.shopify_storefront_access_token,
    adminToken: data.shopify_admin_access_token || null,
    connectionStatus: data.shopify_connection_status || "not_connected"
  };
}

function unwrapEdges(connection) {
  return (connection?.edges || []).map((edge) => edge.node);
}

function mapShopifyProduct(product) {
  const variants = unwrapEdges(product.variants).map((variant) => ({
    id: variant.id,
    title: variant.title,
    sku: variant.sku || null,
    available_for_sale: Boolean(variant.availableForSale),
    price_amount: Number(variant.price?.amount || 0),
    currency_code: variant.price?.currencyCode || null
  }));

  return {
    id: product.id,
    title: product.title,
    short_title: buildShopifyShortTitle(product.title),
    handle: product.handle,
    online_store_url: product.onlineStoreUrl || null,
    total_inventory: product.totalInventory ?? null,
    variants
  };
}

function selectPreferredVariant(product) {
  const variants = product.variants || [];
  return variants.find((variant) => variant.available_for_sale) || variants[0] || null;
}

function resolveRequestedShopifyProduct(products, requestedName) {
  const normalizedInterest = normalizeLookupText(requestedName);
  if (!normalizedInterest) {
    return null;
  }

  const exact = products.find((product) => {
    const titleMatches = normalizeLookupText(product.title) === normalizedInterest;
    const shortTitleMatches = normalizeLookupText(product.short_title) === normalizedInterest;
    return titleMatches || shortTitleMatches;
  });
  if (exact) {
    return exact;
  }

  const partial = products.find((product) => {
    const normalizedTitle = normalizeLookupText(product.title);
    const normalizedShortTitle = normalizeLookupText(product.short_title);
    return (
      normalizedInterest.includes(normalizedTitle) ||
      normalizedTitle.includes(normalizedInterest) ||
      normalizedInterest.includes(normalizedShortTitle) ||
      normalizedShortTitle.includes(normalizedInterest)
    );
  });
  if (partial) {
    return partial;
  }

  return products.find((product) => {
    const titleTokens = [product.title, product.short_title]
      .map((value) => normalizeLookupText(value))
      .join(" ")
      .split(/\s+/)
      .filter((token) => token.length > 3);
    const matchedTokens = titleTokens.filter((token) => normalizedInterest.includes(token));
    return matchedTokens.length >= Math.min(2, titleTokens.length);
  }) || null;
}

async function fetchTenantShopifyProducts({ supabase, tenantId, limit = 20 }) {
  const config = await getTenantShopifyConfig(supabase, tenantId);
  const data = await shopifyGraphqlRequest({
    domain: config.domain,
    storefrontToken: config.storefrontToken,
    query: `
      query FetchProducts($first: Int!) {
        products(first: $first) {
          edges {
            node {
              id
              title
              handle
              onlineStoreUrl
              totalInventory
              variants(first: 25) {
                edges {
                  node {
                    id
                    title
                    sku
                    availableForSale
                    price {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    variables: { first: Math.max(1, Math.min(Number(limit) || 20, 50)) }
  });

  return {
    store: config.domain,
    products: unwrapEdges(data.products).map(mapShopifyProduct)
  };
}

async function resolveShopifyCartLinesFromIntent({ supabase, tenantId, productInterest, requestedQuantity }) {
  const catalog = await fetchTenantShopifyProducts({
    supabase,
    tenantId,
    limit: 50
  });

  const requestedItems = splitRequestedProducts(productInterest);
  const resolvedItems = requestedItems
    .map((requestedName) => {
      const matchedProduct = resolveRequestedShopifyProduct(catalog.products || [], requestedName);
      if (!matchedProduct) {
        return null;
      }

      const variant = selectPreferredVariant(matchedProduct);
      if (!variant?.id) {
        return null;
      }

      return {
        requested_name: requestedName,
        merchandiseId: variant.id,
        quantity: 1,
        product_name: matchedProduct.title,
        variant_title: variant.title,
        unit_price: variant.price_amount,
        currency_code: variant.currency_code || null
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
}

function mapShopifyCart(cart) {
  const lines = unwrapEdges(cart.lines).map((line) => ({
    line_gid: line.id,
    quantity: Number(line.quantity || 0),
    variant_gid: line.merchandise?.id || null,
    product_name: line.merchandise?.product?.title || null,
    variant_title: line.merchandise?.title || null,
    unit_price: Number(line.cost?.amountPerQuantity?.amount || 0),
    line_total: Number(line.cost?.subtotalAmount?.amount || 0),
    currency_code: line.cost?.subtotalAmount?.currencyCode || line.cost?.amountPerQuantity?.currencyCode || null
  }));

  return {
    shopify_cart_gid: cart.id,
    shopify_checkout_url: cart.checkoutUrl,
    currency_code: cart.cost?.totalAmount?.currencyCode || cart.cost?.subtotalAmount?.currencyCode || null,
    subtotal_amount: Number(cart.cost?.subtotalAmount?.amount || 0),
    total_amount: Number(cart.cost?.totalAmount?.amount || 0),
    status: "ready_for_checkout",
    raw_payload: cart,
    items: lines
  };
}

async function syncLocalShopifyCart({
  supabase,
  tenantId,
  orderId,
  sessionId,
  channel,
  cart,
  localCartId = null
}) {
  const mapped = mapShopifyCart(cart);

  let existingCart = null;
  if (localCartId) {
    const { data, error } = await supabase
      .from("shopify_carts")
      .select("id")
      .eq("id", localCartId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (error) {
      throw error;
    }
    existingCart = data;
  }

  if (!existingCart && mapped.shopify_cart_gid) {
    const { data, error } = await supabase
      .from("shopify_carts")
      .select("id")
      .eq("shopify_cart_gid", mapped.shopify_cart_gid)
      .maybeSingle();
    if (error) {
      throw error;
    }
    existingCart = data;
  }

  const payload = {
    tenant_id: tenantId,
    order_id: orderId || null,
    session_id: sessionId || null,
    channel: channel || "instagram",
    shopify_cart_gid: mapped.shopify_cart_gid,
    shopify_checkout_url: mapped.shopify_checkout_url,
    currency_code: mapped.currency_code,
    subtotal_amount: mapped.subtotal_amount,
    total_amount: mapped.total_amount,
    status: mapped.status,
    last_error: null,
    raw_payload: mapped.raw_payload,
    updated_at: new Date().toISOString()
  };

  let cartRecord;
  if (existingCart?.id) {
    const { data, error } = await supabase
      .from("shopify_carts")
      .update(payload)
      .eq("id", existingCart.id)
      .select("*")
      .single();

    if (error) {
      throw error;
    }
    cartRecord = data;
  } else {
    const { data, error } = await supabase
      .from("shopify_carts")
      .insert(payload)
      .select("*")
      .single();

    if (error) {
      throw error;
    }
    cartRecord = data;
  }

  await supabase.from("shopify_cart_items").delete().eq("shopify_cart_id", cartRecord.id);

  if (mapped.items.length) {
    const itemsPayload = mapped.items.map((item) => ({
      shopify_cart_id: cartRecord.id,
      product_id: null,
      product_name: item.product_name,
      shopify_variant_gid: item.variant_gid,
      shopify_line_gid: item.line_gid,
      quantity: item.quantity,
      unit_price: item.unit_price,
      line_total: item.line_total,
      currency_code: item.currency_code,
      raw_payload: item,
      updated_at: new Date().toISOString()
    }));

    const { error } = await supabase
      .from("shopify_cart_items")
      .insert(itemsPayload);

    if (error) {
      throw error;
    }
  }

  return {
    cart: cartRecord,
    items: mapped.items
  };
}

async function syncOrderFromShopifyCart({ supabase, orderId, cart, items }) {
  if (!orderId) {
    return null;
  }

  const quantity = (items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0) || 1;
  const productInterest = (items || [])
    .map((item) => item.product_name)
    .filter(Boolean)
    .join(", ");
  const primaryItem = items && items.length === 1 ? items[0] : null;

  const { data: updatedOrder, error: orderError } = await supabase
    .from("orders")
    .update({
      product_interest: productInterest || null,
      quantity,
      product_id: null,
      status: "checkout_ready",
      currency_code: cart.currency_code || null,
      unit_price: primaryItem?.unit_price ?? null,
      total_amount: cart.total_amount ?? null,
      updated_at: new Date().toISOString()
    })
    .eq("id", orderId)
    .select("*")
    .single();

  if (orderError) {
    throw orderError;
  }

  await supabase.from("order_items").delete().eq("order_id", orderId);

  if ((items || []).length) {
    const { error: itemsError } = await supabase
      .from("order_items")
      .insert(items.map((item) => ({
        order_id: orderId,
        product_id: null,
        product_name: item.product_name || item.variant_title || item.variant_gid || "Shopify item",
        quantity: Number(item.quantity || 1),
        unit_price: item.unit_price ?? null,
        line_total: item.line_total ?? null
      })));

    if (itemsError) {
      throw itemsError;
    }
  }

  return updatedOrder;
}

async function loadExistingOrderContext(supabase, tenantId, orderId) {
  if (!orderId) {
    return null;
  }

  const { data, error } = await supabase
    .from("orders")
    .select("id,session_id,channel")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Order not found");
  }

  return data;
}

async function loadOrderForShopify(supabase, tenantId, orderId) {
  const orderResult = await supabase
    .from("orders")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", orderId)
    .maybeSingle();

  if (orderResult.error) {
    throw orderResult.error;
  }

  if (!orderResult.data) {
    throw new Error("Order not found");
  }

  const orderItemsResult = await supabase
    .from("order_items")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });

  if (orderItemsResult.error) {
    throw orderItemsResult.error;
  }

  const orderItems = orderItemsResult.data || [];
  const productIds = orderItems.map((item) => item.product_id).filter(Boolean);

  let productsById = new Map();
  if (productIds.length) {
    const productsResult = await supabase
      .from("products")
      .select("id,name,shopify_variant_gid,shopify_product_gid")
      .in("id", productIds);

    if (productsResult.error) {
      throw productsResult.error;
    }

    productsById = new Map((productsResult.data || []).map((product) => [String(product.id), product]));
  }

  const unresolved = [];
  const lines = orderItems.map((item) => {
    const product = item.product_id ? productsById.get(String(item.product_id)) : null;
    const variantGid = product?.shopify_variant_gid || null;

    if (!variantGid) {
      unresolved.push(item.product_name || orderResult.data.product_interest || "Unknown product");
    }

    return {
      order_item_id: item.id,
      product_id: item.product_id || null,
      product_name: item.product_name,
      merchandiseId: variantGid,
      quantity: Number(item.quantity || 1)
    };
  });

  if (!lines.length) {
    throw new Error("Order has no order items yet");
  }

  if (unresolved.length) {
    throw new Error(`Shopify variant mapping is missing for: ${unresolved.join(", ")}`);
  }

  return {
    order: orderResult.data,
    lines
  };
}

async function createTenantShopifyCartFromOrder({ supabase, tenantId, orderId, sessionId, channel }) {
  const config = await getTenantShopifyConfig(supabase, tenantId);
  const { order, lines } = await loadOrderForShopify(supabase, tenantId, orderId);
  const attributes = buildCartAttributes({
    tenantId,
    orderId: order.id,
    sessionId: sessionId || order.session_id,
    channel: channel || order.channel,
    productInterest: order.product_interest
  });

  const data = await shopifyGraphqlRequest({
    domain: config.domain,
    storefrontToken: config.storefrontToken,
    query: `
      mutation CreateCart($input: CartInput!) {
        cartCreate(input: $input) {
          cart {
            id
            checkoutUrl
            cost {
              subtotalAmount { amount currencyCode }
              totalAmount { amount currencyCode }
            }
            lines(first: 100) {
              edges {
                node {
                  id
                  quantity
                  merchandise {
                    ... on ProductVariant {
                      id
                      title
                      product { title }
                    }
                  }
                  cost {
                    amountPerQuantity { amount currencyCode }
                    subtotalAmount { amount currencyCode }
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    variables: {
      input: {
        attributes,
        lines: lines.map((line) => ({
          merchandiseId: line.merchandiseId,
          quantity: line.quantity
        }))
      }
    }
  });

  const userErrors = data.cartCreate?.userErrors || [];
  if (userErrors.length) {
    throw new Error(`Shopify cart create failed: ${userErrors.map((entry) => entry.message).join(", ")}`);
  }

  const cart = data.cartCreate?.cart;
  if (!cart?.id) {
    throw new Error("Shopify cart create returned no cart");
  }

  return syncLocalShopifyCart({
    supabase,
    tenantId,
    orderId: order.id,
    sessionId: sessionId || order.session_id,
    channel: channel || order.channel,
    cart
  });
}

async function createTenantShopifyCartFromIntent({
  supabase,
  tenantId,
  orderId,
  sessionId,
  channel,
  productInterest,
  quantity
}) {
  const config = await getTenantShopifyConfig(supabase, tenantId);
  const lines = await resolveShopifyCartLinesFromIntent({
    supabase,
    tenantId,
    productInterest,
    requestedQuantity: quantity
  });

  if (!lines.length) {
    throw new Error("No Shopify products matched the requested items");
  }

  const existingOrder = await loadExistingOrderContext(supabase, tenantId, orderId);
  const effectiveSessionId = existingOrder?.session_id || sessionId || null;
  const effectiveChannel = existingOrder?.channel || channel || "instagram";
  const attributes = buildCartAttributes({
    tenantId,
    orderId: existingOrder?.id || orderId || null,
    sessionId: effectiveSessionId,
    channel: effectiveChannel,
    productInterest
  });

  const data = await shopifyGraphqlRequest({
    domain: config.domain,
    storefrontToken: config.storefrontToken,
    query: `
      mutation CreateCart($input: CartInput!) {
        cartCreate(input: $input) {
          cart {
            id
            checkoutUrl
            cost {
              subtotalAmount { amount currencyCode }
              totalAmount { amount currencyCode }
            }
            lines(first: 100) {
              edges {
                node {
                  id
                  quantity
                  merchandise {
                    ... on ProductVariant {
                      id
                      title
                      product { title }
                    }
                  }
                  cost {
                    amountPerQuantity { amount currencyCode }
                    subtotalAmount { amount currencyCode }
                  }
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    variables: {
      input: {
        attributes,
        lines: lines.map((line) => ({
          merchandiseId: line.merchandiseId,
          quantity: line.quantity
        }))
      }
    }
  });

  const userErrors = data.cartCreate?.userErrors || [];
  if (userErrors.length) {
    throw new Error(`Shopify cart create failed: ${userErrors.map((entry) => entry.message).join(", ")}`);
  }

  const cart = data.cartCreate?.cart;
  if (!cart?.id) {
    throw new Error("Shopify cart create returned no cart");
  }

  const synced = await syncLocalShopifyCart({
    supabase,
    tenantId,
    orderId: orderId || null,
    sessionId: effectiveSessionId,
    channel: effectiveChannel,
    cart
  });

  if (orderId) {
    const updatedOrder = await syncOrderFromShopifyCart({
      supabase,
      orderId,
      cart: synced.cart,
      items: synced.items
    });

    return {
      cart: synced.cart,
      items: synced.items,
      order: updatedOrder
    };
  }

  return synced;
}

async function fetchTenantShopifyCart({ supabase, tenantId, localCartId }) {
  const config = await getTenantShopifyConfig(supabase, tenantId);
  const cartResult = await supabase
    .from("shopify_carts")
    .select("*")
    .eq("id", localCartId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (cartResult.error) {
    throw cartResult.error;
  }

  if (!cartResult.data?.shopify_cart_gid) {
    throw new Error("Shopify cart not found");
  }

  const data = await shopifyGraphqlRequest({
    domain: config.domain,
    storefrontToken: config.storefrontToken,
    query: `
      query FetchCart($id: ID!) {
        cart(id: $id) {
          id
          checkoutUrl
          cost {
            subtotalAmount { amount currencyCode }
            totalAmount { amount currencyCode }
          }
          lines(first: 100) {
            edges {
              node {
                id
                quantity
                merchandise {
                  ... on ProductVariant {
                    id
                    title
                    product { title }
                  }
                }
                cost {
                  amountPerQuantity { amount currencyCode }
                  subtotalAmount { amount currencyCode }
                }
              }
            }
          }
        }
      }
    `,
    variables: { id: cartResult.data.shopify_cart_gid }
  });

  const cart = data.cart;
  if (!cart?.id) {
    throw new Error("Shopify cart fetch returned no cart");
  }

  return syncLocalShopifyCart({
    supabase,
    tenantId,
    orderId: cartResult.data.order_id,
    sessionId: cartResult.data.session_id,
    channel: cartResult.data.channel,
    localCartId,
    cart
  });
}

function buildDesiredLineMap(lines) {
  return new Map(
    lines.map((line) => [
      line.merchandiseId,
      {
        quantity: line.quantity,
        order_item_id: line.order_item_id,
        product_id: line.product_id,
        product_name: line.product_name
      }
    ])
  );
}

function buildCurrentLineMap(cart) {
  return new Map(
    cart.items
      .filter((line) => line.variant_gid)
      .map((line) => [
        line.variant_gid,
        {
          line_gid: line.line_gid,
          quantity: line.quantity,
          product_name: line.product_name
        }
      ])
  );
}

async function updateTenantShopifyCartFromOrder({ supabase, tenantId, localCartId, orderId }) {
  const config = await getTenantShopifyConfig(supabase, tenantId);
  const existingCart = await fetchTenantShopifyCart({ supabase, tenantId, localCartId });
  const { order, lines } = await loadOrderForShopify(supabase, tenantId, orderId);

  const desiredByVariant = buildDesiredLineMap(lines);
  const currentByVariant = buildCurrentLineMap(existingCart);

  const toAdd = [];
  const toUpdate = [];
  const toRemove = [];

  desiredByVariant.forEach((desired, variantGid) => {
    const current = currentByVariant.get(variantGid);
    if (!current) {
      toAdd.push({
        merchandiseId: variantGid,
        quantity: desired.quantity
      });
      return;
    }

    if (current.quantity !== desired.quantity) {
      toUpdate.push({
        id: current.line_gid,
        quantity: desired.quantity,
        merchandiseId: variantGid
      });
    }
  });

  currentByVariant.forEach((current, variantGid) => {
    if (!desiredByVariant.has(variantGid)) {
      toRemove.push(current.line_gid);
    }
  });

  if (toRemove.length) {
    const removeResult = await shopifyGraphqlRequest({
      domain: config.domain,
      storefrontToken: config.storefrontToken,
      query: `
        mutation RemoveLines($cartId: ID!, $lineIds: [ID!]!) {
          cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
            userErrors { field message }
          }
        }
      `,
      variables: {
        cartId: existingCart.cart.shopify_cart_gid,
        lineIds: toRemove
      }
    });

    const removeErrors = removeResult.cartLinesRemove?.userErrors || [];
    if (removeErrors.length) {
      throw new Error(`Shopify cart remove failed: ${removeErrors.map((entry) => entry.message).join(", ")}`);
    }
  }

  if (toUpdate.length) {
    const updateResult = await shopifyGraphqlRequest({
      domain: config.domain,
      storefrontToken: config.storefrontToken,
      query: `
        mutation UpdateLines($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
          cartLinesUpdate(cartId: $cartId, lines: $lines) {
            userErrors { field message }
          }
        }
      `,
      variables: {
        cartId: existingCart.cart.shopify_cart_gid,
        lines: toUpdate
      }
    });

    const updateErrors = updateResult.cartLinesUpdate?.userErrors || [];
    if (updateErrors.length) {
      throw new Error(`Shopify cart update failed: ${updateErrors.map((entry) => entry.message).join(", ")}`);
    }
  }

  if (toAdd.length) {
    const addResult = await shopifyGraphqlRequest({
      domain: config.domain,
      storefrontToken: config.storefrontToken,
      query: `
        mutation AddLines($cartId: ID!, $lines: [CartLineInput!]!) {
          cartLinesAdd(cartId: $cartId, lines: $lines) {
            userErrors { field message }
          }
        }
      `,
      variables: {
        cartId: existingCart.cart.shopify_cart_gid,
        lines: toAdd
      }
    });

    const addErrors = addResult.cartLinesAdd?.userErrors || [];
    if (addErrors.length) {
      throw new Error(`Shopify cart add failed: ${addErrors.map((entry) => entry.message).join(", ")}`);
    }
  }

  const refreshed = await fetchTenantShopifyCart({ supabase, tenantId, localCartId });

  await supabase
    .from("shopify_carts")
    .update({
      order_id: order.id,
      session_id: order.session_id,
      channel: order.channel,
      updated_at: new Date().toISOString()
    })
    .eq("id", refreshed.cart.id);

  return refreshed;
}

async function getTenantShopifyCheckoutUrl({ supabase, tenantId, localCartId }) {
  const refreshed = await fetchTenantShopifyCart({ supabase, tenantId, localCartId });

  return {
    cart: refreshed.cart,
    checkout_url: refreshed.cart.shopify_checkout_url
  };
}

module.exports = {
  buildShopifyShortTitle,
  fetchTenantShopifyProducts,
  createTenantShopifyCartFromIntent,
  createTenantShopifyCartFromOrder,
  updateTenantShopifyCartFromOrder,
  getTenantShopifyCheckoutUrl
};
