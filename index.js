require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const { isValidPhoneNumber } = require("libphonenumber-js");

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function isValidPhone(number) {
  try {
    return isValidPhoneNumber(number);
  } catch (e) {
    return false;
  }
}

function isValidEmail(email) {
  return emailRegex.test(email.trim());
}

function detectContactChoice(msg) {
  if (msg.includes("1") || msg.includes("whatsapp")) return "whatsapp";
  if (msg.includes("2") || msg.includes("text")) return "text";
  if (msg.includes("3") || msg.includes("phone")) return "phone";
  if (msg.includes("4") || msg.includes("email")) return "email";
  return null;
}

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

    const handoffTriggers = ["talk to a human", "speak to a human", "human agent", "real person", "talk to someone", "contact support"];
    const purchaseTriggers = ["i want to buy", "i would like to buy", "purchase", "how do i buy", "how to buy", "i want to order", "ready to buy", "want to purchase", "can i buy", "id like to buy", "i will buy", "i want to purchase", "buy it", "buy this", "get it", "i want it", "how do i get"];

    const wantsHuman = handoffTriggers.some(function(t) { return message.toLowerCase().includes(t); });
    const wantsToBuy = purchaseTriggers.some(function(t) { return message.toLowerCase().includes(t); });

    const { data: existingHandoff } = await supabase
      .from("handoff_requests")
      .select("*")
      .eq("session_id", session_id)
      .eq("reason", "purchase_intent")
      .maybeSingle();

    if (existingHandoff && existingHandoff.contact_method === "phone" && existingHandoff.contact_detail && !existingHandoff.preferred_time) {
      const newChoice = detectContactChoice(message.toLowerCase());
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
      const newChoice = detectContactChoice(message.toLowerCase());

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
          const reply = "That does not look like a valid phone number. Please include your country code and full number, for example: +91 9876543210\n\nOr type 1, 2, 3 or 4 to choose a different contact method.";
          await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
          return res.json({ reply });
        }
      }

      if (existingHandoff.contact_method === "phone") {
        if (isValidPhone(rawMessage)) {
          await supabase.from("handoff_requests").update({ contact_detail: rawMessage }).eq("session_id", session_id).eq("reason", "purchase_intent");
          const reply = "Got it! What is the best time to call you at " + rawMessage + "?";
          await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
          return res.json({ reply });
        } else {
          const reply = "That does not look like a valid phone number. Please include your country code and full number, for example: +91 9876543210\n\nOr type 1, 2, 3 or 4 to choose a different contact method.";
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
          const reply = "That does not look like a valid email address. Please try again like this: name@example.com\n\nOr type 1, 2, 3 or 4 to choose a different contact method.";
          await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
          return res.json({ reply });
        }
      }
    }

    if (existingHandoff && !existingHandoff.contact_method) {
      const msg = message.toLowerCase();
      const choice = detectContactChoice(msg);
      let reply = "";
      if (choice === "whatsapp") {
        await supabase.from("handoff_requests").update({ contact_method: "whatsapp" }).eq("session_id", session_id).eq("reason", "purchase_intent");
        reply = "Please share your WhatsApp number with country code, for example: +91 9876543210";
      } else if (choice === "text") {
        await supabase.from("handoff_requests").update({ contact_method: "text" }).eq("session_id", session_id).eq("reason", "purchase_intent");
        reply = "Please share your mobile number with country code, for example: +91 9876543210";
      } else if (choice === "phone") {
        await supabase.from("handoff_requests").update({ contact_method: "phone" }).eq("session_id", session_id).eq("reason", "purchase_intent");
        reply = "Please share your phone number with country code, for example: +91 9876543210";
      } else if (choice === "email") {
        await supabase.from("handoff_requests").update({ contact_method: "email" }).eq("session_id", session_id).eq("reason", "purchase_intent");
        reply = "Please share your email address, for example: name@example.com";
      } else {
        reply = "Please choose one of these options:\n\n1. WhatsApp\n2. Text message\n3. Phone call\n4. Email";
      }
      await supabase.from("chat_messages").insert({ session_id, role: "assistant", content: reply });
      return res.json({ reply });
    }

    if (wantsToBuy) {
      await supabase.from("handoff_requests").insert({ session_id, reason: "purchase_intent", status: "pending", product_interest: message });
      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: process.env.ALERT_EMAIL,
        subject: "New Purchase Intent!",
        text: "A customer wants to buy!\nSession: " + session_id + "\nMessage: " + message,
      });
      const reply = "That is great! How would you prefer our team to contact you to complete your purchase?\n\n1. WhatsApp\n2. Text message\n3. Phone call\n4. Email\n\nJust reply with your preferred option!";
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
      ? recentChats.reverse().map(function(m) {
          return { role: m.role, content: m.content };
        })
      : [{ role: "user", content: message }];

    const systemPrompt = "You are a friendly customer support assistant for a digital products business that sells tools to physical product sellers.\n\nUse this information to answer questions:\n\n" + productList + "\n\n" + faqList + "\n\nGuidelines:\n- Keep all responses under 3 sentences\n- Be direct and concise\n- When listing products show name and price only\n- Never make up information not provided above\n- Remember context from previous messages in the conversation";

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
