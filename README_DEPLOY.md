# Oogiri App Deploy Guide

## Local start

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Deploy with Render

1. Push this `oogiri-app` folder to GitHub.
2. Open Render and create a new Web Service from the GitHub repository.
3. Use these settings:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: `NODE_ENV=production`
4. Deploy.

## Important storage note

This version saves accounts and ratings in `data/stats.json`.
On many free hosting services, local files can reset when the service restarts or redeploys.
For a real public release, move user data to a database such as PostgreSQL or Supabase.


## 戦績を消さずに公開する場合

この版は `DATABASE_URL` を設定すると、Supabase / PostgreSQL にユーザー情報と戦績を保存します。設定方法は `README_DB.md` を見てください。

開発中に1人でラウンド開始したい場合は、RenderのEnvironmentに以下を追加できます。

```text
MIN_PLAYERS_TO_START=1
```

公開時は2人以上開始に戻すのがおすすめです。
