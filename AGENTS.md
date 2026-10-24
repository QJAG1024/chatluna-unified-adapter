# Agent Instructions — adapter-unified

本文件约束在本仓库内工作的所有 AI 代理。**设计决策的完整来龙去脉见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，动代码前先读它。**

改动了设计（新增/删除配置项、改变兜底顺序、改变协议实现来源）时，必须同步更新
`docs/ARCHITECTURE.md` 与本文档的「禁止事项」。

---

## 这是什么

`koishi-plugin-chatluna-unified-adapter` —— ChatLuna 的**第三方**统一适配器。

**它是 fork 二改，不是网关。** 一个插件实例只讲**一种** wire 协议
（Chat Completions / Responses / Anthropic Messages），协议由配置项 `protocol`
选定。它统一的是**同一协议在不同供应商下的差异**：

1. 端点与鉴权布局（base 路径、鉴权头形态、额外 header）
2. 模型列表从哪里拿、拿不到怎么办
3. 模型的上下文 / 输出上限 / 能力（视觉、工具、思考、类型）从哪来

它**不**在不同协议之间路由、转译或负载均衡。多上游 = 多个插件实例
（`reusable = true`），名字由用户的 `platform` 决定。

上游参照版本：ChatLunaLab/chatluna `v1-dev` @ `ca1177d4`，
`koishi-plugin-chatluna@1.4.0-alpha.44`。

---

## 禁止事项（Hard constraints）

以下每一条都是明确讨论后**否掉**的方案，不要重新引入。

- ❌ **不做多协议网关。** 不按模型路由到不同协议端点，不做协议间转译，不做
  协议间的模型列表合并。一个实例一种协议到底。
- ❌ **不预测上游。** 不用 models.dev 的供应商归属去推断"这个模型属于哪家"、
  "这条 id 大概该走哪个端点"。`providerPreset` / `seedModels` 两个配置项
  因此被删除，不要加回来。
- ❌ **不用 catalog 的模型清单充当模型列表。** catalog 只说"供应商对外提供
  什么"，不说"这个端点能服务什么"，两者之间没有保证。
- ❌ **不做跨实例的发现结果共享。** 每个实例自己拉自己的 `/models`。跨实例
  共享的只有 catalog（元数据索引）。
- ❌ **不新增启发式。** 不写新的模型名正则/关键词表去猜能力。只能复用
  `@chatluna/v1-shared-adapter` 已有的 `supportImageInput` /
  `supportAudioInput` / `getModelMaxContextSizeByName`。
- ❌ **不要求上游改动。** 一切通过 ChatLuna 已公开的扩展点（见架构文档
  「可用的扩展点」）完成。不以"等 core 加个字段"为前提写代码。
- ❌ **不引入测试框架。** 遵循 ChatLuna 仓库规则：本仓库不加 mocha/vitest/
  node:test。验证走「构建 + `scripts/` 下的探针脚本 + 真机 koishi」。
- ❌ **不新增 linter/formatter。** 沿用 `.prettierrc` 与 chatluna 的
  eslint 配置风格，不自造规则。
- ❌ **不复制 chatluna 内部实现之外的第三方代码。** 只有
  `src/anthropic/` 允许存放复制代码，且必须带锚点注释（见下）。

## 必须事项

- ✅ 一个实例 = 一个协议 = 一个 `platform` 命名空间。
- ✅ `export const reusable = true`，允许同一插件在配置树里挂多个实例。
- ✅ 元数据**只填缺失，绝不覆盖用户显式设置**。这是整个插件的第一承诺。
- ✅ 所有可覆写的数值字段**不给 `Schema.default()`**。缺失即 `undefined`，
  这是"用户没设"与"用户设成了默认值"唯一可区分的表达。
- ✅ `catalog()` 永远 resolve；`refreshModels()` 拿不到模型时返回 `[]`
  **不抛错**（空列表是合法状态，见架构文档「零模型」）。
- ✅ 网络操作有硬上界（`metadata.timeout`），超时即降级，不无限等。

---

## 仓库结构

```
AGENTS.md                    本文件
docs/ARCHITECTURE.md         设计决策与内部结构（改动设计前必读）
README.md                    面向用户：安装、配置、供应商示例
package.json
tsconfig.json                需 resolveJsonModule（内联 catalog 快照）
scripts/
  fetch-catalog.mjs          构建期：拉 models.dev → 归一化 → src/data/
  probe.ts                   开发期：对真实端点跑发现/元数据，人工核对
src/
  index.ts                   插件入口 + Schema + locales 装配
  protocol.ts                协议枚举、默认路径、默认 authHeader、max_tokens 兜底位
  endpoints.ts               base 归一化、/v1 探测修正、URL 拼接
  discovery.ts               列表解析（多形态）、实例内 memo
  catalog.ts                 快照加载 / 磁盘缓存 / 启动刷新 / 单例时序
  spec.ts                    catalog + 覆写 → ModelInfo（字段级填充）
  client.ts                  refreshModels / _createModel / fileHandlingConfig
  requester.ts               按 protocol 分发
  anthropic/                 Anthropic Messages 协议实现（vendor 自 adapter-claude）
  data/models.dev.json       构建期内联快照（不要手工编辑）
  locales/                   zh-CN / en-US 的 *.schema.yml
```

`src/data/models.dev.json` 由 `scripts/fetch-catalog.mjs` 生成，**不要手改**；
要更新就重跑脚本。

---

## Vendored 代码政策

`src/anthropic/` 下的代码复制自 ChatLuna 官方 Claude 适配器。必须遵守：

1. 每个文件头部带块注释：上游包名 + 版本 + commit + 复制日期 + **本仓库的
   偏离清单**。
2. `src/anthropic/README.md` 维护同步表（文件 ↔ 上游路径 ↔ 版本 ↔ 偏离项）
   与 re-vendor 命令。
3. 许可证为 AGPL-3.0，与上游同源。**保留原始版权声明**，整包对外仍是
   AGPL-3.0，不得改为其他许可。
4. 上游发版后检查一次 diff；偏离项变化时同步更新注释与 README。

允许复制的原因：`koishi-plugin-chatluna-claude-adapter` 的 `exports` 只有
`"."`，`utils.ts` / `types.ts` / `requester.ts` 不在公开面，第三方插件
无法 import。

---

## 代码风格

沿用 ChatLuna 的强制规则（原文见上游 `AGENTS.md`），要点：

- **最简单能跑的实现。** 不写 `resolveXxx` / `normalizeXxx` / `ensureXxx` 这类
  包装函数；1–5 行的逻辑内联；只在 ≥2 个调用点且逻辑非平凡时才抽函数。
- **不做推测性防御。** 接口没声明 `?` 就不要判空。不链式 fallback。
- **不抽无用常量。** 一次性、语义自明的字面量直接写。
- **类方法必须用到 `this`**，否则提成模块级函数。
- 4 空格缩进、单引号、无分号、无尾逗号、`printWidth: 80`、箭头函数带括号。
- 短名优先：`ctx` / `cfg` / `err` / `opts` / `msg` / `id`。
- 不要解构：用 `session.guildId`、`config.maxTokens` 保留上下文。
- import 分组：node 内置 → 第三方 → `koishi` → `koishi-plugin-chatluna/...`
  → 本地。
- 只从 ChatLuna 的**公开导出路径** import（`package.json` 的 `exports` 里
  列出的那些）。不要深挖 `lib/` 内部路径。

---

## 常用命令

脚手架在 M0 落地后补全（镜像 chatluna 单包构建：esbuild 出 cjs/mjs，
tsc 出 d.ts）：

```bash
yarn install
yarn build              # 全量
yarn lint               # eslint
yarn lint-fix
node scripts/fetch-catalog.mjs          # 重新生成 src/data/models.dev.json
yarn tsx scripts/probe.ts <baseURL> <apiKey>   # 对真实端点核对发现结果
```

真机验证：把本包挂进 koishi 配置，观察适配器加载通知与
`chatluna.model.list` 的输出。

---

## 交付前自检

- [ ] `yarn build` 通过，`lib/` 自包含（catalog 已内联，无外部数据文件依赖）
- [ ] `yarn lint` 无新增错误
- [ ] 新增/删除配置项时同步了 `docs/ARCHITECTURE.md` 的配置表
- [ ] 没有重新引入「禁止事项」里的任何一条
- [ ] vendored 代码的偏离清单与实际 diff 一致
