const express = require('express');

const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// Existing Meta webhook verification — preserved.
app.get('/', (req, res) => {
  const {
    'hub.mode': mode,
    'hub.challenge': challenge,
    'hub.verify_token': token
  } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Safely convert Flow answers to text.
function getAnswer(data, ...keys) {
  for (const key of keys) {
    if (data[key] !== undefined && data[key] !== null) {
      return typeof data[key] === 'object'
        ? JSON.stringify(data[key])
        : String(data[key]);
    }
  }
  return '';
}

// Receive Meta webhook events.
app.post('/', async (req, res) => {
  try {
    const entries = req.body.entry || [];

    for (const entry of entries) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        const messages = value.messages || [];
        const contacts = value.contacts || [];

        for (const message of messages) {
          // Only process completed WhatsApp Flow submissions.
          if (
            message.type !== 'interactive' ||
            message.interactive?.type !== 'nfm_reply'
          ) {
            continue;
          }

          const flowReply = message.interactive.nfm_reply;
          let answers = flowReply.response_json;

          if (typeof answers === 'string') {
            answers = JSON.parse(answers);
          }

          if (!answers || typeof answers !== 'object') {
            throw new Error('Flow response data is missing or invalid.');
          }

          const contact = contacts.find(
            item => item.wa_id === message.from
          ) || contacts[0] || {};

          const enquiry = {
            enquiry_id: message.id || `FLOW-${Date.now()}`,
            submitted_at: message.timestamp
              ? new Date(Number(message.timestamp) * 1000).toISOString()
              : new Date().toISOString(),

            customer_name:
              getAnswer(answers, 'customer_name', 'name') ||
              contact.profile?.name ||
              '',

            whatsapp_number:
              message.from || contact.wa_id || '',

            product: getAnswer(
              answers,
              'product',
              'category',
              'furniture_category'
            ),

            budget: getAnswer(answers, 'budget'),

            city: getAnswer(
              answers,
              'city',
              'delivery_city'
            ),

            requirements: getAnswer(
              answers,
              'requirements',
              'additional_requirements'
            )
          };

          const sheetsUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
          const sheetsSecret = process.env.GOOGLE_SHEETS_WEBHOOK_SECRET;

          if (!sheetsUrl || !sheetsSecret) {
            throw new Error('Google Sheets environment variables are missing.');
          }

          // Forward the enquiry to Google Apps Script.
          const response = await fetch(sheetsUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              token: sheetsSecret,
              enquiry: enquiry
            })
          });

          const responseText = await response.text();

          let result;
          try {
            result = JSON.parse(responseText);
          } catch {
            throw new Error('Google Sheets returned an invalid response.');
          }

          if (!response.ok || !result.success) {
            throw new Error(
              result.message || `Google Sheets HTTP ${response.status}`
            );
          }

          console.log(
            `FLOW ENQUIRY SAVED: ${result.enquiry_id}`
          );
        }
      }
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error('WEBHOOK PROCESSING ERROR:', error.message);
    return res.sendStatus(500);
  }
});

app.listen(port, () => {
  console.log(`Olympia Furniture webhook listening on port ${port}`);
});
