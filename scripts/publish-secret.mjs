// Pass the secret through stdin only; never include it in argv or output.
import { spawn } from "node:child_process";
import { localConfig, workerConfig } from "./local-config.mjs";
const local = localConfig();
const config = workerConfig();
const token = local.DISCORD_BOT_TOKEN;
if (!token || token.includes("replace") || /[\r\n]/.test(token))
  throw Error("先に .dev.vars の DISCORD_BOT_TOKEN= の右側にBotトークンを保存してください。");
const identity = await fetch("https://discord.com/api/v10/oauth2/applications/@me", {
  headers: { Authorization: `Bot ${token}` },
});
if (!identity.ok) throw Error(`Bot認証失敗 HTTP ${identity.status}`);
if ((await identity.json()).id !== config.vars.DISCORD_APPLICATION_ID)
  throw Error("BotトークンとアプリIDが一致しません。送信を中止しました。");
const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "secret", "put", "DISCORD_BOT_TOKEN"], {
  stdio: ["pipe", "inherit", "inherit"],
  windowsHide: true,
});
child.stdin.on("error", () => {});
child.stdin.end(token + "\n");
child.on("error", () => { console.error("Wranglerの起動に失敗しました。"); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
