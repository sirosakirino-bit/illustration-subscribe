-- 決済状況ページ（admin-payments.html）で、追加料金（オプション請求）の履歴に
-- 「何の請求か」を表示できるようにするための説明文カラム。
-- サブスクの月額課金イベントではNULLのまま（表示上は使わない）。
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS description TEXT;
