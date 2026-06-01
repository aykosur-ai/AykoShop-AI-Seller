-- AykoShop Database Schema v2.1
-- PostgreSQL

-- Products
CREATE TABLE IF NOT EXISTS aykoshop_products (
  id SERIAL PRIMARY KEY,
  product_name VARCHAR(255) NOT NULL,
  price VARCHAR(50),
  description TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  whatsapp_url TEXT DEFAULT '',
  instagram_url TEXT DEFAULT '',
  category VARCHAR(100) DEFAULT '',
  status VARCHAR(50) DEFAULT 'available',
  view_count INTEGER DEFAULT 0,
  order_count INTEGER DEFAULT 0,
  tags TEXT DEFAULT '',
  stock INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  sold_at TIMESTAMP
);

-- Customer Profiles
CREATE TABLE IF NOT EXISTS aykoshop_profiles (
  id SERIAL PRIMARY KEY,
  subscriber_id VARCHAR(100) UNIQUE NOT NULL,
  customer_name VARCHAR(255),
  channel VARCHAR(50) DEFAULT 'messenger',
  stage VARCHAR(50) DEFAULT 'cold',
  interested_in TEXT DEFAULT '',
  total_messages INTEGER DEFAULT 0,
  last_seen TIMESTAMP DEFAULT NOW(),
  p_notes TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Chat History
CREATE TABLE IF NOT EXISTS aykoshop_chat_history (
  id SERIAL PRIMARY KEY,
  subscriber_id VARCHAR(100) NOT NULL,
  role VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Orders (Digital Products)
CREATE TABLE IF NOT EXISTS aykoshop_orders (
  id SERIAL PRIMARY KEY,
  subscriber_id VARCHAR(100) DEFAULT '',
  customer_name VARCHAR(255),
  phone VARCHAR(50) DEFAULT '',
  product TEXT,
  city VARCHAR(100) DEFAULT 'digital',
  address TEXT DEFAULT '',
  price VARCHAR(50) DEFAULT '',
  status VARCHAR(50) DEFAULT 'new',
  channel VARCHAR(50) DEFAULT 'whatsapp',
  notes TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- AI Training
CREATE TABLE IF NOT EXISTS aykoshop_training (
  id SERIAL PRIMARY KEY,
  question TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  category VARCHAR(100) DEFAULT 'general',
  approved BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Conversation Examples (AI Memory)
CREATE TABLE IF NOT EXISTS aykoshop_conversation_examples (
  id SERIAL PRIMARY KEY,
  category VARCHAR(100) DEFAULT 'general',
  name VARCHAR(255) DEFAULT '',
  customer_message TEXT NOT NULL,
  correct_reply TEXT NOT NULL,
  source VARCHAR(50) DEFAULT 'manual',
  subscriber_id VARCHAR(100) DEFAULT '',
  approved BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Unknown Questions
CREATE TABLE IF NOT EXISTS aykoshop_unknown_questions (
  id SERIAL PRIMARY KEY,
  subscriber_id VARCHAR(100),
  customer_name VARCHAR(255),
  question TEXT NOT NULL,
  channel VARCHAR(50),
  manychat_link TEXT,
  answer TEXT DEFAULT '',
  learned BOOLEAN DEFAULT false,
  category VARCHAR(100) DEFAULT 'general',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Data Warehouse
CREATE TABLE IF NOT EXISTS aykoshop_warehouse (
  id SERIAL PRIMARY KEY,
  subscriber_id VARCHAR(100),
  customer_name VARCHAR(255),
  platform VARCHAR(50),
  message TEXT,
  ai_response TEXT,
  intent VARCHAR(50) DEFAULT 'general',
  category VARCHAR(100) DEFAULT 'general',
  result VARCHAR(50) DEFAULT 'pending',
  tags TEXT,
  order_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Lead Scores
CREATE TABLE IF NOT EXISTS aykoshop_lead_scores (
  id SERIAL PRIMARY KEY,
  subscriber_id VARCHAR(100) UNIQUE NOT NULL,
  lead_score INTEGER DEFAULT 0,
  sentiment VARCHAR(50) DEFAULT 'neutral',
  pipeline_stage VARCHAR(50),
  needs_follow_up BOOLEAN DEFAULT false,
  scored_at TIMESTAMP DEFAULT NOW()
);

-- Broadcasts
CREATE TABLE IF NOT EXISTS aykoshop_broadcasts (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255),
  message TEXT,
  target_stage VARCHAR(50) DEFAULT 'all',
  sent_count INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'draft',
  created_at TIMESTAMP DEFAULT NOW(),
  sent_at TIMESTAMP
);

-- Workflow Errors
CREATE TABLE IF NOT EXISTS aykoshop_workflow_errors (
  id SERIAL PRIMARY KEY,
  execution_id VARCHAR(100),
  workflow_id VARCHAR(100),
  workflow_name VARCHAR(255),
  error_message TEXT,
  error_node VARCHAR(255),
  started_at TIMESTAMP DEFAULT NOW(),
  resolved BOOLEAN DEFAULT false
);

-- Ad Tracking
CREATE TABLE IF NOT EXISTS aykoshop_ad_tracking (
  id SERIAL PRIMARY KEY,
  subscriber_id VARCHAR(100),
  customer_name VARCHAR(255),
  ad_source VARCHAR(255),
  ad_campaign VARCHAR(255),
  ad_platform VARCHAR(100),
  visits INTEGER DEFAULT 1,
  converted BOOLEAN DEFAULT false,
  revenue DECIMAL(10,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Stopped Chats
CREATE TABLE IF NOT EXISTS aykoshop_stopped_chats (
  id SERIAL PRIMARY KEY,
  subscriber_id VARCHAR(100) UNIQUE NOT NULL,
  reason TEXT DEFAULT '',
  stopped_at TIMESTAMP DEFAULT NOW()
);

-- Settings
CREATE TABLE IF NOT EXISTS aykoshop_settings (
  id SERIAL PRIMARY KEY,
  key VARCHAR(100) UNIQUE NOT NULL,
  value TEXT,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Default Settings
INSERT INTO aykoshop_settings (key, value) VALUES
  ('admin_password', 'ayko2026'),
  ('store_email', 'your@email.com'),
  ('store_name', 'AykoShop'),
  ('store_phone', '212XXXXXXXXX'),
  ('system_prompt', '')
ON CONFLICT (key) DO NOTHING;

-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_profiles_subscriber ON aykoshop_profiles(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_profiles_last_seen ON aykoshop_profiles(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_stage ON aykoshop_profiles(stage);
CREATE INDEX IF NOT EXISTS idx_chat_history_subscriber ON aykoshop_chat_history(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_created ON aykoshop_chat_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON aykoshop_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON aykoshop_orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_warehouse_subscriber ON aykoshop_warehouse(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_category ON aykoshop_warehouse(category);
CREATE INDEX IF NOT EXISTS idx_lead_scores_score ON aykoshop_lead_scores(lead_score DESC);
