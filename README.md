# 🛍️ AykoShop AI Seller

> AI-powered Sales CRM & Dashboard for Digital Products

[![n8n](https://img.shields.io/badge/n8n-Automation-orange)](https://n8n.io)
[![OpenAI](https://img.shields.io/badge/OpenAI-GPT--4o-green)](https://openai.com)
[![ManyChat](https://img.shields.io/badge/ManyChat-Integrated-blue)](https://manychat.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-Database-blue)](https://postgresql.org)

## 🚀 Overview

AykoShop AI Seller is a complete AI-powered sales system for digital products (Free Fire, PUBG, Netflix, Spotify, etc.) that automates customer conversations across WhatsApp, Instagram, and Messenger.

## ✨ Features

- 🤖 **AI Seller** — GPT-4o responds to customers automatically
- 💬 **Unified Inbox** — WhatsApp + Instagram + Messenger in one place
- 👥 **Customer CRM** — Full profiles, history, tags, lead scoring
- 📦 **Digital Orders** — Track and manage digital product orders
- 🗂️ **Kanban Pipeline** — Drag & drop order management
- 🧠 **AI Learning** — Learns from your conversations automatically
- ❓ **Unknown Questions** — AI flags questions it can't answer for manual reply
- 📊 **Analytics** — Revenue, conversion rate, top products
- 🎯 **Customer Segments** — VIP, Hot, Lost, New customers
- ⏰ **Follow-up System** — Detect and re-engage lost customers
- 📢 **Broadcast** — Send bulk messages via ManyChat
- 🔮 **AI Insights** — Business intelligence from your data
- 🗄️ **Data Warehouse** — All conversations stored and searchable
- 📈 **Daily Reports** — Automated Telegram reports every morning
- 🔑 **Secure Login** — JWT authentication with password recovery

## 🏗️ Architecture

```
WhatsApp / Instagram / Messenger
         ↓
      ManyChat
         ↓
        n8n (Webhook)
         ↓
    OpenAI GPT-4o
         ↓
    PostgreSQL (VPS)
         ↓
    Dashboard (React-like HTML)
```

## 📁 Repository Structure

```
AykoShop-AI-Seller/
├── dashboard/
│   └── index.html          # Complete Dashboard (single file)
├── api/
│   └── server.js           # Express.js REST API
├── n8n-workflows/
│   ├── main-seller.json    # Main AI Seller workflow
│   ├── get-history.json    # Chat history webhook
│   ├── ai-scoring.json     # Lead scoring workflow
│   ├── error-monitor.json  # Error monitoring
│   ├── ad-tracker.json     # Ad tracking
│   ├── ai-learning.json    # AI learning system
│   └── daily-report.json   # Daily Telegram report
├── database/
│   └── schema.sql          # Complete PostgreSQL schema
├── prompts/
│   └── system-prompt.md    # AI system prompt template
├── docs/
│   └── api-reference.md    # API documentation
├── .env.example            # Environment variables template
├── package.json
├── README.md
└── DEPLOYMENT.md
```

## ⚡ Quick Start

### 1. Clone & Install
```bash
git clone https://github.com/yourusername/AykoShop-AI-Seller.git
cd AykoShop-AI-Seller
npm install
```

### 2. Configure Environment
```bash
cp .env.example .env
# Edit .env with your credentials
```

### 3. Setup Database
```bash
PGPASSWORD=yourpassword psql -U n8n -h localhost -d n8ndb -f database/schema.sql
```

### 4. Start API
```bash
npm start
# API runs on port 4000
```

### 5. Deploy Dashboard
```bash
cp dashboard/index.html /var/www/aykoshop/build/index.html
nginx -s reload
```

## 🔧 n8n Workflows

Import these workflows in order:
1. `main-seller.json` — Main AI conversation handler
2. `get-history.json` — Chat memory webhook
3. `ai-scoring.json` — Lead scoring (runs hourly)
4. `error-monitor.json` — Error monitoring (runs every minute)
5. `ad-tracker.json` — Ad source tracking
6. `ai-learning.json` — AI learning system
7. `daily-report.json` — Daily report (runs at 8AM)

## 🌐 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/products` | List products |
| GET | `/api/customers` | List customers |
| GET | `/api/orders` | List orders |
| GET | `/api/segments` | Customer segments |
| GET | `/api/follow-ups` | Follow-up needed |
| GET | `/api/ai-insights` | AI business insights |
| GET | `/api/warehouse/search` | Search conversations |
| POST | `/api/auth/login` | Login |
| POST | `/api/broadcasts/:id/send` | Send broadcast |

Full API reference: [docs/api-reference.md](docs/api-reference.md)

## 🔐 Default Credentials

- **Dashboard URL:** `http://YOUR_VPS_IP:3001`
- **API URL:** `http://YOUR_VPS_IP:4000`
- **Default Password:** `ayko2026` (change in Settings)
- **Recovery Email:** Set in Settings → Account Info

## 📱 Integrations

- **ManyChat:** Messenger + Instagram + WhatsApp
- **OpenAI:** GPT-4o for conversations + Vision for images
- **Telegram:** Admin notifications + daily reports
- **n8n:** Workflow automation
- **Google Drive:** Product image storage

## 📄 License

MIT License — Free to use and modify.

---

Built with ❤️ by Ayoub Akarfi
