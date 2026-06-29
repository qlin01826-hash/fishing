# 独立静态网页版（Standalone Public Build）

这是一个完全独立的构建入口，**和根目录的 Kubee 内网构建毫无关系**：

| 文件 / 操作 | 影响 Kubee 内网构建？ |
| --- | --- |
| 这个 `web/` 文件夹 | ❌ 不影响 |
| 根目录 `pnpm dev` / `pnpm build` | ✅ 完全不变 |
| `vite.config.ts` / `package.json` / `pnpm-workspace.yaml` | ✅ 完全没改 |

游戏源码（`game/client/...`、`packages/...`、`i18n/`）一份不动地复用，只是用 `web/vite.config.ts` 里的别名指过去。

---

## 一次性准备

在**项目根目录**（不是 `web/`）执行过 `pnpm install` 即可。`web/` 不需要单独的 `pnpm install`，它直接借用根目录的 `node_modules`。

---

## 本地开发预览

```powershell
# 项目根目录执行（注意 --config 后面的路径）
pnpm exec vite --config web/vite.config.ts
```

默认端口 `4173`，启动后访问：

- 本机：`http://localhost:4173`
- 同 Wi-Fi 的手机：`http://<你的电脑局域网IP>:4173`

> 注意：跟根目录原本的 `pnpm dev`（端口 `15173`）是两个独立的服务，可以同时跑。

---

## 打包静态站

```powershell
pnpm exec vite build --config web/vite.config.ts
```

输出目录：`web/dist/`。这就是真正可以上传到任何静态托管的网页：HTML、JS、JSON 全部在里头，**不依赖 Kubee CDN，也不需要 importmap**。

打完包后本地预览一下（端口 `4174`）：

```powershell
pnpm exec vite preview --config web/vite.config.ts
```

---

## 部署给朋友看（不用 Cloudflare）

下面几种方式按"省事程度"排序，挑一种就好。

### 方式 A：Netlify Drop（最快，零账号）

1. 打开 https://app.netlify.com/drop
2. 把 `web/dist/` 文件夹直接拖进去
3. 几秒后给你一个 `https://xxxx.netlify.app` 链接，发给朋友即可

### 方式 B：Vercel CLI

```powershell
npm i -g vercel
cd web/dist
vercel              # 第一次会问你登录、确认项目名等，之后选 yes 就行
vercel --prod       # 拿到正式 URL
```

### 方式 C：Surge.sh（一行命令）

```powershell
npm i -g surge
surge web/dist
```

按提示给个邮箱就有一个 `https://你起的名字.surge.sh`。

### 方式 D：Cloudflare Pages（不是 Tunnel）

注意这是 Pages（静态托管），跟之前说的 `cloudflared` tunnel 是两回事，**不需要保持电脑开机**：

1. 把整个仓库（或者只把 `web/dist/`）推到 GitHub
2. cloudflare.com → Pages → Connect to Git → 选仓库
3. Build command 留空（直接拖打好的 `web/dist/`），或者填 `pnpm install && pnpm exec vite build --config web/vite.config.ts`，Output directory 填 `web/dist`

### 方式 E：GitHub Pages

GitHub Pages 一般跑在子路径下（`https://<user>.github.io/<repo>/`），所以要带上 `VITE_BASE`：

```powershell
# Windows PowerShell：
$env:VITE_BASE = "/你的仓库名/"
pnpm exec vite build --config web/vite.config.ts

# 或者用 cross-env（已经在根 devDependencies 里）：
pnpm exec cross-env VITE_BASE=/你的仓库名/ vite build --config web/vite.config.ts
```

然后把 `web/dist/` 推到 `gh-pages` 分支，或者用 GitHub Actions 自动部署。

### 方式 F：在自己电脑上长开（同 Wi-Fi）

最朴素的方式。预览服务自带 `--host`：

```powershell
pnpm exec vite preview --config web/vite.config.ts
```

输出会列出 `Network: http://192.168.x.x:4174`，把这个地址发给同一 Wi-Fi 下的朋友手机就能打开。前提是 Windows 防火墙允许 Node.js 入站连接（第一次跑的时候系统会弹窗，选"允许"）。

---

## 移动端控制说明（写给朋友看）

- 左手区（屏幕左下圆形面板）= **底拍**：跟着圆环节奏点
- 右手区（其他位置）= 抛竿、收线、跟鱼、反拉急冲
- PC 上：空格键 = 底拍，鼠标左键 = 其他操作
