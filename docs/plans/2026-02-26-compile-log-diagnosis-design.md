# 编译诊断机制设计

## 问题

specchecker 在分析过程中会产生编译错误日志（`{projectPath}/log/compile.log`），当前工具和智能体完全忽略了这个文件。编译错误可能反映三类问题：编译配置选择错误、源代码严重缺陷、缺少依赖文件。需要在静态分析流程中加入编译诊断环节。

## 设计

### 工具层（misra-checker.ts）

`executeCheck()` 在 analyze 步骤完成后，读取 `{projectPath}/log/compile.log`，将内容作为返回值的 `compile_log` 字段返回给智能体。工具只负责读取，不做分类判断。

### 智能体 prompt（static-analyzer.ts）

在 Step 1（运行 specchecker check）之后新增 **Step 1.5：编译诊断**：

1. 检查返回值中的 `compile_log`，如果为空或无错误 → 跳过
2. 有错误时，先读取 `.matrix/data/software-analysis.json` 获取 compiler_dialect、target_cpu 等上下文
3. **对编译错误做去重归因**，识别根因错误（root cause），忽略级联错误，只对根因分类和应对
4. **优先综合判断是否为编译配置错误**：
   - 判据：大量错误、基础类型/标准头文件未识别、平台特征与当前配置不匹配
   - 参考 software-analysis.json 选择新配置；如无该文件 → 上报编排层请求 Analyst 协助
   - 换配置后重新调用 `specchecker(mode="check")`，最多重试 3 次
5. **排除配置错误后**：
   - 缺少项目特有头文件 → 上报编排层请求 Analyst 补充 stubs/include
   - 明确的源代码问题 → 记录到 defects.json（source: `static_analysis`，用现有最接近的 category）

### 编译错误级联去重原则

分析 compile.log 时，必须先识别根因错误，忽略由根因引发的级联错误，避免冗余工作量和错误判断。典型级联模式：

- **头文件缺失** → 大量 undefined type / undefined identifier
- **类型定义错误** → 后续使用该类型的语句全部报错
- **宏定义缺失** → 依赖该宏的条件编译分支全部失败
- **关键语法符号缺失**（`{`、`(`、`;` 等） → 后续大量 unexpected token / parse error

### 技能层（skills/static-analysis/SKILL.md）

新增"编译诊断"章节，固化决策树、判据、级联去重原则、应对措施。

### 变更范围

| 文件 | 变更 |
|------|------|
| `src/tools/misra-checker.ts` | `executeCheck()` 读取 compile.log 加入返回值 |
| `src/agents/static-analyzer.ts` | prompt 新增 Step 1.5 编译诊断 |
| `skills/static-analysis/SKILL.md` | 新增编译诊断章节 |

Schema 不变、SA-Reviewer 不变。
