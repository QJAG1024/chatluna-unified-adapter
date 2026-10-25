<div align="center">

# koishi-plugin-chatluna-unified-adapter

_一个实例接入一条上游路由，端点、鉴权与模型元数据都可配置。_

## [![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-unified-adapter)](https://www.npmjs.com/package/koishi-plugin-chatluna-unified-adapter) [![npm](https://img.shields.io/npm/dm/koishi-plugin-chatluna-unified-adapter)](https://www.npmjs.com/package/koishi-plugin-chatluna-unified-adapter)

![node version](https://img.shields.io/badge/node-%3E=18-green)

</div>

## ✨ 特性

* 🔌 **三种协议**：Chat Completions、Responses、Anthropic Messages，由配置项选择
* 🧩 **多实例**：同一插件可挂任意多个实例，各自命名，互不干扰
* 🔑 **按 key 配置端点**：每把 key 有自己的 base URL、鉴权头形态与额外请求头
* 📋 **模型列表可覆盖**：端点没有 `/models` 时指向别处，或完全手写
* 🏷️ **元数据自动填充**：上下文、输出上限、视觉/工具/思考能力取自 [models.dev](https://models.dev)
* ✍️ **覆写优先**：手动设置的字段永远生效，未设置的才交给元数据源

## 🚀 部署

在 Koishi 插件市场搜索 `chatluna-unified-adapter`，安装后启用即可。

需要 [ChatLuna](https://chatluna.chat/) 主插件，版本 ≥ `1.4.0-alpha.44`。

## ⚙️ 配置

一个实例对应一种协议与一条上游路由。接入同一供应商的多个端点时，挂载多个实例，
以 `platform` 区分。

```yaml
plugins:
  chatluna:xxx: {}

  chatluna-unified-adapter:a1:
    platform: my-gateway            # 模型以 my-gateway/模型名 出现
    protocol: chat
    apiKeys:
      - - sk-xxxx
        - https://api.example.com/v1
        - true

  chatluna-unified-adapter:a2:
    platform: my-gateway-claude
    protocol: messages
    apiKeys:
      - - sk-xxxx
        - https://api.example.com/anthropic/v1
        - true
```

基础配置项：

| 配置项 | 说明 |
| --- | --- |
| `platform` | 实例名称，同时作为模型前缀 |
| `protocol` | `chat` / `responses` / `messages` |
| `apiKeys` | API Key、请求地址、是否启用 |

请求地址须包含版本路径，如 `https://api.openai.com/v1`。

### 协议

| 协议 | 说明 |
| --- | --- |
| `chat` | OpenAI Chat Completions。兼容网关的通用选择，支持嵌入与重排序模型 |
| `responses` | OpenAI Responses |
| `messages` | Anthropic Messages。官方 API 与 Claude 兼容端点 |

### 鉴权与请求头

默认鉴权头由协议决定：`chat` 与 `responses` 使用 `Authorization: Bearer`，
`messages` 同时发送 `x-api-key` 与 `Authorization`。

需要其他形态时由 `authHeader` 指定（`bearer` / `x-api-key` / `both`）。
`headers` 表用于补充额外请求头，如 `anthropic-beta` 或自定义 UA。

### 模型列表

模型列表仅从配置的端点获取。获取失败时该实例加载为零模型，不中断启动。

| 配置项 | 说明 |
| --- | --- |
| `modelsURL` | 列表地址。部分 Anthropic 兼容端点不提供 `/models`，可指向该供应商其他端点的列表 |
| `modelsProbe` | 端点无列表时额外尝试 `地址/v1/models`，并在日志中输出可用地址 |
| `pullModels` | 关闭后仅使用 `modelOverrides` 中的模型 |

### 模型覆写

`modelOverrides` 以模型 id 为键。键存在即注入该模型，无论端点是否列出；
未填写的字段仍从元数据源获取。

```yaml
modelOverrides:
  text-embedding-v3:                # 元数据源中不存在
    modelType: Embeddings 嵌入模型
    contextSize: 8192
  qwen3-max:
    contextSize: 262144             # 覆盖元数据源的值
    maxOutputTokens: 65536
  some-private-model:
    modelCapabilities: [tool_call, image_input]
```

`maxOutputTokens` 仅用于 `messages` 协议：该 API 要求 `max_tokens` 必填。

## 🏷️ 模型元数据

上下文长度、输出上限、视觉与工具能力默认取自 [models.dev](https://models.dev)（MIT）。
数据按三层依次回退：

1. 启动时实时拉取
2. 运行时缓存 `data/chatluna/unified-adapter/unified-catalog.json`
3. 包内快照

任一层失败时使用上一层。同一进程内的多个实例共享一次拉取。

元数据源未收录的模型回退到 ChatLuna 既有的推断与默认值，与其他适配器一致。
`metadata.sources` 可追加自建源，需返回 models.dev 同构数据。

## 📌 已知情况

* 端点列出的 embedding、图像生成、语音等非对话模型会被登记为对话模型，因为
  类型无法从名称可靠判断。可用 `blacklistModels` 过滤，或在 `modelOverrides`
  中标注 `modelType`。
* 工具执行失败时，错误信息位于结果文本中（退出码与 stderr），没有结构化的失败
  标记。此行为与 ChatLuna 官方适配器一致。
* 三种协议相互独立，不支持协议间转译或负载均衡。

## 📄 许可证

[AGPL-3.0](./LICENSE)。

`src/anthropic/` 下的代码复制自 ChatLuna 官方 Claude 适配器（同为 AGPL-3.0），
保留原始版权声明。同步方式见 [`src/anthropic/README.md`](src/anthropic/README.md)。

## 🔧 开发

设计决策见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，代理协作约定见
[`AGENTS.md`](AGENTS.md)。

```bash
yarn install
yarn build          # atsc（d.ts）+ esbuild（cjs/mjs）
yarn lint
yarn fetch-catalog  # 重新生成 src/data/models.dev.json
```

仓库内附三个验证脚本，运行后输出结果并退出，非测试框架：

| 脚本 | 作用 |
| --- | --- |
| `yarn probe <base> [key] [protocol]` | 对端点执行模型发现与元数据匹配，用于核对供应商行为 |
| `node scripts/harness.cjs <config.json>` | 启动 koishi 并挂载实例，输出模型数量与能力 |
| `node scripts/chat.cjs <config.json> <platform/model>` | 启动 koishi 并执行一轮对话，输出回复与用量 |

`config.json` 为插件配置数组，每个元素对应一个实例。
