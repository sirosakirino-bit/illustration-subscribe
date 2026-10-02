// ポイントプランの「今月の受付可能ポイント数」まわりの共通計算
// 月間総制作キャパは8pt固定。月1プランの基礎確保（2pt×人数）＋追加購入確定分を差し引いた
// 自動算出値を初期値としつつ、運営が capacity_settings で直接上書きできる。

const MONTHLY_CAP = 8;

function currentMonthKey(d) {
  const now = d || new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

function currentMonthStartIso(d) {
  const now = d || new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

export async function computeCapacity(db) {
  const month = currentMonthKey();
  const monthStart = currentMonthStartIso();

  const settingRows = await db.sql`SELECT * FROM capacity_settings WHERE month = ${month}`;

  const monthlyMemberRows = await db.sql`
    SELECT COUNT(*)::int AS c FROM members WHERE plan = 'monthly' AND is_removed = false
  `;
  const monthlyMemberCount = monthlyMemberRows[0].c;
  const baseReserved = monthlyMemberCount * 2;

  const extraRows = await db.sql`
    SELECT COUNT(*)::int AS c FROM applications
    WHERE kind = 'monthly' AND point_cost = 3 AND status IN ('制作中', '対応完了')
      AND created_at >= ${monthStart}
  `;
  const extraConfirmed = extraRows[0].c;

  const autoCalculated = Math.max(0, MONTHLY_CAP - baseReserved - extraConfirmed);
  const availablePoints = settingRows.length > 0 ? settingRows[0].available_points : autoCalculated;

  const holdRows = await db.sql`
    SELECT COALESCE(SUM(applications.point_cost), 0)::int AS held
    FROM applications
    JOIN members ON members.id = applications.member_id
    WHERE members.plan = 'point'
      AND applications.kind IN ('menu', 'consult')
      AND applications.status IN ('ヒアリング中', '制作中')
      AND applications.point_cost IS NOT NULL
      AND applications.created_at >= ${monthStart}
  `;
  const held = holdRows[0].held;
  const remaining = Math.max(0, availablePoints - held);

  return {
    month: month,
    cap: MONTHLY_CAP,
    monthly_member_count: monthlyMemberCount,
    base_reserved: baseReserved,
    extra_confirmed: extraConfirmed,
    auto_calculated: autoCalculated,
    available_points: availablePoints,
    held: held,
    remaining: remaining,
    updated_at: settingRows.length > 0 ? settingRows[0].updated_at : null,
    updated_by: settingRows.length > 0 ? settingRows[0].updated_by : null
  };
}

export async function setCapacity(db, availablePoints, updatedBy) {
  const month = currentMonthKey();
  await db.sql`
    INSERT INTO capacity_settings (month, available_points, updated_by, updated_at)
    VALUES (${month}, ${availablePoints}, ${updatedBy || null}, now())
    ON CONFLICT (month) DO UPDATE SET
      available_points = EXCLUDED.available_points,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `;
  return computeCapacity(db);
}
