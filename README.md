# dsh-kilo-prompt · Kilo 内置提示词

一个 [DSH](https://github.com/deepseek-ai/deepseek-harness) 插件：把
[Kilo Code](https://github.com/Kilo-Org/kilocode) 的内置系统提示词（`soul` + `default`）
移植过来，侧栏一键开关。

开启后，模型的行为准则会变成 Kilo 的那一套：**少说话、多干活、干完就停**。

## 它做什么

DSH 的系统提示词是按 `order` 排序的段落拼起来的：

```
 -1000  harness:identity      "You are an AI agent powered by DeepSeek Harness."
     0  deployment persona    （部署级人格，默认空串）
   100  ← 本插件插在这里
   500  plan policy
   600  team policy
  1000+ 各工具的说明
```

插件通过 `ctx.systemPrompt.section({ name, order, text })` 注册自己的段落，
拿到一个 disposer；关掉开关就调用 disposer，下一轮请求即恢复。

**不需要重启、不需要改 profile 配置**，点一下立刻生效。

## 提示词来源与改动

取自 `Kilo-Org/kilocode`：

| 层 | 文件 |
| --- | --- |
| 人格层 | `packages/opencode/src/kilocode/soul.txt` |
| 主体层 | `packages/opencode/src/session/prompt/default.txt` |

Kilo 真实的拼装顺序是 `[soul, provider(model), environment, user.system]`，这里取
`soul + default` 两层——也就是它不选特定模型时实际发出的内容。

### 相对原文的改动

原文点名了一批 Kilo 自己的工具，DSH 里没有同名的。照搬会让模型去调不存在的工具然后
吃报错，所以逐条换成了 DSH 的实际工具：

| 原文 | 改后 |
| --- | --- |
| `Bash` | `pwsh` |
| `Task` | `subagent` |
| `WebFetch` | `web_fetch` |
| `ls` 工具 | `glob` / `pwsh` |
| `question` | `ask_user_question` |

另外删掉了 DSH 用不上的三样：`/help` 命令说明、GitHub issues 反馈地址、
「用户问 Kilo 能不能做某事时先 WebFetch kilo.ai/docs」。

**规则、语气、few-shot、禁令全部保留原文。**

### 它带来的行为变化（预期之内）

- 回答被压到 **4 行以内**，能一个词就一个词
- 禁止 "Great / Certainly / Okay / Sure" 开头
- 禁止结尾提问或邀请继续对话
- 做完文件就停，不写"我做了什么"的总结
- **不加任何代码注释**（除非明确要求）
- 不主动 commit
- 做完任务**必须**跑 lint 和 typecheck

## 用法

侧栏底部（铃铛右边）多一个按钮：

| 状态 | 含义 |
| --- | --- |
| 灰色图标 | 关（默认）。用 DSH 自己的提示词 |
| 高亮 + 右上角绿点 | 开。已注入 Kilo 提示词 |

**点一下切换**，立即生效，状态持久化（`~/.dsh/plugin-data/dsh-kilo-prompt/settings.json`）。

鼠标悬停可以看到当前状态与注入的字符数。

### 为什么默认关

这会整体替换模型的说话方式与行为准则，属于强副作用开关，所以默认关。
配置文件缺失、损坏、格式不对，一律当成关。

## 为什么不用 `@deepseek-ai/dsh-persona`

DSH 自带的 `dsh-persona` 是给 agent preset 用的。它注册的段落名与注册表自己注册的
persona 同名，**全局挂载会撞名并报错**（该包源码注释里明说 "mounted globally it
collides with the registry's own registration and fails loud"）。

所以本插件用自己的段落名 `kilo:persona`，只做追加，不碰部署人格。

## 安装

### 桌面版 / 本机

```powershell
# 1. 让 profile 能解析到本包（等价于 pnpm 的 link: 依赖）
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
$pkg = Join-Path $p 'package.json'
$j = Get-Content $pkg -Raw | ConvertFrom-Json
$j.dependencies | Add-Member -NotePropertyName 'dsh-kilo-prompt' -NotePropertyValue 'link:D:/Projects/dsh-kilo-prompt' -Force
$j.dsh.profile.bundles += 'dsh-kilo-prompt'
$j | ConvertTo-Json -Depth 20 | Set-Content $pkg -Encoding utf8
```

然后在 DSH 的**插件**页确认它已启用。

### 命令行版

```bash
dsh plugin --profile web add github:HitMargin/dsh-kilo-prompt
```

## 开发

```bash
node --check index.js && node --check client.js
node test/smoke.mjs     # 客户端：模块外壳、slot 注册、渲染、HMR 自清理
node test/host.test.mjs # 宿主：段落注册/撤销、持久化、跨站拦截、注册失败兜底
```

零依赖、零构建。测试用 `node:vm` 把客户端真跑一遍，不需要浏览器。

`host.test.mjs` 里有一条值得注意的用例：**注册抛错时请求仍返回 200，开关状态如实反映
用户意图**——不假装成功，也不让插件崩掉。

## 许可证

MIT