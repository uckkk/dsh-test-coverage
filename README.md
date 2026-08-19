# dsh-test-coverage · 测试覆盖率分析

解析代码覆盖率报告，产出**结构化、可直接指导补测试**的覆盖数据。支持 LCOV（`.lcov` / `lcov.info`）、Cobertura（`coverage.xml`）、Istanbul / Vitest / Jest（`coverage-final.json`）、Go（`cover.out`）。纯 Node 实现，无 shell、无网络、无外部服务。

## 为什么需要它

Agent 跑完带覆盖率的测试后，覆盖率报告往往又大又乱。本插件把报告解析成：

- 总体行覆盖率 + 逐文件覆盖率表（按「覆盖最低 → 最高」排序）；
- 最该补测试的文件列表；
- 指定文件**确切的未覆盖行区间**，直接针对这些行补测试。

## 安装

```bash
dsh plugin add dsh-test-coverage
```

安装后在 profile 的 `package.json` 的 `dsh.profile.bundles` 中加入 `"dsh-test-coverage"`（或用你使用的插件市场一键安装）。

## 提供的工具

| 工具 | 作用 |
|---|---|
| `coverage_report` | 解析报告，返回总体覆盖率 + 逐文件表 + 覆盖最低文件 |
| `coverage_gaps` | 返回指定文件确切的未覆盖行区间 |

## 用法示例

```
帮我看看这个项目的测试覆盖率
→ 调用 coverage_report(path="/workspace/coverage/lcov.info")

哪些行还没测到？
→ 调用 coverage_gaps(file="src/parser.js", path="/workspace/coverage")
```

## 说明

- 本插件只做「解析与分析」，运行测试并产出覆盖率请用项目自带的测试命令（或配合其它测试插件）。
- 大报告会自动截断（文件表最多 300 项、区间最多 400 段），避免占用过多上下文。

## 安装

```bash
dsh plugin add github:uckkk/dsh-test-coverage
```

> 安装即在本机运行第三方代码，请自行审阅源码。

## 安装

```bash
dsh plugin add github:uckkk/dsh-test-coverage
```

## 使用

安装后在会话中调用该插件注册的工具即可。

## 许可

MIT

> 安装即在本机运行第三方代码，请自行审阅源码。

## 安装

```bash
dsh plugin add github:uckkk/dsh-test-coverage
```

## 使用

安装后在会话中调用该插件注册的工具即可。
