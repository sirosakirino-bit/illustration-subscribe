-- 会員情報（Netlify Identityのアカウントと紐づく追加プロフィール・ポイント残高）
CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  identity_user_id TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  full_name TEXT,
  handle_name TEXT,
  zip TEXT,
  prefecture TEXT,
  address1 TEXT,
  address2 TEXT,
  usage_type TEXT,
  sns_x TEXT,
  sns_youtube TEXT,
  sns_twitch TEXT,
  plan TEXT NOT NULL DEFAULT 'point',
  point_balance INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ポイント使用申請（メニュー即時受付／特殊依頼の相談どちらも含む）
CREATE TABLE IF NOT EXISTS applications (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL, -- 'menu'（メニューから選択）or 'consult'（特殊な依頼の相談）
  title TEXT NOT NULL,
  details TEXT,
  point_cost INTEGER, -- 確定ポイント数（相談中はNULLの場合あり）
  point_estimate TEXT, -- 相談時点の希望目安（例：'4pt','わからない'）
  status TEXT NOT NULL DEFAULT 'ヒアリング中', -- 'ヒアリング中' → '制作中' → '対応完了'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ポイント残高の手動調整履歴（admin-point-adjust.html用）
CREATE TABLE IF NOT EXISTS point_adjustments (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  delta INTEGER NOT NULL, -- プラスは付与、マイナスは減算
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
