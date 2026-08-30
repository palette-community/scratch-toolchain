# parse-sb3-blocks 上游提案说明

> 关于是否把本仓库在 `parse-sb3-blocks` 上做的几处修改向上游
> (`palette-community/parse-sb3-blocks`) 提案，整理在本文。

## 决定

**不向上游提案；保留本地 patch。** 理由见末尾。

## 本仓库对上游的修改

### 1. `parseInsertedBlock` 识别 `procedures_call`（commit `cdd90ab`）

**动机**：自定义块调用被插入到 vanilla 块输入时（如
`motion_gotoxy` X/Y、`operator_add` NUM1），原实现退化为
`[unknown opcode: procedures_call]` StringInput，前向文本中渲染为空。

**改动**（`src/parser/parse.js`）：

```js
if (opcode === 'procedures_call') {
    const proc = (block.mutation && Sanitizer.labelSanitize(block.mutation.proccode)) || '???';
    return new ProcedureCall(blockId, proc, getProcCallArgs(block, blocks));
}
```

**上游 PR 草案**：上述 4 行 patch。

### 2. 输入位置 `::custom` 识别（commit `21474d1`）

**动机**：`(proc::custom)` 出现在算术表达式内（`(- (proc::custom) 1)`）
时，scratchblocks 文法把 `::custom` 当 statement 标记，line-level 之后
无处吸收 → 逆向解析报 Unknown，cascade 整个 target 触发安全护栏。

**改动**（`src/parser/from-scratchblocks.js` 两处）：

```js
// tokenizeLine: 闭括号后吸收 `::custom` 到 expr token
const customMatch = /^::\s*custom\b/.exec(line.slice(j));
if (customMatch) {
    tokens[tokens.length - 1].isCustom = true;
    j += customMatch[0].length;
}

// parseExpr: 识别 isCustom 后用 parseProcCall 构造 ProcedureCall
if (token.isCustom) {
    const m = /^[(<\[]([\s\S]*)[)\]>]$/.exec(token.value);
    const inner = m ? m[1] : token.value;
    const { proc, args } = this.parseProcCall(inner);
    return new ProcedureCall(null, proc, args);
}
```

**配套**（`src/block-type/block.js`）：

```js
// blockSyntax: procedures_call 输入最小包裹
if (rendered && /(?:^|[^\\])::\s*custom\s*$/.test(rendered) && !/^[(<\[]/.test(rendered)) {
    return `(${rendered})`;
}
```

**上游 PR 草案**：
- `tokenizeLine` + `parseExpr` 的 12 行 patch
- `Block.blockSyntax` 的 4 行 patch
- 合计约 16 行；需要 (a) 解释动机 (b) 加 fixture `custom-in-input.json`
  + snapshot (c) 说明 `blockSyntax` 的 wrap 不影响 vanilla 文本

### 3. hat 检测（`event_when*`）（commit `07bf4db`）

**动机**：`opcode.startsWith('event_')` 把 `event_broadcast` 误判为
hat，导致 `when stage clicked\nbroadcast [_click v]` 被拆成两个脚本。

**改动**：

```js
const isHat = info.isHat || (conn.opcode && /^event_when/.test(conn.opcode));
```

**上游 PR 草案**：1 行 patch。

### 4. `argument_reporter` 不带 `'custom'` 分类（commit `07bf4db`）

**动机**：把 `argument_reporter` 构造成 `Variable(name, 'custom', REPORTER)`
导致 forward 渲染 `(name::custom)`，reverse 误识别为 `procedures_call`。

**改动**：分类从 `'custom'` 改为 `null`。

**上游 PR 草案**：1 行 patch。

### 5. `commentProc` 缺 unescape（commit `07bf4db`）

**动机**：`// [arg]::custom` 分支把 regex 捕获直接 `new StringInput(...)`，
`StringInput` 又 sanitize 一次 → `\` 双转义。

**改动**：

```js
new StringInput(unescape(commentProc[1]))
```

**上游 PR 草案**：1 行 patch + 1 行新增 `unescape` import（文件内已有
`unescape` 函数，可直接引用）。

## 汇总：上游 PR 建议

按优先级排：

1. **#4 + #5 + #3**：三处一行 patch，独立无依赖，合计 4 行。可合并为一个 PR。
2. **#1**：4 行 patch，独立。中优先级。
3. **#2**：12 + 4 = 16 行 patch，**需要先在本地与上游 main 同步后再提**（涉及
   `tokenizeLine` 内部结构，若上游版本不同需要调整）。低优先级。

## 决定的理由（不向上游）

- **维护成本 vs 收益不匹配**：本仓库是 git-palette 工具链的下游；上游
  parse-sb3-blocks 主要面向 scratchblocks-editor 用户。我们的 fix 针对
  round-trip 字节一致场景，对编辑器用例影响有限。
- **本地 patch 已加注释 + 文档**：未来若需要向上游迁移，本文 + 上述
  patch 草案即可作为 PR 模板，无需重做调研。
- **上游项目活跃度**：`palette-community/parse-sb3-blocks` 是内部
  fork（实际是 `@turbowarp/scratch-parser` 的变种？），review 周期长，
  收益低。
- **可回滚性**：本地 patch 是条件性逻辑（`isCustom` 标志、`^event_when`
  正则），不影响 vanilla 路径；如需放弃可直接 `git revert`。

## 触发上游评估的条件

若以下任一为真，重新评估上游化：

- 其他工具（编辑器、CI、第三方 git 工具）也遇到输入位置 `::custom`
  误识别问题
- 上游接受类似 patch 并形成社区共识
- 我们放弃维护 git-palette（那上游化无意义）
