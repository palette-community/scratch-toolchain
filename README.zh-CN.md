# scratch-toolchain

通过 git 协作 Scratch / TurboWarp 项目。`.sb3` zip 在 commit 时被解包为展开的、diff 友好的
目录树，checkout / merge 后再重新打包回 `.sb3`，让编辑器始终与树同步。展开的目录树是 git
中存储的唯一事实源；`.sb3` 被 gitignore 并自动重新生成。

English | **[English](README.md)**

## 包

本仓库是一个包含两个包的小型 monorepo：

| 包 | 角色 | README |
|---|---|---|
| [`scratch-git/`](./scratch-git) | vanilla Scratch 工作流：CLI（`git palette`）、git hook、`.sb3` ↔ 树转换、合并冲突处理。拥有面向用户的接口。 | [README](./scratch-git/README.md) |
| [`extension-git/`](./extension-git) | 扩展发现、解析与注册（自定义 + 内置 TurboWarp 扩展）。作为 `scratch-git` 的依赖被拥有。 | [README](./extension-git/README.md) |

外部依赖（两个包都消费，但不在本仓库内）：

- [`parse-sb3-blocks`](https://github.com/palette-community/parse-sb3-blocks) — I/O-free
  的 scratchblocks 解析器 / 序列化器。`scratch-git` 必须针对其源码树开发（见
  `scratch-git/README.md` 的 *开发*）。
- [`scratch-sandbox`](https://github.com/palette-community/scratch-sandbox) — 用于在受限
  CommonJS shim 中安全执行自定义扩展 `getInfo()` 源码。
- `extensions/turbowarp/`（git 子模块）— TurboWarp [`scratch-vm`](https://github.com/TurboWarp/scratch-vm)
  的 sparse checkout，用于规范的内置扩展块元数据（`pen`、`music`……）。

## 你得到什么

```
┌─────────────────────────────────┐
│  外部编辑器（TurboWarp）         │
│  MyProject.sb3  ←→  MyProject.sb3│
└────────────────┬────────────────┘
                 │ git palette commit / editor-sync
┌────────────────▼────────────────┐
│  scratch-git  ──依赖──►          │
│  （CLI、hook、.sb3↔树）    extension-git     │
│                    （resolve / register）   │
└────────────────┬────────────────┘
                 │
┌────────────────▼────────────────┐
│  git 中展开的目录树              │
│  .palette/  roles/  .scratchdeps │
└─────────────────────────────────┘
```

一个典型回合：

1. 在编辑器里：`Export` → `MyProject.sb3`。
2. `git palette commit MyProject.sb3 -m "import v1"` —— pre-commit hook 把 `.sb3` 解包为
   `.palette/` + `roles/`，移除暂存的 `.sb3`，commit 整个树。
3. 协作：审阅 scratchblocks 文本（`.sb` 文件）和 JSON（`project.json`）的 diff，合并，解决冲突。
4. `git checkout` / `git merge` —— post-checkout / post-merge hook 从树重新生成
   `MyProject.sb3`（未解决冲突时跳过）。
5. 在编辑器里重新打开 `MyProject.sb3`。循环。

## 往返保真度

展开 ↔ 重新打包的循环对任何 Scratch / TurboWarp 能打开的项目都是**功能等价的**。对大多数
项目（vanilla 块、自定义块、内置扩展、源码可达的自定义扩展），它在 blocks-JSON 层面也是
**byte-identical**。完整表格见
[`scratch-git/README.md`](./scratch-git#往返保真度)。

`scratch-git` 里的安全护栏保证重新打包**绝不会生成坏 `.sb3`**：如果丢块过多（例如某扩展
你忘了把源码打包进来），repack 会回退为仅结构重建（生成新 id）并打印警告。

## 安装 / 使用

一次性安装 CLI：

```sh
npm install github:palette-community/scratch-toolchain#packages/scratch-git
```

然后，在 Scratch / TurboWarp 项目仓库里：

```sh
git palette init MyProject
git palette install
git palette commit MyProject.sb3 -m "import v1"
```

完整命令列表、布局和工作流见 [`scratch-git/README.md`](./scratch-git)。

## 布局

```
scratch-toolchain/
├── README.md                 # 本文件
├── scratch-git/              # vanilla 工作流包（CLI、hook、解析器粘合）
├── extension-git/            # 扩展发现/注册包
├── extensions/turbowarp/     # git 子模块：sparse 的 TurboWarp scratch-vm 扩展
└── test_sb3/                 # 本地测试 fixture（不属于任何包）
```

## 开发

每个包都有自己的 `npm test` 和 `README`。典型设置：

```sh
# scratch-git：针对实时 parse-sb3-blocks 源码开发
cd scratch-git
rm -rf node_modules/parse-sb3-blocks
ln -s ../../parse-sb3-blocks node_modules/parse-sb3-blocks   # 按需调整路径
npm install --no-audit --no-fund
npm test
```

`npm install` 会把软链替换为已发布的 tarball；每次 install 后需重新创建软链。
`extension-git` 对其 `parse-sb3-blocks` 和 `scratch-sandbox` 软链使用同样模式（作为传递依赖，
通过 workspace `scratch-git` 引用）。

## 许可证

MPL-2.0.
