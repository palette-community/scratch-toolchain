// 严格保真校验：project.json 每个 target 的"应渲染语句块"集合，是否与实际 .sb
// 文本里的语句行一一对应。
//
// 设计：
//   parse.js 的遍历规则是权威的"应渲染集合"。我们复制它：
//     - 从 top-level 块出发；
//     - 语句位置（next 链 / SUBSTACK* 分支）的块各占 .sb 里一行；
//     - 非 SUBSTACK 输入里的块（插入式 reporter/boolean）是内联的，不单独成行；
//     - 语句位置的 unknown opcode 被 parse.js 丢弃（不渲染）；
//     - procedures_definition → `define` 行 + 其 next 体；custom_block(prototype) 不单独成块；
//     - procedures_prototype 永不渲染；procedures_call 渲染并遍历其参数输入。
//   文本侧：统计"语句行" = 非空行，排除 `end` / `else` / 纯注释行（`define` 算 1 行）。
//   两边数量应相等（= 无块丢失、无 C/E 肚子被掏空）。
//   另加：自定义积木 `define` 后必须紧跟缩进体（检测脱钩）。
//
// 用法: node scripts/verify-fidelity.mjs <a.sb3> [b.sb3] ...

import { readSb3 } from '../src/sb3.js';
import { resolveExtensions } from '../src/extresolve.js';
import { projectToSnippets, allBlocks } from 'parse-sb3-blocks';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

function computeExpectedStatements(target) {
  const blocks = target.blocks || {};
  const visited = new Set();
  let stmtCount = 0;
  const stmtOps = new Map();
  const addStmt = (op) => {
    stmtCount++;
    stmtOps.set(op, (stmtOps.get(op) || 0) + 1);
  };
  const isUnknown = (op) => !allBlocks[op];

  const walk = (id, asStmt) => {
    const b = blocks[id];
    if (!b || visited.has(id)) return;
    visited.add(id);
    const op = b.opcode;

    if (op === 'procedures_prototype') return; // 永不单独渲染

    if (op === 'procedures_definition') {
      if (asStmt) addStmt('procedures_definition'); // 仅当是语句（内联的自定义块不单独成行）
      if (b.next) walk(b.next, true);
      for (const k of Object.keys(b.inputs || {})) {
        if (k === 'custom_block') continue; // prototype 不单独成块
        const v = b.inputs[k][1];
        if (typeof v === 'string') walk(v, false);
      }
      return;
    }
    if (op === 'procedures_call') {
      if (asStmt) addStmt('procedures_call'); // 内联调用不成行
      if (b.next) walk(b.next, true);
      for (const k of Object.keys(b.inputs || {})) {
        const v = b.inputs[k][1];
        if (typeof v === 'string') walk(v, false);
      }
      return;
    }

    const unknown = isUnknown(op);
    if (asStmt) {
      if (unknown) {
        // 渲染器现在：占位符行 + 保留 next 链与 SUBSTACK 体
        addStmt(op);
        if (b.next) walk(b.next, true);
        for (const k of Object.keys(b.inputs || {})) {
          const v = b.inputs[k][1];
          if (typeof v !== 'string') continue;
          if (k.startsWith('SUBSTACK')) walk(v, true);
        }
        return;
      }
      addStmt(op);
      if (b.next) walk(b.next, true);
      for (const k of Object.keys(b.inputs || {})) {
        const v = b.inputs[k][1];
        if (typeof v !== 'string') continue;
        if (k.startsWith('SUBSTACK')) walk(v, true);
        else walk(v, false);
      }
    } else {
      // 插入式块（reporter/boolean）内联在父行里，不单独成行 → 不计语句。
      // 仍遍历其输入：SUBSTACK 分支里的块是语句，其他输入继续内联。
      if (b.next) walk(b.next, false);
      for (const k of Object.keys(b.inputs || {})) {
        const v = b.inputs[k][1];
        if (typeof v !== 'string') continue;
        if (k.startsWith('SUBSTACK')) walk(v, true);
        else walk(v, false);
      }
    }
  };

  for (const id of Object.keys(blocks)) {
    if (blocks[id].topLevel) walk(id, true);
  }
  return { stmtCount, stmtOps };
}

function countStatementLines(text) {
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'end' || line === 'else') continue;
    if (line.startsWith('//')) continue;
    n++;
  }
  return n;
}

function checkDetachment(text) {
  // 返回脱钩的 define 行号列表（define 后紧跟非缩进行 = 体不在 define 下）
  const lines = text.split('\n');
  const detached = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!/^define\b/.test(t)) continue;
    const defIndent = lines[i].length - lines[i].trimStart().length;
    // 找下一条非空行
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length) continue; // 文件结束且体为空 → 非缺陷
    const bodyLine = lines[j];
    const bodyIndent = bodyLine.length - bodyLine.trimStart().length;
    // 空体自定义块：define 后紧跟的是另一个 define（或文件结束）→ 无体可挂，不算缺陷
    if (/^define\b/.test(bodyLine.trim())) continue;
    if (bodyIndent <= defIndent) detached.push(i + 1); // 体未缩进且非 define → 脱钩
  }
  return detached;
}

async function verifyFile(file) {
  const { json } = await readSb3(file);
  const paletteDir = path.join(os.tmpdir(), `gp-fidelity-${process.pid}`);
  mkdirSync(paletteDir, { recursive: true });
  await resolveExtensions(structuredClone(json), { paletteDir });

  const results = [];
  let idx = 0;
  for (const target of json.targets || []) {
    const name = target.name || `target${idx}`;
    idx++;
    const expected = computeExpectedStatements(target);
    const { targets } = await projectToSnippets(structuredClone({ targets: [target] }), { locale: 'en' });
    const snippet = targets[name] || targets[`target${idx - 1}`];
    const text = [...(snippet?.scripts ?? []), ...(snippet?.orphans ?? [])].join('\n\n');
    const actualLines = countStatementLines(text);
    const detached = checkDetachment(text);
    const delta = actualLines - expected.stmtCount;
    results.push({
      name,
      isStage: !!target.isStage,
      expected: expected.stmtCount,
      actual: actualLines,
      delta,
      detached,
    });
  }
  return { file, results };
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node scripts/verify-fidelity.mjs <a.sb3> ...');
    process.exit(2);
  }
  let bad = 0;
  for (const file of files) {
    const { results } = await verifyFile(file);
    console.log(`\n===== ${file} =====`);
    for (const r of results) {
      const ok = r.delta === 0 && r.detached.length === 0;
      const tags = [];
      if (r.delta !== 0) tags.push(`块数差 Δ${r.delta}`);
      if (r.detached.length) tags.push(`define脱钩@行${r.detached.join(',')}`);
      console.log(
        `  [${ok ? 'OK' : 'MISMATCH'}] ${r.name}${r.isStage ? ' (stage)' : ''}  应渲染语句=${r.expected} 文本语句=${r.actual}` +
          (tags.length ? `  <- ${tags.join('; ')}` : ''),
      );
      if (!ok) bad++;
    }
  }
  console.log(`\n汇总: ${bad === 0 ? '全部匹配 ✓' : `${bad} 个 target 不匹配 ✗`}`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
