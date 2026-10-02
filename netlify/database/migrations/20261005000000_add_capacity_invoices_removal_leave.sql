-- 制作枠状況：月ごとに運営が調整する「ポイントプラン受付可能ポイント数」
CREATE TABLE IF NOT EXISTS capacity_settings (
  month TEXT PRIMARY KEY, -- 'YYYY-MM'
  available_points INTEGER NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 領収書の発行者情報（運営の氏名・連絡先・角印画像）。1行のみ使用する設定テーブル
CREATE TABLE IF NOT EXISTS invoice_issuer (
  id INTEGER PRIMARY KEY DEFAULT 1,
  full_name TEXT,
  phone TEXT,
  zip TEXT,
  address TEXT,
  stamp_image_data_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 発行済み領収書の履歴（運営の記帳・確定申告用）
CREATE TABLE IF NOT EXISTS receipts (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  period_month TEXT NOT NULL, -- 'YYYY-MM'（対象月）
  plan TEXT NOT NULL,
  amount_total INTEGER NOT NULL, -- 税込金額
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 会員：強制退会（即時利用停止）・退会予告・プラン変更予約の各フラグ
ALTER TABLE members ADD COLUMN IF NOT EXISTS is_removed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE members ADD COLUMN IF NOT EXISTS removed_reason TEXT;
ALTER TABLE members ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
ALTER TABLE members ADD COLUMN IF NOT EXISTS leave_requested_at TIMESTAMPTZ;

-- 申請：オプション（商用利用・実績非公開・著作権譲渡）の選択有無を記録
ALTER TABLE applications ADD COLUMN IF NOT EXISTS opt_commercial BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS opt_hidden BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS opt_copyright BOOLEAN NOT NULL DEFAULT false;
