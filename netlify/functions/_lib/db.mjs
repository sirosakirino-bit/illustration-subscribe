import { getDatabase } from '@netlify/database';

// 通常は Netlify が自動で接続情報を渡してくれますが、
// このサイトの関数は「Lambda互換モード」という古い形式で書かれているため、
// 自動検出が効かず MissingDatabaseConnectionError になることがあります。
// そのため、Netlifyの「Database」画面でコピーした接続文字列を
// 環境変数 DB_CONNECTION_STRING として保存してもらい、それを明示的に渡します。
export function getDb() {
  const connectionString = process.env.DB_CONNECTION_STRING || process.env.NETLIFY_DB_URL;
  return connectionString ? getDatabase({ connectionString }) : getDatabase();
}
