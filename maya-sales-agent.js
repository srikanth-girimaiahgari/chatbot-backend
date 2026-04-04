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

function findMatchingProducts(products, latestMessage) {
  const message = normalizeText(latestMessage);

  return (products || []).filter((product) => {
    const name = normalizeText(product.name);
    if (!name) {
      return false;
    }

    if (message.includes(name)) {
      return true;
    }

    const nameTokens = name.split(/\s+/).filter((token) => token.length > 3);
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
  const priceLine = `${product.name} is priced at ${formatMoney(product.price, currency)}.`;
  const linkLine = product.product_url ? `Product link: ${product.product_url}.` : "";
  const imageLine = product.image_url ? `Image: ${product.image_url}.` : "";

  if (message.includes("image") || message.includes("photo") || message.includes("picture") || message.includes("pic")) {
    if (product.image_url || product.product_url) {
      return `${priceLine} ${imageLine} ${linkLine}`.trim();
    }
    return `${priceLine} I can help with product details, but an image link is not saved for this item yet.`;
  }

  if (message.includes("link") || message.includes("url") || message.includes("website")) {
    if (product.product_url) {
      return `${priceLine} ${linkLine}`.trim();
    }
    return `${priceLine} A product link is not saved for this item yet, but I can still help with details or similar options.`;
  }

  if (message.includes("available") || message.includes("availability") || message.includes("in stock")) {
    const stockLine = product.in_stock === false
      ? "It is currently out of stock."
      : "It is currently available.";
    return `${priceLine} ${stockLine} ${sizes ? `Sizes available: ${sizes}.` : ""} Would you like details or similar options too?`.trim();
  }

  if (message.includes("detail") || message.includes("details") || message.includes("more info")) {
    const description = product.description ? `${product.description}.` : "";
    return `${priceLine} ${description} ${sizes ? `Sizes available: ${sizes}.` : ""} Would you like me to show similar options too?`.trim();
  }

  if (message.includes("price") || message.includes("cost") || message.includes("how much")) {
    return `${priceLine} ${sizes ? `Sizes available: ${sizes}.` : ""} Would you like similar options in the same budget too?`.trim();
  }

  return null;
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
    return `I’m not seeing an in-stock option in ${budget.label} right now. If you want, I can show the closest available styles just above that budget.`;
  }

  const lines = matches.map((product) => `${product.name} - ${formatMoney(product.price, currency)}. ${pickReason(product, latestMessage)}`);
  return `Here are ${matches.length} options in ${budget.label}:\n\n${lines.join("\n")}\n\nIf you want, I can narrow these by minimalist, trendy, or premium style too.`;
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

  return [
    "You are MAYA, a warm sales assistant for this business.",
    `Channel: ${contextLabel}.`,
    "Your job is to reply like a real digital employee: understand intent, guide the shopper, recommend the right products, and gently move toward purchase.",
    "Always sound human, warm, concise, and confident.",
    "Reply in 2-4 short sentences unless listing options.",
    `Use the tenant's catalog currency consistently: ${currency.code} (${currency.symbol}).`,
    "Never switch to a different currency or invent currency symbols.",
    "Never invent price, stock, shipping time, size details, or discount approvals.",
    "If the customer asks price, details, or availability and the message matches a product in the catalog, you must answer using that exact matched product name and exact database price first.",
    "Do not answer price questions with a broad collection range when an exact matched product price is available.",
    "Only mention a general price range if the customer explicitly asks for options by budget and no single product is clearly identified.",
    "If the customer asks price/details/availability, answer first with facts from the catalog, then ask one useful selling question.",
    budgetPrompt
      ? `If budget is missing and recommendations would help, ask for budget using sensible catalog-based choices such as: ${budgetPrompt}.`
      : "If budget is missing and recommendations would help, ask for the customer's preferred budget range in the catalog's currency.",
    "Do not ask for budget as the first move unless the customer is explicitly asking for options by range or wants recommendations without naming a specific product.",
    "If style is missing and recommendations would help, ask whether they prefer minimalist, trendy, or premium.",
    "When recommending products, suggest only 2-3 options and briefly say why each matches.",
    "If the customer clearly wants to buy, confirm the product, confirm quantity, and say DigiMaya can move them to the next checkout step right away.",
    "If the customer asks for custom design, unusual discount, negotiation, complaint handling, or something unclear after repeated back-and-forth, hand off to the team.",
    "If human handoff is needed, end with HUMAN_HANDOFF|[session_id].",
    "If the customer is ready to buy, collect name, occasion, preferred contact method, then contact detail, confirm quantity, and end with HANDOFF_READY|[name]|[occasion]|[contact_method]|[contact_detail]|[product_interest]|[quantity]. Use quantity 1 if they do not specify a number.",
    `Inferred stage: ${inferredStage}.`,
    `Known budget: ${inferredBudget || "unknown"}.`,
    `Known style: ${inferredStyle || "unknown"}.`,
    `Known use-case: ${inferredUseCase || "unknown"}.`,
    `Matched products for latest message: ${matchedProductText}.`,
    "BUSINESS INFO:",
    "Answer from the tenant's actual catalog and FAQs rather than reusing assumptions from another brand.",
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
  parseBudgetFromText
};
