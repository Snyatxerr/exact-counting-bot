# 数式カウント

Discordの1サーバー・1テキストチャンネルで、数式を使って1から順に数えるBotです。Cloudflare Workersと固定IDのSQLite-backed Durable Object 1個で動作します。PCを起動し続ける必要はありません。

## 遊び方

管理者が対象チャンネルで `/set` を実行すると受付を開始します。本文全体に `1`、`2/1`、`sqrt(9)` などを書きます。直前の正解者以外の人が次の整数を答えると✅が付き、個人の累計正解数が増えます。

正しい式でも期待値と異なる場合、または直前の正解者が続けて正解を答えた場合は❌となり、次は1に戻ります。無効な式・一致を確定できない式・雑談は進行を変えません。編集・削除では再判定しません。BotとWebhookからの投稿は対象外です。数式の詳細は [MATH.md](MATH.md) を参照してください。

| コマンド | 内容 |
| --- | --- |
| `/set` | このチャンネルで開始・再開・移動。保存済みの進行・統計を保持 |
| `/stop` | 進行と統計を保持して停止 |
| `/reset` | 現在値と最後の正解者を初期化。最高記録・累計は保持。停止中は再開しない |
| `/status` | 受付・Gateway接続・現在値・次の数・最高記録 |
| `/stats [user]` | 個人の累計正解数 |
| `/ranking` | 累計正解数の上位10人 |
| `/help` | 日本語の遊び方と数式の対応範囲 |

上3つはサーバー管理権限が必要です。すべてのコマンドの応答は、実行したチャンネルを閲覧できる全員に表示されます。ランキング・個人統計・最後の正解者はDiscordの名前表示を使用し、名前の表示によるメンション通知は送りません。

## 構成

- `src/game.ts`：進行・交代・リセットの状態遷移
- `src/parser.ts`、`src/rational.ts`、`src/math.ts`：入力構文・BigInt有理数・厳密数学判定
- `src/store.ts`：SQLite保存、重複排除、永続outbox、保持期限の整理
- `src/worker.ts`：Discord署名検証、Gateway接続、コマンド、通知、Cron
- `scripts/`：Guildコマンド登録、Secrets登録などの導入用スクリプト
- `tests/`：数学・状態遷移・Workers実行環境・署名・Gateway・保存データ整理の検証

入力方法は [入力方法メモ.md](入力方法メモ.md)、数学の範囲は [MATH.md](MATH.md)、実施済みの検証と未確認事項は [VERIFICATION.md](VERIFICATION.md) に記載しています。

## 再セットアップ・デプロイ

Node 26.13.xとnpmを用意し、クローンしたディレクトリで `npm ci` を実行します。依存バージョンは `package-lock.json`、Nodeのバージョンは `.nvmrc` に固定しています。以下はWindows PowerShellの手順です。

```powershell
npm ci
if (!(Test-Path -LiteralPath wrangler.jsonc)) {
  Copy-Item -LiteralPath wrangler.jsonc.example -Destination wrangler.jsonc
}
if (!(Test-Path -LiteralPath .dev.vars)) {
  Copy-Item -LiteralPath .dev.vars.example -Destination .dev.vars
}
```

`wrangler.jsonc` と `.dev.vars` はローカル設定としてGit対象外です。リポジトリには `.example` のみを含めます。既存環境の設定は上書きしないでください。

1. Discord Developer Portalでアプリを作成し、`wrangler.jsonc` の `DISCORD_APPLICATION_ID`・`DISCORD_PUBLIC_KEY`・`ALLOWED_GUILD_ID` を設定します。`name` はCloudflareのWorker名です。このファイルは登録スクリプトでも読むため、JSONとして有効な形式を維持してください。
2. Botページで **Message Content Intent** だけを有効にして保存します。Presence・Server Members Intentは不要です。GatewayのIntentは33281です。[Discord公式Gateway仕様](https://docs.discord.com/developers/events/gateway)
3. `.dev.vars` の `DISCORD_BOT_TOKEN=` の右側にBotトークンを保存します。トークンはチャットやコマンド引数に貼りません。このファイルはGitの対象外ですが、ローカルには平文で保存されます。
4. Cloudflareにログインし、アカウントのworkers.devサブドメインを設定します。SQLite-backed Durable Objectsが利用できるFreeプランを使用します。
5. 次の順に実行します。初回デプロイ時はトークンがないためGatewayに接続しません。Secretの登録後、Cronまたはコマンド処理時に接続します。

```powershell
.\node_modules\node\bin\node.exe node_modules/wrangler/bin/wrangler.js login --scopes account:read user:read workers_scripts:write
.\node_modules\node\bin\node.exe node_modules/typescript/bin/tsc
.\node_modules\node\bin\node.exe --import tsx --test tests/*.test.ts
.\node_modules\node\bin\node.exe node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir dist
.\node_modules\node\bin\node.exe node_modules/wrangler/bin/wrangler.js deploy
.\node_modules\node\bin\node.exe scripts/publish-secret.mjs
```

Secret登録スクリプトはトークンが設定したアプリに属することをDiscord APIで確認し、標準入力経由でCloudflareへ送信します。値は出力しません。

6. 以下のURLの `YOUR_APPLICATION_ID` と `YOUR_GUILD_ID` を設定値に置き換え、対象サーバーの管理者がBotの追加を承認します。

```text
https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot%20applications.commands&permissions=68672&guild_id=YOUR_GUILD_ID&disable_guild_select=true
```

要求する権限はView Channels・Send Messages・Read Message History・Add Reactionsの4つ（68672）です。チャンネルの上書き設定でも許可されている必要があります。`/set` はDiscord側の閲覧権限を変更しません。必要なら管理者がBotの閲覧範囲を対象チャンネルに限定してください。

7. Guild限定のコマンドを登録します。他のアプリやグローバルコマンドは変更しません。同じアプリ・同じGuildのコマンド一覧はこの7件に置き換わります。

```powershell
.\node_modules\node\bin\node.exe scripts/register.mjs
```

8. Developer Portalの一般情報のInteraction URLに、Wranglerが出力した公開URLの末尾へ `/interactions` を付けて保存します（例：`https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/interactions`）。Discordの署名付きPING検証が成功すると保存されます。
9. 対象チャンネルで `/set`、`/status` を実行します。Gatewayが「接続済み」であることを確認してから、半角 `1`、別のユーザーの `2` を投稿して✅と統計を確認します。

Windows以外では、Node 26.13.xを有効にしたうえで `npm run typecheck`、`npm test`、`npm run build`、`npm run deploy`、`npm run register` を使用できます。Secretsの登録は `node scripts/publish-secret.mjs` です。

## 運用・復旧

毎分Cronが同じDOの接続を確認し、正常な接続は維持します。`/stop` はゲーム受付を止めますが、コマンド受付とGatewayは動き続けます。

短い切断は保存済みのセッションと確定済みsequenceからResumeを試みます。Resumeできない場合は受付を止めて復旧待ちにします。進行・統計を保持したまま `/set` で現在以降の投稿から再開できます。復元できない停止区間の投稿は判定しません。1から始めたい場合は `/reset` の後に `/set` を実行します。

`/status` の「稼働中」は受付設定を表し、Gatewayの「接続済み」と併せて確認します。「設定エラー」の場合はトークン・Message Content Intentを確認し、修正後に `/set` を実行します。

SQLiteのトランザクションで進行・累計・重複排除・通知予約をまとめて確定します。通知は永続outboxから再送し、実送信5回・有効期限30分・送信中lease30秒で制限します。429の待機と5xxの再試行に対応します。通知に失敗しても確定した進行は巻き戻しません。Discordのnonce重複抑制には期限があるため、外部通知の永久的なexactly-onceは保証しません。

`/health` の200はHTTP入口の生存確認です。Gatewayの接続確認には使えません。本番の `/test` は404です。本番で `TEST_MODE` を設定しないでください。DOのID、Worker名、migrationを変えると保存先が変わり得るため、通常更新では維持します。

## 無料枠の見積もりと制約

2026-11-06に確認した[Cloudflare公式料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)では、FreeのDO durationは13,000 GB-s/日です。常駐1個の概算は `0.128 × 86400 = 11059.2 GB-s/日`（約85.1%）。同一アカウントの他のDOと共用する枠です。外向きWebSocketはHibernationできる前提にしません。

Cronは1,440回/日。5人・100投稿/日ではイベント・通知・SQLite更新が加わります。DO requestsは100,000/日、SQLite readsは5,000,000行/日、writesは100,000行/日、保存量は合計5GBです。イベント数・再送・索引・削除処理によって使用量が変わるため、これは上限内を保証する実測値ではありません。初期運用でCloudflareのUsageを確認してください。上限超過では該当処理が失敗し、日次枠はUTC午前0時に戻ります。

Workersのバンドル上限は[2026-09-04更新](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)で全プラン非圧縮64MiBです。本プロジェクトの実測サイズ・起動時間は検証記録を参照してください。通常WorkerのCPU枠とDOのCPU枠は別です。数学の処理予算は無限の安全性やすべての入力での時間上限を証明するものではありません。
