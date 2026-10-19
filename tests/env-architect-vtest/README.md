# EnvArchitect 智能体测试用例 — VTest 仿真平台

## 测试目标

验证 `env-architect` 智能体（Phase 5: 仿真环境设计）能够针对 **VTest 目标机仿真器** 正确完成以下任务：

1. 从 `software-analysis.json` 读取接口规格和数据流图
2. 为每个硬件接口设计 VTest 虚拟外设 DLL 仿真模型
3. 生成 VTE 项目配置文件（引脚连接、内存映射、设备属性）
4. 生成 VTest 测试脚本（时间序列激励注入 + 响应采集）
5. 设计基线测试用例并验证环境可用性
6. 输出 `env-design.json` 符合 `TestEnvironmentDesign` Schema

## 被测系统

**卫星电源控制单元 (PCU)** — ARM Cortex-M4 (STM32F407)

| 接口 | 类型 | VTest 仿真方式 |
|------|------|---------------|
| IF-001: ADC 6 通道 | 硬件 | `vdev_adc.dll` — VPort 数据注入 → Pin 连接 ADC 寄存器 |
| IF-002: PWM 2 路 | 硬件 | `vdev_pwm_capture.dll` — 内存监视 TIM CCR/ARR 寄存器 |
| IF-003: UART 遥测遥控 | 外部 | `vdev_uart.dll` — VPort 帧注入/捕获 ↔ USART1_DR |
| IF-004: GPIO 5出2入 | 硬件 | `vdev_gpio.dll` — Pin 连接 GPIO 端口，事件记录 |

## 目录结构

```
tests/env-architect-vtest/
├── README.md                              ← 本文件
├── requirements.md                        # 被测软件需求文档 (中文)
├── src/
│   ├── pcu_main.c                         # PCU 主程序
│   └── pcu_hal.h                          # 硬件抽象层定义
├── .matrix/
│   ├── config/matrix.jsonc                # Matrix 插件配置
│   └── data/
│       └── software-analysis.json         # Phase 1 输出 (EnvArchitect 输入)
└── expected/                              # ========== 预期输出 ==========
    ├── env-design.json                    # 预期 env-design.json (TestEnvironmentDesign Schema)
    └── vtest/
        ├── pcu_sim.vte                    # 预期 VTE 项目文件
        ├── vdev_adc.c                     # 预期 ADC 虚拟设备 DLL 源码
        ├── vdev_uart.c                    # 预期 UART 虚拟设备 DLL 源码
        ├── vdev_gpio.c                    # 预期 GPIO 虚拟设备 DLL 源码
        └── test_scripts/
            ├── nominal_test.txt           # 标称工况测试脚本
            ├── overvoltage_test.txt       # 过压保护测试脚本
            └── undervoltage_test.txt      # 欠压保护 (负载卸载) 测试脚本
```

## 执行方法

### 方式 1: 直接测试 EnvArchitect 工具调用 (最快)

```bash
cd /c/claude/matrix-embedded-agent
bun -e '
import { testEnvCtrl } from "./src/tools/test-env-ctrl.ts"
const result = await testEnvCtrl.execute({
  action: "configure",
  config: {
    platform: "vtest",
    project_file: "tests/env-architect-vtest/expected/vtest/pcu_sim.vte"
  }
})
console.log(result)
'
```

### 方式 2: 端到端运行 EnvArchitect 智能体

```bash
# 1. 构建插件
bun run build

# 2. ���测试项目中创建 opencode.json
cat > tests/env-architect-vtest/opencode.json << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///c/claude/matrix-embedded-agent/dist/index.js"]
}
EOF

# 3. 运行 (需禁用 phase-gate 以跳过阶段依赖)
cd tests/env-architect-vtest
opencode run --command matrix-start "请为 PCU 项目设计 VTest 仿真测试环境" \
  --print-logs --log-level INFO
```

### 方式 3: 手动模拟 EnvArchitect 7 步工作流

按下文「验证步骤」逐步检查。

---

## 验证步骤 — EnvArchitect 7 步工作流映射

### Step 1: 收集接口规格

**输入**: `.matrix/data/software-analysis.json`

**验证点**:
- [ ] 智能体读取了 `interfaces` 数组 (4 个接口)
- [ ] 智能体识别了 `data_flow_graph` 中的 14 条边（数据通路）
- [ ] 智能体提取了 `interrupt_table` (3 个中断向量)
- [ ] 智能体解析了 `runtime_environment` (裸机, 168MHz, STM32F407 外设)

**通过标准**: 智能体输出的接口分析报告包含所有 4 个接口 (ADC/PWM/UART/GPIO)，并正确识别数据方向。

### Step 2: 设计仿真模型

**预期输出**: 为每个接口设计 VTest 虚拟外设 DLL

| 接口 | 预期仿真模型 | 验证点 |
|------|-------------|--------|
| IF-001 ADC | `vdev_adc.dll` | VPort 输入 6×uint16_t，Pin 输出 6 通道 + DMA 中断 |
| IF-002 PWM | `vdev_pwm_capture.dll` | 监视 TIM1_CCR1/ARR + TIM2_CCR1/ARR 内存地址 |
| IF-003 UART | `vdev_uart.dll` | TX 捕获 + RX 注入，按波特率时序模拟 |
| IF-004 GPIO | `vdev_gpio.dll` | 5 路输出 Pin 监控 + 2 路输入 Pin 注入 |

**通过标准**:
- [ ] 生成了 ≥ 4 个虚拟设备仿真模型描述
- [ ] 每个模型包含 VPort 定义和 Pin 连接说明
- [ ] ADC 模型支持数据注入和 DMA 中断触发
- [ ] UART 模型支持双向帧收发
- [ ] GPIO 模型支持输出事件记录

### Step 3: 设计测试环境架构

**预期输出**: `env-design.json` 符合 `TestEnvironmentDesign` Schema

**验证点**:
- [ ] `platforms` 包含 VTest 平台定义 (type: `host`)
- [ ] `platforms[0].components` 包含 ≥ 5 个虚拟设备 DLL 组件
- [ ] `tools` 包含 VTest、arm-none-eabi-gcc、MSVC
- [ ] `simulation_models` 包含 ≥ 4 个模型 (ADC/UART/GPIO/PWM)
- [ ] 每个 `simulation_models` 的 `fidelity` 设�� `high` 或 `medium`
- [ ] `environment_difference_analysis` 非空，描述了仿真与真实硬件的差异
- [ ] `baseline_status` 初始为 `"待验证"`

**Schema 校验**:
```bash
bun -e '
import { TestEnvironmentDesignSchema } from "./src/schema/test-environment.ts"
import { readFileSync } from "fs"
const data = JSON.parse(readFileSync("tests/env-architect-vtest/expected/env-design.json", "utf-8"))
const result = TestEnvironmentDesignSchema.safeParse(data)
console.log(result.success ? "PASS: Schema validation OK" : "FAIL: " + JSON.stringify(result.error))
'
```

### Step 4: 生成仿真代码

**预期输出**: VTest 虚拟设备 DLL 源码 + VTE 项目文件

**VTE 项目文件验证点** (`pcu_sim.vte`):
- [ ] `[Cpu]` 设为 ARM Cortex-M4
- [ ] `[CpuFre]` 设为 168000000
- [ ] `[Devices]` 包含 ≥ 4 个 DLL
- [ ] `[Connect]` 正确连接 ADC 通道 → CPU ADC 寄存器
- [ ] `[Connect]` 正确连接 UART TX/RX → CPU USART1_DR
- [ ] `[Connect]` 正确连接 GPIO 引脚 → CPU GPIO 端口
- [ ] `[PhyMem]` 包含 Flash (0x08000000) 和 SRAM (0x20000000)
- [ ] `[VPortConnect]` 连接测试驱动到各外设设备

**虚拟设备 DLL 验证点**:
- [ ] 每个 DLL 导出 `extern "C" vttRES WINAPI MainProc(vttMESSAGE Msg, void *pData, DWORD dwParam)`
- [ ] 使用 `#include "stdafx.h"` (包含 MFC 和 vttDevice.h)
- [ ] `struct VTTFUNCS vtt;` 在 stdafx.cpp 中全局声明 (不是设备结构体字段)
- [ ] MainProc 入口处 switch 之前调用 `vtt.ConfirmDevID(pData)`
- [ ] `VTT_INIT` 中调用 `vtt.GetFunctionPointers(dwParam, pData)` 并设置 `nPortCount`
- [ ] `VTT_QPORTS` 返回 `(vttRES)gPorts` — vttPORT 静态数组指针
- [ ] `VTT_QSIZE` 返回 `(vttRES)sizeof(TCHIP_HEADER)`
- [ ] 通过 .def ���件导出 MainProc，无需 DllMain (MFC 处理)
- [ ] 设备状态使用全局 static 结构体 (不依赖 pData 存储自定义数据)
- [ ] ADC DLL 使用 `vtt.CreateTimer` 周期采样 + `vtt.PinConnect` 输出数据
- [ ] UART DLL 使用 `vtt.WriteVPort` 转发捕获帧 + `VTT_VWBYTES` 接收注入帧
- [ ] GPIO DLL 在 `VTT_PINCONNECT` 中记录输出变化事件
- [ ] 编译要求: VS2013 v120 toolset, MFC Dynamic, Win32, MultiByte

### Step 5: 生成测试驱动框架

**预期输出**: 测试脚本文件

**验证点**:
- [ ] 生成了 ≥ 3 套测试脚本 (标称/过压/欠压)
- [ ] 脚本格式为 `#<时间>,<命令>,<参数>`
- [ ] `nominal_test.txt` 覆盖: 初始化验证 → MPPT 运行 → 遥测验证
- [ ] `overvoltage_test.txt` 覆盖: SRS-005 过压保护 200μs 响应
- [ ] `undervoltage_test.txt` 覆盖: SRS-006 分级负载卸载 (3 级, 100ms 间隔)
- [ ] 每个脚本包含明确的预期结果注释

### Step 6: 基线验证

**预期输出**: 基线测试结果

**验证点**:
- [ ] `env-design.json` 中 `baseline_tests` 包含 ≥ 5 个基线测试
- [ ] BL-001: 固件加载与初始化验证 (SRS-001)
- [ ] BL-002: ADC 数据通路验证 (SRS-002, SRS-004)
- [ ] BL-003: UART 回环验证 (SRS-007, SRS-008)
- [ ] BL-004: GPIO 输出驱动验证 (SRS-001)
- [ ] BL-005: PWM 输出验证 (SRS-002, SRS-003)
- [ ] BL-006: 过压保护响应验证 (SRS-005)
- [ ] BL-007: 仿真稳定性验证
- [ ] 每个基线测试有 `related_requirements` 追踪链

### Step 7: 写入输出

**预期产物清单**:

| 文件 | 路径 | 说明 |
|------|------|------|
| env-design.json | `.matrix/data/env-design.json` | 环境设计文档 (JSON) |
| VTE 项目文件 | `.matrix/test-env/pcu_sim.vte` | VTest 仿真配置 |
| ADC DLL 源码 | `.matrix/test-env/vdev/vdev_adc.c` | 虚拟 ADC 设备 |
| UART DLL 源码 | `.matrix/test-env/vdev/vdev_uart.c` | 虚拟 UART 设备 |
| GPIO DLL 源码 | `.matrix/test-env/vdev/vdev_gpio.c` | 虚拟 GPIO 设备 |
| PWM DLL 源码 | `.matrix/test-env/vdev/vdev_pwm_capture.c` | 虚拟 PWM 捕获设备 |
| 测试驱动 DLL | `.matrix/test-env/vdev/vdev_test_driver.c` | 测试脚本执行引擎 |
| 标称测试脚本 | `.matrix/test-env/scripts/nominal_test.txt` | 正常工况测试 |
| 过压测试脚本 | `.matrix/test-env/scripts/overvoltage_test.txt` | SRS-005 验证 |
| 欠压测试脚本 | `.matrix/test-env/scripts/undervoltage_test.txt` | SRS-006 验证 |
| 环境设计报告 | `.matrix/reports/test-environment.md` | Markdown 格式报告 |

---

## 通过/失败判定

### 关键通过标准 (必须全部满足)

| # | 标准 | 权重 |
|---|------|------|
| C1 | `env-design.json` 通过 `TestEnvironmentDesign` Schema 校验 | 必须 |
| C2 | 生成了 VTE 项目文件，包含正确的 `[Cpu]`、`[Devices]`、`[Connect]` 配置 | 必须 |
| C3 | 为每个硬件接口 (IF-001~IF-004) 生成了对应的虚拟设备 DLL 模型 | 必须 |
| C4 | 虚拟设备 DLL 实现了 VTest `MainProc` 消息处理接口 | 必须 |
| C5 | 生成了 ≥ 1 套可执行的测试脚本 | 必须 |
| C6 | `baseline_tests` 覆盖了初始化、数据通路、通信回环 | 必须 |
| C7 | 所有需求 (SRS-001~SRS-008) 在测试脚本或基线测试中有追踪 | 必须 |

### 可选增强标准

| # | 标准 | 说明 |
|---|------|------|
| E1 | `environment_difference_analysis` 识别了 ≥ 3 项仿真差异 | 质量加分 |
| E2 | 测试脚本包含故障注入场景 (过流/过温) | 覆盖 SRS-005/006 |
| E3 | 配置了覆盖率采集 (COX 文件输出) | 支持 Phase 7/8 |
| E4 | Pin 连接图包含正确的 STM32F407 外设地址映射 | 精确度加分 |
| E5 | VPort 通信协议在 DLL 间一致 (数据格式、字节序) | 集成质量 |

---

## VTest 参考资料

本测试用例中的 VTest 平台概念参考:
- `C:\claude\vtest-ai-提示词\vttDevice.h` — VTest 设备 DLL C 头文件
- `C:\claude\vtest-ai-提示词\VTest编程接口说明.md` — 完整 API 文档
- `C:\claude\vtest-ai-提示词\VTest项目文件vte格式说明.md` — VTE 配置格式
- `C:\claude\vtest-ai-提示词\测试脚本格式说明.md` — 测试脚本格式
- `C:\claude\vtest-ai-提示词\构建VTest目标机仿真环境.md` — 环境搭建 5 步流程

### VTest 关键概念

| 概念 | 说明 |
|------|------|
| VTE 文件 | INI 格式项目配置，定义 CPU、设备 DLL、引脚连接、内存映射 |
| 虚拟设备 DLL | Windows 32-bit MFC DLL，导出 `extern "C" vttRES WINAPI MainProc(vttMESSAGE, void*, DWORD)`，需 VS2013 v120 编译 |
| VTT 消息 | `VTT_INIT`/`VTT_RESET`/`VTT_CLOCK`/`VTT_PINCONNECT`/`VTT_VWBYTES` 等 |
| VTTFUNCS | 全局 API 函数指针结构体 (60+ 函数)，在 stdafx.cpp 中声明为 `struct VTTFUNCS vtt;`，通过 `vtt.GetFunctionPointers(dwParam, pData)` 初始化 |
| Pin 连接 | 设备间引脚级信号连接 (`PinConnect` API) |
| VPort | 设备间虚拟端口通信 (`WriteVPort`/`VTT_VWBYTES`，批量数据传输) |
| 测试脚本 | `#<时间>,<命令>,<参数>` 格式的时间序列测试操作 |
| COX 文件 | 代码覆盖率输出文件 (`OutCoxFile` API) |
