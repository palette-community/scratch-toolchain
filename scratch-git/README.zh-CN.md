# git-palette

把 Scratch / TurboWarp 项目以**展开、易 diff 的树**形式存入 git，而不是一个黑盒 `.sb3` 压缩包。
提交时由 `pre-commit` hook 把 `.sb3` 解包成 `.palette/` + `roles/`；`post-checkout` / `post-merge`
hook 在树变化后再把 `.sb3` 重新打包回去。工具输出是稳定的纯英文文本（可被脚本安全解析）。

属于 [scratch-toolchain](https://github.com/palette-community/scratch-toolchain) 系列，
配合 [scratch-sandbox](https://github.com/palette-community/scratch-sandbox) 做扩展积木渲染。

**中文** | English

## 目录

- [安装与使用](#安装与使用)
- [被管理仓库布局](#被管理仓库布局)
- [命令](#命令)
- [工作流](#工作流)
- [合并冲突处理](#合并冲突处理)
- [工作原理（hook）](#工作原理hook)
- [扩展依赖（`.scratchdeps`）](#扩展依赖scratchdeps)
- [开发](#开发)
- [许可证](#许可证)

---

## 安装与使用

```sh
npm install github:palette-community/git-palette
```

`git-palette` 会被 git 识别为子命令（`git palette <cmd>`）。在项目仓库中：

```sh
git palette init MyProject     # 生成 .palette/、README.md、.scratchdeps、.gitignore
git palette install           # 把 core.hooksPath 指向工具的 hooks
git palette commit MyProject.sb3 -m "import v1"   # 强制暂存被 gitignore 的 .sb3
```

`commit` 之后，仓库里只保留展开树；`MyProject.sb3` 被 gitignore，并在你 `git checkout` / `git merge`
时自动重新生成。

## 被管理仓库布局

```
<repo root>/
├── .palette/
│   ├── type.json            # {"type":"project"}
│   ├── meta.json            # 辅助信息：{name, importedAt, tool, source}
│   ├── project.json         # 权威数据（美化打印，保留源键序）
│   ├── assets.json          # 素材索引：{"<md5ext>": {target, kind, name}}
│   ├── extensions/          # （可选）已解析的扩展积木元数据快照
│   └── cache/               # 已锁定的扩展下载（跨重建保留）
├── roles/
│   ├── stage/               # isStage
│   │   ├── stage.sb         # 仅积木（scratchblocks 文本）
│   │   ├── costumes/*.ext
│   │   └── sounds/*.ext
│   └── <SpriteName>/
│       ├── <SpriteName>.sb # 仅积木
│       ├── costumes/*.ext
│       └── sounds/*.ext
├── .scratchdeps             # 扩展依赖声明与版本锁定
└── README.md                # 由 `init` 生成
```

目录名统一为英文（`roles/`、`stage/`、`costumes/`、`sounds/`）；`<SpriteName>` 取 `project.json`
中的目标名，原样保留。每个 `.sb` 文件**只包含该角色的积木**（scratchblocks），不含任何标题或
清单，按编辑器坐标 `(y, x)` 排序以保证 diff 稳定。

## 命令

| 命令 | 作用 |
|---|---|
| `git palette install` | 配置 `core.hooksPath` 指向工具 hooks；确保 `.gitignore`（`/scratch4js/`、`*.sb3`、`node_modules/`） |
| `git palette init [name]` | 生成 `.palette/`、`README.md`、`.scratchdeps` 与 `.gitignore` 骨架 |
| `git palette import <file.sb3>` | 手动把 `.sb3` 解包成树（不提交） |
| `git palette export [-o out.sb3]` | 把树打包回 `.sb3`（project.json 权威 + 素材 + 扩展注入） |
| `git palette commit [sb3...] -m <msg>` | 强制暂存被 gitignore 的 `.sb3` 并提交（pre-commit 自动解包） |
| `git palette status` | 对比工作区 `.sb3` 与已提交树，列出差异文件 |
| `git palette diff [a.sb3 b.sb3]` | 无参：树的 `git diff`；给定两个 `.sb3`：对比其 scratchblocks 文本 |
| `git palette conflicts` | 列出 palette 树中未解决的合并冲突（标注文本 / 二进制） |
| `git palette resolve <file> [--ours\|--theirs]` | 解决二进制素材冲突：取某一侧并 `git add` |
| `git palette editor-sync` | 手动从树重新生成编辑器用 `.sb3`（由 post-checkout/post-merge 调用） |
| `git palette deps <list\|lock>` | 查看 / 锁定扩展依赖 |
| `git palette extmeta` | 解析已锁定的扩展 JS，写出 `.palette/extensions/<id>.json` 积木元数据快照 |

## 工作流

```
外部编辑器（TurboWarp / 官网）
        │  导出 MyProject.sb3
        ▼
git palette commit MyProject.sb3
        │  pre-commit hook
        │   从索引读 blob → 解包 → 重建 roles/ + .palette/ → git rm --cached *.sb3 → git add 树
        ▼
git 对象库 = 展开树（唯一真相）
        │
        ├─ 协作：git palette diff / status 查看积木文本差异
        ├─ 合并：git palette conflicts / resolve
        │
        └─ 切分支 / 合并 → post-checkout / post-merge hook
              git palette editor-sync → 从树重新生成 MyProject.sb3 供编辑器使用
外部编辑器重新打开 MyProject.sb3 → 下一轮
```

`.sb3` 是“编辑器与仓库之间的货币”，不进 git（gitignore）。展开树才是 git 中存储的唯一真相；
两个 hook 自动保持 `.sb3` 与树同步。

## 合并冲突处理

树由人类可读文本与二进制素材混合而成，分别处理：

- **文本冲突**（`.sb` / `project.json` / `assets.json` / `.scratchdeps`）：正常三方合并，直接编辑
  scratchblocks 文本解决。`git palette conflicts` 标注为 `text`。`.palette/meta.json` 含非确定的
  `importedAt` 时间戳，被 `status` / 比对自动忽略。
- **二进制冲突**（素材 `*.svg/*.png/*.wav/...`）：git 无法文本合并，`git palette conflicts` 标注为
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
| 使用 Turbowarp 高级特性（表达式中嵌套 `procedures_call`、复杂自定义块 proccode） | **功能等价**；block **id** 和少量展示形式细节（input key 字符串、genId 顺序）可能与源码不同，但块图结构完整，`.sb3` 打开运行完全一致 |

如果往返检测到丢块过多（例如某个扩展你忘了把源码打包进来），repack 会**回退**为仅结构重建（生成新 id）并打印
警告——绝不会生成坏 `.sb3`。完整的 byte-identical 报告与少量无法保证的边界情况（主要是自定义块
调用 inputs 的动态 argId key 和没带源码的扩展）见 scratch-toolchain 仓库的 `PLAN.md`。

## 工作原理（hook）

- `pre-commit`：找出暂存的 `*.sb3` → 从**索引**读取每个 blob（不依赖工作区）→ 解包到仓库根的树 →
  `git rm --cached` 掉 `.sb3` 并 `git add` 整棵树。幂等。
- `post-checkout` / `post-merge`：运行 `editor-sync` → 从树重建被 gitignore 的 `.sb3`
  （存在未解决冲突时跳过）。

## 扩展依赖（`.scratchdeps`）

```ini
# dependency declarations (extension version locking)
pen: builtin
myext: https://ext.turbowarp.org/foo.js
  sha256: ab12…
```

- `unpack` 从 `project.json.extensions` 抽取：字符串 → 内置；对象（`extensionId`/`js`）→ 自定义。
- `export` 写回：内置 → 字符串；自定义 → `{extensionId, js, type:'extension'}`。
- `deps lock` 把自定义扩展 JS 下载到 `.palette/cache/<id>.js` 并记录其 sha256。

## 开发

```sh
npm test            # node --test test/*.test.js
```

往返、冲突与 git 流集成测试都在临时 git 仓库中运行。

## 许可证

MPL-2.0。
