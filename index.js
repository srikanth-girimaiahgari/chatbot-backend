if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const { isValidPhoneNumber } = require("libphonenumber-js");
const { connectCall } = require("./call-agent");
const { handleConnect } = require("./call-agent");


const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function isValidPhone(number) {
  try {
    const cleaned = number.replace(/[\s\-\(\)]/g, "");
    return cleaned.startsWith("+") && cleaned.length >= 8 && cleaned.length <= 16;
  } catch (e) {
    return false;
  }
}

function isValidEmail(email) {
  return emailRegex.test(email.trim());
}

function detectContactChoice(msg) {
  if (msg.includes("a") || msg.includes("phone call") || msg.includes("call me")) return "phone";
  if (msg.includes("b") || msg.includes("whatsapp")) return "whatsapp";
  if (msg.includes("c") || msg.includes("text")) return "text";
  if (msg.includes("d") || msg.includes("email")) return "email";
  return null;
}

async function detectIntent(message) {
  const result = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 20,
    system: "You are an intent detector. Reply with exactly one word only: 'buy' ONLY if the customer explicitly says they want to purchase or buy a specific product, 'human' if they want to talk to a human agent or get direct support, or 'none' for everything else including questions about products, prices, availability or general inquiries.",
    messages: [{ role: "user", content: message }]
  });
  return result.content[0].text.trim().toLowerCase();
}


const { router: smsAgent, init: initSmsAgent } = require("./sms-agent");
initSmsAgent(supabase, anthropic, require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN));
app.use("/", smsAgent);
app.get("/", (req, res) => {
  res.json({ status: "Chatbot backend is running!" });
});

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

app.post("/call/connect", handleConnect);

app.use("/", smsAgent);

app.post("/chat", async (req, res) => {
  const { message, session_id } = req.body;
  if (!message || !session_id) {
    return res.status(400).json({ error: "message and session_id are required" });
  }
  try {
    await supabase.from("chat_messages").insert({ session_id, role: "user", content: message });

    const { data: existingHandoff } = await supabase
      .from("handoff_requests")
      .select("*")
      .eq("session_id", session_id)
      .eq("reason", "purchase_intent")
      .maybeSingle();

    if (existingHandoff && existingHandoff.contact_method === "phone" && existingHandoff.contact_detail && !existingHandoff.preferred_time) {
      const newChoice = isValidPhone(message.trim()) ? null : detectContactChoice(message.toLowerCase());
      if (newChoice) {
        await supabase.from("handoff_requests").update({ contact_method: newChoice, contact_detail: null, preferred_time: null }).eq("session_id", session_id).eq("reason", "purchase_intent");
        let reply = "";
        if (newChoice === "whatsapp") reply = "No problem! Please share your WhatsApp number with country code, for example: +91 9876543210";
        else if (newChoice === "text") reply = "No problem! Please share your mobile number with country code, for example: +91 9876543210";
        else if (newChoice === "phone") reply = "No problem! Please share your phone number with country code, for example: +91 9876543210";
        else if (newChoice === "email") reply = "No problem! Please share your email address, for example: name@example.com";
        await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
        return res.json({ reply });
      }
      await supabase.from("handoff_requests").update({ preferred_time: message }).eq("session_id", session_id).eq("reason", "purchase_intent");
      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: process.env.ALERT_EMAIL,
        subject: "Customer Phone Call Details Received!",
        text: "Number: " + existingHandoff.contact_detail + "\nPreferred time: " + message + "\nSession: " + session_id,
      });
      const reply = "Perfect! Our team will call you at " + message + ". Looking forward to helping you grow your business!";
      await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
      return res.json({ reply });
    }

    if (existingHandoff && existingHandoff.contact_method && !existingHandoff.contact_detail) {
      const rawMessage = message.trim();
      const newChoice = isValidPhone(rawMessage) ? null : detectContactChoice(message.toLowerCase());

      if (newChoice && newChoice !== existingHandoff.contact_method) {
        await supabase.from("handoff_requests").update({ contact_method: newChoice, contact_detail: null }).eq("session_id", session_id).eq("reason", "purchase_intent");
        let reply = "";
        if (newChoice === "whatsapp") reply = "No problem! Please share your WhatsApp number with country code, for example: +91 9876543210";
        else if (newChoice === "text") reply = "No problem! Please share your mobile number with country code, for example: +91 9876543210";
        else if (newChoice === "phone") reply = "No problem! Please share your phone number with country code, for example: +91 9876543210";
        else if (newChoice === "email") reply = "No problem! Please share your email address, for example: name@example.com";
        await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
        return res.json({ reply });
      }

      if (existingHandoff.contact_method === "whatsapp" || existingHandoff.contact_method === "text") {
        if (isValidPhone(rawMessage)) {
          await supabase.from("handoff_requests").update({ contact_detail: rawMessage }).eq("session_id", session_id).eq("reason", "purchase_intent");
          await resend.emails.send({
            from: "onboarding@resend.dev",
            to: process.env.ALERT_EMAIL,
            subject: "Customer Contact Detail Received!",
            text: "Contact method: " + existingHandoff.contact_method + "\nContact: " + rawMessage + "\nSession: " + session_id,
          });
          const reply = "Thank you! Our team will " + (existingHandoff.contact_method === "whatsapp" ? "message you on WhatsApp at " : "text you at ") + rawMessage + " within minutes!";
          await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
          return res.json({ reply });
        } else {
          const reply = "That does not look like a valid phone number. Please include your country code and full number, for example: +91 9876543210\n\nOr type A, B, C or D to choose a different contact method.";
          await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
          return res.json({ reply });
        }
      }

      if (existingHandoff.contact_method === "phone") {
        if (isValidPhone(rawMessage)) {
          await supabase.from("handoff_requests").update({ contact_detail: rawMessage, contact_method: "phone" }).eq("session_id", session_id).eq("reason", "purchase_intent");
          await connectCall(rawMessage, existingHandoff.product_interest || "your products");
          const reply = "Thank you! Our team will call you at " + rawMessage + " within minutes!";
          await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
          return res.json({ reply });
        } else {
          const reply = "That does not look like a valid phone number. Please include your country code and full number, for example: +91 9876543210\n\nOr type A, B, C or D to choose a different contact method.";
          await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
          return res.json({ reply });
        }
      }

      if (existingHandoff.contact_method === "email") {
        if (isValidEmail(rawMessage)) {
          await supabase.from("handoff_requests").update({ contact_detail: rawMessage }).eq("session_id", session_id).eq("reason", "purchase_intent");
          await resend.emails.send({
            from: "onboarding@resend.dev",
            to: process.env.ALERT_EMAIL,
            subject: "Customer Email Received!",
            text: "Customer email: " + rawMessage + "\nSession: " + session_id,
          });
          const reply = "Thank you! Our team will email you at " + rawMessage + " with payment details shortly!";
          await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
          return res.json({ reply });
        } else {
          const reply = "That does not look like a valid email address. Please try again like this: name@example.com\n\nOr type A, B, C or D to choose a different contact method.";
          await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
          return res.json({ reply });
        }
      }
    }

    if (existingHandoff && !existingHandoff.contact_method) {
      const choice = detectContactChoice(message.toLowerCase());
      let reply = "";
      if (choice === "phone") {
        await supabase.from("handoff_requests").update({ contact_method: "phone" }).eq("session_id", session_id).eq("reason", "purchase_intent");
        reply = "Please share your phone number with country code, for example: +91 9876543210";
      } else if (choice === "whatsapp") {
        await supabase.from("handoff_requests").update({ contact_method: "whatsapp" }).eq("session_id", session_id).eq("reason", "purchase_intent");
        reply = "Please share your WhatsApp number with country code, for example: +91 9876543210";
      } else if (choice === "text") {
        await supabase.from("handoff_requests").update({ contact_method: "text" }).eq("session_id", session_id).eq("reason", "purchase_intent");
        reply = "Please share your mobile number with country code, for example: +91 9876543210";
      } else if (choice === "email") {
        await supabase.from("handoff_requests").update({ contact_method: "email" }).eq("session_id", session_id).eq("reason", "purchase_intent");
        reply = "Please share your email address, for example: name@example.com";
      } else {
        reply = "Please choose one of these options:\n\nA. Phone call\nB. WhatsApp\nC. Text message\nD. Email";
      }
      await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
      return res.json({ reply });
    }

    const intent = await detectIntent(message);
    const wantsToBuy = intent === "buy";
    const wantsHuman = intent === "human";

    if (wantsToBuy) {
      await supabase.from("handoff_requests").insert({
        session_id,
        reason: "purchase_intent",
        status: "pending",
        product_interest: message,
      });
      const reply = "That is great! How would you like our team to reach you to complete your purchase?\n\nA. Phone call (we call you within minutes)\nB. WhatsApp\nC. Text message\nD. Email";
      await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
      return res.json({ reply });
    }

    if (wantsHuman) {
      await supabase.from("handoff_requests").insert({ session_id, reason: "customer_request", status: "pending" });
      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: process.env.ALERT_EMAIL,
        subject: "New Human Handoff Request",
        text: "A customer needs help.\nSession: " + session_id + "\nMessage: " + message,
      });
      const reply = "I am connecting you to our team right now. Someone will be with you shortly!";
      await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
      return res.json({ reply });
    }

    const { data: products } = await supabase.from("products").select("*").eq("in_stock", true);
    const { data: faqs } = await supabase.from("faqs").select("*");

    const productList = products && products.length > 0
      ? "PRODUCTS:\n" + products.map(function(p) { return "- " + p.name + " ($" + p.price + "): " + p.description; }).join("\n")
      : "";

    const faqList = faqs && faqs.length > 0
      ? "FAQS:\n" + faqs.map(function(f) { return "Q: " + f.question + "\nA: " + f.answer; }).join("\n\n")
      : "";

    const { data: recentChats } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", session_id)
      .order("created_at", { ascending: false })
      .limit(6);

    const conversationHistory = recentChats
      ? recentChats.reverse().map(function(m) { return { role: m.role, content: m.content }; })
      : [{ role: "user", content: message }];

   const systemPrompt = "You are Maya, a smart and friendly pre-sales assistant for a digital products business that helps physical product sellers run their business more efficiently.\n\n" +
"BUSINESS IDENTITY:\n" +
"We sell 5 digital tools designed specifically for small to medium physical product sellers — people who sell on markets, online stores, Instagram, WhatsApp or their own website.\n\n" +
"PRODUCT CATALOG:\n" +
"1. Inventory Tracker Pro ($29.99)\n" +
"   - Tracks stock movement, low inventory alerts, reorder points\n" +
"   - Best for: sellers who lose track of stock or run out unexpectedly\n" +
"   - Key benefit: never miss a sale due to stockout\n\n" +
"2. Profit Margin Calculator ($19.99)\n" +
"   - Calculates real profit after costs, shipping, fees, discounts\n" +
"   - Best for: sellers who are not sure if they are actually making money\n" +
"   - Key benefit: know your exact profit on every product\n\n" +
"3. Supplier Contact Manager ($24.99)\n" +
"   - Stores supplier details, pricing, order history, reorder info\n" +
"   - Best for: sellers who deal with multiple suppliers\n" +
"   - Key benefit: never lose a supplier contact or miss a reorder\n\n" +
"4. Sales Performance Dashboard ($39.99)\n" +
"   - Shows sales trends, top selling items, revenue performance\n" +
"   - Best for: sellers who want to understand what is working\n" +
"   - Key benefit: make data-driven decisions to grow faster\n\n" +
"5. Product Label & Barcode Kit ($14.99)\n" +
"   - Creates printable product labels and barcodes\n" +
"   - Best for: sellers who need professional looking labels\n" +
"   - Key benefit: look professional without a designer\n\n" +
"BUNDLE SUGGESTIONS:\n" +
"- Starter Bundle: Inventory Tracker Pro + Profit Margin Calculator (best for beginners)\n" +
"- Growth Bundle: Sales Performance Dashboard + Supplier Contact Manager (best for scaling)\n" +
"- Complete Bundle: all 5 products work together as a full business management system\n\n" +
"EDGE CASE ANSWERS:\n" +
"- Free trial: No free trial but we offer a 7-day money back guarantee\n" +
"- Shopify integration: Not yet but products work alongside any platform\n" +
"- Restaurants or non-product businesses: These tools are designed for product sellers, may not be the best fit\n" +
"- Already using Excel: Our tools are more structured and purpose-built, saving you setup time\n" +
"- Customisation: Not currently available but we are working on it\n\n" +
"BEHAVIOUR GUIDELINES:\n" +
"- Greet warmly and confidently\n" +
"- When asked who you are, introduce yourself and the business clearly\n" +
"- Always recommend the most relevant product based on the customer's specific need\n" +
"- Suggest bundles when customer asks about multiple products or buying more than one\n" +
"- Keep responses precise under 2 sentences unless listing products\n" +
"- Never make up features or prices not listed above\n" +
"- If customer says they are not ready yet, acknowledge and offer to send them info via email\n" +
"- Do not ask for contact details — the system handles that separately\n" +
"- Sound like a helpful human sales assistant, not a robot\n\n" +
"CURRENT PRODUCTS AND FAQS FROM DATABASE:\n" + productList + "\n\n" + faqList;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      messages: conversationHistory,
      system: systemPrompt,
    });

    const reply = response.content[0].text;
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
