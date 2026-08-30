# extension-git

[scratch-toolchain](https://github.com/palette-community/scratch-toolchain) 协作工作流的扩展
一半。拥有 Scratch **扩展**（自定义 + 内置）相关的一切，让 vanilla 一半
（[`scratch-git`](../scratch-git)）能专注于核心工作流，只需依赖本包做扩展的解析与注册。

`scratch-git` 在每次 `.sb3` ↔ 树的转换中都会调用本包：读取项目记录、抓取（或内联）每个扩展的源码，
并把生成的块定义注册到 I/O-free 的 `parse-sb3-blocks` 解析器中，让正向/反向往返能输出有效的
scratchblocks 文本。

English | **[English](README.md)**

## 目录

- [功能](#功能)
- [公共 API](#公共-api)
- [源码布局](#源码布局)
- [扩展源码](#扩展源码)
- [缓存布局（`.palette/cache`）](#缓存布局palettecache)
- [开发](#开发)
- [许可证](#许可证)

---

## 功能

Scratch / TurboWarp 的 `.sb3` 在两处记录其扩展：

- `project.extensionURLs` — 一个对象，把每个扩展 id 映射到其源码位置
  （`https://…js` URL 或内联的 `data:` URL）。
- `project.extensions` — 一个裸 id 列表（**自定义和内置都有**）。一个 id 在这里出现但不在
  `extensionURLs` 中，就是内置 / 未解析的扩展；我们保留其 `builtin` 分类，解析器把它渲染为
  `[unknown opcode: …]` 占位符（`scratch-git` 的安全护栏会阻止损失蔓延到项目的其他部分）。

本包把这些记录转换为已注册的块定义。具体而言：

1. `resolveExtensions(project, { paletteDir })` — 遍历 `project.extensionURLs` +
   `project.extensions` 中的 URL 条目；对每个：
   - `data:` URL → 内联解码（`base64` 或 percent-encoded）。
   - `https://` URL → 写入 `.palette/cache/<id>.js`（如果还没有）并 `registerExtensionFromSource`。
   - `extensions` 中没有 URL 的裸 id → 留给 `registerTurbowarpBuiltins` 处理
     （或如果不是内置则用 `[unknown opcode: …]`）。
2. `registerCachedExtensions(paletteDir)` — 从 `.palette/cache/*.js` 重新加载已缓存的扩展 JS，
   支持离线 / 重复运行，无需网络。
3. `registerTurbowarpBuiltins()` — 加载捆绑的 TurboWarp `scratch-vm` 扩展子模块
   （`extensions/turbowarp/src/extensions/`）并注册规范的 `pen`、`music`、`videoSensing`…… 等块。

`scratch-git` 在解包（pre-commit）和打包（post-checkout / post-merge）时，于 `parse-sb3-blocks`
的正向/反向渲染器运行之前调用这三个。

## 公共 API

包的 `main`（`src/index.js`）重导出三个函数：

| 函数 | 用途 |
|---|---|
| `resolveExtensions(project, { paletteDir })` | 解析项目的 `extensionURLs` + `extensions`，注册对应块定义。抓取的源码写入 `paletteDir/cache/`。 |
| `registerCachedExtensions(paletteDir)` | 重新注册 `paletteDir/cache/` 中已有的每个 `*.js`（离线 / 幂等）。 |
| `registerTurbowarpBuiltins()` | 注册 TurboWarp 的内置扩展（从 `extensions/turbowarp` git 子模块加载）。 |

典型调用顺序（见 `scratch-git/src/repack.js` 和 `hook.js`）：

```js
import {
    resolveExtensions,
    registerCachedExtensions,
    registerTurbowarpBuiltins,
} from 'extension-git';

registerTurbowarpBuiltins();
await resolveExtensions(project, { paletteDir });
// 或完全离线 / 可复现的运行：
registerCachedExtensions(paletteDir);
```

两个来源组合起来：`pen`（内置）和 `myext_*`（来自 `data:` URL）都进入 `parse-sb3-blocks` 的全局
块表，正向渲染器输出它们，反向解析器识别它们。

## 源码布局

```
extension-git/
├── package.json
└── src/
    ├── index.js         # 公共 API 重导出
    ├── extresolve.js    # resolveExtensions + registerCachedExtensions + data: URL 解码
    └── builtins.js      # registerTurbowarpBuiltins（读 extensions/turbowarp 子模块）
```

除了 `parse-sb3-blocks`（用于块注册）和 `scratch-sandbox`（用于在受限 CommonJS shim 中执行
自定义扩展源码）之外，无其他运行时依赖。

## 扩展源码

解码器同时处理两种线格式：

| 形式 | 示例 | 解码方式 |
|---|---|---|
| `data:application/javascript;base64,…` | 内联，base64 | `Buffer.from(payload, 'base64').toString('utf8')` |
| `data:application/javascript,…`（percent-encoded） | 内联，percent-encoded | `decodeURIComponent(payload)` |
| `data:text/javascript;base64,…` / `data:text/javascript,…` | 同上，只是另一种 MIME | 同上 |
| `https://…/ext.js` | 在 resolve 时下载 | 由调用方注入的 `opts.fetch(url)` |

`scratch-git` 向 `resolveExtensions` 传一个 `fetch` 选项（带超时）用于 `https://` 情况；失败时
扩展保持未注册，块图输出标准的 `[unknown opcode: …]` 占位符。

## 缓存布局（`.palette/cache`）

当 `resolveExtensions` 下载一个自定义扩展时，它会写入：

```
.palette/cache/
├── <ext-id>.js           # 已锁定的源码（若 .scratchdeps 记录了则做 sha256 校验）
└── <ext-id>.json         # 解析后的 getInfo() 快照（块元数据、菜单、图标）
```

这些文件在项目级别被 gitignore（它们可由 `extensionURLs` + `.scratchdeps` 复现）。
`registerCachedExtensions` 重新加载 `.js` 而不连接网络，因此一个带有已填充缓存的新克隆
无需重新下载即可往返。

## 开发

```sh
npm test            # node --test test/*.test.js
```

测试套件覆盖 `data:` URL 解码（base64 / percent-encoded，含/不含 `charset` meta，
两种 MIME 类型）。

针对实时 `parse-sb3-blocks` 源码（兄弟仓库）开发——见
[`scratch-git` README](../scratch-git#开发) 的软链说明；这里也一样。

## 许可证

MPL-2.0.
