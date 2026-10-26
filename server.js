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
    // In ra toàn bộ dữ liệu Pancake gửi sang để kiểm tra
    console.log('[DEBUG WEBHOOK RAW]:', JSON.stringify(req.body, null, 2));

    if (!isAITimeShift()) {
      console.log('[Ca Đêm] Đã nhận Webhook nhưng bỏ qua do đang là ban ngày.');
      return res.status(200).send({ status: 'Ignored: Outside AI shift hours (Daytime)' });
    }

    const webhookData = req.body;
    const customerMessages = extractRecentConversation(webhookData);
    if (!customerMessages || customerMessages.length === 0) {
      console.log('[Ca Đêm] Webhook không có nội dung tin nhắn hợp lệ.');
      return res.status(200).send({ status: 'Ignored: No relevant message' });
    }

    const extractedData = await parseWithOpenAI(customerMessages);
    if (!extractedData.is_order_confirmed || extractedData.confidence_score < 0.85) {
      console.log('[Ca Đêm] AI đánh giá khách chưa chốt đơn hoặc độ tin cậy thấp:', extractedData);
      return res.status(200).send({ status: 'Ignored: Order not confirmed yet' });
    }

    const draftOrderResult = await createPancakeDraftOrder(extractedData);
    console.log('[Ca Đêm] Đã tạo đơn nháp thành công trên Pancake:', draftOrderResult);
    return res.status(200).send({ status: 'Success Night Shift', order_id: draftOrderResult.id });

  } catch (error) {
    console.error('Lỗi xử lý webhook ca đêm:', error.message);
    return res.status(500).send({ error: error.message });
  }
});

async function parseWithOpenAI(conversationHistory) {
  const systemPrompt = `Bạn là trợ lý AI chuyên bóc tách đơn hàng từ tin nhắn Facebook/Pancake. Trả về đúng định dạng JSON Schema: {"is_order_confirmed": boolean, "customer_name": string, "phone_number": string, "shipping_address": string, "items": [{"sku": string, "quantity": number, "unit_price": number}], "confidence_score": number}. Không kèm text ngoài.`;

  const userPayload = {
    danh_muc_san_pham: PRODUCT_CATALOG,
    lich_su_hoi_thoai: conversationHistory
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

async function createPancakeDraftOrder(orderData) {
  const pancakeEndpoint = `https://pos.pancake.vn/api/v1/shops/${PANCAKE_SHOP_ID}/orders`;

  const payload = {
    customer: {
      name: orderData.customer_name,
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

function extractRecentConversation(payload) {
  if (payload.messages && Array.isArray(payload.messages)) return payload.messages;
  if (payload.message && payload.message.text) return [payload.message.text];
  if (payload.event_name === 'new_message' && payload.data) return [payload.data.message || payload.data.text];
  return [JSON.stringify(payload)];
}

app.listen(PORT, () => {
  console.log(`AI Backend đang chạy trên cổng ${PORT}`);
});
