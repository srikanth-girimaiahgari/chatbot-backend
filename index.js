require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const { Resend } = require("resend");
const { connectCall } = require("./call-agent");
const { router: smsAgent, init: initSmsAgent } = require("./sms-agent");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

initSmsAgent(supabase, anthropic, require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN));

app.get("/", (req, res) => {
  res.json({ status: "Chatbot backend is running!" });
});

const VERIFY_TOKEN      = process.env.VERIFY_TOKEN || "maya_verify_token";
const IG_ACCESS_TOKEN   = process.env.IG_ACCESS_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN   = process.env.WA_ACCESS_TOKEN;

// ADD THESE 2 LINES:
console.log("WA_PHONE_NUMBER_ID at startup:", WA_PHONE_NUMBER_ID);
console.log("WA_ACCESS_TOKEN at startup:", WA_ACCESS_TOKEN?.substring(0, 20));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified ✅");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const body = req.body;
  console.log("Webhook event received:", JSON.stringify(body, null, 2));

  // Must respond 200 quickly so Meta doesn't retry
  res.sendStatus(200);

  // ── Instagram DMs ────────────────────────────────────────────────
  if (body.object === "instagram") {
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId   = event.sender?.id;
        const messageText = event.message?.text;
        if (event.message?.is_echo) continue;   // ignore bot's own echoes
        if (!messageText) continue;              // ignore stickers, reactions, etc.
        console.log(`[Instagram] Message from ${senderId}: ${messageText}`);
        const mayaReply = await getMayaReplyForInstagram(senderId, messageText);
        await sendReply(senderId, mayaReply);
      }
    }
    return;
  }

  // ── WhatsApp Business DMs ────────────────────────────────────────
  if (body.object === "whatsapp_business_account") {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const messages = change.value?.messages || [];
        for (const msg of messages) {
          if (msg.type !== "text") continue;          // ignore images, docs, stickers
          const senderPhone = msg.from;               // e.g. "919876543210"
          const messageText = msg.text?.body;
          if (!messageText) continue;
          console.log(`[WhatsApp] Message from ${senderPhone}: ${messageText}`);
          const mayaReply = await getMayaReplyForWhatsApp(senderPhone, messageText);
          await sendWhatsAppReply(senderPhone, mayaReply);
        }
      }
    }
    return;
  }
});

async function getMayaReplyForInstagram(senderId, messageText) {
  try {
    // Get or build conversation history from Supabase
    const { data: recentChats } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", senderId)
      .order("created_at", { ascending: false })
      .limit(10);

    // Save incoming message
    await supabase.from("chat_messages").insert({
      session_id: senderId,
      role: "user",
      content: messageText,
    });

    const { data: products } = await supabase.from("products").select("*").eq("in_stock", true);
    const { data: faqs } = await supabase.from("faqs").select("*");

    const conversationHistory = recentChats
      ? recentChats.reverse().map((m) => ({ role: m.role, content: m.content }))
      : [];

    conversationHistory.push({ role: "user", content: messageText });

    const productList = products && products.length > 0
      ? products.map((p) => {
          const sizes = p.sizes_in_stock && p.sizes_in_stock.length > 0
            ? `Sizes available: ${p.sizes_in_stock.join(", ")}`
            : "Currently out of stock in all sizes";
          return `${p.name} — ₹${p.price}\n  ${p.description}\n  ${sizes}`;
        }).join("\n\n")
      : "";

    const faqList = faqs && faqs.length > 0
      ? faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")
      : "";

    const systemPrompt = `You are Maya, a warm and stylish pre-sales assistant for an Indian ethnic wear brand. You help customers discover and buy beautiful lehengas, gowns, and festive outfits.

ABOUT THE BUSINESS:
We sell premium Indian ethnic wear — lehengas, gowns, and festive sets — for weddings, receptions, sangeets, and special occasions. All products are fully stitched, available in sizes S to XXL, with free shipping across India including GST.

PRODUCTS:
${productList}

FAQS:
${faqList}

HOW TO HANDLE A CUSTOMER WHO WANTS TO BUY:
1. First ask their name and what occasion they are shopping for
2. Then ask how they prefer to be contacted: A. Phone call B. WhatsApp C. Text message D. Email
3. Then ask for their contact detail (phone number or email)
4. Then confirm: "Thank you [name]! Our team will [contact method] you at [detail] within minutes!"
5. End with: HANDOFF_READY|[name]|[occasion]|[contact_method]|[contact_detail]|[product_interest]

IMPORTANT RULES:
- All prices are in Indian Rupees (₹). Never use $ symbol.
- Keep replies SHORT — this is an Instagram DM, 2-3 sentences max.
- Sound warm and conversational, like texting a stylish helpful friend.
- If asked about size, mention sizes run S to XXL and they should check the size chart.
- If asked about shipping, mention free shipping across India including GST.
- Wash care: Cindrella Gown is hand wash. All lehengas are dry clean only.
- Never make up information not in the product list above.`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: systemPrompt,
      messages: conversationHistory,
    });

    let reply = response.content[0].text;

    // Handle handoff trigger
    if (reply.includes("HANDOFF_READY|")) {
      const parts = reply.split("HANDOFF_READY|")[1].split("|");
      await supabase.from("handoff_requests").insert({
        session_id: senderId,
        reason: "purchase_intent",
        status: "pending",
        customer_name: parts[0] || "",
        contact_method: parts[2] || "",
        contact_detail: parts[3] || "",
        product_interest: parts[4] || "",
      });

      // Email alert to you
      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: process.env.ALERT_EMAIL,
        subject: `New Instagram Lead — ${parts[0]}`,
        text: `Name: ${parts[0]}\nProduct: ${parts[4]}\nContact: ${parts[2]} — ${parts[3]}`,
      });

      reply = reply.split("HANDOFF_READY|")[0].trim();
    }

    // Save MAYA's reply to history
    await supabase.from("chat_messages").insert({
      session_id: senderId,
      role: "assistant",
      content: reply,
    });

    return reply;

  } catch (err) {
    console.error("MAYA reply error:", err.message);
    return "Hey! Thanks for reaching out 👋 I'll have someone from the team get back to you shortly!";
  }
}

async function sendReply(recipientId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    });

    const options = {
      hostname: "graph.instagram.com",
      path: `/v21.0/me/messages?access_token=${IG_ACCESS_TOKEN}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const https = require("https");
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        console.log("Reply sent:", data);
        resolve();
      });
    });

    req.on("error", (err) => {
      console.error("Failed to send reply:", err.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

// ── WhatsApp: Maya AI reply ───────────────────────────────────────────────────
async function getMayaReplyForWhatsApp(senderPhone, messageText) {
  // Use "wa_" prefix so WhatsApp sessions never collide with Instagram sessions
  const sessionId = "wa_" + senderPhone;

  try {
    const { data: recentChats } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(10);

    await supabase.from("chat_messages").insert({
      session_id: sessionId,
      role: "user",
      content: messageText,
    });

    const { data: products } = await supabase.from("products").select("*").eq("in_stock", true);
    const { data: faqs }     = await supabase.from("faqs").select("*");

    const conversationHistory = recentChats
      ? recentChats.reverse().map((m) => ({ role: m.role, content: m.content }))
      : [];
    conversationHistory.push({ role: "user", content: messageText });

    const productList = products && products.length > 0
      ? products.map((p) => {
          const sizes = p.sizes_in_stock && p.sizes_in_stock.length > 0
            ? `Sizes available: ${p.sizes_in_stock.join(", ")}`
            : "Currently out of stock in all sizes";
          return `${p.name} — ₹${p.price}\n  ${p.description}\n  ${sizes}`;
        }).join("\n\n")
      : "";

    const faqList = faqs && faqs.length > 0
      ? faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")
      : "";

    const systemPrompt = `You are Maya, a warm and stylish pre-sales assistant for an Indian ethnic wear brand. You are replying on WhatsApp — keep messages friendly and concise.

ABOUT THE BUSINESS:
We sell premium Indian ethnic wear — lehengas, gowns, and festive sets — for weddings, receptions, sangeets, and special occasions. All products are fully stitched, available in sizes S to XXL, with free shipping across India including GST.

PRODUCTS:
${productList}

FAQS:
${faqList}

HOW TO HANDLE A CUSTOMER WHO WANTS TO BUY:
1. First ask their name and what occasion they are shopping for
2. Then ask how they prefer to be contacted: A. Phone call B. WhatsApp C. Text message D. Email
3. Then ask for their contact detail (phone number or email)
4. Then confirm: "Thank you [name]! Our team will [contact method] you at [detail] within minutes!"
5. End with: HANDOFF_READY|[name]|[occasion]|[contact_method]|[contact_detail]|[product_interest]

IMPORTANT RULES:
- All prices are in Indian Rupees (₹). Never use $ symbol.
- Keep replies SHORT — this is WhatsApp, 2-3 sentences max.
- Sound warm and conversational, like texting a helpful friend.
- If asked about size, mention sizes run S to XXL and they should check the size chart.
- If asked about shipping, mention free shipping across India including GST.
- Wash care: Cindrella Gown is hand wash. All lehengas are dry clean only.
- Never make up information not in the product list above.`;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      system: systemPrompt,
      messages: conversationHistory,
    });

    let reply = response.content[0].text;

    // Handle handoff trigger
    if (reply.includes("HANDOFF_READY|")) {
      const parts = reply.split("HANDOFF_READY|")[1].split("|");
      await supabase.from("handoff_requests").insert({
        session_id: sessionId,
        reason: "purchase_intent",
        status: "pending",
        customer_name: parts[0] || "",
        contact_method: parts[2] || "",
        contact_detail: parts[3] || "",
        product_interest: parts[4] || "",
      });

      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: process.env.ALERT_EMAIL,
        subject: `New WhatsApp Lead — ${parts[0]}`,
        text: `Name: ${parts[0]}\nProduct: ${parts[4]}\nContact: ${parts[2]} — ${parts[3]}\nWhatsApp: ${senderPhone}`,
      });

      reply = reply.split("HANDOFF_READY|")[0].trim();
    }

    await supabase.from("chat_messages").insert({
      session_id: sessionId,
      role: "assistant",
      content: reply,
    });

    return reply;

  } catch (err) {
    console.error("MAYA WhatsApp reply error:", err.message);
    return "Hey! Thanks for reaching out 👋 I'll have someone from our team get back to you shortly!";
  }
}

// ── WhatsApp: send reply via Cloud API ───────────────────────────────────────
async function sendWhatsAppReply(toPhone, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      messaging_product: "whatsapp",
      to: toPhone,
      type: "text",
      text: { body: text },
    });

    const options = {
      hostname: "graph.facebook.com",
      path: `/v21.0/${WA_PHONE_NUMBER_ID}/messages`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Authorization": `Bearer ${WA_ACCESS_TOKEN}`,
      },
    };

    const https = require("https");
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        console.log("WhatsApp reply sent:", data);
        resolve();
      });
    });

    req.on("error", (err) => {
      console.error("Failed to send WhatsApp reply:", err.message);
      resolve();
    });

    req.write(body);
    req.end();
  });
}

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

app.use("/", smsAgent);

app.post("/call/connect", require("./call-agent").handleConnect);

app.delete("/cleanup/:session_id", async (req, res) => {
  const { session_id } = req.params;
  await supabase.from("handoff_requests").delete().eq("session_id", session_id);
  await supabase.from("chat_messages").delete().eq("session_id", session_id);
  res.json({ message: "Session cleaned up: " + session_id });
});

app.post("/chat", async (req, res) => {
  const { message, session_id } = req.body;
  if (!message || !session_id) {
    return res.status(400).json({ error: "message and session_id are required" });
  }

  try {
    await supabase.from("chat_messages").insert({ session_id, role: "user", content: message });

    const { data: products } = await supabase.from("products").select("*").eq("in_stock", true);
    const { data: faqs } = await supabase.from("faqs").select("*");
    const { data: recentChats } = await supabase
      .from("chat_messages")
      .select("*")
      .eq("session_id", session_id)
      .order("created_at", { ascending: false })
      .limit(10);

    const conversationHistory = recentChats
      ? recentChats.reverse().map(function(m) { return { role: m.role, content: m.content }; })
      : [{ role: "user", content: message }];

    const productList = products && products.length > 0
      ? products.map(function(p) {
          var sizes = p.sizes_in_stock && p.sizes_in_stock.length > 0
            ? "Sizes available: " + p.sizes_in_stock.join(", ")
            : "Currently out of stock in all sizes";
          return p.name + " — ₹" + p.price + "\n  " + p.description + "\n  " + sizes;
        }).join("\n\n")
      : "";

    const faqList = faqs && faqs.length > 0
      ? faqs.map(function(f) { return "Q: " + f.question + "\nA: " + f.answer; }).join("\n\n")
      : "";

    const systemPrompt = "You are Maya, a warm and stylish pre-sales assistant for an Indian ethnic wear brand.\n\n" +
"ABOUT THE BUSINESS:\n" +
"We sell premium Indian ethnic wear — lehengas, gowns, and festive sets — for weddings, receptions, sangeets, and special occasions. All products are fully stitched, available in sizes S to XXL, with free shipping across India including GST.\n\n" +
"PRODUCTS:\n" + productList + "\n\n" +
"FAQS:\n" + faqList + "\n\n" +
"POLICIES:\n" +
"- All prices are in Indian Rupees (₹). Never use $ symbol.\n" +
"- Free shipping across India, price includes GST.\n" +
"- Sizes available: S to XXL. Customers should check the size chart before ordering.\n" +
"- Wash care: Cindrella Gown — hand wash. All lehengas — dry clean only.\n" +
"- Each set includes all pieces listed (blouse + skirt + dupatta where applicable).\n\n" +
"HOW TO HANDLE A CUSTOMER WHO WANTS TO BUY:\n" +
"1. First ask their name and what occasion they are shopping for\n" +
"2. Then ask how they prefer to be contacted: A. Phone call B. WhatsApp C. Text message D. Email\n" +
"3. Then ask for their contact detail (phone number or email)\n" +
"4. Then confirm: 'Thank you [name]! Our team will [contact method] you at [detail] within minutes!'\n" +
"5. End with: HANDOFF_READY|[name]|[occasion]|[contact_method]|[contact_detail]|[product_interest]\n\n" +
"HOW TO HANDLE A HUMAN AGENT REQUEST:\n" +
"1. Say: 'I am connecting you to our team right now. Someone will be with you shortly!'\n" +
"2. End with: HUMAN_HANDOFF|[session_id]\n\n" +
"IMPORTANT RULES:\n" +
"- Always answer any question the customer asks, even mid-purchase flow\n" +
"- Never ignore a question to push the purchase flow\n" +
"- Keep responses under 3 sentences unless listing products\n" +
"- Sound like a helpful human sales assistant\n" +
"- Never make up information not provided above\n" +
"- If customer changes their mind mid-flow, handle it naturally";

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: conversationHistory,
      system: systemPrompt,
    });

    let reply = response.content[0].text;

    if (reply.includes("HANDOFF_READY|")) {
      const parts = reply.split("HANDOFF_READY|")[1].split("|");
      const customerName = parts[0] || "";
      const businessType = parts[1] || "";
      const contactMethod = parts[2] || "";
      const contactDetail = parts[3] || "";
      const productInterest = parts[4] || "";

      await supabase.from("handoff_requests").insert({
        session_id,
        reason: "purchase_intent",
        status: "pending",
        customer_name: customerName,
        business_type: businessType,
        contact_method: contactMethod,
        contact_detail: contactDetail,
        product_interest: productInterest,
      });

      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: process.env.ALERT_EMAIL,
        subject: "New Purchase Lead — " + customerName,
        text: "Name: " + customerName + "\nBusiness: " + businessType + "\nProduct: " + productInterest + "\nContact: " + contactMethod + " — " + contactDetail,
      });

      if (contactMethod.toLowerCase().includes("phone")) {
        await connectCall(contactDetail, productInterest);
      }

      reply = reply.split("HANDOFF_READY|")[0].trim();
    }

    if (reply.includes("HUMAN_HANDOFF|")) {
      await supabase.from("handoff_requests").insert({
        session_id,
        reason: "customer_request",
        status: "pending",
      });

      await resend.emails.send({
        from: "onboarding@resend.dev",
        to: process.env.ALERT_EMAIL,
        subject: "Human Handoff Request",
        text: "A customer needs human support.\nSession: " + session_id,
      });

      reply = reply.split("HUMAN_HANDOFF|")[0].trim();
    }

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
