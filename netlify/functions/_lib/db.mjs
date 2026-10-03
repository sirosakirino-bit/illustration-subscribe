// '@netlify/database' パッケージはここでは読み込まず、getDb()が実際に呼ばれた時に動的import()で読み込む。
// ※ トップレベルで固定的にimportすると、万が一そのパッケージが正しくインストール/バンドルされていない
//    環境では、このファイルをimportしているだけの関数（会員一覧・メッセージ・決済関連など、
//    DBを扱う処理すべて）が軒並み丸ごと動かなくなってしまうため（_lib/stripe.mjsと同じ対策）。
let _getDatabase = null;
async function loadGetDatabase() {
  if (_getDatabase) return _getDatabase;
  const mod = await import('@netlify/database');
  _getDatabase = mod.getDatabase;
  return _getDatabase;
}

// 通常は Netlify が自動で接続情報を渡してくれますが、
// このサイトの関数は「Lambda互換モード」という古い形式で書かれているため、
// 自動検出が効かず MissingDatabaseConnectionError になることがあります。
// そのため、Netlifyの「Database」画面でコピーした接続文字列を
// 環境変数 DB_CONNECTION_STRING として保存してもらい、それを明示的に渡します。
export async function getDb() {
  const getDatabase = await loadGetDatabase();
  const connectionString = process.env.DB_CONNECTION_STRING || process.env.NETLIFY_DB_URL;
  return connectionString ? getDatabase({ connectionString }) : getDatabase();
}
