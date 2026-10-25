# Agent Instructions — adapter-unified

本文件约束在本仓库内工作的所有 AI 代理。设计依据见
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，修改代码前应先阅读。

变更设计（增删配置项、调整回退顺序、更换协议实现来源）时，须同步更新
`docs/ARCHITECTURE.md` 与本文件的「禁止事项」。

---

## 定位

`koishi-plugin-chatluna-unified-adapter` 是 ChatLuna 的第三方适配器，基于官方
适配器改写。

一个插件实例只实现一种 wire 协议（Chat Completions / Responses /
Anthropic Messages），由配置项 `protocol` 选定。适配器统一的是同一协议在不同
供应商下的差异：

1. 端点与鉴权（base 路径、鉴权头形态、额外请求头）
2. 模型列表的来源与获取失败时的行为
3. 模型的上下文、输出上限与能力（视觉、工具、思考、类型）

不在协议之间路由、转译或负载均衡。多个上游对应多个插件实例
（`reusable = true`），命名由用户的 `platform` 决定。

上游参照：ChatLunaLab/chatluna `v1-dev` @ `ca1177d4`，
`koishi-plugin-chatluna@1.4.0-alpha.44`。

---

## 禁止事项

以下各项均为评估后否定的方案，不得重新引入。各项的否定理由见
`docs/ARCHITECTURE.md` §4。

- ❌ **不做多协议网关。** 不按模型路由到不同协议的端点，不做协议间转译，
  也不合并不同协议的模型列表。
- ❌ **不预测上游。** 不使用 models.dev 的供应商归属推断模型属于哪家、应走哪个
  端点。`providerPreset` 与 `seedModels` 两个配置项因此被移除，不得恢复。
- ❌ **不用 catalog 的模型清单充当模型列表。** catalog 描述供应商对外提供什么，
  不保证该端点能提供什么。
- ❌ **不做跨实例的模型发现共享。** 每个实例独立请求自己的 `/models`。跨实例
  共享的只有 catalog 元数据索引。
- ❌ **不新增启发式。** 不新增按模型名推断能力的正则或关键词表。仅可复用
  `@chatluna/v1-shared-adapter` 已有的 `supportImageInput`、
  `supportAudioInput` 与 `getModelMaxContextSizeByName`。
- ❌ **不依赖上游改动。** 实现只使用 ChatLuna 已公开的扩展点（见架构文档
  「可用的扩展点」），不以 core 新增字段为前提。
- ❌ **不引入测试框架。** 遵循 ChatLuna 仓库规则，不添加 mocha / vitest /
  node:test。验证方式为构建、`scripts/` 下的脚本与真实 koishi 实例。
- ❌ **不新增 linter 或 formatter。** 沿用 `.prettierrc` 与 chatluna 的
  eslint 配置。
- ❌ **不复制第三方代码。** 仅 `src/anthropic/` 允许存放复制自 ChatLuna 的代码，
  且须带锚点注释（见下）。

## 必须事项

- ✅ 一个实例对应一种协议与一个 `platform` 命名空间。
- ✅ 插件入口导出 `reusable = true`，以允许同一插件在配置树中挂载多个实例。
- ✅ 元数据只填充缺失字段，不覆盖用户显式设置的值。
- ✅ 可覆写的数值字段不设 `Schema.default()`。缺失即 `undefined`，以便区分
  「用户未设置」与「用户设置为默认值」。
- ✅ `catalog()` 始终 resolve；`refreshModels()` 无法获取模型时返回 `[]`，
  不抛错（空列表为合法状态，见架构文档「零模型」）。
- ✅ 网络操作受 `metadata.timeout` 限制，超时即降级。
- ✅ 请求头统一由 `protocol.ts` 的 `buildHeaders()` 构造，以确保模型发现、
  补全与元数据拉取使用同一套鉴权。

---

## 仓库结构

```
AGENTS.md                    本文件
docs/ARCHITECTURE.md         设计决策与内部结构（修改设计前必读）
README.md                    面向用户：安装、配置、已知情况
package.json
tsconfig.json                需启用 resolveJsonModule（内联 catalog 快照）
scripts/
  fetch-catalog.mjs          构建期：拉 models.dev → 归一化 → src/data/
  probe.ts                   开发期：对端点执行发现与元数据匹配
src/
  index.ts                   插件入口 + Schema + locales 装配
  protocol.ts                协议枚举、默认路径、默认 authHeader、请求头构造
  endpoints.ts               base 归一化、/v1 探测修正、URL 拼接
  discovery.ts               列表解析（多形态）、实例内 memo
  catalog.ts                 快照加载 / 磁盘缓存 / 启动刷新 / 单例时序
  spec.ts                    catalog + 覆写 → ModelInfo（字段级填充）
  client.ts                  refreshModels / _createModel / fileHandlingConfig
  requester.ts               按 protocol 分发
  anthropic/                 Anthropic Messages 协议实现（复制自 adapter-claude）
  data/models.dev.json       构建期内联快照（由脚本生成）
  locales/                   zh-CN / en-US 的 *.schema.yml
```

`src/data/models.dev.json` 由 `scripts/fetch-catalog.mjs` 生成，不手工编辑；
更新时重新运行该脚本。

---

## Vendored 代码政策

`src/anthropic/` 下的代码复制自 ChatLuna 官方 Claude 适配器，须遵守：

1. 每个文件头部带块注释：上游包名、版本、commit、复制日期与本仓库的偏离清单。
2. `src/anthropic/README.md` 维护同步表（文件、上游路径、版本、偏离项）与
   re-vendor 命令。
3. 许可证为 AGPL-3.0，与上游同源。保留原始版权声明，整包仍以 AGPL-3.0 发布，
   不得改为其他许可。
4. 上游发版后宜比对一次 diff；偏离项变化时同步更新注释与 README。

复制的原因：`koishi-plugin-chatluna-claude-adapter` 的 `exports` 仅暴露 `"."`，
`utils.ts` / `types.ts` / `requester.ts` 不在公开导出中，第三方插件无法 import。

---

## 代码风格

沿用 ChatLuna 的规则（原文见上游 `AGENTS.md`），要点：

- 实现以简明为准。不写 `resolveXxx` / `normalizeXxx` / `ensureXxx` 一类包装
  函数；1–5 行的逻辑内联；仅在两个以上调用点且逻辑非平凡时抽为函数。
- 不做推测性防御。接口未声明 `?` 的字段不判空，不写链式回退。
- 不提取无复用价值的常量，语义自明的字面量直接写在调用处。
- 类方法必须使用 `this`，否则提为模块级函数。
- 格式：4 空格缩进、单引号、无分号、无尾逗号、`printWidth: 80`、箭头函数带
  括号。
- 局部变量与参数优先短名：`ctx` / `cfg` / `err` / `opts` / `msg` / `id`。
- 不使用解构，保留 `session.guildId`、`config.maxTokens` 形式的上下文。
- import 顺序：node 内置 → 第三方 → `koishi` → `koishi-plugin-chatluna/...`
  → 本地。
- 只从 ChatLuna 的公开导出路径 import（`package.json` 的 `exports` 所列），
  不引用 `lib/` 内部路径。

---

## 常用命令

```bash
yarn install
yarn build              # atsc（d.ts）+ esbuild（cjs/mjs）
yarn lint
yarn lint-fix
yarn fetch-catalog      # 重新生成 src/data/models.dev.json
yarn probe <baseURL> [apiKey] [protocol]   # 对端点核对模型发现结果
```

真机验证：将本包挂入 koishi 配置，检查适配器加载通知与
`chatluna.model.list` 的输出。

---

## 交付前自检

- [ ] `yarn build` 通过，`lib/` 自包含（catalog 已内联，无外部数据文件依赖）
- [ ] `yarn lint` 无新增错误
- [ ] 增删配置项时同步了 `docs/ARCHITECTURE.md` 的配置表
- [ ] 未违反「禁止事项」中的任何一项
- [ ] vendored 代码的偏离清单与实际 diff 一致
