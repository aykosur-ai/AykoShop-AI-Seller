# n8n Workflows

## Import Order

Import these workflows in order in your n8n instance:

| # | File | Description | Status |
|---|------|-------------|--------|
| 1 | `01-main-seller.json` | Main AI Seller - Handles all customer messages | Active ✅ |
| 2 | `02-get-history.json` | Chat History Webhook - AI memory | Active ✅ |
| 3 | `03-ai-scoring.json` | Lead Scoring - Runs every hour | Active ✅ |
| 4 | `04-error-monitor.json` | Error Monitor - Runs every minute | Active ✅ |
| 5 | `05-ad-tracker.json` | Ad Source Tracker | Active ✅ |
| 6 | `06-ai-learning.json` | AI Learning System | Active ✅ |
| 7 | `07-daily-report.json` | Daily Report - 8AM Telegram | Active ✅ |

## How to Import

1. Open your n8n instance
2. Go to **Workflows** → **Import from file**
3. Import each JSON file in order
4. Configure credentials for each workflow:
   - PostgreSQL connection
   - Telegram Bot API
   - Google Drive OAuth2

## Webhooks

After importing, these webhooks will be available:

| Webhook | URL | Used By |
|---------|-----|---------|
| ManyChat | `/webhook/aykoshop-manychat` | Main Seller |
| Get History | `/webhook/aykoshop-get-history` | AI Memory |
| Get Examples | `/webhook/aykoshop-get-examples` | AI Learning |
| Daily Report | `/webhook/aykoshop-daily-report` | Dashboard |
| Ad Tracker | `/webhook/aykoshop-ad-tracker` | Ads |

## Configuration

Update these values in each workflow:
- `YOUR_VPS_IP` → Your VPS IP address
- `YOUR_TELEGRAM_BOT_TOKEN` → Your Telegram bot token
- `YOUR_TELEGRAM_CHAT_ID` → Your Telegram chat ID
- `YOUR_OPENAI_KEY` → Your OpenAI API key
- `YOUR_MANYCHAT_KEY` → Your ManyChat API key
