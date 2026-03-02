# 猜词对战手机网页版（Supabase 实时联机）

这个目录是纯前端 H5 版本，不需要 Flutter。

## 1. 先执行安全版 SQL（必须）

在 Supabase 的 SQL Editor 执行：

- `schema_secure.sql`（当前目录下）

注意：这个脚本会重建 `rooms/guesses`，会清空旧数据。

这个安全版做了这些事：

- 使用 Supabase 匿名登录（每个玩家都有自己的 `auth.uid()`）
- 严格 RLS：只能看自己房间数据
- 通过 RPC 提交密词/猜词（服务端判定颜色）
- 前端不再读取对方密词（防止直接偷看）

## 2. 本地运行

```bash
cd word_duel_web
python3 -m http.server 8080
```

浏览器打开 `http://localhost:8080`，在页面输入：

- 访问密码（默认：`5201314`）

输入密码后会自动连接，不需要手动填 URL/key。

如果你要改密码，编辑：

- `app.js` 里的 `APP_PRESET.accessPassword`

## 3. 联机流程

1. A 打开网页，输入昵称，创建房间。
2. A 把房间码发给 B。
3. B 输入昵称 + 房间码加入。
4. 双方提交秘密单词。
5. 双方开始猜词，实时同步猜词记录和颜色反馈。

## 4. 部署到公网

推荐 Vercel：

1. 把 `word_duel_web` 推到 GitHub 仓库
2. Vercel -> `New Project` -> 选择该仓库
3. `Deploy`
4. 得到 `https://xxx.vercel.app`，两部手机打开即可

## 5. 安全提醒

- `anon key` 可以放前端，真正安全靠 RLS 和 RPC。
- 不要把 `service_role key` 放到前端。
- 这个“网页访问密码”只是便捷入口，不是强安全（因为前端代码可被查看）。
