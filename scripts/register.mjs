// Tokens come only from environment / ignored .dev.vars. Never print response bodies.
import { localConfig, workerConfig } from "./local-config.mjs";
const local = localConfig();
const config = workerConfig();
const token = local.DISCORD_BOT_TOKEN;
const app =
    local.DISCORD_APPLICATION_ID || config.vars.DISCORD_APPLICATION_ID,
  guild = local.ALLOWED_GUILD_ID || config.vars.ALLOWED_GUILD_ID;
if (!token || !/^\d+$/.test(app) || !/^\d+$/.test(guild))
  throw Error("ローカルSecretsとwrangler.jsoncのIDを設定してください。");
const identity = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
  headers: { Authorization: `Bot ${token}` },
});
if (!identity.ok) throw Error(`Bot認証失敗 HTTP ${identity.status}`);
if ((await identity.json()).id !== app)
  throw Error("BotトークンとアプリIDが一致しません。登録を中止しました。");
const descriptions = {
  set: "このチャンネルで開始・再開・移動",
  stop: "進行を保持して停止",
  reset: "統計を保持して次を1に戻す",
  status: "進行と稼働状態",
  stats: "個人の累計正解数",
  ranking: "累計正解数ランキング",
  help: "遊び方と数式の対応範囲",
};
const commands = Object.entries(descriptions).map(([name, description]) => ({
  name,
  description,
  type: 1,
  default_member_permissions: ["set", "stop", "reset"].includes(name)
    ? "32"
    : null,
  ...(name === "stats"
    ? {
        options: [
          {
            name: "user",
            description: "対象ユーザー",
            type: 6,
            required: false,
          },
        ],
      }
    : {}),
}));
const r = await fetch(
  `https://discord.com/api/v10/applications/${app}/guilds/${guild}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  },
);
if (!r.ok)
  throw Error(`登録失敗 HTTP ${r.status}（応答本文は機密保護のため非表示）`);
console.log("Guildコマンド7件を登録しました。");
console.log(
  `招待URL: https://discord.com/oauth2/authorize?client_id=${app}&scope=bot%20applications.commands&permissions=68672&guild_id=${guild}&disable_guild_select=true`,
);
