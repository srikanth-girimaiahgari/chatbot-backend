require("dotenv").config();
console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);

const app = express();
app.use(cors());
app.use(express.json());

// Connect to Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Connect to Claude
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Email transporter

// ─── HEALTH CHECK ───────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Chatbot backend is running!" });
});

// ─── PRODUCTS SEARCH ────────────────────────────────────
app.get("/products", async (req, res) => {
  const { search } = req.query;
  try {
    let query = supabase.from("products").select("*");
    if (search) {
      query = query.ilike("name", `%${search}%`);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ products: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CHAT ────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  const { message, session_id } = req.body;

  if (!message || !session_id) {
    return res.status(400).json({ error: "message and session_id are required" });
  }

  try {
    console.log("Message received:", message);
    // Save user message to database
    await supabase.from("chat_messages").insert({
      session_id,
      role: "user",
      content: message,
    });

    // Check if user wants human handoff
    const handoffTriggers = ["talk to a human", "speak to a human",
      "human agent", "real person", "talk to someone", "contact support"];
    const wantsHuman = handoffTriggers.some((trigger) =>
      message.toLowerCase().includes(trigger)
    );
    console.log("Wants human:", wantsHuman);
    if (wantsHuman) {
      await supabase.from("handoff_requests").insert({
        session_id,
        reason: "customer_request",
        status: "pending",
      });

      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: process.env.ALERT_EMAIL,
        subject: "New Human Handoff Request",
        text: `A customer is requesting a human agent.\n\nSession ID: ${session_id}\nMessage: ${message}`,
      });

      const reply = "I'm connecting you to our team right now. Someone will be with you shortly!";

      await supabase.from("chat_messages").insert({
        session_id,
        role: "assistant",
        content: reply,
      });

      return res.json({ reply });
    }

    // Check FAQs first
    const words = message.toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .split(" ")
      .filter(w => w.length > 3)
      .sort((a, b) => b.length - a.length);
      .filter(w => !["products", "product"].includes(w));
    console.log("Search words:", words);

    let faqMatch = null;
    for (const word of words) {
      const { data } = await supabase
        .from("faqs")
        .select("*")
        .ilike("question", `%${word}%`)
        .limit(1);
      console.log("Searching FAQ for:", word, "Result:", data);
      if (data && data.length > 0) {
        faqMatch = data[0];
        break;
      }
    }

    if (faqMatch) {
      const reply = faqMatch.answer;

      await supabase.from("chat_messages").insert({
        session_id,
        role: "assistant",
        content: reply,
      });

      return res.json({ reply });
    }

    // Check products if message mentions product keywords
    const productKeywords = ["product", "stock", "available", 
      "buy", "purchase", "sell", "have", "list", "show", "what"];
    const mentionsProduct = productKeywords.some((word) =>
      message.toLowerCase().includes(word)
    );

    let productContext = "";
    if (mentionsProduct) {
      const { data: products } = await supabase
        .from("products")
        .select("*")
        .eq("in_stock", true);

      if (products && products.length > 0) {
        productContext = "Our available products are:\n" +
          products.map((p) =>
            `- ${p.name}: $${p.price}`
          ).join("\n");
      }
    }

    // Call Claude API
    const systemPrompt = `You are a helpful customer support assistant for a digital products business that sells tools to physical product sellers. 
When listing products, always format them as a numbered list with name and price only.
Keep responses concise and under 100 words.
Never cut off a list midway — always complete it.
${productContext ? `\n${productContext}` : ""}`;
    console.log("Product context:", productContext);
    console.log("System prompt:", systemPrompt);
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 500,
      messages: [{ role: "user", content: message }],
      system: systemPrompt,
    });

    const reply = response.content[0].text;

    await supabase.from("chat_messages").insert({
      session_id,
      role: "assistant",
      content: reply,
    });

    res.json({ reply });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── HANDOFF QUEUE ───────────────────────────────────────
app.get("/handoff", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("handoff_requests")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (error) throw error;
    res.json({ queue: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chatbot backend running on port ${PORT}`);
});
