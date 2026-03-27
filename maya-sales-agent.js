function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function detectBudget(text) {
  const value = normalizeText(text);

  if (!value) {
    return null;
  }

  if (value.includes("under 1000") || value.includes("below 1000") || value.includes("less than 1000")) {
    return "Under Rs. 1000";
  }

  if (
    value.includes("1000 - 2000") ||
    value.includes("1000 to 2000") ||
    value.includes("between 1000 and 2000")
  ) {
    return "Rs. 1000 - Rs. 2000";
  }

  if (value.includes("above 2000") || value.includes("over 2000") || value.includes("more than 2000")) {
    return "Above Rs. 2000";
  }

  return null;
}

function parseBudgetFromText(text) {
  const value = normalizeText(text);

  if (!value) {
    return null;
  }

  if (value.includes("under") || value.includes("below") || value.includes("less than")) {
    const max = Number((value.match(/\d[\d,]*/g) || [])[0]?.replace(/,/g, ""));
    if (Number.isFinite(max)) {
      return { label: `Under Rs. ${max.toLocaleString("en-IN")}`, max };
    }
  }

  if (value.includes("above") || value.includes("over") || value.includes("more than")) {
    const min = Number((value.match(/\d[\d,]*/g) || [])[0]?.replace(/,/g, ""));
    if (Number.isFinite(min)) {
      return { label: `Above Rs. ${min.toLocaleString("en-IN")}`, min };
    }
  }

  const matches = value.match(/\d[\d,]*/g);
  if (matches && matches.length >= 2) {
    const min = Number(matches[0].replace(/,/g, ""));
    const max = Number(matches[1].replace(/,/g, ""));
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return {
        label: `Rs. ${min.toLocaleString("en-IN")} - Rs. ${max.toLocaleString("en-IN")}`,
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

function detectStage(messages, latestMessage) {
  const transcript = messages.map((message) => normalizeText(message.content || message.text)).join(" \n ");
  const latest = normalizeText(latestMessage);

  if (latest.includes("pay") || latest.includes("payment") || latest.includes("buy this") || latest.includes("i want this")) {
    return "ready_to_buy";
  }

  if (
    transcript.includes("budget") ||
    transcript.includes("under rs.") ||
    transcript.includes("rs. 1000") ||
    transcript.includes("above rs. 2000")
  ) {
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

function buildProductHighlights(products) {
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

    return `${product.name} — Rs. ${product.price}\n${product.description}\n${sizes}${tags ? `\nTags: ${tags}` : ""}`;
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

function buildProductResponse(product, latestMessage) {
  const message = normalizeText(latestMessage);
  const sizes = product.sizes_in_stock && product.sizes_in_stock.length > 0
    ? product.sizes_in_stock.join(", ")
    : null;
  const priceLine = `${product.name} is priced at Rs. ${product.price}.`;

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

function buildBudgetRecommendationResponse(products, latestMessage) {
  const budget = parseBudgetFromText(latestMessage);
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

  const lines = matches.map((product) => `${product.name} - Rs. ${product.price}. ${pickReason(product, latestMessage)}`);
  return `Here are ${matches.length} options in ${budget.label}:\n\n${lines.join("\n")}\n\nIf you want, I can narrow these by minimalist, trendy, or premium style too.`;
}

function buildMayaSystemPrompt({ products, faqs, contextLabel, recentChats, latestMessage }) {
  const inferredBudget = recentChats.map((chat) => detectBudget(chat.content)).find(Boolean) || detectBudget(latestMessage);
  const inferredStyle = recentChats.map((chat) => detectStyle(chat.content)).find(Boolean) || detectStyle(latestMessage);
  const inferredUseCase = recentChats.map((chat) => detectUseCase(chat.content)).find(Boolean) || detectUseCase(latestMessage);
  const inferredStage = detectStage(recentChats, latestMessage);
  const matchedProducts = findMatchingProducts(products, latestMessage);
  const matchedProductText = matchedProducts.length > 0
    ? matchedProducts.slice(0, 3).map((product) => `${product.name} = Rs. ${product.price}`).join(" | ")
    : "none";

  return [
    "You are MAYA, a warm sales assistant for an Indian ethnic wear brand.",
    `Channel: ${contextLabel}.`,
    "Your job is to reply like a real digital employee: understand intent, guide the shopper, recommend the right products, and gently move toward purchase.",
    "Always sound human, warm, concise, and confident.",
    "Reply in 2-4 short sentences unless listing options.",
    "Always use Indian Rupees written like Rs. 899 or Rs. 1,999.",
    "Never use the $ symbol.",
    "Never invent price, stock, shipping time, size details, or discount approvals.",
    "If the customer asks price, details, or availability and the message matches a product in the catalog, you must answer using that exact matched product name and exact database price first.",
    "Do not answer price questions with a broad collection range when an exact matched product price is available.",
    "Only mention a general price range if the customer explicitly asks for options by budget and no single product is clearly identified.",
    "If the customer asks price/details/availability, answer first with facts from the catalog, then ask one useful selling question.",
    "If budget is missing and recommendations would help, ask for budget using these choices: Under Rs. 1000, Rs. 1000 - Rs. 2000, Above Rs. 2000.",
    "If style is missing and recommendations would help, ask whether they prefer minimalist, trendy, or premium.",
    "When recommending products, suggest only 2-3 options and briefly say why each matches.",
    "If the customer clearly wants to buy, confirm the product and say the team can send a payment link right away.",
    "If the customer asks for custom design, unusual discount, negotiation, complaint handling, or something unclear after repeated back-and-forth, hand off to the team.",
    "If human handoff is needed, end with HUMAN_HANDOFF|[session_id].",
    "If the customer is ready to buy and wants a human/payment-link step, collect name, occasion, preferred contact method, then contact detail, and end with HANDOFF_READY|[name]|[occasion]|[contact_method]|[contact_detail]|[product_interest].",
    `Inferred stage: ${inferredStage}.`,
    `Known budget: ${inferredBudget || "unknown"}.`,
    `Known style: ${inferredStyle || "unknown"}.`,
    `Known use-case: ${inferredUseCase || "unknown"}.`,
    `Matched products for latest message: ${matchedProductText}.`,
    "BUSINESS INFO:",
    "We sell premium Indian ethnic wear for weddings, receptions, sangeets, festive occasions, and stylish daily dressing.",
    "Sizes run S to XXL.",
    "Free shipping across India including GST.",
    "Wash care: Cindrella Gown is hand wash. All lehengas are dry clean only.",
    "PRODUCTS:",
    buildProductHighlights(products),
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
