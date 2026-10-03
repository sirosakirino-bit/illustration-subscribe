-- 個別のオプション請求（商用利用・実績非公開・著作権譲渡・修正回数超過など）を
-- 申請のメッセージスレッドから、ステータスを問わずいつでもリクエストできるようにする。
-- Stripeの一回限りの請求書（Invoice）機能を使い、会員はメッセージ内の「お支払いはこちら」リンクから支払う
-- （サブスクの月額課金とは完全に別枠。Checkout SessionではなくInvoice APIを使うため、
-- 既存のcheckout.session.completedハンドラ（mode:'subscription'前提）には影響しない）。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS charge_amount INTEGER; -- kind='charge'の場合の請求金額（税込・円）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS charge_status TEXT; -- kind='charge'の場合のみ使用：'pending'（未払い）/ 'paid'（支払い済み）/ 'failed'（決済エラー）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS stripe_invoice_id TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS stripe_hosted_invoice_url TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS messages_stripe_invoice_id_idx ON messages (stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL;
