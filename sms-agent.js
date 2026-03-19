const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const twilio = require("twilio");
const router = express.Router();

let supabase, anthropic, twilioClient;

function init(supabaseClient, anthropicClient, twilioClientInstance) {
  supabase = supabaseClient;
  anthropic = anthropicClient;
  twilioClient = twilioClientInstance;
}

// ─── INCOMING SMS WEBHOOK ─────────────────────────────────────
router.post("/sms", async (req, res) => {
  const incomingMsg = req.body.Body;
  const fromNumber = req.body.From;
  const session_id = "sms_" + fromNumber.replace(/\D/g, "");

  try {
    await supabase.from("chat_messages").insert({
      session_id,
      role: "user",
      content: incomingMsg,
    });

    const intentDetection = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 20,
      system: "You are an intent detector. Analyze the message and reply with exactly one word: 'buy' if the customer wants to purchase something, 'human' if they want to talk to a human agent, or 'none' if neither.",
      messages: [{ role: "user", content: incomingMsg }]
    });

    const detectedIntent = intentDetection.content[0].text.trim().toLowerCase();

    if (detectedIntent === "human") {
      await supabase.from("handoff_requests").insert({
        session_id,
        reason: "customer_request",
        status: "pending",
      });
      const reply = "We have received your request. A team member will contact you shortly on " + fromNumber + ".";
      await sendSMS(fromNumber, reply);
      await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
      return res.send("<Response></Response>");
    }

    if (detectedIntent === "buy") {
      await supabase.from("handoff_requests").insert({
        session_id,
        reason: "purchase_intent",
        status: "pending",
        product_interest: incomingMsg,
        contact_method: "text",
        contact_detail: fromNumber,
      });
      const reply = "Great! We have noted your interest. Our team will text you back on " + fromNumber + " shortly to complete your purchase.";
      await sendSMS(fromNumber, reply);
      await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
      return res.send("<Response></Response>");
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
      : [{ role: "user", content: incomingMsg }];

    const systemPrompt = "You are a friendly customer support assistant for a digital products business that sells tools to physical product sellers.\n\nUse this information to answer questions:\n\n" + productList + "\n\n" + faqList + "\n\nGuidelines:\n- Keep responses under 2 sentences (SMS has character limits)\n- Be direct and concise\n- Never make up information not provided above";

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 150,
      messages: conversationHistory,
      system: systemPrompt,
    });

    const reply = response.content[0].text;
    await sendSMS(fromNumber, reply);
    await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
    res.send("<Response></Response>");

  } catch (err) {
    console.error("SMS error:", err.message);
    res.send("<Response></Response>");
  }
});

async function sendSMS(to, body) {
  await twilioClient.messages.create({
    body,
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
  });
}

module.exports = { router, init };