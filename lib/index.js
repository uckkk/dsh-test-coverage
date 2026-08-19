// dsh-test-coverage — 确定性覆盖率报告分析插件（DeepSeek Harness）。
// 解析 LCOV / Cobertura / Istanbul-JSON / Go cover.out，产出结构化、可被模型直接使用的覆盖率数据。
// 无 shell、无网络、无外部服务依赖。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

const name = "测试覆盖率分析";
const inject = ["tools"];

const MAX_FILES = 300;
const MAX_WORST = 20;
const MAX_GAP_RANGES = 400;

// ── 归一化 ──────────────────────────────────────────────────────────────
// 所有解析器统一返回 { files: [{ file, hits: Map<行号, 命中次数> }] }。

function parseLcov(text) {
  const files = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      cur = { file: line.slice(3), hits: new Map() };
      files.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith("DA:")) {
      const body = line.slice(3);
      const comma = body.indexOf(",");
      if (comma === -1) continue;
      const ln = Number(body.slice(0, comma));
      const hits = Number(body.slice(comma + 1));
      if (Number.isInteger(ln) && ln > 0) cur.hits.set(ln, hits);
    } else if (line === "end_of_record") {
      cur = null;
    }
  }
  return { files };
}

function parseGoCover(text) {
  // go tool cover -func 输出：文件:起始行.列,结束行.列 语句数 命中次数
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("mode:")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const loc = parts[0];
    const count = Number(parts[parts.length - 1]);
    const colon = loc.lastIndexOf(":");
    if (colon === -1) continue;
    const file = loc.slice(0, colon);
    const range = loc.slice(colon + 1);
    const startLine = Number(range.split(",")[0].split(".")[0]);
    if (!Number.isInteger(startLine) || startLine <= 0) continue;
    let byLine = map.get(file);
    if (!byLine) { byLine = new Map(); map.set(file, byLine); }
    let counts = byLine.get(startLine);
    if (!counts) { counts = new Set(); byLine.set(startLine, counts); }
    counts.add(count);
  }
  const files = [];
  for (const [file, byLine] of map) {
    const hits = new Map();
    for (const [ln, counts] of byLine) {
      let covered = false;
      for (const c of counts) if (c > 0) { covered = true; break; }
      hits.set(ln, covered ? 1 : 0);
    }
    files.push({ file, hits });
  }
  return { files };
}

function parseIstanbul(obj) {
  const files = [];
  for (const [file, rec] of Object.entries(obj)) {
    const statementMap = rec.statementMap || {};
    const counts = rec.s || {};
    const lineCount = new Map();
    for (const [sidRaw, span] of Object.entries(statementMap)) {
      const line = span?.start?.line;
      if (!Number.isInteger(line) || line <= 0) continue;
      const c = Number(counts[sidRaw]) || 0;
      const prev = lineCount.get(line) || 0;
      lineCount.set(line, Math.max(prev, c));
    }
    const hits = new Map();
    for (const [ln, c] of lineCount) hits.set(ln, c > 0 ? 1 : 0);
    if (hits.size === 0) continue;
    files.push({ file, hits });
  }
  return { files };
}

function parseCobertura(text) {
  const files = [];
  const classRe = /<class\b[^>]*filename="([^"]*)"[^>]*>([\s\S]*?)<\/class>/g;
  let m;
  while ((m = classRe.exec(text))) {
    const file = m[1];
    const body = m[2];
    const hits = new Map();
    const lineRe = /<line\b[^>]*\bnumber="(\d+)"[^>]*\bhits="(\d+)"/g;
    let lm;
    while ((lm = lineRe.exec(body))) {
      const ln = Number(lm[1]);
      const h = Number(lm[2]);
      if (Number.isInteger(ln) && ln > 0) hits.set(ln, h);
    }
    if (hits.size === 0) continue;
    files.push({ file, hits });
  }
  return { files };
}

const FORMAT_DETECT = [
  ["cobertura", /cobertura|coverage\.xml$/i],
  ["json", /coverage-final\.json|\.json$/i],
  ["go", /cover\.out$/i],
  ["lcov", /lcov|\.info$/i],
];

async function statSafe(p) {
  try { return await stat(p); } catch { return null; }
}

async function discoverCoverageFile(path) {
  const s = await statSafe(path);
  if (!s) return null;
  if (s.isFile()) return path;
  if (!s.isDirectory()) return null;
  const names = [
    "lcov.info", "coverage.lcov", "coverage-final.json",
    "coverage.xml", "cobertura.xml", "cover.out",
  ];
  for (const n of names) {
    const p = join(path, n);
    if (await statSafe(p)) return p;
  }
  const entries = await readdir(path).catch(() => []);
  for (const e of entries) {
    const p = join(path, e);
    const es = await statSafe(p);
    if (es?.isFile() && /lcov|coverage|cover\.out/i.test(basename(e))) return p;
  }
  return null;
}

function detectFormat(path, hint) {
  if (hint && hint !== "auto") return hint;
  for (const [fmt, re] of FORMAT_DETECT) {
    if (re.test(path)) return fmt;
  }
  return "lcov";
}

async function loadCoverage(path, formatHint) {
  const file = await discoverCoverageFile(path);
  if (!file) throw new Error(`在 ${JSON.stringify(path)} 中未找到覆盖率报告文件`);
  const fmt = detectFormat(file, formatHint);
  const text = await readFile(file, "utf8");
  if (fmt === "json") {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error(`覆盖率 JSON 解析失败：${e.message}`); }
    return { format: fmt, ...parseIstanbul(obj) };
  }
  if (fmt === "cobertura") return { format: fmt, ...parseCobertura(text) };
  if (fmt === "go") return { format: fmt, ...parseGoCover(text) };
  return { format: fmt, ...parseLcov(text) };
}

function summarize(files) {
  let coveredLines = 0, totalLines = 0;
  const outFiles = [];
  for (const f of files) {
    let covered = 0, total = 0;
    const uncovered = [];
    for (const [ln, h] of f.hits) {
      total += 1;
      if (h > 0) covered += 1; else uncovered.push(ln);
    }
    coveredLines += covered; totalLines += total;
    outFiles.push({
      file: f.file,
      linePercent: total === 0 ? 0 : Math.round((covered / total) * 1000) / 10,
      coveredLines: covered,
      totalLines: total,
      uncoveredLineCount: uncovered.length,
      _uncovered: uncovered,
    });
  }
  outFiles.sort((a, b) => a.linePercent - b.linePercent || b.uncoveredLineCount - a.uncoveredLineCount);
  return { coveredLines, totalLines, files: outFiles };
}

function ranges(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out = [];
  let start = null, end = null;
  for (const ln of sorted) {
    if (start === null) { start = end = ln; }
    else if (ln === end + 1) { end = ln; }
    else { out.push({ start, end }); start = end = ln; }
  }
  if (start !== null) out.push({ start, end });
  return out;
}

async function apply(ctx, _config) {
  ctx.tools.register(defineTool({
    name: "coverage_report",
    description:
      "把代码覆盖率报告文件（LCOV `.lcov`/`lcov.info`、Cobertura `coverage.xml`、Istanbul/Vitest/Jest 的 `coverage-final.json`、或 Go 的 `cover.out`）解析成结构化摘要：总体行覆盖率 + 按「覆盖最低 → 最高」排序的逐文件表，让模型立刻知道哪些文件最缺测试。请在运行带覆盖率的测试套件后调用。传入报告文件路径，或传入目录自动发现报告。`format` 一般无需指定，`auto` 会自动识别。",
    parameters: {
      path: {
        type: "string",
        description: "覆盖率报告文件的路径，或包含该文件的目录（自动发现）。默认使用当前工作目录。",
      },
      format: {
        type: "string",
        enum: ["auto", "lcov", "cobertura", "json", "go"],
        description: "报告格式。保持 `auto` 即可按文件名自动识别。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", required: true },
          format: { type: "string", required: true },
          totals: {
            type: "object", additionalProperties: false, required: true,
            properties: {
              files: { type: "integer", required: true },
              coveredLines: { type: "integer", required: true },
              totalLines: { type: "integer", required: true },
              linePercent: { type: "number", required: true },
            },
          },
          files: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                file: { type: "string", required: true },
                linePercent: { type: "number", required: true },
                coveredLines: { type: "integer", required: true },
                totalLines: { type: "integer", required: true },
                uncoveredLineCount: { type: "integer", required: true },
              },
            },
          },
          worstFiles: { type: "array", required: true, items: { type: "string" } },
        },
      },
      render: (_args, value) => {
        const t = value.totals;
        const lines = [
          `覆盖率报告（${value.format}，${value.source}）`,
          `总体：${t.coveredLines}/${t.totalLines} 行（${t.linePercent}%），共 ${t.files} 个文件。`,
          `覆盖率最低的文件：`,
          ...value.worstFiles.map((f) => `  - ${f}`),
        ];
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    execute: async (args, exec) => {
      const path = args.path || exec.agent?.session?.cwd || process.cwd();
      const { format, files } = await loadCoverage(path, args.format);
      const sum = summarize(files);
      const worst = sum.files.slice(0, MAX_WORST).map((f) => f.file);
      return {
        source: path,
        format,
        totals: {
          files: sum.files.length,
          coveredLines: sum.coveredLines,
          totalLines: sum.totalLines,
          linePercent: sum.totalLines === 0 ? 0 : Math.round((sum.coveredLines / sum.totalLines) * 1000) / 10,
        },
        files: sum.files.slice(0, MAX_FILES).map((f) => ({
          file: f.file,
          linePercent: f.linePercent,
          coveredLines: f.coveredLines,
          totalLines: f.totalLines,
          uncoveredLineCount: f.uncoveredLineCount,
        })),
        worstFiles: worst,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "coverage_gaps",
    description:
      "从覆盖率报告（LCOV / Cobertura / Istanbul JSON / Go cover.out）中，返回指定文件「确切未覆盖的行区间」。`file` 参数是一个子串，只要能和报告中某个源文件路径匹配即可（用文件名即可，在唯一时）。用它看清到底哪些行还没被测试覆盖，然后针对这些区间补写测试。",
    parameters: {
      file: {
        type: "string",
        required: true,
        description: "能匹配报告中源文件路径的子串（文件名通常即可，需唯一）。",
      },
      path: {
        type: "string",
        description: "覆盖率报告文件或目录。默认使用当前工作目录。",
      },
      format: {
        type: "string",
        enum: ["auto", "lcov", "cobertura", "json", "go"],
        description: "报告格式。保持 `auto` 即可。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string", required: true },
          uncoveredLineCount: { type: "integer", required: true },
          uncoveredRanges: {
            type: "array", required: true,
            items: {
              type: "object", additionalProperties: false,
              properties: {
                start: { type: "integer", required: true },
                end: { type: "integer", required: true },
              },
            },
          },
          uncoveredLines: { type: "array", required: true, items: { type: "integer" } },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `${value.file}：${value.uncoveredLineCount} 行未覆盖，共 ${value.uncoveredRanges.length} 个区间。\n区间：${value.uncoveredRanges.map((r) => (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`)).join(", ")}`,
      }],
    },
    execute: async (args, exec) => {
      const path = args.path || exec.agent?.session?.cwd || process.cwd();
      const { files } = await loadCoverage(path, args.format);
      const matches = files.filter((f) => f.file.includes(args.file));
      if (matches.length === 0) throw new Error(`没有文件能匹配 ${JSON.stringify(args.file)}`);
      if (matches.length > 1) {
        const exact = matches.filter((f) => basename(f.file) === args.file || f.file.endsWith(args.file));
        if (exact.length === 1) { matches.length = 0; matches.push(exact[0]); }
        else throw new Error(`${JSON.stringify(args.file)} 匹配到多个文件，请更精确：${matches.slice(0, 10).map((f) => f.file).join(", ")}`);
      }
      const f = matches[0];
      const uncovered = [];
      for (const [ln, h] of f.hits) if (h <= 0) uncovered.push(ln);
      const rs = ranges(uncovered);
      return {
        file: f.file,
        uncoveredLineCount: uncovered.length,
        uncoveredRanges: rs.slice(0, MAX_GAP_RANGES),
        uncoveredLines: uncovered.slice(0, 1000),
      };
    },
  }));
}

export { apply, inject, name };
