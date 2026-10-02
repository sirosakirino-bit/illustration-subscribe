-- 全体お知らせ配信の送信履歴（マイページでの告知表示用）
CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- お知らせ配信のテンプレート（件名・本文のひな形を保存しておき、配信画面から呼び出す）
CREATE TABLE IF NOT EXISTS announcement_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
