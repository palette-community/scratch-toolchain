# scratch-git

[scratch-toolchain](https://github.com/palette-community/scratch-toolchain) 协作工作流的 vanilla
Scratch 一半。把 Scratch / TurboWarp 项目以**展开的、diff 友好的目录树**存进 git，而不是不透明的
`.sb3` zip。`.sb3` 在 commit 时由 `pre-commit` hook 解包为 `.palette/` + `roles/`，在
`post-checkout` / `post-merge` 时由 hook 重新打包回 `.sb3`。工具输出是稳定的纯英文文本
（可被脚本安全解析）。

CLI 以 `git palette` 子命令暴露（历史名——为向后兼容现有 hook 和使用习惯保留）。扩展发现
与注册在兄弟包 [`extension-git`](../extension-git) 里；`scratch-git` 每次转换都会调用它。

English | **[English](README.md)**

## 目录

- [安装与使用](#安装与使用)
- [被管理仓库布局](#被管理仓库布局)
- [命令](#命令)
- [工作流](#工作流)
- [合并冲突处理](#合并冲突处理)
- [往返保真度](#往返保真度)
- [工作原理（hook）](#工作原理hook)
- [扩展依赖（`.scratchdeps`）](#扩展依赖scratchdeps)
- [开发](#开发)
- [许可证](#许可证)

---

## 安装与使用

```sh
npm install github:palette-community/scratch-toolchain#packages/scratch-git
```

（或在仓库根安装整个 monorepo，然后依赖 `scratch-git` workspace）

`scratch-git` 被 git 识别为 `git palette` 子命令。在项目仓库里：

```sh
git palette init MyProject     # scaffold .palette/, README.md, .scratchdeps, .gitignore
git palette install           # 把 core.hooksPath 指向工具 hooks
git palette commit MyProject.sb3 -m "import v1"   # 强制 stage 被 gitignore 的 .sb3
```

`commit` 之后，仓库只存展开的目录树；`MyProject.sb3` 被 gitignore，每次 `git checkout` /
`git merge` 时自动重新生成。

## 被管理仓库布局

```
<repo root>/
├── .palette/
│   ├── type.json            # {"type":"project"}
│   ├── meta.json            # 提示性：{name, importedAt, tool, source}
│   ├── project.json         # 权威项目数据（pretty-printed，保留源 key 顺序）
│   ├── assets.json          # 素材索引：{"<md5ext>": {target, kind, name}}
│   ├── extensions/          # （可选）解析后的扩展 block-metadata 快照
│   └── cache/               # 已锁定的扩展下载（rebuild 之间保留）
├── roles/
│   ├── stage/               # isStage
│   │   ├── stage.sb         # 仅积木（scratchblocks 文本）
│   │   ├── costumes/*.ext
│   │   └── sounds/*.ext
│   └── <SpriteName>/
│       ├── <SpriteName>.sb # 仅积木
│       ├── costumes/*.ext
│       └── sounds/*.ext
├── .scratchdeps             # 扩展依赖声明 + 版本锁定
└── README.md                # 由 `init` scaffold
```

目录名是英文（`roles/`、`stage/`、`costumes/`、`sounds/`）；`<SpriteName>` 取自 `project.json`
的角色名，原样保留。每个 `.sb` 文件**只包含该目标的积木**（scratchblocks），无标题无章节
标签，按编辑器的 `(y, x)` 顺序排序以保证 diff 稳定。

## 命令

| 命令 | 用途 |
|---|---|
| `git palette install` | 设置 `core.hooksPath` → 工具 hooks；确保 `.gitignore`（`*.sb3`、`node_modules/`）|
| `git palette init [name]` | scaffold `.palette/`、`README.md`、`.scratchdeps`、`.gitignore` |
| `git palette import <file.sb3>` | 手动把 `.sb3` 解包到树（不 commit）|
| `git palette export [-o out.sb3]` | 把树打包回 `.sb3`（project.json 权威 + 素材 + 扩展注入）|
| `git palette commit [sb3...] -m <msg>` | 强制 stage 被 gitignore 的 `.sb3` 并 commit（pre-commit 自动解包）|
| `git palette status` | 对比工作区 `.sb3` 与已 commit 的树；列出有差异的文件 |
| `git palette diff [a.sb3 b.sb3]` | 无参：对树跑 `git diff`；两 `.sb3`：对比 scratchblocks 文本 |
| `git palette conflicts` | 列出 palette 树中未解决的合并冲突（标注文本 / 二进制） |
| `git palette resolve <file> [--ours\|--theirs]` | 解决二进制素材冲突：取某一侧并 `git add` |
| `git palette editor-sync` | 手动从树重新生成编辑器 `.sb3`（由 post-checkout/post-merge 调用）|
| `git palette deps <list\|lock>` | 检查 / 锁定扩展依赖 |
| `git palette extmeta` | 把已锁定的扩展 JS 解析为 `.palette/extensions/<id>.json` block-metadata 快照 |

## 工作流

```
external editor (TurboWarp / website)
        │  export MyProject.sb3
        ▼
git palette commit MyProject.sb3
        │  pre-commit hook
        │   从 index 读 blob → 解包 → 重建 roles/ + .palette/ → git rm --cached *.sb3 → git add tree
        ▼
git object store = 展开的目录树（单一事实源）
        │
        ├─ 协作：git palette diff / status 查看积木文本变化
        ├─ 合并：git palette conflicts / resolve
        │
        └─ checkout / merge → post-checkout / post-merge hook
              git palette editor-sync → 为编辑器重新生成 MyProject.sb3
external editor 重新打开 MyProject.sb3 → 下一轮
```

`.sb3` 是编辑器与仓库之间的"货币"——它从不进入 git（被 gitignore）。展开的目录树是 git 中存储
的唯一事实；两个 hook 自动保持 `.sb3` 同步。

## 合并冲突处理

树是文本与二进制素材的混合，分别处理：

- **文本冲突**（`.sb` / `project.json` / `assets.json` / `.scratchdeps`）：正常的 git 三方合并，
  直接编辑 scratchblocks 文本解决。`git palette conflicts` 标为 `text`。`.palette/meta.json`
  含非确定性的 `importedAt` 时间戳，被 `status` / 对比忽略。
- **二进制冲突**（素材 `*.svg/*.png/*.wav/...`）：git 无法文本合并，`git palette conflicts` 标为
  `binary`。用 `git palette resolve <file> --ours|--theirs` 整文件取一侧并 `git add`。
- **冲突期间的反向同步**：`post-checkout` / `post-merge` 检测到未解决冲突（`git diff --diff-filter=U`）
  时会**跳过** `.sb3` 重建，避免用半冲突的树生成坏 `.sb3`。

## 往返保真度

git 中存储的内容（`.sb` scratchblocks 文本 + `project.json`）与原 `.sb3` **功能等价**，重新打包
出来的 `.sb3` 能被 Scratch / TurboWarp 正常打开运行。能否 byte-identical 取决于项目内容：

| 项目形态 | 往返结果 |
| --- | --- |
| 纯 vanilla 块（无自定义块、无扩展） | **byte-identical** blocks JSON |
| 含自定义块（define + call）、变量、列表、广播 | blocks JSON **byte-identical**，保留原 block id |
| 项目加载的扩展源码可达（`.palette/cache/*.js` 或项目内有 `data:` URL） | 扩展块正常注册，blocks JSON byte-identical |
| TurboWarp / PenguinMod 内置扩展 | 自动注册，blocks JSON byte-identical |
| 自定义扩展源码**不可达**（未打包进 cache、项目内也无） | 这些扩展块渲染为 `[unknown opcode: …]` 占位符（仅这些块有损；安全护栏阻止损失蔓延到其他块） |
| 使用 Turbowarp 高级特性（表达式中嵌套 `procedures_call`、复杂自定义块 proccode）| **功能等价**；block **id** 和少量展示形式细节（input key 字符串、genId 顺序）可能与源码不同，但块图结构完整，`.sb3` 打开运行完全一致 |

如果往返检测到丢块过多（例如某个扩展你忘了把源码打包进来），repack 会**回退**为仅结构重建（生成新 id）并打印
警告——绝不会生成坏 `.sb3`。

## 工作原理（hook）

- `pre-commit`：找出暂存的 `*.sb3` → 从**索引**读取每个 blob（不依赖工作区）→ 解包到仓库根的树 →
  `git rm --cached` 掉 `.sb3` 并 `git add` 整棵树。幂等。
- `post-checkout` / `post-merge`：运行 `editor-sync` → 从树重建 gitignored 的 `.sb3`（未解决冲突时跳过）。

## 扩展依赖（`.scratchdeps`）

```ini
# 依赖声明（扩展版本锁定）
pen: builtin
myext: https://ext.turbowarp.org/foo.js
  sha256: ab12…
```

- `unpack` 从 `project.json.extensions` 抽取：string → builtin；object（`extensionId`/`js`）→ custom。
- `export` 写回：builtin → string；custom → `{extensionId, js, type:'extension'}`。
- `deps lock` 把 custom 扩展 JS 下载到 `.palette/cache/<id>.js` 并记录其 sha256。

实际的扩展发现、URL/data: URL 解码、scratch-sandbox 执行、TurboWarp 内置子模块注册都在兄弟包
[`extension-git`](../extension-git) 里；本包只调用其公共 API（`resolveExtensions`、
`registerCachedExtensions`、`registerTurbowarpBuiltins`）。

## 开发

```sh
npm test            # node --test test/*.test.js
```

往返、合并冲突、git-flow 集成测试针对临时 git 仓库运行。

针对实时 `parse-sb3-blocks` 源码（兄弟仓库）开发：

```sh
rm -rf node_modules/parse-sb3-blocks
ln -s ../../parse-sb3-blocks node_modules/parse-sb3-blocks
```

`npm install` 会把软链替换为已发布的 tarball；每次 install 后需重新创建软链。

## 许可证

MPL-2.0.
