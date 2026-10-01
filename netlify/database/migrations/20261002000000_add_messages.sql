-- 申請ごとのメッセージスレッド（会員⇔運営のやり取り・ポイント提示・納品連絡）
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  sender TEXT NOT NULL, -- 'member' / 'admin' / 'system'
  kind TEXT NOT NULL DEFAULT 'text', -- 'text'（通常メッセージ）/ 'quote'（ポイント提示）/ 'delivery'（納品連絡）/ 'system'（自動記録）
  body TEXT,
  point_cost INTEGER, -- kind='quote' の場合の提示ポイント数
  quote_status TEXT, -- kind='quote' の場合のみ使用：'pending'（会員の確認待ち）/ 'accepted'（正式受付済み）
  read_by_member BOOLEAN NOT NULL DEFAULT FALSE,
  read_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_application_id_idx ON messages (application_id);
