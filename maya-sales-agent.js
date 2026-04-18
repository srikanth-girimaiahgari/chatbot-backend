function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCurrencyCode(value) {
  const code = String(value || "").trim().toUpperCase();
  const supported = new Set(["INR", "USD", "GBP", "AUD", "EUR", "CAD"]);
  return supported.has(code) ? code : "";
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
  return map[normalized] || null;
}

function getCatalogCurrency(products = [], tenant = {}) {
  const tenantCurrency = getCurrencyConfig(tenant.currency_code);
  if (tenantCurrency) {
    return tenantCurrency;
  }

  const numericPrices = (products || [])
    .map((product) => Number(product.price))
    .filter((price) => Number.isFinite(price) && price > 0);

  if (numericPrices.length === 0) {
      return {
      code: "INR",
      symbol: "₹",
      locale: "en-IN"
    };
  }

  const maxPrice = Math.max(...numericPrices);
  if (maxPrice <= 250) {
    return {
      code: "GBP",
      symbol: "£",
      locale: "en-GB"
    };
  }

  return {
    code: "INR",
    symbol: "₹",
    locale: "en-IN"
  };
}

function formatMoney(amount, currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    return `${currency.symbol} 0`;
  }

  if (currency.code === "GBP") {
    return `${currency.symbol}${value.toLocaleString(currency.locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  return `${currency.symbol} ${value.toLocaleString(currency.locale, {
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2
  })}`;
}

function buildBudgetBands(products = []) {
  const prices = (products || [])
    .map((product) => Number(product.price))
    .filter((price) => Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);

  if (prices.length < 3) {
    return [];
  }

  const min = prices[0];
  const max = prices[prices.length - 1];
  if (min === max) {
    return [];
  }

  const lowCutoff = prices[Math.floor((prices.length - 1) / 3)];
  const highCutoff = prices[Math.floor(((prices.length - 1) * 2) / 3)];

  if (!(min < lowCutoff && lowCutoff <= highCutoff && highCutoff < max)) {
    return [];
  }

  return [
    { type: "max", max: lowCutoff },
    { type: "range", min: lowCutoff, max: highCutoff },
    { type: "min", min: highCutoff }
  ];
}

function formatBudgetBand(band, currency) {
  if (band.type === "max") {
    return `Under ${formatMoney(band.max, currency)}`;
  }

  if (band.type === "min") {
    return `Above ${formatMoney(band.min, currency)}`;
  }

  return `${formatMoney(band.min, currency)} - ${formatMoney(band.max, currency)}`;
}

function detectBudget(text, products = [], tenant = {}) {
  const value = normalizeText(text);
  const currency = getCatalogCurrency(products, tenant);
  const numberMatches = (value.match(/\d[\d,]*/g) || []).map((item) => Number(item.replace(/,/g, ""))).filter(Number.isFinite);

  if (!value) {
    return null;
  }

  if ((value.includes("under") || value.includes("below") || value.includes("less than")) && numberMatches[0] != null) {
    return `Under ${formatMoney(numberMatches[0], currency)}`;
  }

  if ((value.includes("above") || value.includes("over") || value.includes("more than")) && numberMatches[0] != null) {
    return `Above ${formatMoney(numberMatches[0], currency)}`;
  }

  if (numberMatches.length >= 2 && (value.includes("-") || value.includes(" to ") || value.includes("between"))) {
    return `${formatMoney(numberMatches[0], currency)} - ${formatMoney(numberMatches[1], currency)}`;
  }

  return null;
}

function parseBudgetFromText(text, products = [], tenant = {}) {
  const value = normalizeText(text);
  const currency = getCatalogCurrency(products, tenant);

  if (!value) {
    return null;
  }

  if (value.includes("under") || value.includes("below") || value.includes("less than")) {
    const max = Number((value.match(/\d[\d,]*/g) || [])[0]?.replace(/,/g, ""));
    if (Number.isFinite(max)) {
      return { label: `Under ${formatMoney(max, currency)}`, max };
    }
  }

  if (value.includes("above") || value.includes("over") || value.includes("more than")) {
    const min = Number((value.match(/\d[\d,]*/g) || [])[0]?.replace(/,/g, ""));
    if (Number.isFinite(min)) {
      return { label: `Above ${formatMoney(min, currency)}`, min };
    }
  }

  const matches = value.match(/\d[\d,]*/g);
  if (matches && matches.length >= 2) {
    const min = Number(matches[0].replace(/,/g, ""));
    const max = Number(matches[1].replace(/,/g, ""));
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return {
        label: `${formatMoney(min, currency)} - ${formatMoney(max, currency)}`,
        min,
        max
      };
    }
  }

  return null;
}

function detectStyle(text) {
  const value = normalizeText(text);
  const styles = ["minimalist", "trendy", "premium", "bridal", "festive", "daily wear", "party wear"];

  for (const style of styles) {
    if (value.includes(style)) {
      return style;
    }
  }

  return null;
}

function detectUseCase(text) {
  const value = normalizeText(text);
  const occasions = ["daily wear", "wedding", "reception", "sangeet", "party", "gift", "bridal", "festive"];

  for (const occasion of occasions) {
    if (value.includes(occasion)) {
      return occasion;
    }
  }

  return null;
}

function detectStage(messages, latestMessage, products = []) {
  const transcript = messages.map((message) => normalizeText(message.content || message.text)).join(" \n ");
  const latest = normalizeText(latestMessage);
  const knownBudget = detectBudget(transcript, products) || detectBudget(latest, products);

  if (latest.includes("pay") || latest.includes("payment") || latest.includes("buy this") || latest.includes("i want this")) {
    return "ready_to_buy";
  }

  if (transcript.includes("budget") || knownBudget) {
    return "budget_captured";
  }

  if (
    latest.includes("price") ||
    latest.includes("details") ||
    latest.includes("available") ||
    latest.includes("show me") ||
    latest.includes("looking for")
  ) {
    return "product_inquiry";
  }

  return "new_lead";
}

function buildProductHighlights(products, tenant = {}) {
  const currency = getCatalogCurrency(products, tenant);
  return (products || []).slice(0, 25).map((product) => {
    const sizes = product.sizes_in_stock && product.sizes_in_stock.length > 0
      ? `Sizes: ${product.sizes_in_stock.join(", ")}`
      : "Sizes: check availability";

    const tags = []
      .concat(product.category || [])
      .concat(product.style || [])
      .concat(product.occasion || [])
      .filter(Boolean)
      .join(", ");

    const links = [
      product.product_url ? `Product link: ${product.product_url}` : null,
      product.image_url ? `Image: ${product.image_url}` : null
    ].filter(Boolean).join("\n");

    return `${product.name} — ${formatMoney(product.price, currency)}\n${product.description}\n${sizes}${tags ? `\nTags: ${tags}` : ""}${links ? `\n${links}` : ""}`;
  }).join("\n\n");
}

function buildFaqText(faqs) {
  return (faqs || []).slice(0, 25).map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n\n");
}

function splitAttributeValues(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => String(item || "").split(/,|\/|\||;/))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return String(value || "")
    .split(/,|\/|\||;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function cleanVariantFragment(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function simplifySizeLabel(value) {
  const raw = cleanVariantFragment(value);
  if (!raw) {
    return "";
  }

  const beforeSlash = raw.split("/")[0].trim();
  const withoutMeasurement = beforeSlash.replace(/\([^)]*\)/g, "").trim();
  const normalized = withoutMeasurement.toUpperCase();
  const shortMatch = normalized.match(/\b(XXS|XS|S|M|L|XL|XXL|XXXL|FREE SIZE|FREE)\b/);
  if (shortMatch) {
    return shortMatch[1] === "FREE" ? "Free Size" : shortMatch[1];
  }

  return withoutMeasurement || raw;
}

function isLikelySizeValue(value) {
  const raw = cleanVariantFragment(value);
  if (!raw) {
    return false;
  }

  const normalized = raw.toUpperCase();
  if (/\b(XXS|XS|S|M|L|XL|XXL|XXXL|FREE SIZE|FREE)\b/.test(normalized)) {
    return true;
  }

  if (/^\d{2,3}$/.test(raw)) {
    return true;
  }

  if (/^\d{2,3}\s*-\s*\d{2,3}$/.test(raw)) {
    return true;
  }

  if (/waist|size|inch|cm/i.test(raw)) {
    return true;
  }

  return false;
}

function getVariantFragments(product) {
  return splitAttributeValues(product?.sizes_in_stock);
}

function getProductColors(product) {
  const explicitColors = splitAttributeValues(product?.color);
  if (explicitColors.length > 0) {
    return uniqueValues(explicitColors);
  }

  return uniqueValues(
    getVariantFragments(product).filter((value) => !isLikelySizeValue(value))
  );
}

function getProductSizes(product) {
  return uniqueValues(
    getVariantFragments(product)
      .filter(isLikelySizeValue)
      .map(simplifySizeLabel)
  );
}

function buildVariantSelectionReply(product) {
  const colors = getProductColors(product);
  const sizes = getProductSizes(product);

  const lines = [`Got it, ${product.name}.`];

  if (colors.length > 0) {
    lines.push(`Colors: ${colors.join(", ")}`);
  }

  if (sizes.length > 0) {
    lines.push(`Sizes: ${sizes.join(", ")}`);
  }

  if (colors.length > 0 && sizes.length > 0) {
    lines.push("Which color and size do you want?");
    return lines.join("\n");
  }

  if (colors.length > 0) {
    lines.push("Which color do you want?");
    return lines.join("\n");
  }

  if (sizes.length > 0) {
    lines.push("Which size do you want?");
    return lines.join("\n");
  }

  return `Got it, ${product.name}.\nWant me to add it?`;
}

function getCategoryIntent(products, latestMessage) {
  const message = normalizeText(latestMessage);
  if (!message) {
    return null;
  }

  const wantsList = [
    "list",
    "show",
    "see",
    "collections",
    "collection",
    "catalog",
    "range",
    "have",
    "available"
  ].some((phrase) => message.includes(phrase));

  if (!wantsList) {
    return null;
  }

  const categories = Array.from(
    new Set(
      (products || [])
        .flatMap((product) => splitAttributeValues(product.category))
        .map((category) => category.trim())
        .filter(Boolean)
    )
  );

  return categories.find((category) => {
    const normalizedCategory = normalizeText(category);
    return normalizedCategory && message.includes(normalizedCategory);
  }) || null;
}

function buildCategoryListingResponse(products, latestMessage) {
  const category = getCategoryIntent(products, latestMessage);
  if (!category) {
    return null;
  }

  const picks = (products || [])
    .filter((product) => splitAttributeValues(product.category).some((value) => normalizeText(value) === normalizeText(category)))
    .filter((product) => product?.in_stock !== false)
    .slice(0, 4);

  if (picks.length === 0) {
    return null;
  }

  const lines = picks.map((product) => `- ${product.name}`);
  return `Here are our ${category.toLowerCase()} picks:\n${lines.join("\n")}\nWhich one do you want?`;
}

function getBrowseQualifier(latestMessage) {
  const message = normalizeText(latestMessage);
  if (!message) {
    return null;
  }

  const wantsBrowse = [
    "other",
    "else",
    "more",
    "show",
    "list",
    "see",
    "pieces",
    "options"
  ].some((phrase) => message.includes(phrase));

  if (!wantsBrowse) {
    return null;
  }

  const qualifiers = ["bridal", "wedding", "party", "festive", "daily wear", "accessories", "jewelry", "saree", "sarees", "lehenga", "lehengas", "shawl", "shawls", "bangle", "bangles"];
  return qualifiers.find((item) => message.includes(item)) || null;
}

function productMatchesQualifier(product, qualifier) {
  const haystack = [
    product.name,
    product.full_name,
    product.category,
    product.style,
    product.occasion,
    product.description
  ]
    .flatMap((value) => splitAttributeValues(value))
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .join(" ");

  if (!haystack) {
    return false;
  }

  if (qualifier === "wedding") {
    return haystack.includes("wedding") || haystack.includes("bridal");
  }

  if (qualifier.endsWith("s")) {
    const singular = qualifier.slice(0, -1);
    return haystack.includes(qualifier) || haystack.includes(singular);
  }

  return haystack.includes(qualifier);
}

function buildBrowseListingResponse(products, latestMessage) {
  const qualifier = getBrowseQualifier(latestMessage);
  if (!qualifier) {
    return null;
  }

  const picks = (products || [])
    .filter((product) => product?.in_stock !== false)
    .filter((product) => productMatchesQualifier(product, qualifier))
    .slice(0, 4);

  if (picks.length === 0) {
    return null;
  }

  const label = qualifier === "wedding" ? "bridal" : qualifier;
  const lines = picks.map((product) => `- ${product.name}`);
  return `Here are some ${label} picks:\n${lines.join("\n")}\nWhich one do you want?`;
}

function isRecentProduct(product) {
  if (product?.is_new_arrival === true) {
    return true;
  }

  const createdAt = product?.created_at ? new Date(product.created_at) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    return false;
  }

  const ageInDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
  return ageInDays <= 45;
}

function isOnSaleProduct(product) {
  if (product?.is_on_sale === true) {
    return true;
  }

  const price = Number(product?.price);
  const regularPrice = Number(product?.regular_price);
  const discount = Number(product?.discount_percentage);

  return (
    (Number.isFinite(regularPrice) && Number.isFinite(price) && regularPrice > price) ||
    (Number.isFinite(discount) && discount > 0)
  );
}

function getCollectionIntent(latestMessage) {
  const message = normalizeText(latestMessage);
  if (!message) {
    return null;
  }

  const intents = [
    {
      key: "new_arrivals",
      phrases: ["new arrivals", "new arrival", "new collection", "new listings", "latest collection", "latest arrivals", "new items", "latest items"]
    },
    {
      key: "best_sellers",
      phrases: ["best sellers", "best seller", "most preferred", "most sold", "popular items", "popular products", "what sells most", "bestselling", "best selling"]
    },
    {
      key: "top_rated",
      phrases: ["top rated", "top-rated", "best rated", "highest rated", "most reviewed", "best reviewed", "top review", "best review"]
    },
    {
      key: "deals",
      phrases: ["on sale", "sale items", "sale collection", "deals", "offers", "promotions", "discounted", "discount items", "any sale", "any offers"]
    }
  ];

  for (const intent of intents) {
    if (intent.phrases.some((phrase) => message.includes(phrase))) {
      return intent.key;
    }
  }

  return null;
}

function sortCollectionProducts(products, intentKey) {
  const rows = (products || []).filter((product) => product?.in_stock !== false);

  if (intentKey === "best_sellers") {
    return rows.sort((a, b) => Number(b.sales_count || 0) - Number(a.sales_count || 0));
  }

  if (intentKey === "top_rated") {
    return rows.sort((a, b) => {
      const ratingDiff = Number(b.review_rating || 0) - Number(a.review_rating || 0);
      if (ratingDiff !== 0) {
        return ratingDiff;
      }
      return Number(b.review_count || 0) - Number(a.review_count || 0);
    });
  }

  return rows.sort((a, b) => {
    const aDate = a?.created_at ? new Date(a.created_at).getTime() : 0;
    const bDate = b?.created_at ? new Date(b.created_at).getTime() : 0;
    return bDate - aDate;
  });
}

function buildCollectionResponse(products, latestMessage, tenant = {}) {
  const intentKey = getCollectionIntent(latestMessage);
  if (!intentKey) {
    return null;
  }

  const currency = getCatalogCurrency(products, tenant);
  let filtered = [];
  let label = "";

  if (intentKey === "new_arrivals") {
    filtered = (products || []).filter(isRecentProduct);
    label = "new arrivals";
  } else if (intentKey === "best_sellers") {
    filtered = (products || []).filter((product) => product?.is_best_seller === true || Number(product?.sales_count || 0) > 0);
    label = "best sellers";
  } else if (intentKey === "top_rated") {
    filtered = (products || []).filter((product) => product?.is_top_rated === true || Number(product?.review_rating || 0) >= 4);
    label = "top rated picks";
  } else if (intentKey === "deals") {
    filtered = (products || []).filter(isOnSaleProduct);
    label = "sale picks";
  }

  const picks = sortCollectionProducts(filtered, intentKey).slice(0, 3);
  if (picks.length === 0) {
    return `I don’t have clear ${label} tagged right now.\nI can still show you a few good picks from the catalog.`;
  }

  const lines = picks.map((product) => `- ${product.name} - ${formatMoney(product.price, currency)}`);
  return `Here are ${label}:\n${lines.join("\n")}\nWhich one do you want to see?`;
}

function findMatchingProducts(products, latestMessage) {
  const message = normalizeText(latestMessage);

  return (products || []).filter((product) => {
    const names = [product.name, product.full_name]
      .map((value) => normalizeText(value))
      .filter(Boolean);

    if (names.length === 0) {
      return false;
    }

    const exactOrPartial = names.some((name) => message.includes(name) || name.includes(message));
    if (exactOrPartial) {
      return true;
    }

    const nameTokens = names
      .join(" ")
      .split(/\s+/)
      .filter((token) => token.length > 3);
    const matchedTokens = nameTokens.filter((token) => message.includes(token));
    return matchedTokens.length >= Math.min(2, nameTokens.length);
  });
}

function buildProductResponse(product, latestMessage, tenant = {}) {
  const message = normalizeText(latestMessage);
  const currency = getCatalogCurrency([product], tenant);
  const sizes = product.sizes_in_stock && product.sizes_in_stock.length > 0
    ? product.sizes_in_stock.join(", ")
    : null;
  const priceLine = `${product.name} is ${formatMoney(product.price, currency)}.`;
  const linkLine = product.product_url ? `Link: ${product.product_url}` : "";
  const imageLine = product.image_url ? `Image: ${product.image_url}` : "";

  if (message.includes("image") || message.includes("photo") || message.includes("picture") || message.includes("pic")) {
    if (product.image_url || product.product_url) {
      return [priceLine, imageLine, linkLine].filter(Boolean).join("\n");
    }
    return `${priceLine}\nI don’t have an image link saved for it yet.`;
  }

  if (message.includes("link") || message.includes("url") || message.includes("website")) {
    if (product.product_url) {
      return `${priceLine}\n${linkLine}`;
    }
    return `${priceLine}\nI don’t have the product link saved yet.`;
  }

  if (message.includes("available") || message.includes("availability") || message.includes("in stock")) {
    const stockLine = product.in_stock === false
      ? "Currently out of stock."
      : "Currently available.";
    return [
      priceLine,
      stockLine,
      sizes ? `Sizes: ${sizes}.` : "",
      "Want details or should I add it?"
    ].filter(Boolean).join("\n");
  }

  if (message.includes("detail") || message.includes("details") || message.includes("more info")) {
    return [
      priceLine,
      product.description ? product.description : "",
      sizes ? `Sizes: ${sizes}.` : "",
      "Want this one or similar options?"
    ].filter(Boolean).join("\n");
  }

  if (message.includes("price") || message.includes("cost") || message.includes("how much")) {
    return [
      priceLine,
      sizes ? `Sizes: ${sizes}.` : "",
      "Want me to add it or show similar options?"
    ].filter(Boolean).join("\n");
  }

  return buildVariantSelectionReply(product);
}

function pickReason(product, latestMessage) {
  const message = normalizeText(latestMessage);
  const name = product.name || "This option";

  if (message.includes("wedding") || message.includes("bridal")) {
    return `${name} works well for wedding functions.`;
  }

  if (message.includes("party") || message.includes("festive") || message.includes("sangeet")) {
    return `${name} is a strong pick for festive occasions.`;
  }

  return `${name} is a good match in this budget.`;
}

function buildBudgetRecommendationResponse(products, latestMessage, tenant = {}) {
  const currency = getCatalogCurrency(products, tenant);
  const budget = parseBudgetFromText(latestMessage, products, tenant);
  if (!budget) {
    return null;
  }

  const matches = (products || [])
    .filter((product) => {
      const price = Number(product.price);
      if (!Number.isFinite(price)) {
        return false;
      }

      if (budget.min != null && price < budget.min) {
        return false;
      }

      if (budget.max != null && price > budget.max) {
        return false;
      }

      return product.in_stock !== false;
    })
    .sort((a, b) => Number(a.price) - Number(b.price))
    .slice(0, 3);

  if (matches.length === 0) {
    return `I’m not seeing an in-stock option in ${budget.label}.\nI can show the closest options just above that budget.`;
  }

  const lines = matches.map((product) => `- ${product.name} - ${formatMoney(product.price, currency)}`);
  return `Options in ${budget.label}:\n${lines.join("\n")}\nWhich one do you want?`;
}

function buildMayaSystemPrompt({ products, faqs, contextLabel, recentChats, latestMessage, tenant }) {
  const currency = getCatalogCurrency(products, tenant);
  const budgetBands = buildBudgetBands(products);
  const budgetPrompt = budgetBands.length > 0
    ? budgetBands.map((band) => formatBudgetBand(band, currency)).join(", ")
    : null;
  const inferredBudget = recentChats.map((chat) => detectBudget(chat.content, products, tenant)).find(Boolean) || detectBudget(latestMessage, products, tenant);
  const inferredStyle = recentChats.map((chat) => detectStyle(chat.content)).find(Boolean) || detectStyle(latestMessage);
  const inferredUseCase = recentChats.map((chat) => detectUseCase(chat.content)).find(Boolean) || detectUseCase(latestMessage);
  const inferredStage = detectStage(recentChats, latestMessage, products);
  const matchedProducts = findMatchingProducts(products, latestMessage);
  const matchedProductText = matchedProducts.length > 0
    ? matchedProducts.slice(0, 3).map((product) => `${product.name} = ${formatMoney(product.price, currency)}`).join(" | ")
    : "none";
  const shopifyCheckoutReady = Boolean(tenant?.shopify_store_domain && tenant?.shopify_storefront_access_token);
  const businessName = String(tenant?.business_name || "this business").trim();
  const businessCategory = String(tenant?.business_category || "").trim() || "general product business";
  const commerceMode = shopifyCheckoutReady ? "shopify_checkout" : "catalog_inquiry";
  const productSource = shopifyCheckoutReady ? "Shopify catalog for checkout truth" : "tenant catalog stored in DigiMaya";

  return [
    "You are MAYA, DigiMaya's customer-facing digital employee for this tenant.",
    `Business name: ${businessName}.`,
    `Business category: ${businessCategory}.`,
    `Channel: ${contextLabel}.`,
    `Commerce mode: ${commerceMode}.`,
    `Product source of truth for this tenant: ${productSource}.`,
    "Your job is to behave like the business itself: understand shopper intent, answer from the real catalog and FAQs, guide the shopper clearly, and move them toward the correct next step.",
    "Always sound human, short, clear, and confident.",
    "DM style only. Do not sound like a brochure, catalog write-up, or customer support article.",
    "Keep most replies to 1-3 short lines. Use 4 short lines max when needed.",
    "Each reply should do one job only: answer, suggest, confirm, or ask for the next step.",
    "Use plain chat language. Avoid long intros, filler, repeated compliments, and decorative adjectives.",
    "Do not praise every selection. A simple 'Yes', 'Done', 'Perfect', or 'Got it' is enough.",
    "Ask one clear question at the end, not two or three.",
    "If the customer already chose an item, stop selling and move to add-to-cart or checkout.",
    "After adding one item, do not show the full order summary right away.",
    "After each add-to-cart step, reply in a short human way like: item added, 1 item in cart / 2 items in cart / 3 items in cart, then ask if they want anything else.",
    "Do not list all cart items and totals after each product addition.",
    "Only show the full order item list and total when the customer says they are done adding items or says no to adding more.",
    "If the customer says no after 'anything else?', then move to a short order summary and ask if they are ready to checkout.",
    "If the customer asks to see collections, give only 3-5 top categories or a few best picks first, not the full catalog dump.",
    "If the customer asks for a category like jewelry, sarees, lehengas, shawls, or bangles, show only product names first. Do not include price, colors, sizes, or long descriptions in that first list.",
    "Once the customer picks one product, ask for color or size next if those options exist. Do not dump variants before the customer chooses the product.",
    "When asking for size, show only clean size labels like XS, S, M, L, XL, XXL, or Free Size by default. Do not show waist measurements or color-size combinations unless the customer specifically asks for detailed size info.",
    `Use the tenant's catalog currency consistently: ${currency.code} (${currency.symbol}).`,
    "Never switch to a different currency or invent currency symbols.",
    "Never invent price, stock, shipping time, size details, or discount approvals.",
    "Do not speak as if you are one fixed kind of store. Adapt to the tenant's actual business type and catalog.",
    "If the customer asks price, details, or availability and the message matches a product in the catalog, you must answer using that exact matched product name and exact database price first.",
    "Do not answer price questions with a broad collection range when an exact matched product price is available.",
    "Only mention a general price range if the customer explicitly asks for options by budget and no single product is clearly identified.",
    "If the customer asks price/details/availability, answer first with facts from the catalog, then ask one useful next-step question.",
    "If the customer asks for new arrivals, best sellers, top rated items, deals, offers, or promotions, show only 2-3 relevant products from that catalog segment.",
    budgetPrompt
      ? `If budget is missing and recommendations would help, ask for budget using sensible catalog-based choices such as: ${budgetPrompt}.`
      : "If budget is missing and recommendations would help, ask for the customer's preferred budget range in the catalog's currency.",
    "Do not ask for budget as the first move unless the customer is explicitly asking for options by range or wants recommendations without naming a specific product.",
    "If style is missing and recommendations would help, ask whether they prefer minimalist, trendy, or premium.",
    "When recommending products, suggest only 2-3 options.",
    "Keep product descriptions very short unless the customer asks for more.",
    "Use occasion questions only while the customer is still deciding what to buy or when occasion helps narrow the recommendation. Once the customer has chosen an item, do not keep asking about occasion unless it is still truly needed.",
    shopifyCheckoutReady
      ? "For Shopify checkout tenants, switch into cart mode once the customer clearly selects an item: confirm the exact item, clarify variant or quantity only if needed, say it is added, mention the cart item count in a short way, and ask if they want anything else."
      : "If the customer clearly wants to buy, confirm the product, confirm quantity, and collect enough details for the next manual business step.",
    shopifyCheckoutReady
      ? "When the customer says they are done adding items, stop recommending products and switch into checkout preparation mode."
      : "When the customer is ready to buy, move to the next manual business step without adding extra friction.",
    shopifyCheckoutReady
      ? "For Shopify checkout tenants, collect only the minimum chat details needed before checkout. Ask for full name and phone number with country code together in one message. Do not ask for occasion at this stage if the item is already chosen."
      : "If checkout is not active, collect only the details the business needs for the next manual step.",
    shopifyCheckoutReady
      ? "Do not ask for full shipping address in one messy message. If address collection is needed in chat later, ask for it in structured parts."
      : "Keep customer detail collection simple and relevant.",
    "If the customer asks for custom design, unusual discount, negotiation, complaint handling, or something unclear after repeated back-and-forth, hand off to the team.",
    "If human handoff is needed, end with HUMAN_HANDOFF|[session_id].",
    "If the customer is ready to buy, collect the minimum details with as little friction as possible. For checkout-style flows, ask for full name and phone number together in one message. Then confirm quantity and end with HANDOFF_READY|[name]|[occasion]|[contact_method]|[contact_detail]|[product_interest]|[quantity]. Use quantity 1 if they do not specify a number.",
    shopifyCheckoutReady
      ? 'If this tenant has Shopify checkout available and the customer is clearly ready to check out, end with SHOPPING_INTENT_JSON:{"action":"create_checkout","product_interest":"...","quantity":1,"customer_name":"...","occasion":"...","contact_method":"...","contact_detail":"..."} on its own final line. Use it only after the customer has finished adding items and confirmed they want to proceed. Keep it valid JSON and use the same details already collected in the conversation.'
      : "Do not mention Shopify or checkout links unless the backend confirms this tenant is ready for that flow.",
    shopifyCheckoutReady
      ? "Before checkout, show a very short order summary in chat style only after the customer is done adding items: list the items, total, key customer details, then ask for confirmation."
      : "Before finalizing any purchase, briefly confirm the key order details in normal language.",
    shopifyCheckoutReady
      ? "Important safety rule: a checkout link means checkout is ready, not that payment succeeded. Never say the order is confirmed or paid until the backend tells you that success is verified."
      : "If checkout is not active for this tenant, do not imply that payment or order confirmation happens automatically.",
    `Inferred stage: ${inferredStage}.`,
    `Known budget: ${inferredBudget || "unknown"}.`,
    `Known style: ${inferredStyle || "unknown"}.`,
    `Known use-case: ${inferredUseCase || "unknown"}.`,
    `Matched products for latest message: ${matchedProductText}.`,
    "BUSINESS INFO:",
    "Answer from the tenant's actual catalog and FAQs rather than reusing assumptions from another brand.",
    "Treat this tenant's catalog and rules as the only business truth for the conversation.",
    "PRODUCTS:",
    buildProductHighlights(products, tenant),
    "FAQS:",
    buildFaqText(faqs)
  ].join("\n\n");
}

module.exports = {
  buildMayaSystemPrompt,
  findMatchingProducts,
  buildProductResponse,
  buildBudgetRecommendationResponse,
  buildCollectionResponse,
  buildCategoryListingResponse,
  buildBrowseListingResponse,
  parseBudgetFromText
};
