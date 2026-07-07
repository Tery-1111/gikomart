const axios = require('axios');
const WHAPI_TOKEN = process.env.WHAPI_TOKEN;
const WHAPI_URL = 'https://gate.whapi.cloud';

// Format the broadcast message
function formatMessage(listing) {
  return `📦 *NEW AT GikoMart*: ${listing.title}
💰 *Price:* KSh ${listing.price.toLocaleString()}
📂 *Category:* ${listing.category}
✅ *Condition:* ${listing.condition}
📝 "${listing.description.slice(0, 100)}${listing.description.length > 100 ? '...' : ''}"
📍 *Location:* ${listing.location}
👤 *Seller:* ${listing.sellerName}
🔗 View & contact seller on GikoMart:
https://gikomart.onrender.com
👉 _Sent via GikoMart – Sell locally. Reach instantly._`;
}

// Send to a WhatsApp group or channel — image if available, text otherwise
async function sendToGroup(groupId, message, imageUrl) {
  try {
    let response;
    if (imageUrl) {
      response = await axios.post(
        `${WHAPI_URL}/messages/image`,
        { to: groupId, media: imageUrl, caption: message },
        { headers: { Authorization: `Bearer ${WHAPI_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    } else {
      response = await axios.post(
        `${WHAPI_URL}/messages/text`,
        { to: groupId, body: message },
        { headers: { Authorization: `Bearer ${WHAPI_TOKEN}`, 'Content-Type': 'application/json' } }
      );
    }
    return { success: true, data: response.data };
  } catch (err) {
    console.error('WhatsApp broadcast error:', err.message);
    return { success: false, error: err.message };
  }
}

// Main broadcast function
async function broadcastListing(listing) {
  const message = formatMessage(listing);
  const imageUrl = listing.images && listing.images.length > 0 ? listing.images[0] : null;
  const groups = process.env.WHATSAPP_GROUPS ? process.env.WHATSAPP_GROUPS.split(',') : [];
  if (!groups.length) {
    console.log('No WhatsApp groups configured — skipping broadcast');
    return;
  }
  const results = [];
  for (const groupId of groups) {
    const result = await sendToGroup(groupId.trim(), message, imageUrl);
    results.push({ groupId, ...result });
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('Broadcast results:', results);
  return results;
}

module.exports = { broadcastListing, formatMessage };