# 猜词对战手机网页版（Supabase 实时联机）

这个目录是一个纯前端 H5 版本，不需要 Flutter。

你和女朋友用手机浏览器打开同一个网页，就可以实时对战。

## 1. 你现在已经做好的前置

- 已在 Supabase 执行过 `../supabase/schema.sql`
- 已把 `rooms`、`guesses` 加入 Realtime publication

## 2. 本地先跑起来

在电脑终端执行：

```bash
cd word_duel_web
python3 -m http.server 8080
```

然后浏览器打开：

```text
http://localhost:8080
```

进入网页后，在“连接设置”里输入：

- Supabase URL（你的项目地址）
- Supabase anon key（你的 public key）

点“连接”成功后即可创建/加入房间。

## 3. 手机联机流程

1. A 手机打开网页，输入昵称，创建房间。
2. A 把房间码发给 B。
3. B 手机打开同一个网页，输入昵称+房间码加入。
4. 双方提交各自秘密单词。
5. 双方开始猜词，页面会实时同步历史记录和颜色反馈。

## 4. 部署到公网（推荐 Vercel，最省事）

### 方式 A：直接上传目录

1. 打开 https://vercel.com
2. 选择 `Add New Project` -> `Browse All Templates`（或导入本地目录）
3. 把 `word_duel_web` 目录作为静态站点部署
4. 部署完成后得到一个 `https://xxx.vercel.app` 链接
5. 你们两部手机都打开这个链接即可

### 方式 B：Netlify

1. 打开 https://app.netlify.com
2. `Add new site` -> `Deploy manually`
3. 把 `word_duel_web` 目录拖进去
4. 得到公网链接后，双方手机打开即可

## 5. 重要说明（MVP 安全）

当前 `schema.sql` 为了上手简单，RLS 策略是“开放读写”，适合测试。

如果以后要公开给很多人使用，建议改成：

- 强化 RLS（按房间成员限制权限）
- 用 Edge Function 在服务端做猜词判定，避免前端可篡改
