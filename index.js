require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const { Resend } = require("resend");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

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

app.post("/chat", async (req, res) => {
  const { message, session_id } = req.body;
  if (!message || !session_id) {
    return res.status(400).json({ error: "message and session_id are required" });
  }
  try {
    await supabase.from("chat_messages").insert({ session_id, role: "user", content: message });

 const handoffTriggers = ["talk to a human", "speak to a human",
  "human agent", "real person", "talk to someone", "contact support"];
const purchaseTriggers = ["i want to buy", "i would like to buy",
  "purchase", "how do i buy", "how to buy", "i want to order",
  "ready to buy", "want to purchase", "id like to purchase"];

const wantsHuman = handoffTriggers.some((trigger) =>
  message.toLowerCase().includes(trigger)
);
const wantsToBuy = purchaseTriggers.some((trigger) =>
  message.toLowerCase().includes(trigger)
);

const phoneRegex = /(\+?\d[\d\s\-]{7,}\d)/;
const phoneMatch = message.match(phoneRegex);

if (phoneMatch) {
  const whatsappNumber = phoneMatch[0].trim();

  await supabase
    .from("handoff_requests")
    .update({ whatsapp: whatsappNumber })
    .eq("session_id", session_id)
    .eq("reason", "purchase_intent");

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: process.env.ALERT_EMAIL,
    subject: "Customer WhatsApp Number Received!",
    text: "Customer WhatsApp number: " + whatsappNumber + "\n\nSession ID: " + session_id + "\n\nContact them now to close the sale!",
  });

  const reply = "Thank you! Our team will contact you on " + whatsappNumber + " within minutes. Get ready to grow your business!";

  await supabase.from("chat_messages").insert({
    session_id,
    role: "assistant",
    content: reply,
  });

  return res.json({ reply });
}


if (wantsToBuy) {
  await supabase.from("handoff_requests").insert({
    session_id,
    reason: "purchase_intent",
    status: "pending",
    product_interest: message,
  });

  await resend.emails.send({
    from: "onboarding@resend.dev",
    to: process.env.ALERT_EMAIL,
    subject: "New Purchase Intent!",
    text: "A customer wants to buy!\n\nSession ID: " + session_id + "\nMessage: " + message + "\n\nFollow up with them immediately!",
  });

  const reply = "That's great! To complete your purchase, please share your WhatsApp number and our team will reach out to you within minutes to finalize everything.";

  await supabase.from("chat_messages").insert({
    session_id,
    role: "assistant",
    content: reply,
  });

  return res.json({ reply });
}

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
    text: "A customer is requesting a human agent. Session ID: " + session_id + " Message: " + message,
  });

  const reply = "I am connecting you to our team right now. Someone will be with you shortly!";

  await supabase.from("chat_messages").insert({
    session_id,
    role: "assistant",
    content: reply,
  });

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

    const systemPrompt = "You are a friendly customer support assistant for a digital products business that sells tools to physical product sellers.\n\nUse this information to answer questions:\n\n" + productList + "\n\n" + faqList + "\n\nGuidelines:\n- Keep all responses under 3 sentences\n- Be direct and concise\n- When listing products show name and price only\n- Never make up information not provided above";

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 200,
      messages: [{ role: "user", content: message }],
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
