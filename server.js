require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PANCAKE_API_TOKEN = process.env.PANCAKE_API_TOKEN;
const PANCAKE_SHOP_ID = process.env.PANCAKE_SHOP_ID;

const PRODUCT_CATALOG = [
  { sku: "DAC-RIM-CD-500G", name: "Đác Rim Chanh Dây 500g", price: 85000 },
  { sku: "MIT-THAI-SAY-500G", name: "Mít Thái Sấy Giòn 500g", price: 95000 }
];

function isAITimeShift() {
  const now = new Date();
  const currentHour = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh', hour: 'numeric', hour12: false }));
  if (currentHour >= 18 || currentHour < 8) {
    return true; 
  }
  return false; 
}

app.post('/webhook/pancake', async (req, res) => {
  try {
    console.log('[DEBUG WEBHOOK RAW]:', JSON.stringify(req.body, null, 2));

    res.status(200).json({ success: true, message: "Webhook received" });

    if (!isAITimeShift()) {
      console.log('[Ca Đêm] Đã nhận Webhook nhưng bỏ qua do đang là ban ngày.');
      return;
    }

    const webhookData = req.body;
    const customerMessage = extractLatestCustomerMessage(webhookData);
    const customerId = extractCustomerId(webhookData);

    if (!customerMessage || !customerId) {
      console.log('[Ca Đêm] Không tìm thấy nội dung tin nhắn hoặc ID khách hàng.');
      return;
    }

    const aiResponse = await chatAndParseWithOpenAI(customerMessage);
    
    if (aiResponse.reply_message) {
      await sendPancakeMessage(customerId, aiResponse.reply_message);
    }

    if (aiResponse.is_order_confirmed && aiResponse.confidence_score >= 0.85) {
      const draftOrderResult = await createPancakeDraftOrder(aiResponse);
      console.log('[Ca Đêm] Đã tạo đơn nháp thành công trên Pancake:', draftOrderResult);
      await sendPancakeMessage(customerId, "Dạ em đã lên đơn nháp cho mình rồi nhé ạ. Sáng ra shop sẽ liên hệ xác nhận và gửi hàng sớm cho anh chị ạ!");
    }

  } catch (error) {
    console.error('Lỗi xử lý webhook ca đêm:', error.message);
  }
});

async function chatAndParseWithOpenAI(customerMessage) {
  const systemPrompt = `Bạn là nhân viên tư vấn bán hàng ca đêm cho cửa hàng đặc sản ăn vặt (Đác Rim Chanh Dây 85k, Mít Thái Sấy Giòn 95k). 
Nhiệm vụ của bạn:
1. Trả lời/tư vấn lịch sự, thân thiện với khách. Nếu khách chưa chốt đơn, hãy tư vấn thêm.
2. Bóc tách thông tin đơn hàng nếu khách muốn mua.
Trả về đúng định dạng JSON Schema: 
{
  "reply_message": "string (nội dung tin nhắn tư vấn hoặc trả lời khách)",
  "is_order_confirmed": boolean, 
  "customer_name": "string", 
  "phone_number": "string", 
  "shipping_address": "string", 
  "items": [{"sku": "string", "quantity": number, "unit_price": number}], 
  "confidence_score": number
}
Không kèm text ngoài JSON.`;

  const userPayload = {
    danh_muc_san_pham: PRODUCT_CATALOG,
    tin_nhan_cua_khach: customerMessage
  };

  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) }
    ],
    response_format: { type: "json_object" }
  }, {
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` }
  });

  return JSON.parse(response.data.choices[0].message.content);
}

async function sendPancakeMessage(customerId, messageText) {
  try {
    const endpoint = `https://pos.pancake.vn/api/v1/shops/${PANCAKE_SHOP_ID}/conversations/${customerId}/messages`;
    await axios.post(endpoint, {
      message: messageText
    }, {
      headers: { 'Authorization': `Bearer ${PANCAKE_API_TOKEN}` }
    });
    console.log('[Ca Đêm] Đã gửi tin nhắn phản hồi cho khách thành công.');
  } catch (err) {
    console.error('Lỗi gửi tin nhắn qua Pancake:', err.response?.data || err.message);
  }
}

async function createPancakeDraftOrder(orderData) {
  const pancakeEndpoint = `https://pos.pancake.vn/api/v1/shops/${PANCAKE_SHOP_ID}/orders`;

  const payload = {
    customer: {
      name: orderData.customer_name || "Khách hàng Facebook",
      phone_number: orderData.phone_number,
      address: orderData.shipping_address
    },
    items: orderData.items.map(item => ({
      sku: item.sku,
      quantity: item.quantity,
      price: item.unit_price
    })),
    status: 'draft',
    tags: ['AI_ChoDuyet']
  };

  const response = await axios.post(pancakeEndpoint, payload, {
    headers: { 'Authorization': `Bearer ${PANCAKE_API_TOKEN}` }
  });

  return response.data;
}

// Mở rộng quét linh hoạt toàn bộ cấu trúc payload từ Pancake
function extractLatestCustomerMessage(payload) {
  if (payload.original_message) return payload.original_message;
  if (payload.message) {
    if (typeof payload.message === 'string') return payload.message;
    if (payload.message.original_message) return payload.message.original_message;
    if (payload.message.text) return payload.message.text;
  }
  if (payload.data) {
    if (payload.data.original_message) return payload.data.original_message;
    if (payload.data.message) return payload.data.message;
    if (payload.data.text) return payload.data.text;
  }
  if (payload.messages && Array.isArray(payload.messages) && payload.messages.length > 0) {
    const last = payload.messages[payload.messages.length - 1];
    return typeof last === 'string' ? last : (last.text || last.original_message || JSON.stringify(last));
  }
  return JSON.stringify(payload);
}

function extractCustomerId(payload) {
  if (payload.conversation_id) return payload.conversation_id;
  if (payload.message && payload.message.conversation_id) return payload.message.conversation_id;
  if (payload.data && payload.data.conversation_id) return payload.data.conversation_id;
  if (payload.sender && payload.sender.id) return payload.sender.id;
  return "default_conversation";
}

app.listen(PORT, () => {
  console.log(`AI Backend đang chạy trên cổng ${PORT}`);
});
