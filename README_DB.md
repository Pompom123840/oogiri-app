# DB保存（Supabase / PostgreSQL）設定

この版は、環境変数 `DATABASE_URL` がある場合は PostgreSQL / Supabase に保存します。
`DATABASE_URL` がない場合は、従来通り `data/stats.json` にローカル保存します。

## Supabaseで使う場合

1. Supabaseで新しいProjectを作成
2. Project Settings → Database → Connection string を開く
3. URI形式の接続文字列をコピー
4. RenderのWeb Service → Environment に追加

```text
DATABASE_URL=postgresql://postgres.xxxxx:password@aws-xxxx.pooler.supabase.com:6543/postgres
```

Renderでは通常SSLが必要なので、基本はそのままでOKです。
ローカルPostgreSQLなどSSLなしで使う場合だけ、追加で以下を設定してください。

```text
DATABASE_SSL=false
```

## 1人テスト開始を許可したい場合

開発中だけ1人でラウンド開始したい場合は、環境変数を追加します。

```text
MIN_PLAYERS_TO_START=1
```

公開時は未設定、または `2` 推奨です。

## 保存されるもの

- ログインユーザー
- パスワードハッシュ
- レーティング
- トロフィー
- 勝利数
- 回答数
- 総得票数
- 通報退出回数
- BAN期限

初回起動時に `oogiri_app_state` テーブルが自動作成されます。
