# 検証・デプロイ記録

実施日：2026-11-06（JST）。トークンや個別メッセージ本文はこの記録に保存しません。

## 確認済み

- Node 26.13.0、Wrangler 4.158.0、TypeScript 5.9.3、Compute Engine 0.181.1。依存バージョンはロックファイルに固定。
- `tsc`：成功。
- `node --import tsx --test tests/*.test.ts`：127件成功、失敗0。数学ケースの一部はmath.testとruntime.testのimportにより二度実行されるため、127は独立した仕様ケース数ではない。
- 数学の厳密一致・不一致・定義域・計算予算、ゲームの交代・統計保持、workerd内SQLiteトランザクション・再起動・重複排除・outbox lease・429/5xx/403/404・復旧待ちを検証。
- dynamic code executionを無効にしたCAS検証、Ed25519署名・PING・不正署名・不正JSON・他Guild拒否・本番test経路非公開を検証。
- 模擬Gatewayとの実際のWebSocket接続でHTTPS Upgrade、IDENTIFY、READY、MESSAGE_CREATEからの正解リアクション、状態応答、Heartbeat要求への送信を検証。Discord本番サーバーの代わりにローカル模擬サーバーを使うテスト。
- 本番Workerへのデプロイ成功。最終コード公開時：7,596.43 KiB非圧縮、1,883.69 KiB gzip、起動44ms。
- Cron `* * * * *` とSQLite-backed CountingBotのmigration v1を公開。
- BotトークンのアプリID一致を確認し、Cloudflare Secret `DISCORD_BOT_TOKEN` として登録。値は出力していない。
- Discord APIで対象サーバーへの参加、Message Content Intent有効、Interaction URLを確認。
- Guild限定コマンド7件を登録。
- 公開URLの `/health` 200、`/test` 404、署名なし `/interactions` POST 401。
- Developer PortalのInteraction URL保存に成功（Discordの署名付き接続検証）。
- #countで本番 `/set` の開始応答と `/status` の「稼働中・現在0・次1」を画面で確認。
- Gateway修正後、本番の新しい数字投稿 `1` にBot自身の✅が付いたことをDiscord APIで確認。ユーザーからも動作確認の返答あり。
- 保持データ3,000件・完了通知6,000件のローカルworkerd試験で、毎分の整理は9行の読み取り。10,001件の重複排除データを9,999件へ削減し、処理済み境界を保持することも検証。

## 名前表示とコマンド結果の公開

ユーザーの指定により、ランキング・個人統計・最後の正解者をDiscordのユーザー参照形式で表示するよう変更。Discord側で名前として描画され、allowed_mentionsのparseを空にして通知を抑える。保存済みのIDとスコアは変更しない。

すべてのコマンドについて、初回deferからEPHEMERALを除去し、そのチャンネルの閲覧者全員に結果を表示する。権限不足などの応答も公開形式。管理操作に必要な権限は従来どおり。

署名付きHTTP試験で7コマンドすべての公開応答を検証。Gateway連携試験でランキング・個人統計・最後の正解者のユーザー参照と通知抑制を検証し、本番へデプロイ済み。

## 本番確認で発見・修正した点

最初のデプロイではHTTPコマンドは応答したが通常の数字投稿に反応しなかった。Discordが返すwss URLをそのままWorkers fetchへ渡していたことが原因。ローカルworkerdで `Fetch API cannot load: wss://gateway.discord.gg/...` を再現し、同じ接続先へのHTTPS Upgradeは101となることを確認した。

URLのプロトコルをHTTPSへ変換してUpgradeするよう修正し、上記Gateway回帰テストを追加した。`/status` はゲーム受付設定とGateway接続状態を別々に表示するよう変更した。

## まだ確認していない項目

- 今回変更した名前表示・公開応答の本番Discord画面での見た目と、累計統計の利用者確認。
- 本番での長時間常駐、実際のGateway ResumeとResume不能、Cloudflare再起動時の振る舞い。
- Freeの日次Usage実測、128MB上限に対する最悪入力のピークメモリ、全入力に対するCAS時間上限。
- Discord自身の429・削除・権限変更を本番で発生させる試験。

常駐DOは本番1個のみを使用し、ローカル試験はMiniflareの一時保存先を使う。無料枠の算術見積もりはREADMEに記載し、実測保証と区別する。
