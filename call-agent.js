const twilio = require("twilio");

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

async function connectCall(customerNumber, customerMessage) {
  try {
    console.log("OWNER:", process.env.OWNER_PHONE_NUMBER);
console.log("FROM:", process.env.TWILIO_PHONE_NUMBER);
console.log("TO:", customerNumber);
    await twilioClient.calls.create({
      to: process.env.OWNER_PHONE_NUMBER || "+12244160090",
      from: process.env.TWILIO_PHONE_NUMBER,
      twiml: `<Response>
        <Say voice="alice">New customer alert. A customer is interested in your business. They said: ${customerMessage}. Press 1 to connect to them now.</Say>
        <Gather numDigits="1" action="/call/connect?customer=${encodeURIComponent(customerNumber)}" method="POST">
          <Say voice="alice">Press 1 to connect now or hang up to call them back later.</Say>
        </Gather>
        <Say voice="alice">No input received. You can call back the customer directly.</Say>
      </Response>`
    });
    console.log("Owner call initiated to", process.env.OWNER_PHONE_NUMBER);
  } catch (err) {
    console.error("Call error:", err.message);
  }
}

async function handleConnect(req, res) {
  const digit = req.body.Digits;
  const customerNumber = req.query.customer;

  if (digit === "1") {
    res.send(`<Response>
      <Say voice="alice">Connecting you to the customer now.</Say>
      <Dial>${customerNumber}</Dial>
    </Response>`);
  } else {
    res.send(`<Response>
      <Say voice="alice">Okay. You can call the customer back directly.</Say>
      <Hangup/>
    </Response>`);
  }
}

module.exports = { connectCall, handleConnect };