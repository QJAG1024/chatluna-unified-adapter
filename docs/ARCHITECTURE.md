# 架构与设计决策

> 本文记录 `adapter-unified` 的**决策与理由**，不是 API 文档。
> 动代码前读这里；改设计后同步更新这里。
>
> 上游参照：ChatLunaLab/chatluna `v1-dev` @ `ca1177d4`，
> `koishi-plugin-chatluna@1.4.0-alpha.44`。

---

## 1. 问题陈述

ChatLuna 现有适配器把「一个供应商 = 一个适配器 = 一套硬编码假设」写死在代码里。
三个假设在真实上游面前经常不成立：

**假设一：`base/models` 存在且可用。**
`shared-adapter` 的 `getModels()` 直接 `GET 'models'`。
`adapter-claude` 走 `/v1/models` 分页，失败则回退到 9 条硬编码 `FALLBACK_MODELS`。
阿里云百炼的 Anthropic 兼容端点**不提供** `/models`（实测 404，官方文档亦明说），
于是 Claude 适配器在百炼上永远只能用那 9 条写死的 `claude-*`，
而这些模型在百炼上根本不存在。

**假设二：模型的元数据可以从名字推出来。**
`shared-adapter` 用一张手写表（`getModelMaxContextSizeByName`）加一组正则
（`supportImageInput`）推断上下文与视觉能力。表外的名字一律落到
`200_000` / 文本能力。新模型发布当天，用户拿到的是一个上下文被低估、
视觉能力被判定为无的降级模型。

**假设三：一批 key 共享同一个 base 与同一套鉴权头。**
`ClientConfig` 只有 `apiKey` / `apiEndpoint` 两个字段，
`ModelRequester.buildHeaders()` 硬编码 `Authorization: Bearer`。
Claude 适配器硬编码 `Authorization` + `x-api-key` 双写。
需要 `x-api-key` 单写、需要额外 `anthropic-beta`、需要独立 models 地址的
上游，只能改代码。

### 一个具体实例：阿里云百炼

无 key 也能用 401/404 区分路由存在性（实测）：

```
GET /compatible-mode/v1/models              401   存在
GET /compatible-mode/v1/chat/completions    400   存在（GET 不被允许）
GET /compatible-mode/v1/responses           401   存在
GET /apps/anthropic/v1/messages             400   存在
GET /apps/anthropic/v1/models               404   不存在   ← 问题假设一
GET /api/v2/apps/claude-code-proxy/v1/*     401   旧端点，官方已标"仅支持已下架模型"
```

关键事实（来自官方文档的 `~/.claude/settings.json` 样例）：

```json
"ANTHROPIC_BASE_URL": "https://dashscope.aliyuncs.com/apps/anthropic",
"ANTHROPIC_MODEL": "auto",
"ANTHROPIC_DEFAULT_HAIKU_MODEL": "qwen3.6-flash",
"ANTHROPIC_DEFAULT_SONNET_MODEL": "qwen3.8-flash",
"ANTHROPIC_DEFAULT_OPUS_MODEL": "qwen3.8-max"
```

**百炼的 Anthropic 端点服务的是 qwen 模型名，不是 `claude-*`。**
这条事实同时否掉了两个设计（见 §4）。

---

## 2. 产品定义

**一个插件实例 = 一条上游路由 = 一种 wire 协议 = 一个 `platform` 命名空间。**

```
platform: bailian          protocol: chat        → bailian/qwen-plus
platform: bailian-claude   protocol: messages    → bailian-claude/qwen3.8-max
```

`export const reusable = true`，所以同一插件可以在配置树里挂多个实例，
`platform` 由用户自由命名。多上游不需要任何 core 改动。

它统一的是**同一协议在不同供应商下的差异**，分为三层互不依赖的数据管线：

```
┌─ 端点层 endpoints ─────────────────────────────────┐
│ 每把 key 自己的 base URL / 鉴权头 / 额外 header     │
│ /v1 探测修正                                        │
└─────────────────────────────────────────────────────┘
┌─ 发现层 discovery ─────────────────────────────────┐
│ modelsURL 显式覆盖 → 端点 /models → 空               │
│ 多形态响应解析；实例内 memo                          │
└─────────────────────────────────────────────────────┘
┌─ 元数据层 catalog ─────────────────────────────────┐
│ models.dev 实时 → 运行时磁盘缓存 → 包内快照          │
│ 4059 条 id → {context, output, modalities, …}        │
│ 字段级填充，绝不覆盖用户设置                         │
└─────────────────────────────────────────────────────┘
```

三层各自的失败互不传染：端点没 `/models` 不影响元数据；
catalog 拉不到不影响模型列表。

---

## 3. 模型列表与元数据的确定路径

这是整个插件最核心的行为契约。**没有第二条路径，没有推断分支。**

```
refreshModels():

  ① pullModels === false
       → 手动条目（modelOverrides 的键）是唯一来源，据此构建 ModelInfo

  ② pullModels === true
       尝试拉取 id 列表：modelsURL 填了就用它，否则用 key 的 base + '/models'
       ├─ 拉到 → 每个 id 依次匹配元数据：
       │         catalog(实时 → 磁盘缓存 → 包内快照)
       │         → 未命中则 ChatLuna 既有启发式
       │         → 仍未命中则保守默认
       │         手动条目里未出现在列表中的，追加注入
       └─ 拉不到（网络失败 / 404 / 解析空）
               → 等价于 ①：只用手动条目

  ③ 手动条目与拉取结果都为空
       → 返回 []，不抛错。适配器加载成功，但零模型。
```

要点：

- **`refreshModels()` 永不抛错。** 空数组是合法返回值。
- **`pullModels: false` 与"拉取失败"行为一致**：都退化为纯手动模式。
  这是"能拉就用拉的，拉不到退化成手动"，不是二选一。
- 拉取结果的网络失败只 `logger.warn`，不 `markConfigStatus(false)`。
  若抛错，`BasePlatformClient.isAvailable()` 会把这条 config 标记为不可用，
  后续真实请求反而撞 `NOT_AVAILABLE_CONFIG`——比空列表更糟。

### 零模型是合法状态（已核对 core 源码）

`BasePlatformClient.getModels()`：

```ts
models = await this.refreshModels(config)
this._modelInfos = {}
for (const model of models) { /* 空数组时不执行 */ }
return models   // → []
```

`init()` → `isAvailable()` 返回 `true` → `refreshClient()` 里
`this._models[platform] = [].concat([])` → 适配器通知变成
「加载成功，共加载了 0 个模型」。调用链上没有任何一处把空列表当失败，
所以**不需要任何 core 改动**就能实现"启动但不加载任何模型"。

### 手动条目（`modelOverrides`）

`Schema.dict(Schema.object({...}))`，键 = 模型 id。

语义三条：

1. 键存在 → 即使 discovery 和 catalog 都没这个模型，也注入它。
2. 键存在但某字段缺席 → 该字段仍走 catalog 填充。
3. 数值字段一律**无 `Schema.default()`**。

第 3 条是"绝不覆盖"能成立的前提。对照现有 `adapter-openai-like` 的
`additionalModels` 表：`contextSize: Schema.number().default(128000)`
使得"用户没填"和"用户填了 128000"在 schema 物化后无法区分，于是只能退化成
「只要模型在表里出现，catalog 就完全不起作用」。dict + 无默认值消除了这个
退化，代价是渲染从表格式变成折叠面板（`schemastery-vue` 的
`group.vue`，每个键一个可折叠面板）。

`modelOverrides` **不能**加 `role('table')`：`toColumns()` 要求每列都是
`string`/`number`/`boolean`/const union/multiset，嵌套 object 会让整张表
静默退回 `SchemaGroup`。

不提供 `additionalModels` → `modelOverrides` 的迁移层：这是新包，
没有存量用户。

---

## 4. 明确否掉的方案（不要重新引入）

每一条都对应一次具体讨论，理由已核实。

### 4.1 ❌ 多协议网关 / 按模型路由到不同协议

**否掉理由**：协议与协议之间的差异不止 wire 格式——缓存策略、错误重试、
usage 语义、tool call 表达、thinking 块的签名回传都不同。单协议实例能保证
requester、错误计数、并发池、缓存全部是单一语义；多协议则需要在运行时
"猜这个模型该走哪条 wire"，而且 `ModelInfo` 没有协议字段（见 §7），
协议只能存在 requester 侧，等于给每个请求加一次查表。

**替代**：`protocol` 枚举 + 多实例。用户起名 `bailian` / `bailian-claude`。

**曾经考虑并否掉的折中**：勾选多个协议后自动注册
`custom-chat` / `custom-messages` 之类派生 platform 名。理由：名字丑陋且
不受用户控制，而 `reusable` 已经允许用户自己起名，不必绕。

### 4.2 ❌ 用 models.dev 的供应商归属预测上游

**曾考虑**：`providerPreset`（按端点 host 反查 models.dev 的 provider slug，
用 `alibaba-cn` 的模型清单当种子，或在同一个 id 存在于多个 provider 时择优）。

**否掉理由**：这是对用户上游做预测，而预测毫无意义——catalog 记录的是
"供应商对外提供什么"，既不保证"这个端点能服务"，也不保证"这把 key 有权访问"。
更糟的是百炼实测：`alibaba-cn` 的 80 条清单里混着
`qwen3-asr-flash`（`type: transcription`）、`qwen3-omni-flash-realtime`
（`type: realtime`）这类**不可能通过 Anthropic wire 调用**的模型。
把它们摆进模型列表，用户点一下就报错，比列表为空更糟——空列表至少指向
"你需要配置"。

**替代**：用户明确填 `modelsURL`；或什么都不填，接受零模型。

### 4.3 ❌ `seedModels`（用 catalog 清单冒充模型列表）

同上——它是 4.2 的具体形式，配置项已删除。

### 4.4 ❌ 跨实例共享 discovery 结果

**曾考虑**：两个实例挂同一个 host（`bailian/chat` + `bailian-claude/messages`），
后者借前者的列表。

**否掉理由**：同上，属于对上游的预测。而且百炼实测表明两个端点服务的
**确实是同一批 qwen id**，用户可以用
`modelsURL: https://dashscope.aliyuncs.com/compatible-mode/v1/models`
精确达成——`modelsURL` 这个字段就是为"列表在别处"准备的。不需要隐式共享。

**唯一跨实例共享的是 catalog**（元数据索引），因为它描述的是模型本身的
属性，与端点无关。

### 4.5 ❌ 新增启发式表 / 正则

不写新的模型名猜测。兜底只用 ChatLuna 已有的
`supportImageInput` / `supportAudioInput` / `getModelMaxContextSizeByName`。
未知模型按现有行为落 `200_000`（与 `adapter-openai-like` 一致），
不引入新的"保守默认"数值。

### 4.6 ❌ 依赖上游改动

不写"等 core 给 `ModelInfo` 加协议字段/输出上限字段"的代码。
一切通过 §7 列出的已公开扩展点完成。

---

## 5. 元数据层（catalog）

### 5.1 三层来源

```
实时 models.dev/api.json
  ↓ 拉取成功
运行时缓存 data/chatluna/unified-adapter/unified-catalog.json
  ↓ 与包内快照比 fetchedAt，取较新者
包内快照 src/data/models.dev.json（构建期生成，import 内联进 lib/）
```

`metadata.enabled === false` 时三层都不用，全部走 §3 ②的启发式与默认。

### 5.2 单例与执行时序

`reusable = true` 时 cordis 为每个配置实例创建 fork scope，但 `apply()`
来自**同一个模块实例**，所以 `catalog.ts` 顶层的 `let` 在进程内只有一份。
**不需要 `ctx.provide()` / 不注册 service / 不改 core。**

```
t0  cordis ready（events.ts 把所有 ready 监听器 scope.ensure 后并发踢出）
    ├─ inst A  await catalog(ctx, cfgA)
    ├─ inst B  await catalog(ctx, cfgB)   ← 三者 await 同一个 in-flight promise
    └─ inst C  await catalog(ctx, cfgC)
              ├ ensureDisk()    读磁盘缓存 + 包内快照，一次性
              ├ maybeRefresh()  拉实时，成功则原子写盘
              └ 三实例拿到同一份索引
t1  各实例 refreshModels() 用同一份索引匹配
t2  各实例按自己的 refreshInterval 注册 setInterval
    └ 到点都调 maybeRefresh()，被同一个 refreshing 折叠成一次
```

**四个必须处理的陷阱：**

1. **判断顺序：先 in-flight，再冷却。**

   ```ts
   if (refreshing) return refreshing                       // ① 有人在做，等它
   if (Date.now() - lastAttempt < COOLDOWN) return index   // ② 本进程刚做完
   refreshing = refresh(ctx, cfg).finally(() => { refreshing = undefined })
   return refreshing
   ```

   顺序颠倒会出 bug：B 看到 A 刚设的 `lastAttempt` 立刻返回，而此时 A 的
   fetch 还在飞，B 拿到的是旧快照却据此建模型。

2. **`refreshOnStart: false` 的实例只读盘，不等别人的网络。**
   `catalog()` 里先 `await ensureDisk()`（毫秒级），再按需
   `await maybeRefresh()`。

3. **阻塞上界 = `metadata.timeout`。**
   元数据直接决定 `ModelInfo.maxTokens` / `capabilities`，不能"先建模型后
   修正"（那需要重新注册模型并发 `chatluna/model-added`）。所以
   `await catalog()` 会阻塞 `initClient()`，但用 `AbortSignal.timeout()` 封顶，
   超时降级到磁盘缓存。

4. **原子写。** 只有 single-flight 的发起者写，所以无并发写；原子写防的是
   进程被 kill 在 write 中途。`write tmp` → `rename`；Windows 上
   `rename` 覆盖已存在文件会抛 `EPERM`，需 `rm` 后重试。
   读取端：解析失败或 `version` 不匹配 → 静默丢弃回落到包内快照，
   **不删文件**（下次写入会覆盖）。

**实例被全部卸载时不中止 in-flight fetch**——让它跑完写盘，下次启动受益。
不加引用计数（删掉实例时它没有 `ctx` 可用）。

### 5.3 一个实例内只发现一次

`BasePlatformClient.getModels()` 在启动时会把 `refreshModels()` 跑两遍
（`isAvailable` → `init`，然后 `refreshClient` 直接调）。所以客户端持有
`ClientState.listing`，第一次拿到结果后复用，失败结论也一并复用——否则同一
次启动会打两次网络、打两条一样的警告。

这份 memo 是**每客户端**的，不跨实例：每个实例问自己的端点（§4.4）。

### 5.4 `catalog()` 的契约

**永远 resolve 一个可用索引，永不 reject。** 调用方不需要 try/catch。

### 5.5 快照格式与体积

`scripts/fetch-catalog.mjs` 拉 `models.dev/api.json`
（230 providers / 8889 条 / 4059 唯一 id，MIT 许可），归一化去重后只保留
消费字段：

```json
{
  "version": 1,
  "sources": ["models.dev"],
  "fetchedAt": 1761291237000,
  "models": {
    "qwen3-max": { "c": 262144, "o": 65536, "i": "t", "t": "chat", "tl": 1, "r": 1 },
    "text-embedding-v3": { "c": 8192, "t": "embedding" }
  }
}
```

| 键 | 含义 | 映射到 |
|---|---|---|
| `c` | `limit.context` | `ModelInfo.maxTokens`（**上下文**） |
| `o` | `limit.output` | 内部 `maxOutputTokens`（messages 的 `max_tokens` 兜底） |
| `i` | `modalities.input` 首字母集合（`t`ext/`i`mage/`p`df/`a`udio/`v`ideo） | `ImageInput`/`FileInput`/`AudioInput`/`VideoInput` |
| `t` | `type`（缺省视为 `chat`） | `ModelType.llm` / `.embeddings` / `.reranker` |
| `tl` | `tool_call` | `ModelCapabilities.ToolCall` |
| `r` | `reasoning` | `ModelCapabilities.Thinking` + `isThinkModel` |

体积实测：4059 条 **313 KB / gzip 37 KB**。
不带 `name`（用不上）与 `providers` 列表（§4.2 已否）。

`version` 升版即丢弃旧缓存；`sources` 与配置不一致也丢弃（用户加了自定义源，
旧缓存不完整）。

### 5.6 匹配

按顺序尝试：精确 id → 小写 → 去 `vendor/` 前缀 → 去快照日期后缀。

日期后缀有两种写法：`-20250929`（Anthropic 等）与 `-2025-09-29`（百炼等）。
**两种都要剥**——models.dev 把同一个模型的快照记在无日期的 id 下，只剥一种会让
整批带斜杠日期的模型掉进 200k 兜底。实测在 180 个模型的端点上，修正前
catalog 命中 82、修正后 104。
4059 条上实测 61 个真实 id（qwen/claude/gpt/glm/kimi/doubao/hunyuan/ernie/
step/embedding）：精确命中 42，经小写/去前缀归一化再 +3，未命中 16
（集中在 hunyuan / ernie / step / yi / spark / bge / `text-embedding-v3`）。
未命中即走 §3 ②的启发式与默认——这正是 `modelOverrides` 存在的理由。

不去做前缀最长匹配之类更激进的猜测（那等于 4.5）。

---

## 6. 端点层与请求层

### 6.1 base 约定

所有 base **含版本路径**，与 chatluna 现有适配器一致：

```
chat      https://dashscope.aliyuncs.com/compatible-mode/v1
responses https://dashscope.aliyuncs.com/compatible-mode/v1
messages  https://dashscope.aliyuncs.com/apps/anthropic/v1
```

不做 magpie 那种"anthropic base 是 root"的特殊语义——减少认知负担。

### 6.2 鉴权三态 + header 表

`authHeader`：`bearer`（chat/responses 默认）| `x-api-key` | `both`
（messages 默认，即 `adapter-claude` 现有行为）| `custom`。
`headers` 表补 `anthropic-version`、`anthropic-beta`、UA 等。

覆盖点：`ModelRequester.buildHeaders()` 是 `public`。

### 6.3 `/v1` 探测修正（`modelsProbe`）

`base/models` 404 而 `base/v1/models` 200 时，把 base 修正为带 `/v1`。
这是唯一保留的"自动修正"，因为它解决的是"用户少打一层路径"这一真实错误，
而不是对上游能力的预测。仅在 `models` 请求路径上探测，不猜测端点语义。

### 6.4 请求按协议分发

| 协议 | 实现来源 | 位置 |
|---|---|---|
| `chat` | `@chatluna/v1-shared-adapter` 的 `completionStream` / `completion` / `createEmbeddings` / `createRerank` | 直接调用，URL 参数注入 |
| `responses` | 同包 `responseApiCompletionStream` / `responseApiCompletion` | 直接调用 |
| `messages` | vendored 自 `adapter-claude` | 见 §8 |

`nonStreaming: true` 走 `completion()` / `responseApiCompletion()`。

客户端基类按协议选（不涉及 core 改动）：

```ts
protocol === 'chat'
  → PlatformModelEmbeddingsAndRerankerClient 子类（有 embeddings/rerank）
protocol === 'responses' | 'messages'
  → PlatformModelClient 子类
```

两个薄子类共用同一份 `refreshModels` / `_createModel` 实现（放在共同的
模块级函数里，不搞抽象基类继承链）。

---

## 7. 可用的扩展点（全部已存在于 v1-dev）

| 扩展点 | 位置 | 用途 |
|---|---|---|
| `ModelRequester.buildHeaders()` | `platform/api.ts`，`public` | 鉴权三态 + header 表 |
| `ModelRequester.concatUrl()` | 同上，`public` | 绝对 URL / 独立 models URL |
| `BasePlatformClient.refreshModels()` | `platform/client.ts`，抽象 | 发现 + 元数据装配 |
| `_modelInfos` | 同上，`protected` | 模型信息表 |
| `BasePlatformClient.getFileHandlingConfig()` | 同上 | 视觉/文件 MIME 与体积 |
| `ClientConfig` 扩展 | `platform/config.ts`，interface | 每把 key 携带 `authHeader` / `extraHeaders` / `modelsURL`（`adapter-azure-openai` 的 `supportModels` 是现成先例） |
| `ChatLunaPlugin` + `reusable` | `services/chat.ts` + cordis | 多实例 |

### 7.1 两个必须记住的 core 行为

**（a）capabilities 会被重写。** `BasePlatformClient.getModels()` 里：

```ts
model.capabilities = model.capabilities.includes(ModelCapabilities.ImageGeneration)
    ? [ModelCapabilities.ImageGeneration]
    : Array.from(new Set([...model.capabilities, ModelCapabilities.TextInput]))
```

含 `ImageGeneration` 时**只留** `ImageGeneration`，否则强制并上 `TextInput`。
所以 catalog 里 `modalities.output` 含 image 的条目**不能**给普通 LLM 加
`ImageGeneration`，否则那个模型会被判定成纯画图模型。

**（b）`maxTokens` 是上下文，不是输出上限。**
`_createModel()` 里 `maxTokens` 喂给 `modelMaxContextSize`；
`ChatLunaModelInput.maxTokens` 才是发给上游的 `max_tokens`。
两者必须分清，否则会重蹈"把上下文当输出上限"的坑。
catalog 的 `o`（`limit.output`）只用于 messages 协议的 `max_tokens` 兜底。

---

## 8. Vendored 代码

### 8.1 为什么必须复制

`koishi-plugin-chatluna-claude-adapter/package.json`：

```json
"exports": { ".": {...}, "./package.json": {...} }
```

`src/index.ts` 只导出 `apply` / `Config`（值 + 类型）/ `inject` / `name` /
`reusable` / `logger`。`langchainMessageToClaudeMessage`、
`convertDeltaToMessageChunk`、`formatToolsToClaudeTools`、thinking 块状态机
全部在 `utils.ts` / `requester.ts`，**不在公开面**。Node 的 `exports`
字段会硬性阻止深路径 import。第三方插件拿不到，只能复制。

### 8.2 复制 ≠ 纯拷贝

必须改的地方是确定的：

| 上游 | 本仓库 | 原因 |
|---|---|---|
| `import { Config, logger } from '.'`（requester/utils/client 三处） | 本地 logger + 本地 Config | 两个插件不是同一个 `index.ts` |
| `buildHeaders()` 硬编码 `Authorization` + `x-api-key` 双写 | 按 `authHeader` 三态 + `headers` 表 | 见 §6.2 |
| `listModels()` 无条件调用 | 由 discovery 决定是否调 | 端点可能没有 `/models` |
| `setModels()` + `-thinking` 后缀剥离 | 删除 | 上游用模型名后缀表达 thinking；本插件由元数据层直接产出 `capabilities` / `isThinkModel` |
| `max_tokens ?? 10_000` | catalog `limit.output` 兜底 | 硬编码常量是"输出上限缺失"的症状 |

所以复制进来的代码**必然与上游有偏离，且偏离会持续存在**。

### 8.3 锚点

每个 vendored 文件头：

```ts
/*
 * Vendored from koishi-plugin-chatluna-claude-adapter@1.4.0-alpha.11
 *   packages/adapter-claude/src/requester.ts (367 lines)
 *   upstream commit: ca1177d4 (ChatLunaLab/chatluna v1-dev)
 *   vendored: 2026-10-24
 *
 * License: AGPL-3.0 (same as this package). Original: Copyright ChatLunaLab.
 *
 * Local deviations from upstream (keep in sync when re-vendoring):
 *   - logger/Config imported from local plugin entry, not `.`
 *   - buildHeaders() honours config.authHeader ('bearer'|'x-api-key'|'both')
 *     and config.headers, instead of hardcoding both auth schemes
 *   - listModels() is called only when discovery asks for it
 *   - setModels()/`-thinking` suffix stripping removed
 *   - max_tokens falls back to the catalog's limit.output, not a constant
 */
```

加 `src/anthropic/README.md` 同步表（文件 ↔ 上游路径 ↔ 版本 ↔ 复制日期 ↔
偏离项）与 re-vendor 命令：

```bash
git -C /path/to/chatluna show ca1177d4:packages/adapter-claude/src/requester.ts > /tmp/up.ts
diff -u /tmp/up.ts src/anthropic/requester.ts    # 逐条重放偏离项
```

### 8.4 许可证

ChatLuna 与本包同为 **AGPL-3.0**。同源同许可，复制合法；必须保留原始版权
声明，整包对外仍为 AGPL-3.0。

上游演进节奏：v1-dev 近期动过 claude 适配器两次（#972 改 `listModels`
分页与 1M 上下文映射，#665 加动态模型拉取）。`anthropic-beta` 的
interleaved thinking、`cache_control` ttl 属于"上游加了、不跟就跟不上新模型"
的类型。**每个 claude 适配器版本发布后检查一次 diff。**

---

## 9. 配置项

```ts
export const reusable = true
export const name = 'chatluna-unified-adapter'
export const inject = { required: ['chatluna'], optional: ['chatluna_storage'] }

export type UnifiedProtocol = 'chat' | 'responses' | 'messages'
```

| 分组 | 键 | 类型 | 默认 | 说明 |
|---|---|---|---|---|
| 基础 | `platform` | string | `unified` | 模型前缀 |
| | `protocol` | `UnifiedProtocol` | `chat` | 一个实例一种协议 |
| 凭据 | `apiKeys` | `[string, string, boolean][]` | `[[]]` | `[key, baseURL, enabled]`，table |
| | `authHeader` | enum | 按协议 | `bearer` / `x-api-key` / `both` / `custom` |
| | `headers` | `[string, string][]` | `[]` | table |
| 模型 | `pullModels` | boolean | `true` | 关 → 手动条目为唯一来源 |
| | `modelsURL` | string | `''` | 非空则只用它 |
| | `modelsProbe` | boolean | `true` | `base/models` 404 时试 `base/v1/models` |
| | `blacklistModels` | string[] | `[]` | 关键词过滤 |
| | `modelOverrides` | `Record<string, Override>` | `{}` | dict；数值字段**无默认值** |
| | `nonStreaming` | boolean | `false` | |
| 元数据 | `metadata.enabled` | boolean | `true` | |
| | `metadata.sources` | string[] | `['models.dev']` | 可加 `https://` URL |
| | `metadata.refreshOnStart` | boolean | `true` | |
| | `metadata.refreshInterval` | number | `0` | 秒；0 = 只启动刷一次 |
| | `metadata.timeout` | number | `15000` | 毫秒，硬上界 |
| | `metadata.fillCapabilities` | boolean | `true` | 关 → 只填容量不填能力 |
| 采样 | `maxContextRatio` | number | `0.35` | slider |
| | `temperature` | number | `1` | percent |
| | `presencePenalty` | number | `0` | |
| | `frequencyPenalty` | number | `0` | |
| 继承 | `ChatLunaPlugin.Config` | | | `chatConcurrentMaxSize` / `chatTimeLimit` / `configMode` / `maxRetries` / `timeout` / `proxyMode` / `proxyAddress` |

`ModelOverride`：

```ts
{
    modelType?: 'LLM 大语言模型' | 'Embeddings 嵌入模型' | 'Reranker 重排序模型'
    modelCapabilities?: ModelCapabilities[]
    contextSize?: number        // 无默认值
    maxOutputTokens?: number    // 无默认值
}
```

**已删除、不要加回**：`providerPreset`、`seedModels`、`cacheFile`
（路径硬编码）、`additionalModels`（并入 dict）、`modelRouting`
（无多协议路由）、`protocolPreference`。

---

## 10. 里程碑

| | 内容 | 验证方式 |
|---|---|---|
| M0 | 包骨架、Schema、locales、`protocol.ts`、`catalog.ts` 骨架、`anthropic/README.md` | `yarn build`；koishi 里实例化不报错，配置面板渲染正确 |
| M1 | `endpoints.ts` + `discovery.ts`（多形态解析、实例内 memo、`/v1` 探测） | `scripts/probe.ts` 对百炼三端点跑发现：chat 有模型、messages 为空且不抛 |
| M2 | `catalog.ts` 完整（三层来源、单例时序、原子写）+ `spec.ts` | 索引 4059 条；`qwen3-max` 命中；`text-embedding-v3` 落覆写分支；多实例并发只拉一次 |
| M3 | `requester.ts` 分发 + `anthropic/` vendored 移植 | 同一进程内 chat 实例与 messages 实例各回一轮；流式与 thinking 块正常 |
| M4 | `client.ts` 装配 + `fileHandlingConfig` | `chatluna.model.list` 上下文/能力正确；给视觉模型发图 |
| M5 | README + `usage` 文本 + `scripts/harness.cjs` / `scripts/chat.cjs` | 见 §12 |

### 已完成的验证（M0–M4）

无测试框架，验证走真机脚本：

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `scripts/probe.ts` | 发现层对真实端点、元数据匹配 | 见下 |
| `scripts/harness.cjs` | 真 koishi 启动、实例模型数、能力、缓存 | 见下 |
| `scripts/chat.cjs` | 真实对话一轮（三种协议 × 流式/非流式 × 工具调用） | 见下 |
| `scripts/audit.mjs` | 每个模型的元数据来自哪一层（catalog/heuristic/fallback/override） | 见下 |
| `scripts/vision.cjs` | 图片输入在两种 wire 上是否真的到达模型 | 见下 |

发现层实测：`{data:[...]}` / `models/<id>` 前缀 / `{models:[...]}` /
`{results:[...]}` / 裸数组 / 404 / 不可解析 七种形态均按预期；
`base/models` 404 而 `base/v1/models` 200 时正确修正 base；
`modelsURL` 显式时只问它。

真机（`harness.cjs`）：`chat` 实例 180 个模型、`messages` 实例 181 个
（多出的是手动注入的 `text-embedding-v3`）；零模型实例正常加载并只警告一次；
`metadata.enabled: false` 时全部落 200k/文本+工具；写坏缓存后自动回落到包内
快照并重写；第二次启动命中磁盘缓存。

真机（`chat.cjs`）：`chat` / `responses` / `messages` 三种协议各回一轮成功，
流式与非流式都通；工具调用在两种 wire 上分别产出 `call_*` 与 `toolu_*` id；
usage 的 `cache_read` / `reasoning` 字段正确透传。

过程中修掉三个真实缺陷：发现请求没带鉴权（全部 401）、
`shared-adapter` 的非流式路径残留 `stream_options` 被上游拒绝、
catalog 只剥 `-YYYYMMDD` 而漏掉 `-YYYY-MM-DD`（导致整批模型掉进 200k 兜底）。

### 元数据覆盖的真实分布（`scripts/audit.mjs`）

一个 180 模型的端点，修正日期后缀后：

| | 数量 | 说明 |
|---|---|---|
| catalog 命中 | 104 | 上下文/输出/模态来自 models.dev |
| fallback | 76 | 未命中，走 `getModelMaxContextSizeByName` 与默认值 |

76 个未命中里，按名字分类：

| 类别 | 数量 | 说明 |
|---|---|---|
| 对话模型 | 39 | 多为老型号（`qwen-7b-chat`、`qwen1.5-*`）与专有型号（`gui-plus`、`tongyi-*`）；models.dev 未收录 |
| 实时/omni | 15 | `*-realtime`、`*-omni-*`，走独立 wire，不适用于对话端点 |
| 语音 | 10 | `tts` / `asr` / `speech` |
| 图像生成 | 4 | `qwen-image-*`、`z-image-*` |
| 翻译 | 3 | `qwen-mt-*` |
| embedding / rerank | 3 | 走 `/embeddings`、`/rerank` |
| OCR | 2 | |

### 图片输入

`scripts/vision.cjs` 把一张 `image_url` content part 直接喂给模型，绕过 koishi 的
元素拦截器（那条路径只对不支持图片的模型打 warn，不拦），所以测的就是 wire 本身：

| 实例 | 结果 |
|---|---|
| `chat`（qwen3.8-flash） | 纯色图 → `"Red"`，2662 ms |
| `messages`（同一模型） | 同一张图 → `"Red"`，3093 ms |
| `messages`（上蓝下黄） | → `"Blue yellow"`，2992 ms |

最后一条是关键：模型读出了**两个区域**，说明图片字节真的到了模型，不是被上游
静默丢弃后模型瞎猜。

### 沙盒端到端测试（chatluna-sandbox MCP）

`koishi-plugin-chatluna-sandbox` 暴露 MCP（默认 `127.0.0.1:61901/mcp`，Bearer 鉴权），
能模拟 QQ 环境发消息、读回复，并能读到 **adapter 实际发出的请求体与响应体**
（`get_model_request_record`）。这比自写脚本更有说服力：验证的是真实 wire。

| 场景 | 结果 |
|---|---|
| 私聊单轮（messages） | 正常回复 |
| 多轮上下文 | 准确复述上一轮内容；请求里 `user/assistant` 交替正确，system 被转进 messages |
| 图片（真实 QQ 元素 → sandbox 媒体 → `image_url`） | 上蓝下黄答「蓝色 黄色」；wire 上是 `image/base64/image/png` 块 |
| 长消息（18k 字符） | 正常回复，请求体 126 KB，裁剪未误伤 |
| 并发三条 | 全部按序返回 1 / 2 / 3 |
| 无效 key | 上游 403 原文保留，抛 `ChatLunaError:103` |
| Agent 模式（`chatluna-agent`，`defaultChatMode: plugin`） | 工具链往返完整：多轮 `tool_use` → `tool_result` → 再 `tool_use`，27 条消息的对话里共 10 条工具往返，全部正确 |
| 工具真实执行（`bash`） | `echo tool-works-123` → 模型拿到真实输出并转述 |
| 三步工具链 | `bash date +%s` → `file_write /tmp/ua-test.txt` → `file_read` 读回；文件在宿主机真实存在，三步结果一致 |
| 工具执行失败 | `ls /nonexistent-dir-xyz` → 退出码 2 与 stderr 原文回传，模型正确转述 |

请求体实测（`deepseek-v4.1-flash-1017`，修复前 vs 后）：

```
修复前: max_tokens: 1050000   → HTTP 400 "Range of max_completion_tokens should be [1, 393216]"
修复后: max_tokens: 384000    → success
```

修复后取的是同一模型另一条正常记录（`deepseek-v4.1-flash` 的 `o: 384000`）——
说明 `output >= context` 的丢弃规则生效，脏记录被绕过而正常记录仍然命中。

#### Agent 模式下的工具调用（`messages` wire）

`chatluna-agent` 的 `plugin` 模式会给模型一份 10 个工具的清单
（`trigger` / `file_*` / `grep` / `glob` / `bash` / `skill` / `task`）。
沙盒里这些工具因 `workspace-write` 沙箱被拒，但**协议层的往返是完整的**：

```
assistant tool_use   id=toolu_d08aa316... name=bash input={"command":"echo hello-from-agent"}
user      tool_result tool_use_id=toolu_d08aa316... "You do not have permission to call tool 'bash'..."
assistant tool_use   id=toolu_f3076018... name=task input={"action":"run","agent":"general",...}
user      tool_result tool_use_id=toolu_f3076018... "PERMISSION DENIED\n\ntask_id: ..."
...
assistant tool_use   id=toolu_56edea49... name=skill input={"name":"agentcli"}
user      tool_result tool_use_id=toolu_56edea49... "<skill_content name=\"agentcli\">..."
```

三条结论：

1. **`tool_use_id` 被准确回传**，Anthropic 的严格配对要求（每个 `tool_result`
   必须引用一个存在的 `tool_use` id）得到满足——否则上游会直接 400。
2. **工具 schema 是标准 JSON Schema**，`input_schema` 带 `required` 与
   `properties`，由 `formatToolsToClaudeTools()` 生成（vendored 自上游）。
3. **多轮工具链不断裂**：`task` 子代理调用被拒后，模型换用 `skill` 继续，
   新的 `tool_use` 与历史的 `tool_result` 在同一次请求里共存。

**结论**：catalog 命中率约 58%，未命中的主体是端点上"顺带列出"的非对话模型。
这些模型在 ChatLuna 里一律被登记成 `ModelType.llm`（catalog 未命中时无法判断
类型），选中它们会失败——这是**已知并接受**的行为，因为：
判断类型只能靠名字猜测，而本项目明确禁止新增启发式（AGENTS.md）。用户可用
`modelOverrides` 显式标注类型，或用 `blacklistModels` 过滤。

---

## 11. 未决与已知限制

- **`metadata.sources` 的自定义 URL 格式**：目前只约定"返回 models.dev 同构
  或 `{models: [...]}`"。若将来需要更多形态，在 §5.4 的归一化里扩展，
  不在匹配阶段打补丁。
- **运行时缓存不校验内容新旧的语义**：只比 `fetchedAt`。若用户网络长期失败，
  缓存会一直停在最后一次成功的时间点——这是预期行为。
- **`protocol` 变更需要用户重建实例**：同一 `platform` 下换协议相当于换
  一个适配器。不做热切换。
- **未实现 gemini 协议**：第 4 套 wire + 大量变体展开（分辨率后缀、
  thinking 档位），收益低。枚举位保留，实现了再放宽 `UnifiedProtocol`。
