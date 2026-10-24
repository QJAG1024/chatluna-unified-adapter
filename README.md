# koishi-plugin-chatluna-unified-adapter

> ChatLuna 的第三方统一适配器。一个插件实例 = 一条上游路由 = 一种 wire 协议。

ChatLuna 现有适配器把「供应商 = 一套硬编码假设」写进了代码：base URL 只有一个、
`/models` 一定存在、模型的上下文与能力靠手写表和名字正则推断。面对阿里云百炼
这类上游，这三条都不成立——它的 Anthropic 端点没有 `/models`，而 Claude 适配器
只能退回到九条写死的 `claude-*` 模型名。

本适配器统一的是**同一种协议在不同供应商下的差异**，不是不同协议之间的差异：

| 层 | 解决什么 | 靠什么 |
| --- | --- | --- |
| 端点与鉴权 | base 路径布局、鉴权头形态、额外 header | 每把 key 自己的 base、`authHeader` 三态、header 表 |
| 模型列表 | 列表在哪、拿不到怎么办 | `modelsURL` 覆盖、`/v1` 探测修正；拿不到就是空列表，不报错 |
| 模型元数据 | 上下文 / 输出上限 / 视觉 / 工具 / 思考 / 类型 | models.dev（实时 → 磁盘缓存 → 包内快照），字段级填充，绝不覆盖用户设置 |

它**不**在不同协议之间路由、转译或负载均衡。多上游 = 多个插件实例
（`reusable = true`），`platform` 由你起名。

设计决策与理由见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 安装

```bash
yarn add koishi-plugin-chatluna-unified-adapter
```

依赖 `koishi-plugin-chatluna` ≥ `1.4.0-alpha.44` 与 node ≥ 18。

## 配置

一个实例只讲一种协议，所以「同时接百炼的 OpenAI 兼容端点和 Anthropic 端点」
就是在配置树里挂两个实例：

```yaml
plugins:
  chatluna-unified-adapter:            # 实例 1
    platform: bailian                  # → bailian/qwen-plus
    protocol: chat
    apiKeys:
      - [sk-xxxx, https://dashscope.aliyuncs.com/compatible-mode/v1, true]

  chatluna-unified-adapter:            # 实例 2（同一插件的第二个实例）
    platform: bailian-claude           # → bailian-claude/qwen3.8-max
    protocol: messages
    apiKeys:
      - [sk-xxxx, https://dashscope.aliyuncs.com/apps/anthropic/v1, true]
    modelsURL: https://dashscope.aliyuncs.com/compatible-mode/v1/models
```

第二个实例的 `modelsURL` 是必要的：百炼的 Anthropic 端点**不提供** `/models`
（官方文档亦明说）。指向 compatible-mode 的列表接口即可——两个端点服务的是同一批
qwen 模型。不填则实例正常加载，但模型列表为空。

### 常见供应商

| 上游 | protocol | base |
| --- | --- | --- |
| OpenAI | `chat` / `responses` | `https://api.openai.com/v1` |
| 阿里云百炼（OpenAI 兼容） | `chat` / `responses` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| 阿里云百炼（Claude Code） | `messages` | `https://dashscope.aliyuncs.com/apps/anthropic/v1` |
| Anthropic 官方 | `messages` | `https://api.anthropic.com/v1` |
| OpenRouter | `chat` | `https://openrouter.ai/api/v1` |
| DeepSeek | `chat` | `https://api.deepseek.com` |
| 智谱 | `chat` | `https://open.bigmodel.cn/api/paas/v4` |

base 需包含版本路径。若 base 少写了一层（`base/models` 返回 404 而
`base/v1/models` 有内容），`modelsProbe` 会提示正确的地址。

### 模型覆写

`modelOverrides` 以模型 id 为键，**键存在即注入该模型**——即使端点没有列出它。
字段留空则仍然从 models.dev 取值，不会被空值覆盖：

```yaml
modelOverrides:
  text-embedding-v3:                      # models.dev 里没有它
    modelType: Embeddings 嵌入模型
    contextSize: 8192
  qwen3-max:
    contextSize: 262144                   # 覆盖 catalog 值
    maxOutputTokens: 65536
  some-private-model:
    modelCapabilities: [tool_call, image_input]
```

`maxOutputTokens` 用于 Messages 协议：该 API 要求 `max_tokens` 必填。

## 元数据

默认从 [models.dev](https://models.dev)（MIT）取模型元数据，三层：

1. 启动时实时拉取（`metadata.refreshOnStart`）
2. 运行时缓存 `data/chatluna/unified-adapter/unified-catalog.json`
3. 包内快照（构建期生成，约 300 KB / gzip 36 KB）

任一层失败都回落到上一层。同一进程内的多个实例共享一次拉取。

`metadata.sources` 可以追加自建源（`https://` 地址，返回 models.dev 同构数据）。

匹配不到时依次退回 ChatLuna 既有的 `getModelMaxContextSizeByName` /
`supportImageInput` / `supportAudioInput`，最后是保守默认值——与该生态现有适配器
行为一致。

## 开发

```bash
yarn install
yarn build                  # atsc -b（d.ts）+ esbuild（cjs/mjs）
yarn lint
yarn fetch-catalog          # 重新生成 src/data/models.dev.json
yarn probe <baseURL> [key] [chat|responses|messages]
```

三个验证脚本（都不是测试框架，跑完打印结果就退出）：

| 脚本 | 作用 |
| --- | --- |
| `yarn probe <base> [key] [protocol]` | 对真实端点跑发现与元数据匹配，打印「哪个列表路由应答了什么状态、拿到了哪些 id、每个 id 的元数据」。接线前核对供应商怪癖用。 |
| `node scripts/harness.cjs <config.json> [秒]` | 起一个真 koishi，按 JSON 数组挂多个实例，打印每个实例的模型数、能力、上下文。 |
| `node scripts/chat.cjs <config.json> <platform/model> [prompt] [秒]` | 起真 koishi 并跑一轮真实对话，打印回复、usage 与工具调用。`TOOLS=1` 时附带一个可被调用的工具。 |

`config.json` 是插件配置的数组，每个元素一个实例，例如：

```json
[
  {
    "platform": "my-gateway",
    "protocol": "chat",
    "apiKeys": [["sk-...", "https://api.example.com/v1", true]]
  }
]
```

注意 koishi 4.18 的 ESM 入口在部分 Node 版本上存在双包问题，所以这两个脚本用
CommonJS 写、走 `require`。

## 许可证

AGPL-3.0。`src/anthropic/` 下的代码复制自 ChatLuna 官方 Claude 适配器
（同为 AGPL-3.0），保留原始版权声明；同步方式见
[`src/anthropic/README.md`](src/anthropic/README.md)。
