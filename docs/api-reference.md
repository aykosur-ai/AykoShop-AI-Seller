# AykoShop API Reference v2.1

Base URL: `http://YOUR_VPS_IP:4000`

## Authentication

```bash
POST /api/auth/login
Body: { "password": "ayko2026" }
Response: { "token": "eyJ...", "expires_in": "7 days" }

GET /api/auth/verify
Headers: Authorization: Bearer TOKEN
```

## Stats
```bash
GET /api/stats
Response: { available, sold, customers, messages_today, top_categories, sales_by_day }
```

## Products
```bash
GET    /api/products
POST   /api/products/add      Body: { product_name, price, description, image_url, category, status }
PUT    /api/products/:id      Body: { product_name, price, ... }
DELETE /api/products/:id
PATCH  /api/products/:id/status   Body: { status: "sold"|"available" }
```

## Customers
```bash
GET /api/customers
GET /api/customers/:subscriber_id/history
GET /api/customers/:subscriber_id/timeline
```

## Orders
```bash
GET    /api/orders
POST   /api/orders     Body: { customer_name, phone, product, price, status, channel }
PUT    /api/orders/:id
DELETE /api/orders/:id
```

## Training & Conversations
```bash
GET    /api/training
POST   /api/training    Body: { question, correct_answer, category }
DELETE /api/training/:id

GET    /api/conversations
POST   /api/conversations   Body: { category, name, customer_message, correct_reply }
DELETE /api/conversations/:id
```

## Unknown Questions
```bash
GET    /api/unknown-questions
POST   /api/unknown-questions
PATCH  /api/unknown-questions/:id/answer   Body: { answer, category }
DELETE /api/unknown-questions/:id
```

## Warehouse
```bash
GET  /api/warehouse/stats
GET  /api/warehouse/search?q=TEXT&category=CAT&platform=PLATFORM&result=RESULT
POST /api/warehouse
PATCH /api/warehouse/:id/result   Body: { result: "purchased"|"not_purchased"|"pending" }
```

## Analytics
```bash
GET /api/demands?period=day|week|month
GET /api/lead-scores
GET /api/pipeline
GET /api/segments
GET /api/follow-ups
GET /api/ai-insights
```

## Broadcasts
```bash
GET  /api/broadcasts
POST /api/broadcasts      Body: { title, message, target_stage }
POST /api/broadcasts/:id/send
```

## Settings
```bash
GET  /api/settings
POST /api/settings    Body: { key, value }
POST /api/settings/change-password   Body: { current_password, new_password }
POST /api/settings/reset-password    Body: { email, new_password }
GET  /api/system-prompt
POST /api/system-prompt   Body: { prompt }
```

## Export
```bash
GET /api/export/customers      → CSV
GET /api/export/orders         → CSV
GET /api/export/conversations  → CSV
```

## Follow-ups
```bash
GET  /api/follow-ups
POST /api/follow-ups/bulk-send   Body: { message, target: "all"|"hot"|"lost" }
```

## Errors
```bash
GET   /api/workflow-errors
PATCH /api/workflow-errors/:id/resolve
```
