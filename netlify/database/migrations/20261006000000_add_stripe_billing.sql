-- Stripe決済連携：会員にStripe顧客・サブスクリプションの紐付けと支払い状況を持たせる
-- payment_status: 'pending'（Checkout未完了）/ 'active'（支払い中・トライアル中含む）
--                 / 'past_due'（支払い失敗・自動リトライ中）/ 'paused'（休止中）/ 'canceled'（解約済み）
ALTER TABLE members ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE members ADD COLUMN IF NOT EXISTS payment_failed_at TIMESTAMPTZ;
ALTER TABLE members ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
ALTER TABLE members ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE members ADD COLUMN IF NOT EXISTS card_brand TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS card_last4 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS members_stripe_customer_id_idx ON members (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS members_stripe_subscription_id_idx ON members (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- Stripeからの入金・解約イベント履歴（admin-payments.htmlの「直近の決済履歴」表示用）
CREATE TABLE IF NOT EXISTS payment_events (
  id SERIAL PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  stripe_event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, -- 'invoice.paid' / 'invoice.payment_failed' / 'subscription.canceled' / 'option_invoice.paid' など
  category TEXT NOT NULL DEFAULT 'subscription', -- 'subscription'（月額サブスク） / 'option'（オプション個別請求）
  amount INTEGER, -- 税込金額（円）
  status TEXT NOT NULL, -- '成功' / '失敗'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_events_member_id_idx ON payment_events (member_id);
CREATE INDEX IF NOT EXISTS payment_events_created_at_idx ON payment_events (created_at);
