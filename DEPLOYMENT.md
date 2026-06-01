# 🚀 Deployment Guide — AykoShop AI Seller

## Requirements

- VPS (Ubuntu 20.04+) — Recommended: Contabo 4GB RAM
- Node.js 18+
- PostgreSQL 14+
- nginx
- PM2
- n8n Cloud account
- ManyChat account
- OpenAI API key

---

## Step 1: VPS Initial Setup

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt install -y nodejs

# Install nginx
apt install -y nginx

# Install PM2
npm install -g pm2

# Install PostgreSQL
apt install -y postgresql postgresql-contrib
```

---

## Step 2: Database Setup

```bash
# Create database user and database
sudo -u postgres psql -c "CREATE USER n8n WITH PASSWORD 'aykoshop2024';"
sudo -u postgres psql -c "CREATE DATABASE n8ndb OWNER n8n;"

# Run schema
PGPASSWORD=aykoshop2024 psql -U n8n -h localhost -d n8ndb -f database/schema.sql
```

---

## Step 3: API Setup

```bash
# Create backend directory
mkdir -p /var/www/backend
cp api/server.js /var/www/backend/
cp package.json /var/www/backend/
cd /var/www/backend

# Install dependencies
npm install

# Create .env file
cp .env.example .env
nano .env  # Edit with your credentials

# Start with PM2
pm2 start server.js --name aykoshop-api
pm2 save
pm2 startup
```

---

## Step 4: Dashboard Setup

```bash
# Create frontend directory
mkdir -p /var/www/aykoshop/build
cp dashboard/index.html /var/www/aykoshop/build/index.html
```

---

## Step 5: nginx Configuration

```bash
# Create nginx config
cat > /etc/nginx/sites-available/aykoshop << 'EOF'
server {
    listen 3001;
    root /var/www/aykoshop/build;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
EOF

# Enable site
ln -s /etc/nginx/sites-available/aykoshop /etc/nginx/sites-enabled/
nginx -t && nginx -s reload
```

---

## Step 6: n8n Workflows

1. Go to your n8n Cloud instance
2. Import each workflow from `n8n-workflows/` folder
3. Configure credentials:
   - **PostgreSQL:** host=YOUR_VPS_IP, db=n8ndb, user=n8n, pass=aykoshop2024
   - **Telegram:** Add your bot token
   - **Google Drive:** OAuth2 setup
4. Activate all workflows

---

## Step 7: ManyChat Setup

1. Create a flow in ManyChat
2. Add **External Request** action
3. Set URL: `https://YOUR_N8N_URL/webhook/aykoshop-manychat`
4. Method: POST
5. Body: `{"subscriber_id": "{{subscriber_id}}", "message": "{{last_input_text}}", "channel": "messenger"}`

---

## Step 8: Firewall

```bash
# Allow required ports
ufw allow 22    # SSH
ufw allow 80    # HTTP
ufw allow 443   # HTTPS
ufw allow 3001  # Dashboard
ufw allow 4000  # API
ufw enable
```

---

## Maintenance

```bash
# Check API status
pm2 status

# View logs
pm2 logs aykoshop-api

# Restart API
pm2 restart aykoshop-api

# Update dashboard
scp dashboard/index.html root@YOUR_VPS:/var/www/aykoshop/build/index.html
nginx -s reload

# Database backup
PGPASSWORD=aykoshop2024 pg_dump -U n8n -h localhost n8ndb > backup_$(date +%Y%m%d).sql
```

---

## Default Access

| Service | URL | Default Password |
|---------|-----|-----------------|
| Dashboard | `http://YOUR_VPS:3001` | `ayko2026` |
| API | `http://YOUR_VPS:4000` | — |
| n8n | `https://YOUR_N8N_URL` | — |

> ⚠️ Change default password immediately after deployment!
