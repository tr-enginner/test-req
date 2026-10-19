---
name: vtest-environment
description: "VTest 目标机仿真环境设计：虚拟设备 DLL 开发规范、VTE 项目文件格式、VTTFUNCS API 参考、测试脚本格式、编译验证流程、常见错误清单。"
metadata:
  phase: "5"
  agent: "env-architect"
  category: "testing"
  platform: "vtest"
  review_gate: true
---

# VTest 仿真环境设计技能

> **⚠ 全局约束（所有章节适用）**
>
> **Shell 与编码规则**:
> 1. **禁止**使用 `bash` ↔�具直接调用 `vtestc.exe` 或 `MSBuild.exe` — 任何情况下都不允许
> 2. 编译 DLL **只能**通过 `vtest_compile` 工具
> 3. 运行/验证 VTE **只能**通过 `vtest_runner` 工具
> 4. 工具不可用时**向用户报告**，不要用 bash 替代
>
> **代码生成规则 — 必须使用工具，禁止手写**:
> 5. VTE 项目文件 **必须且只能**通过 `vtest_project_generate` / `vtest_project_update` 工具生成。**禁止用 write 工具直接写 .vte 文件** — agent 手写的 VTE 格式几乎总是错误的（行号前缀、逗号分隔、DeviceProperty 格式等）
> 6. 虚拟设备 DLL 源码 **必须**通过 `vtest_device_generate` 工具生成初始框架。可以在工具生成的基础上↔�改，但不要从零手写
> 7. 测试驱动和基线脚本 **必须**通过 `vtest_script_generate` 工具生成
>
> **路径配置规则（严格校验，禁止自动查找）**:
> 8. `matrix.jsonc` 中 `vtest_home` 和 `vs2013_path` 是**必须配置**的字段。工具**不会**在其它目录自动搜索程序
> 9. 如果 `vtest_home` 配置的路径无效（目录不存在或缺少 `vtestc.exe`），工具直接返回错误，**不会**回退到环境变量或其它路径
> 10. 如果 `vs2013_path` 配置的路径无效（目录不存在或找不到 MSBuild），工具直接返回错误，**不会**回退到默认路径或自动扫描
> 11. 未配置时：必须**向用户报告**需要在 `matrix.jsonc` 中设置 `vtest_home` 和 `vs2013_path`，不要尝试自动安装或查找
>
> **固件文件规则**:
> 8. `matrix.jsonc` 中 `firmware.output` 指定的文件就是编译后的固件，**直接使用，不要尝试重新编译或转换格式**
> 9. Keil C51 输出的无扩展名文件（如 `build\prj`）是 **OMF51 格式二进制**，不是源码。文件开头 `0x70` 是 OMF51 Module Header，内部嵌入的 `STARTUP.A51` 等文本是调试信息不是源文件引用。**禁止**因为看到文件中有 `.A51` 文本就判断"需要编译"
>
> **UART 设备 spec 必填规则**:
> 10. 外部 UART 芯片（82C52、16550 等通过 XDATA 映射的 UART）的 `vtest_device_generate` spec **必须包含**：
>     - `interrupt_config` 字段（pin_name, cpu_pin, trigger）— 缺少则不生成 PinConnect 中断触发/释放代码，CPU ISR 永远不会被调用
>     - 数据寄存器的 `role` 设为 `"tx_rx_data"`（读=RX、写=TX 共用同一地址）— 缺少 rx_data 角色则不生成 FIFO pop 代码，CPU 永远读不到接收数据
>     - INT_PIN 端口（`type: "pin"`）— 缺少则 interrupt_config 无法生效
> 11. 识别方法：固件源码中 `interrupt 0`/`interrupt 2` + 读取 XDATA 地址 = 外部 UART 中断模式，必须提供上述配置
>
> **常见手写 VTE 错误（agent 经常犯）**:
> - `[Names]` 中用了中文/空格（如 `82C52 UART (GGG)`）→ 必须是英文变量名风格（如 `sim_uart_ggg`）
> - `[Connect]` 写成 `3.PIN=1000.P1_0` → 正确格式: `1=3.PIN,1000.P1_0`（需要行号前缀和逗号分隔）
> - `[DeviceProperty]` 写成 `1.BaseAddress=0x4000` → 正确格式: `1=1, BaseAddress=0x4000`（需要行号前缀）
> - 自创 `[PortEnable]` section → 不存在此 section，应在 `[DeviceProperty]` 中写 `N=1000, PortEnable=1,3`
> - 这些错误 `vtest_project_generate` 工具会自动处理正确，所以**必须用工具**

> **执行记录约定**:
> 在执行 VTest 环境生成的每个阶段（Phase A/B/C），**必须**将以下信息追加写入 `.matrix/test-env/execution-log.md`：
> - 当前步骤名称和时间
> - 调用的工具名称和**完整参数**（JSON 格式）
> - 工具返回的 `status` 和关键结果字段
> - 如果失败：错误信息和采取的修复动作
> - 如果跳过某步骤或偏离了标准流程：原因说明
>
> 格式示例：
> ```markdown
> ## Phase A: GENERATE
> ### A1: vtest_device_generate
> - **Tool**: vtest_device_generate
> - **Args**: `{"device_name": "sim_uart", "device_type": "uart", ...}`
> - **Result**: `status: "success"`, files: sim_uart.cpp, sim_uart.h, sim_uart.def
> ### A2: vtest_script_generate
> ...
> ## Phase B: COMPILE
> ### B1: vtest_compile
> - **Tool**: vtest_compile
> - **Args**: `{"sln_path": ".matrix/test-env/vtest-devices.sln"}`
> - **Result**: `status: "success"`, 0 errors, 2 warnings, dll_files: [...]
> ```

## 0. 前置学习

**读取内容**：
- `matrix.jsonc` 中配置了 `vtest_docs_paths`，包含VTest 手册：vtestc 命令行用法、VTE 项目文件格式、编程接口 API
- 在开始生成 VTest 环境之前，应先了解目标软件的功能和拟构建环境硬件特征，需要根据`matrix.jsonc` 配置的`source_dirs`分析目标软件功能，并结合`test_env_hardware_docs`分析硬件接口特征，为后继虚拟设备DLL开发做好准备。

> **🚫 禁止自创系统头文件 — vttDevice.h 二进制兼容性**
>
> `vttDevice.h` 是 VTest 引擎与设备 DLL 之间的 **二进制接口契约**。vtestc.exe 期望 DLL 中的 struct 大小、enum 值、VTTFUNCS 类布局与其内部实现 **字节级一致**。任何不匹配都会导致 vtestc 在加载 DLL 时立即崩溃（无错误信息，无 stderr）。
>
> **绝对禁止**自行编写或"推测"vttDevice.h 的内容。具体要求：
> 1. `vttDevice.h` **必须**从以下路径之一获取：
>    - `matrix.jsonc` → `vtest_docs_paths` 中标注的路径
>    - VTest 安装目录下的 include 文件夹
>    - 用户项目中已有的 vttDevice.h 副本
> 2. 如果以上路径均不存在 vttDevice.h，**必须停止并向用户报告**，要求用户提供。**不要**尝试根据 VTest 文档或 API 描述自行创建
> 3. 将获取到的真实 vttDevice.h **原样复制**到 `.matrix/test-env/include/vttDevice.h`，不做任何修改
>
> **为什么不能自创**：真实的 vttDevice.h（约 750 行）包含 C++ class VTTFUNCS（38 个函数指针 + 成员变量 + 构造/析构函数）、精确的 enum tagvttMESSAGE 值序列（含 VTT_QMENU=4 等非直觉值）、以及 vttParamMemoryEvent 等结构体的精确字段布局。Agent 自创的简化版本（如 140 行的 C struct）会导致：
> - enum 值偏移 → VTT_INIT 处理函数永远不会被调用
> - struct 大小不匹配 → 内存访问越界
> - VTTFUNCS 函数指针偏移 → vtt.AddLog() 实际调用到 vtt.ReadByte()，立即崩溃

## 1. VTest 平台概述

VTest 是基于 QEMU 内核的 **嵌入式目标机仿真器**，运行在 Windows x86 平台上。

- CPU 仿真：ARM Cortex-M0/M3/M4/A9、8051 等，通过 QEMU 指令级仿真
- 外设仿真：以 Windows 32-bit DLL 形式加载，每个 DLL 仿真一个虚拟外设
- 设备间通信：Pin 连接（单信号）和 VPort（批量数据）
- 测试驱动：特殊 DLL，解析测试脚本，协调激励注入和响应采集
- 配置入口：`.vte` 项目文件（INI 格式），定义 CPU、设备、连接、内存映射

```
VTest 引擎
  ├── CPU 仿真 (QEMU) ← 加载固件 ELF
  ├── 内存子系统 ← [PhyMem] 配置
  ├── 中断控制器
  └── 总线仿真
       ├── vdev_adc.dll    ← [Devices] 注册
       ├── vdev_uart.dll
       ├── vdev_gpio.dll
       └── vdev_test_driver.dll
```

## 2. 虚拟设备 DLL 开发规范

### 2.1 MainProc 入口函数（唯一导出）

```c
// 签名必须严格匹配（通过 .def 文件导出，不需要 DllMain）
extern "C" vttRES WINAPI MainProc(vttMESSAGE Msg, void *pData, DWORD dwParam)
{
    vtt.ConfirmDevID(pData);   // 每次进入 MainProc 必须调用
    switch (Msg) { ... }
    return (vttRES)FALSE;
}
```

**关键要点**:
- `vtt.ConfirmDevID(pData)` 在 switch 之前，每次调用都执行
- `pData` 指向 VTest 分配的 `TCHIP_HEADER` 结构
- `dwParam` 在 VTT_INIT 时是 VTest 核心 HINSTANCE，其他消息含义各异
- 不需要 DllMain — MFC 自动处理 DLL 初始化

### 2.2 必须处理的 VTT 消息（6 个）

| 消息 | 用途 | 必须做的事 |
|------|------|-----------|
| `VTT_QSIZE` | 查询设备数据结构大小 | `return (vttRES)sizeof(TCHIP_HEADER)` |
| `VTT_INIT` | 初始化 | `vtt.GetFunctionPointers(dwParam, pData)` + 设置 `nPortCount` |
| `VTT_QPORTS` | 查询端口定义 | `return (vttRES)gPorts` — 返回端口数组指针的强制转换 |
| `VTT_SETPROPERTY` | 接收 VTE 配置参数 | 解析 `CString sPara = (LPCTSTR)dwParam`，格式为 `"名称=值"` |
| `VTT_RESET` | 复位 | 创建定时器 `vtt.CreateTimer(pinID, CYCLE_TIMER, seconds)`，设置地址监视 `vtt.SetWatchOnMemoryM(begin, end, type, access)` — **⚠ 任何需要响应 CPU 内存访问的设备（不仅是 UART），都必须在此调用 `SetWatchOnMemoryM` 注册地址范围。这是设备收到 `VTT_MEMREAD`/`VTT_MEMWRITE` 的前提条件。custom/FPGA 类型设备尤其容易遗漏此调用，导致运行时 MEMREAD=0、MEMWRITE=0** |
| `VTT_TERMINATE` | 终止 | 删除定时器、释放资源、**移除内存监视 `vtt.UnSetWatchOnMemoryM()`** |

### 2.3 运行时消息（按需实现）

| 消息 | 触发条件 | 参数 |
|------|---------|------|
| `VTT_CLOCK` | 定时器触发 | `dwParam` = timer/pin ID |
| `VTT_PINCONNECT` | 其他设备/CPU 写入 Pin | `dwParam` = `vttParamPinConnect*` (nPinID + dwValue) |
| `VTT_VWBYTES` | VPort 批量数据写入 | `dwParam` = `vttParamVWBytes*` (vttPinID + nSize + pByte) |
| `VTT_MEMREAD` | CPU 读设备寄存器 | `dwParam` = `vttParamMemoryEvent*` (需先在VTT_RESET中 SetWatchOnMemoryM) |
| `VTT_MEMWRITE` | CPU 写设备寄存器 | `dwParam` = `vttParamMemoryEvent*` |
| `VTT_QPROPERTY` | 查询属性名 | `dwParam` = 属性索引，返回 `(vttRES)gAttrName[dwParam]`，返回 0 表示无更多属性 |

### 2.4 关键数据结构

```c
// 设备头 — VTest 为每个设备分配，pData 指向此结构
typedef struct {
    unsigned int  uID;        // 设备 ID (VTest 分配)
    int           nSize;      // 结构体大小
    int           nPortCount; // 端口数量 (VTT_INIT 中设置)
    void         *pUser;      // 用户指针
} TCHIP_HEADER;

// 端口定义 — 静态数组，VTT_QPORTS 返回其指针
typedef struct {
    vttPINID  iID;          // 端口索引 (对应 enum 中定义的 ID)
    char      strName[52];  // 端口名称 (与 VTE [Connect] 中使用的名称一致)
    EPORT_TYPE eType;       // IOPORT (默认), VIOPORT (VPort 批量数据), IOPIN (Pin 单信号)
} vttPORT;

// Pin 连接参数
typedef struct {
    int           nPinID;   // Pin 索引 (对应 vttPORT 数组下标)
    unsigned long dwValue;  // Pin 值
} vttParamPinConnect;

// VPort 写入参数
typedef struct {
    int           vttPinID; // VPort 索引
    int           nSize;    // 数据字节数
    unsigned char *pByte;   // 数据指针
} vttParamVWBytes;
```

### 2.5 全局 VTTFUNCS API

`struct VTTFUNCS vtt;` 声明在 `stdafx.cpp` 中，全局可见，**不是**设备结构体的字段。

| 函数 | 签名 | 用途 |
|------|------|------|
| `GetFunctionPointers` | `DWORD GetFunctionPointers(DWORD ins, void* pHeader)` | VTT_INIT 中调用，ins=dwParam, pHeader=pData |
| `ConfirmDevID` | `void ConfirmDevID(void* pHeader)` | 每次 MainProc 入口调用 |
| `DevID` | `vttDEVID DevID()` | 获取当前设备 ID |
| `PinConnect` | `void PinConnect(vttPINID, DWORD)` | 输出 Pin 信号 |
| `WriteVPort` | `void WriteVPort(vttPINID, PBYTE, int)` | 写入 VPort 批量数据 |
| `CreateTimer` | `void CreateTimer(vttPINID, timerType, double)` | 创建定时器 (CYCLE_TIMER/ONCE_TIMER, 单位: 秒) |
| `DeleteTimer` | `void DeleteTimer(vttPINID)` | 删除定时器 |
| `GetRunTime` | `double GetRunTime()` | 获取仿真时间 (秒) |
| `GetCpuFre` | `double GetCpuFre()` | 获取 CPU 频率 (MHz) |
| `ReadByte` | `BYTE ReadByte(uint64 addr, DWORD type)` | 读仿真内存 (8位) |
| `WriteByte` | `void WriteByte(uint64 addr, DWORD type, BYTE)` | 写仿真内存 (8位) |
| `SetWatchOnMemoryM` | `void SetWatchOnMemoryM(begin, end, type, access)` | 设置内存监视 |
| `OutCoxFile` | `void OutCoxFile(LPCTSTR)` | 输出覆盖率 COX 文件 |
| `AddLog` | `void AddLog(const char* fmt, ...)` | 输出日志消息 |
| `StopDebug` | `void StopDebug()` | 停止仿真 |

### 2.6 DLL 结构要求

每个虚拟设备 DLL 必须满足:

1. **`#include "stdafx.h"`** — 预编译头，包含 MFC 和 vttDevice.h
2. **全局 `struct VTTFUNCS vtt;`** — 在 stdafx.cpp 中声明（每个 DLL 恰好一份）
3. **端口数组** — `static vttPORT gPorts[PORT_COUNT]`，iID/strName/eType 三元组
4. **MainProc 导出** — `extern "C" vttRES WINAPI MainProc(vttMESSAGE, void*, DWORD)`，通过 .def 文件导出
5. **vtt.ConfirmDevID(pData)** — MainProc 入口处必须调用
6. **VTT_INIT** — 必须调用 `vtt.GetFunctionPointers(dwParam, pData)` 并设置 `nPortCount`
7. **无需 DllMain** — MFC 框架自动处理 DLL 初始化

### 2.8 UART/RS422 外设仿真模式

UART 和 RS422 类外设使用 **内存映射 + VPort 联动** 模式实现全双工串口仿真。与纯 Pin 模式不同，数据通过 VPort 批量传输，CPU 通过寄存器读写与设备交互。

#### 数据流架构

```
CPU 固件                          虚拟设备 DLL                      测试驱动 DLL
   │                                   │                                │
   ├─ 写 TX_DATA 寄存器 ──────────────→│                                │
   │  (VTT_MEMWRITE 拦截)              ├─ vtt.WriteVPort(TX) ─────────→│
   │                                   │                                │ (VTT_VWBYTES)
   │                                   │                                │
   │                                   │←── vtt.WriteVPort(RX) ────────┤
   │                                   │  (VTT_VWBYTES → FIFO push)    │
   ├─ 读 STATUS 寄存器 ──────────────→│                                │
   │  (VTT_MEMREAD → RX_READY 标志)   │                                │
   ├─ 读 RX_DATA 寄存器 ─────────────→│                                │
   │  (VTT_MEMREAD → FIFO pop)        │                                │
```

#### SetWatchOnMemoryM 调用

在 `VTT_RESET` 中注册内存监视，使 CPU 读写设备寄存器时触发 `VTT_MEMREAD` / `VTT_MEMWRITE`：

```c
/* memType=2 表示 MCS-51 XDATA (外部数据存储器) */
vtt.SetWatchOnMemoryM(REG_MIN_ADDR, REG_MAX_ADDR, 2, VTTREADWRITE);
```

在 `VTT_TERMINATE` 中移除监视：

```c
vtt.UnSetWatchOnMemoryM(REG_MIN_ADDR, REG_MAX_ADDR, 2, VTTREADWRITE);
```

#### VTT_MEMWRITE 处理（CPU → 设备）

当 CPU 写入 TX 数据寄存器时，设备拦截并通过 VPort 发送：

```c
case VTT_MEMWRITE:
{
    vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
    if (pe->dwAddress == REG_TX_DATA) {
        BYTE txByte = vtt.ReadByte(pe->dwAddress, 2);
        vtt.WriteVPort(TX_DATA_PORT, &txByte, 1);  /* 发送到测试驱动 */
    }
    break;
}
```

#### VTT_MEMREAD 处理（设备 → CPU）

CPU 读取 RX 数据寄存器时，设备从 FIFO 取数据并通过 `WriteByte` 回写到内存：

```c
case VTT_MEMREAD:
{
    vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
    if (pe->dwAddress == REG_RX_DATA) {
        BYTE rxByte = 0;
        fifo_pop(&rxByte);
        vtt.WriteByte(pe->dwAddress, 2, rxByte);  /* 回写到 CPU 可见内存 */
    } else if (pe->dwAddress == REG_STATUS) {
        BYTE st = UART_STATUS_TX_EMPTY;
        if (g_rx_fifo.count > 0) st |= UART_STATUS_RX_READY;
        vtt.WriteByte(pe->dwAddress, 2, st);
    }
    break;
}
```

**关键**: `VTT_MEMREAD` 中必须调用 `vtt.WriteByte()` 将值写回内存地址，否则 CPU 读到的是旧值。

#### RX FIFO 缓冲

设备维护一个 256 字节环形缓冲区，接收来自 VPort 的数据（`VTT_VWBYTES`）并缓存，等待 CPU 通过寄存器读取：

```c
case VTT_VWBYTES:
{
    vttParamVWBytes *p = (vttParamVWBytes *)dwParam;
    for (int i = 0; i < p->nSize; i++) {
        fifo_push(p->pByte[i]);
    }
    /* 更新状态寄存器 RX_READY 位 */
    vtt.WriteByte(REG_STATUS, 2, status | UART_STATUS_RX_READY);
    break;
}
```

#### VTE 中 VPortConnect 配置

UART 设备与测试驱动通过 VPort 双向连接：

```ini
;; 设备 1=sim_uart, 设备 2=test_driver
;; 设备的 TX 端口连接到测试驱动的 RX 端口（捕获 CPU 发送的数据）
;; 测试驱动的 TX 端口连接到设备的 RX 端口（注入数据给 CPU 接收）
[VPortConnect]
1=1.TX_DATA,2.uart_rx
2=2.uart_tx,1.RX_DATA
```

#### 寄存器 role 字段

代码生成器可使用字段标识寄存器功能：

| role | 说明 | MEMWRITE 行为 | MEMREAD 行为 |
|------|------|--------------|-------------|
| `tx_data` | 发送数据寄存器 | 读取字节 → WriteVPort 发送 | — |
| `rx_data` | 接收数据寄存器 | — | FIFO pop → WriteByte 回写 |
| `status` | 状态寄存器 | — | 构造状态字节 → WriteByte |
| `control` | 控制寄存器 | 读取并保存状态 | — |
| `baud_rate` | 波特率寄存器 | 读取并保存状态 | — |
| `general` | 通用寄存器 | 默认处理 | 默认处理 |

#### 设备类型→配置要求映射（必须遵守）

代码生成器根据 `device_type` 和端口/寄存器配置决定生成哪种仿真代码。**配置错误会导致生成空壳代码（无实际功能）**。

| device_type | 端口要求 | 寄存器 role 要求 | VTE 连接要求 | 关键机制 |
|-------------|---------|-----------------|-------------|---------|
| `uart` | **必须有 VPort 端口**（`type: "vport"`），至少 TX_DATA + RX_DATA 两个 | **必须设置** tx_data / rx_data / status | VTE 必须配 `[VPortConnect]` 连接设备 VPort 与测试驱动 VPort | SetWatchOnMemoryM + FIFO + WriteVPort |
| `rs422` | 同 uart | 同 uart | 同 uart | 同 uart |
| `adc` | Pin 端口（`type: "pin"`）或 VPort | 一般用 `general` | Pin → `[Connect]`; VPort → `[VPortConnect]` | VTT_PINCONNECT / VTT_CLOCK |
| `gpio` | Pin 端口 | 可选 | `[Connect]` | VTT_PINCONNECT |
| `timer` | Pin 端口 | 可选 | `[Connect]` | CreateTimer + VTT_CLOCK |
| `can` / `1553b` / `spi` / `i2c` | VPort 端口 | 按↔�议定义 | `[VPortConnect]` | VTT_VWBYTES |
| `custom` | 自由 | 自由 | 按需 | 按 behavior_description |

**核心规则**：需要批量数据传输的设备（串口、总线）**必须**使用 VPort 端口。Pin 端口仅用于单 bit 信号（GPIO、中断、时钟）。

#### UART/RS422 设备完整设计示例

以下是一个正确的 UART 仿真设备的完整设计，展示从 VteDeviceSpec 输入到 VTE 配置的全链路。

**Step 1: VteDeviceSpec（传给 vtest_device_generate 工具的参数）**

```json
{
  "device_name": "sim_uart_comm",
  "device_type": "uart",
  "ports": [
    { "name": "TX_DATA", "type": "vport", "direction": "output" },
    { "name": "RX_DATA", "type": "vport", "direction": "input" }
  ],
  "registers": [
    { "name": "SBUF",  "address": "0x4000", "width": "8", "access": "readwrite", "role": "tx_data",   "description": "发送/接收数据缓冲区" },
    { "name": "SCON",  "address": "0x4001", "width": "8", "access": "readwrite", "role": "status",    "description": "串口控制/状态寄存器" },
    { "name": "PCON",  "address": "0x4002", "width": "8", "access": "readwrite", "role": "control",   "description": "电源控制寄存器(波特率倍频)" },
    { "name": "BRT",   "address": "0x4003", "width": "8", "access": "write",     "role": "baud_rate", "description": "波特率设置寄存器" }
  ],
  "protocol_params": { "baud_rate": "9600", "frame_format": "8N1" },
  "behavior_description": "UART 串口仿真。CPU 写 SBUF(0x4000) → 设备拦截 → WriteVPort 发送到测试驱动; 测试驱动 WriteVPort → 设备 VTT_VWBYTES → push FIFO → CPU 读 SBUF 时 pop 返回"
}
```

**注意要点**:
- `ports` 使用 `"type": "vport"` — 不是 `"pin"`！VPort 用于批量数据传输
- 接收数据寄存器(SBUF)的 `role` 在此设为 `"tx_data"` 因为 CPU 写时发送; 单独的 rx_data 可用同一地址（VTT_MEMREAD 时 pop FIFO）。如需分离收发地址，增加一个 role 为 `"rx_data"` 的寄存器
- `behavior_description` 明确描述了数据流方向

**Step 2: 生成的代码关键路径（自动生成，无需手写）**

```
VTT_RESET → vtt.SetWatchOnMemoryM(0x4000, 0x4003, 2, VTTREADWRITE)
                                          ↑注册内存监视

CPU 写 SBUF(0x4000) → VTT_MEMWRITE → vtt.ReadByte(0x4000,2) → vtt.WriteVPort(TX_DATA, &byte, 1)
                                          ↑拦截CPU写操作           ↑通过VPort发给测试驱动

测试驱动 WriteVPort → VTT_VWBYTES → fifo_push(byte) → 更新 SCON RX_READY 位
                                          ↑来自测试驱动的数据存入FIFO

CPU 读 SBUF(0x4000) → VTT_MEMREAD → fifo_pop(&byte) → vtt.WriteByte(0x4000, 2, byte)
                                          ↑CPU读操作时从FIFO取数据并回写到内存

CPU 读 SCON(0x4001) → VTT_MEMREAD → 构造状态字节(TX_EMPTY|RX_READY) → vtt.WriteByte()
                                          ↑状态寄存器返回FIFO是否有数据
```

**Step 3: VTE 项目配置（VPortConnect 必须配置）**

```ini
;; 假设设备1=sim_uart_comm, 设备2=test_driver
[Devices]
1=C:\project\.matrix\test-env\sim-models\sim_uart_comm.dll
2=C:\project\.matrix\test-env\drivers\test_driver.dll

[Names]
1=sim_uart_comm
2=test_driver

;; Pin 连接: CPU 串口引脚与设备物理引脚（如果设备同时有 pin 端口）
[Connect]
;; 如果 UART 设备仅通过寄存器+VPort 工作，可无需 Pin 连接

;; VPort 连接: 设备 VPort ↔ 测试驱动 VPort（双向）
;; 设备TX → 测试驱动RX（CPU发出的数据传给测试驱动）
;; 测试驱动TX → 设备RX（测试驱动注入数据给CPU接收）
[VPortConnect]
1=1.TX_DATA,2.uart_rx
2=2.uart_tx,1.RX_DATA

[DeviceProperty]
1=1, BaseAddress=0x4000
2=2, ScriptFile=stimuli\baseline_test.txt
```

#### 端到端仿真数据流检查清单

设计仿真设备时，按此清单逐项检查，确保整个数据链路完整：

- [ ] **CPU → 设备**: 设备 `registers` 中是否有 `role: "tx_data"` 的寄存器？CPU 写此地址时，设备通过 `vtt.WriteVPort()` 将数据发出
- [ ] **设备 → 测试驱动**: 设备 `ports` 中是否有 `type: "vport"` 的输出端口？VTE 的 `[VPortConnect]` 是否将此端口连接到测试驱动的 VPort？
- [ ] **测试驱动 → 设备**: 测试驱动是否有对应 VPort 端口？VTE 的 `[VPortConnect]` 是否将测试驱动的 VPort 连接到设备的 VPort 输入端口？
- [ ] **设备 → CPU**: 设备是否有中断引脚需要与CPU连接？ 设备 `registers` 中是否有 `role: "rx_data"` 的寄存器？设备收到 VPort 数据后存FIFO，CPU 读此地址时 pop 返回
- [ ] **状态查询**: 设备 `registers` 中是否有 `role: "status"` 的寄存器？CPU 读此地址时返回 RX_READY/TX_EMPTY 等标志
- [ ] **内存监视**: device_type 为 uart/rs422 时，代码生成器会自动在 VTT_RESET 中调用 `SetWatchOnMemoryM`（前提是有寄存器定义）
- [ ] **中断通路**: 如果目标固件使用外部中断（`interrupt 0`/`interrupt 2`）接收 UART 数据，设备**必须有 Pin 端口**连接到 CPU 中断引脚，且 VTE `[Connect]` 和 `PortEnable` 必须配置正确（详见下方中断驱动模式）

#### 中断驱动 UART 接收模式（外部 UART 芯片，如 82C52）

> **⚠ 关键区别**：很多嵌入式系统使用**外部 UART 芯片**（如 82C52、16550），通过 XDATA 总线映射寄存器，并用**外部中断线**（如 INT0/P3_2）通知 CPU 数据到达。这与 CPU 内置 UART（通过 SFR 访问）完全不同。**如果目标固件使用 `interrupt 0`/`interrupt 2` 等外部中断处理 UART 接收，设备必须有 Pin 端口连接到 CPU 中断引脚，否则 CPU 的 ISR 永远不会触发。**

**识别方法**：在目标固件源码中搜索以下模式：
- `interrupt 0` + 读取 XDATA 寄存器 → 外部 UART 芯片使用 INT0 (P3_2)
- `interrupt 2` + 读取 XDATA 寄存器 → 外部 UART 芯片使用 INT1 (P3_3)
- ISR 中有 `XBYTE[0x4000]` 等外部寄存器读取 → 中断驱动，不是轮询

**数据流架构（中断驱动）**：

```
测试驱动 DLL              虚拟设备 DLL                        CPU 固件
    │                          │                                │
    ├─ WriteVPort(RX) ────────→│                                │
    │                          ├─ VTT_VWBYTES → FIFO push      │
    │                          ├─ vtt.PinConnect(INT_PIN, 0) ──→│ INT0 触发
    │                          │                                ├─ 进入 ISR
    │                          │                                ├─ 读 STATUS(0x4001)
    │                          │←──────── VTT_MEMREAD ──────────┤ (返回 RX_READY)
    │                          │                                ├─ 读 DATA(0x4000)
    │                          │←──────── VTT_MEMREAD ──────────┤ (FIFO pop → WriteByte)
    │                          ├─ FIFO empty → PinConnect(1) ──→│ 中断释放
    │                          │                                ├─ ISR 返回
```

**设备 DLL 实现要点**：

1. **端口定义**：除了 VPort (TX_DATA, RX_DATA)，**必须额外定义 Pin 端口用于中断信号**：

```c
enum DEVICE_PORT_ID {
    TX_DATA = 0,   /* VPort: 数据发送 */
    RX_DATA = 1,   /* VPort: 数据接收 */
    INT_PIN = 2,   /* Pin: 中断信号输出到 CPU */
    PORT_COUNT = 3,
};

static vttPORT gPorts[PORT_COUNT] = {
    { TX_DATA,  "TX_DATA",  VIOPORT },
    { RX_DATA,  "RX_DATA",  VIOPORT },
    { INT_PIN,  "INT_PIN",  IOPIN },    /* ← 必须是 IOPIN 类型 */
};
```

2. **VTT_VWBYTES 中触发中断**：

```c
case VTT_VWBYTES:
{
    /* ...push data to FIFO... */
    /* 数据入 FIFO 后，拉低中断引脚通知 CPU */
    if (g_rx_fifo.count > 0) {
        vtt.PinConnect(INT_PIN, 0);  /* 低电平触发外部中断 */
    }
    break;
}
```

3. **VTT_MEMREAD 中释放中断**：

```c
case VTT_MEMREAD:
{
    if (pe->dwAddress == REG_DATA) {
        BYTE rxByte = 0;
        fifo_pop(&rxByte);
        vtt.WriteByte(pe->dwAddress, 2, rxByte);
        /* FIFO 空时释放中断引脚 */
        if (g_rx_fifo.count == 0) {
            vtt.PinConnect(INT_PIN, 1);  /* 恢复高电平 */
        }
    }
    break;
}
```

**VTE 配置要求**：

```ini
;; 设备 1=sim_uart, CPU=1000
;; 中断 Pin 连接: 设备 INT_PIN → CPU P3_2 (INT0)
[Connect]
1=1000.P3_2,1.INT_PIN

;; CPU 必须使能 P3 端口
[DeviceProperty]
1=1000, PortEnable=1,3
```

**VteDeviceSpec 示例**（含中断端口）：

```json
{
  "device_name": "sim_uart_ext",
  "device_type": "uart",
  "ports": [
    { "name": "TX_DATA", "type": "vport", "direction": "output" },
    { "name": "RX_DATA", "type": "vport", "direction": "input" },
    { "name": "INT_PIN", "type": "pin", "direction": "output", "description": "中断输出到CPU INT0/P3_2" }
  ],
  "registers": [
    { "name": "UART", "address": "0x4000", "role": "tx_rx_data", "description": "收发数据寄存器（同一地址读=RX，写=TX）" },
    { "name": "UCR",  "address": "0x4001", "role": "status",  "description": "状态寄存器" }
  ],
  "interrupt_config": {
    "pin_name": "INT_PIN",
    "cpu_pin": "P3_2",
    "trigger": "level_low",
    "description": "INT0 外部中断，低电平触发"
  },
  "behavior_description": "外部82C52 UART。中断驱动接收：VPort数据→FIFO→拉低INT_PIN→CPU ISR读取。"
}
```

**中断驱动 UART 检查清单**（在端到端检查清单之外额外检查）：

- [ ] 目标固件是否使用 `interrupt N` ISR 接收 UART 数据？如是，设备**必须有 Pin 端口**
- [ ] 设备 `ports` 中是否有 `type: "pin"` 的中断输出端口？
- [ ] VTE `[Connect]` 中是否将设备中断 Pin 连接到 CPU 对应中断引脚（如 `1000.P3_2,1.INT_PIN`）？
- [ ] VTE `[DeviceProperty]` 中 CPU 的 `PortEnable` 是否包含中断所在端口组（P3 → 3）？
- [ ] 设备 DLL 的 `VTT_VWBYTES` 中，FIFO push 后是否调用了 `vtt.PinConnect(INT_PIN, 0)` 触发中断？
- [ ] 设备 DLL 的 `VTT_MEMREAD` 中，FIFO 空后是否调用了 `vtt.PinConnect(INT_PIN, 1)` 释放中断？

#### 常见设计错误

| 错误 | 后果 | 正确做法 |
|------|------|---------|
| UART 设备端口用 `type: "pin"` | 生成 IOPIN 端口，无法传输字节数据 | 改为 `type: "vport"` |
| 寄存器未设 `role` 字段 | VTT_MEMREAD/MEMWRITE 生成空壳 | 设置 tx_data / rx_data / status |
| VTE 中只配了 `[Connect]` 无 `[VPortConnect]` | VPort 数据无法在设备↔测试驱动间传输 | 必须配置双向 `[VPortConnect]` |
| 测试驱动缺少对应 VPort 端口 | VPortConnect 连接失败 | 测试驱动 ports 中需有 uart_rx / uart_tx |
| behavior_description 模糊 | 代码生成器无法理解意图 | 明确描述 "CPU 写→设备→VPort→测试驱动" 数据流 |
| **中断驱动 UART 缺少 Pin 端口** | **CPU ISR 永远不触发，FIFO 数据无法被读取** | **添加 INT_PIN (IOPIN) 端口并在 VTE [Connect] 中连接到 CPU 中断引脚** |
| **VTE 缺少 P3 的 PortEnable** | **CPU 无法检测到中断引脚信号变化** | **DeviceProperty 中 PortEnable=1,3 包含 P3** |

### 2.9 Custom/FPGA 设备仿真模式

Custom 和 FPGA 类设备通过 **内存映射寄存器组** 与 CPU 交互，没有标准化的 UART FIFO 模式，但核心原理相同：**注册内存监视 → 拦截读写 → 模拟硬件行为**。

#### SetWatchOnMemoryM 注册（与 UART 相同，必须执行）

```c
case VTT_RESET:
    /* 注册设备完整地址范围 — 遗漏此调用是 custom 设备最常见的 bug */
    vtt.SetWatchOnMemoryM(REG_RANGE_MIN, REG_RANGE_MAX, 2, VTTREADWRITE);
    break;

case VTT_TERMINATE:
    vtt.UnSetWatchOnMemoryM(REG_RANGE_MIN, REG_RANGE_MAX, 2, VTTREADWRITE);
    break;
```

**地址范围确定方法**：从目标软件头文件（如 `m.h`）提取该设备所有 XDATA 地址定义，取最小值和最大值作为 `REG_RANGE_MIN` / `REG_RANGE_MAX`。范围可以略大（包含间隙），不会影响性能。

#### 模式 A: 状态寄存器轮询（CPU 读标志位）

CPU 循环读取状态寄存器等待某个标志位置位。设备必须在 `VTT_MEMREAD` 中构造并**回写**当前状态：

```c
case VTT_MEMREAD:
{
    vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
    if (pe->dwAddress == STATUS_REG) {
        BYTE status = 0;
        if (recv_complete) status |= 0x01;  /* 接收完成标志 */
        if (send_complete) status |= 0x02;  /* 发送完成标志 */
        vtt.WriteByte(pe->dwAddress, 2, status);  /* 必须回写！否则 CPU 读到旧值 */
    }
    break;
}
```

**关键**：`VTT_MEMREAD` 中必须调用 `vtt.WriteByte()` 将当前值写回该地址，CPU 才能读到正确值。这是所有设备类型通用的规则。

#### 模式 B: 写后触发（CPU 写启动寄存器 → 设备执行操作）

典型场景：CPU 写 ADC 启动寄存器 → 设备执行 AD 转换 → 填充数据缓冲区 → 设完成标志。

```c
case VTT_MEMWRITE:
{
    vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
    if (pe->dwAddress == AD_START_REG) {
        BYTE val = vtt.ReadByte(pe->dwAddress, 2);
        if (val == 0x01) {
            /* 执行 AD 转换：填充数据缓冲区 */
            for (int ch = 0; ch < NUM_CHANNELS; ch++) {
                BYTE hi = (adc_values[ch] >> 8) & 0x0F;
                BYTE lo = adc_values[ch] & 0xFF;
                vtt.WriteByte(AD_DATA_BASE + ch * 2, 2, hi);
                vtt.WriteByte(AD_DATA_BASE + ch * 2 + 1, 2, lo);
            }
            /* 设置完成标志 */
            ad_complete = 1;
            vtt.WriteByte(AD_STATE_REG, 2, 0x01);
        }
    }
    break;
}
```

#### 模式 C: 接收缓冲区（外部数据写入 → CPU 逐字节读取）

FPGA 通信接口常用模式：外部数据（通过 VPort 或定时器注入）写入接收缓冲区，CPU 逐字节读取。

```c
/* 外部数据到达（VPort 或定时器注入） */
static void fill_recv_buffer(const BYTE* data, int len) {
    for (int i = 0; i < len && i < RECV_BUF_SIZE; i++) {
        vtt.WriteByte(RECV_BASE + i, 2, data[i]);
    }
    recv_complete = 1;
    vtt.WriteByte(STATUS_REG, 2, 0x01);  /* 通知 CPU 数据就绪 */
}

/* CPU 读取缓冲区数据 — VTT_MEMREAD */
case VTT_MEMREAD:
{
    vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
    if (pe->dwAddress >= RECV_BASE && pe->dwAddress < RECV_BASE + RECV_BUF_SIZE) {
        /* 数据已在 fill_recv_buffer 中写入内存，无需额外操作 */
        /* 但如果需要动态计算，在此 WriteByte 回写 */
    }
    break;
}
```

#### 模式 D: 遥测数据发送（CPU 写缓冲区 → 设备打包发送）

CPU 将遥测数据写入发送区域，写完成标志后设备通过 VPort 发送。

```c
case VTT_MEMWRITE:
{
    vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
    /* CPU 写发送完成寄存器 → 读取缓冲区内容并通过 VPort 发送 */
    if (pe->dwAddress == SEND_TRIGGER_REG) {
        BYTE buf[64];
        for (int i = 0; i < send_len; i++) {
            buf[i] = vtt.ReadByte(SEND_BASE + i, 2);
        }
        vtt.WriteVPort(TX_PORT, buf, send_len);
        /* 设置发送完成标志 */
        vtt.WriteByte(SEND_STATUS_REG, 2, 0x01);
    }
    break;
}
```

#### Custom/FPGA 设计检查清单

- [ ] `VTT_RESET` 中是否调用了 `SetWatchOnMemoryM`，覆盖设备完整地址范围？
- [ ] 所有 CPU 轮询的状态寄存器，`VTT_MEMREAD` 中是否有 `WriteByte` 回写？
- [ ] 所有 CPU 写入的控制/启动寄存器，`VTT_MEMWRITE` 中是否有对应处理？
- [ ] 数据缓冲区读取：数据是否已提前写入内存（通过 `WriteByte`）？
- [ ] 如需与测试驱动交互：是否定义了 VPort 端口并在 VTE 中配置 `[VPortConnect]`？
- [ ] `VTT_TERMINATE` 中是否调用了 `UnSetWatchOnMemoryM`？

### 2.7 编译要求 (VS2013)

| 设置 | 值 | 说明 |
|------|------|------|
| ToolsVersion | 12.0 | VS2013 |
| PlatformToolset | v120 | VS2013 编译器 |
| ConfigurationType | DynamicLibrary | DLL |
| UseOfMfc | Dynamic | MFC 动态链接 (**必须**，vttDevice.h 依赖 `_AFXDLL` + `<afxtempl.h>`) |
| CharacterSet | MultiByte | 多字节字符集 |
| Platform | Win32 | 32 位 (**VTest 是 32 位程序**) |
| .def file | `设备名.def` | 导出 MainProc |
| PrecompiledHeader | stdafx.h | 预编译头 |

## 3. VTE 项目文件格式

VTE 文件是 INI 格式的仿真配置入口。

### 必填 Section

| Section | 格式 | 说明 |
|---------|------|------|
| `[ProjectName]` | `项目名称` | 项目名 |
| `[Cpu]` | `cpu_dll_name` | CPU 模拟器 DLL **纯文件名**（不带目录），VTest 自动从自身 cpu 目录加载。如 `C8052.dll`、`C6713.dll` |
| `[CpuFre]` | `频率值` | CPU 时钟频率 (MHz)，如 `12`、`24`、`100` |
| `[Devices]` | `ID=dll_path` | 设备 DLL 列表。**自己开发的库必须使用绝对路径**；**vtest\system 自带的库仅写动态库名称** |
| `[Connect]` | `数字ID.Pin名,数字ID.Pin名` | Pin 级连接，CPU 固定 **1000**，设备用 `[Devices]` 序号 |
| `[PhyMem]` | `起始地址=大小` | 物理内存映射 (十六进制) |

### 可选 Section

| Section | 格式 | 说明 |
|---------|------|------|
| `[VersionName]` | `版本号` | 软件版本 |
| `[SwiType]` | `CTYPE=SWIQ` 等 | CPU 仿真器类型配置 |
| `[BinFiles]` | `N=绝对路径` | 固件文件，**必须为绝对路径**。支持 ELF、Intel HEX、OMF51 格式。**重要**: Keil C51 编译输出的无扩展名文件（如 `build\prj`）就是 OMF51 格式，可直接使用，不需要转换。OMF51 二进制文件头部是 `0x70` (Module Header Record)，内部嵌入了源文件名文本（如 `STARTUP.A51`），**不要误认为是未编译的源码项目文件** |
| `[BinDll]` | `N=dll_name,参数` | 目标码解析 DLL，默认 `1=binparser.dll,0x0`。OMF51 格式也用 binparser.dll |
| `[SourceFiles]` | `N=绝对路径` | 源码文件 (调试和覆盖率)，**必须为绝对路径** |
| `[Names]` | `ID=device_name` | 设备名称 (**英文变量名风格**，如 `sim_uart`)，`[Connect]` 中引用此名 |
| `[VPortConnect]` | `数字ID.VPort名,数字ID.VPort名` | VPort 虚拟端口连接（同样用数字 ID） |
| `[DeviceProperty]` | `数字ID,属性=值` | 设备初始化参数（CPU=1000） |

### MCS-51 (80C51/80C52) 模拟器参考

MCS-51 CPU 模拟器为 `C8051.dll`（51型）和 `C8052.dll`（52型）。以下是 VTE 配置中必须遵循的规则。

#### CPU DLL

| 型号 | DLL 文件名 | 说明 |
|------|-----------|------|
| 80C51 | `C8051.dll` | 5 个中断源，2 个定时器 |
| 80C52 | `C8052.dll` | 6 个中断源，3 个定时器（含 Timer2） |

`[Cpu]` 中只写文件名，**不带目录**:

```ini
[Cpu]
1=C8052.dll
```

#### 有效引脚列表（源码确认）

C8051.dll 和 C8052.dll 编译时 `PRESENT_P0` 和 `PRESENT_P2` **未定义**，因此 **P0、P2 端口不存在**。只有以下引脚可用:

| 引脚名称 | 类型 | 说明 |
|----------|------|------|
| `P1_0` - `P1_7` | IOPIN | P1 端口 (8 pin)，需 PortEnable 使能 1 |
| `P3_0` - `P3_7` | IOPIN | P3 端口 (8 pin)，需 PortEnable 使能 3 |
| `SERIAL` | VIOPORT | 串行通信（UART 数据收发），无需 PortEnable |

**禁止使用** `P0_x`、`P2_x` 或其他任何不在上表中的引脚名称，VTest 会报"端口不存在"错误。

**P3 端口复用功能**:

| 引脚 | 复用 | 说明 |
|------|------|------|
| `P3_0` | RXD | 串行接收 |
| `P3_1` | TXD | 串行发送 |
| `P3_2` | INT0 | 外部中断 0 |
| `P3_3` | INT1 | 外部中断 1 |
| `P3_4` | T0 | 定时器 0 外部输入 |
| `P3_5` | T1 | 定时器 1 外部输入 |
| `P3_6` | WR | 外部数据写 |
| `P3_7` | RD | 外部数据读 |

#### PortEnable 配置（必须）

必须通过 `[DeviceProperty]` 配置 `PortEnable`，指定 CPU 启用哪些端口。**只有使能的端口才能处理 Pin 连接信号**。

```ini
[DeviceProperty]
1=1000,PortEnable=1,3
```

格式: `PortEnable=端口号1,端口号2`，有效值: **1** (P1) 和 **3** (P3)。P0/P2 不存在，不要使用。

#### 内存配置

MCS-51 模拟器**内置** CODE (type 1) 和 IDATA (type 0) 内存，无需在 `[PhyMem]` 中配置。**VTE 序列化器会自动为 MCS-51 生成固定的 XDATA 内存定义 `1=0x0,0xffff,2`**，无需在 `memory_map` 中手动指定。

```ini
; MCS-51 自动生成，无需手动配置
[PhyMem]
1=0x0,0xffff,2           ; XDATA 64KB (固定值)
```

#### 完整 VTE 配置示例 (MCS-51)

```ini
[ProjectName]
1=PCU_8051_Simulation

[Cpu]
1=C8052.dll

[CpuFre]
1=12

;; BinFiles 必须使用绝对路径，支持 OMF51 格式（无扩展名）
[BinFiles]
1=C:\project\prj\Objects\prj

[BinDll]
1=binparser.dll,0x0

;; SourceFiles 必须使用绝对路径
[SourceFiles]
1=C:\project\prj\code.c
2=C:\project\prj\main.h

[PhyMem]
1=0x0000,0xFFFF,2

;; Devices: 自开发的库使用绝对路径
[Devices]
1=C:\project\.matrix\test-env\sim-models\sim_ext_device.dll
2=C:\project\.matrix\test-env\drivers\test_driver.dll

[Names]
1=sim_ext_device
2=test_driver

;; Connect 必须使用数字设备ID: CPU=1000, 设备=1,2,3,...
[Connect]
1=1000.P3_2,1.PIN_INT
2=1000.P3_0,1.RXD

;; VPortConnect 同样使用数字设备ID
[VPortConnect]
1=1000.SERIAL,1.serial_data

[DeviceProperty]
1=1000,PortEnable=1,3
2=2,ScriptFile=stimuli\baseline_test.txt
```

### C6x (TMS320C6x) DSP 模拟器参考

C6x DSP 模拟器支持 C6713、C6701、C6416 三个型号，共享同一套内核代码，通过编译宏区分外设配置。

#### CPU DLL

| 型号 | DLL 文件名 | 芯片ID | 说明 |
|------|-----------|--------|------|
| C6713 | `C6713.dll` | 0x0203 | 浮点 DSP，含 EDMA、I2C、GPIO |
| C6701 | `C6701.dll` | 0x0202 | 浮点 DSP，含 DMA（非 EDMA） |
| C6416 | `C6416.dll` | 0x0C02 | 定点 DSP，含 EDMA、3 个 McBSP |

> **⚠️ 强制规则**: 用户描述的硬件型号必须精确匹配 `[Cpu]` 中的 DLL。例如用户说"C6713"就**必须**用 `C6713.dll`，**禁止**替换成 C6701 或 C6416。三个型号的外设配置不同（EDMA vs DMA、I2C/GPIO 有无、McBSP 数量），用错 DLL 会导致固件无法运行。

`[Cpu]` 中只写文件名，**不带目录**:

```ini
[Cpu]
1=C6713.dll
```

#### 时钟频率

通过 `[CpuFre]` 设置 CPU 频率（MHz）。典型值:

| 型号 | 典型频率 |
|------|---------|
| C6713 | 225 MHz |
| C6701 | 167 MHz |
| C6416 | 600 MHz |

```ini
[CpuFre]
1=225
```

#### 内存配置（PhyMem — 必须显式配置）

**C6x 不是 MCS-51 架构，`[PhyMem]` 必须显式配置所有内存区域**，不会自动生成。

各型号内存映射:

**C6713**:
```ini
[PhyMem]
1=0x00000000,0x0000FFFF,0    ; 内部程序/数据存储器 64KB
2=0x01800000,0x01B7DFFF,2    ; 外设寄存器空间
3=0x01844000,0x01845FFF,2    ; L2 SRAM 8KB
```

**C6701**:
```ini
[PhyMem]
1=0x00000000,0x0000FFFF,0
2=0x01800000,0x019FFFFF,2
```

**C6416**:
```ini
[PhyMem]
1=0x00000000,0x0000FFFF,0
2=0x01800000,0x01C3FFFF,2
```

内存类型说明: `0` = 内部 RAM（CPU 可直接执行），`2` = 外部/外设映射（不可执行）。

#### 有效引脚列表

**所有型号通用端口**:

| 引脚名称 | 类型 | 说明 |
|----------|------|------|
| `INT4` - `INT7` | IOPIN | CPU 中断线 4-7 |
| `VPORT_MCBSP0` | VIOPORT | McBSP0 数据端口 |
| `VPORT_MCBSP0Ctrl` | VIOPORT | McBSP0 控制端口（帧同步/时钟） |
| `VPORT_MCBSP1` | VIOPORT | McBSP1 数据端口 |
| `VPORT_MCBSP1Ctrl` | VIOPORT | McBSP1 控制端口 |
| `TIMER_0` / `TIMER_1` | IOPIN | 定时器外部时钟 |
| `MCBSP0_RECETIMER` / `SENDTIMER` / `FRAMETIMER` | IOPIN | McBSP0 时钟引脚 |
| `MCBSP1_RECETIMER` / `SENDTIMER` / `FRAMETIMER` | IOPIN | McBSP1 时钟引脚 |

**C6416 专用端口**:

| 引脚名称 | 类型 | 说明 |
|----------|------|------|
| `VPORT_MCBSP2` | VIOPORT | McBSP2 数据端口 |
| `VPORT_MCBSP2Ctrl` | VIOPORT | McBSP2 控制端口 |
| `TIMER_2` | IOPIN | 定时器 2 外部时钟 |
| `MCBSP2_RECETIMER` / `SENDTIMER` / `FRAMETIMER` | IOPIN | McBSP2 时钟引脚 |

**C6713 专用端口**:

| 引脚名称 | 类型 | 说明 |
|----------|------|------|
| `VPORT_GPIO` | VIOPORT | GPIO 数据端口（16 pin） |
| `VPORT_I2C` | VIOPORT | I2C 数据端口 |
| `PIN_I2C0SEND` / `PIN_I2C0RCV` | IOPIN | I2C0 收发引脚 |
| `PIN_I2C1SEND` / `PIN_I2C1RCV` | IOPIN | I2C1 收发引脚 |

**C6701 专用端口**:

| 引脚名称 | 类型 | 说明 |
|----------|------|------|
| `DMA_TIMER` | IOPIN | DMA 同步定时器 |

#### McBSP VPort 通信机制

McBSP 通过 VIOPORT 端口与外设 Driver 交换数据，是 C6x 最关键的外设通信方式。

**端口连接**: 每个 McBSP 有数据端口 (`VPORT_MCBSPx`) 和控制端口 (`VPORT_MCBSPxCtrl`)。当使用外部帧同步或外部时钟时，**必须同时连接控制端口**。

**CPU → Driver 数据格式**（外设收到的 buf[0] 值）:

| buf[0] | 含义 | 数据格式 |
|--------|------|----------|
| `0x11` | 发送 32bit 数据 | buf[1..4] 为 DWORD 格式数据 |
| `0xAA` | 帧同步信号 | 无后续数据 |
| `0xBB` | 帧同步 (FSRM=1) | 内部帧同步模式 |
| `0xCC` | 发送时钟 (CLKXM=1) | 内部时钟脉冲 |
| `0xDD` | 接收时钟 (CLKRM=1) | 内部接收时钟脉冲 |

**Driver → CPU 数据格式**（写入 VPort 的 buf[0] 值）:

| buf[0] | 含义 | 数据格式 |
|--------|------|----------|
| `0x11` | 字节数据 | buf[1] 起逐字节，高位在前 |
| `0x22` | DWORD 数据 | buf[1] 起 32 位 DWORD |
| `0xAA` | 输入帧同步 | 外部帧同步信号 (FSXM=0 时) |
| `0xFF` | 错误/特殊 | buf[2] 表示错误类型 |

**帧同步约束**: 当 McBSP 配置为外部帧同步 (FSXM=0) 时，Driver 发送数据前**必须先发 0xAA 帧同步信号**。

#### 中断触发

C6x 中断通过中断选择器 (MUXH/MUXL) 动态映射，模拟器在 `reset()` 时设置默认映射。外设触发中断使用:

```c
// C6713/C6416: 触发 CPU 中断
trigger_interrupt(事件号);   // 如 trigger_interrupt(4) 触发 EXTINT4

// C6713/C6416: 触发 EDMA 事件
trigger_edma_event(事件号);

// C6701: 同时触发 CPU 中断和 DMA 同步
trigger_interrupt(事件号);
```

常用中断事件号:

| 事件号 | 名称 | 说明 |
|--------|------|------|
| 4-7 | EXTINT4-7 | 外部中断（对应 INT4 - INT7 引脚） |
| 1 | TINT0 | Timer0 中断 |
| 12-13 | XINT0/RINT0 | McBSP0 收发中断 |
| 14-15 | XINT1/RINT1 | McBSP1 收发中断 |

#### 完整 VTE 配置示例 (C6713 + McBSP0 连接 UART 设备)

```ini
[ProjectName]
1=C6713_UART_Project

[Cpu]
1=C6713.dll

[CpuFre]
1=225

[BinFiles]
1=C:\project\build\firmware.out

[BinDll]
1=binparser.dll,0x0

[PhyMem]
1=0x00000000,0x0000FFFF,0
2=0x01800000,0x01B7DFFF,2
3=0x01844000,0x01845FFF,2

[Devices]
1=C:\project\.matrix\test-env\drivers\sim_uart.dll

[Names]
1=sim_uart

;; McBSP0 数据端口 → UART 设备，UART 中断 → CPU INT4
[VPortConnect]
1=1000.VPORT_MCBSP0,1.1

[Connect]
1=1000.INT4,1.PIN_INT
```

#### 完整 VTE 配置示例 (C6416 + 多 McBSP)

```ini
[ProjectName]
1=C6416_MultiMcBSP_Project

[Cpu]
1=C6416.dll

[CpuFre]
1=600

[BinFiles]
1=C:\project\build\firmware.out

[BinDll]
1=binparser.dll,0x0

[PhyMem]
1=0x00000000,0x0000FFFF,0
2=0x01800000,0x01C3FFFF,2

[Devices]
1=C:\project\.matrix\test-env\drivers\sim_1553b.dll
2=C:\project\.matrix\test-env\drivers\sim_uart1.dll
3=C:\project\.matrix\test-env\drivers\sim_uart2.dll

[Names]
1=sim_1553b
2=sim_uart1
3=sim_uart2

[VPortConnect]
1=1000.VPORT_MCBSP0,1.1
2=1000.VPORT_MCBSP1,2.1
3=1000.VPORT_MCBSP2,3.1

[Connect]
1=1000.INT4,1.PIN_INT
2=1000.INT5,2.PIN_INT
3=1000.INT6,3.PIN_INT
```

#### C6x 与 MCS-51 配置差异速查

| 配置项 | MCS-51 | C6x |
|--------|--------|-----|
| `[Cpu]` | `C8052.dll` | `C6713.dll` / `C6701.dll` / `C6416.dll` |
| `[CpuFre]` | 12 (MHz) | 225 / 167 / 600 (MHz) |
| `[PhyMem]` | 自动生成 `1=0x0,0xffff,2` | **必须手动配置**全部区域 |
| `[BinFiles]` | OMF51 无扩展名 | ELF/COFF `.out` 格式 |
| 中断引脚 | `P3_2` (INT0), `P3_3` (INT1) | `INT4` - `INT7` |
| VPort 引脚 | `SERIAL` | `VPORT_MCBSP0` 等 |
| `[Connect]` 方向 | `1000.P3_2,1.PIN_INT` | `1000.INT4,1.PIN_INT` |
| PortEnable | **必须**配置 | **不需要** |
| 外设通信 | UART 通过 SERIAL VPort | McBSP 通过 VPORT_MCBSPx |

### CAN 总线仿真配置

VTest 平台下的 CAN 总线仿真芯片 (SJA1000) 支持两种 CPU 访问模式: **直接寄存器映射**和 **FPGA 转接模式**。两种模式使用同一个 CAN.dll，通过不同属性配置区分。

#### CAN 仿真芯片属性

| 属性 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| WorkMode | 下拉 | Basic | Basic 或 Peli |
| BaseAddress | 数值 | 0x4000 | 寄存器基地址 |
| ExDataAddress | 数值 | 0 | 扩展数据地址（FPGA 模式使用） |
| DataWidth | 下拉 | 1 | 数据位宽: 1/2/4 |
| DataPos | 下拉 | 0 | 数据位置偏移: 0/1/2/3 |
| INT_LEVEL | 下拉 | 0 | 中断电平: 0=低电平, 1=高电平 |
| UseBackLevel | 布尔 | FALSE | 中断后恢复电平 |
| ClockSource(Hz) | 数值 | 7372800 | 时钟源频率 |
| SendFrameDelay(s) | 数值 | 0 | 发送帧延迟 |
| ReceFrameDelay(s) | 数值 | 0 | 接收帧延迟 |
| Channel | 下拉 | 0 | 通道号: 0=CANA, 1=CANB |

#### CAN 引脚

| 引脚名称 | 类型 | 说明 |
|----------|------|------|
| `INT_CAN` | IOPIN | 中断引脚，连接 CPU 中断线 |
| `SERIAL` | VIOPORT | CAN 总线数据端口 |
| `CONTROL` | VIOPORT | 控制端口 |

#### 模式一: 直接寄存器映射

CPU 通过内存映射直接访问 CAN 控制器寄存器。只配置 `BaseAddress`，不设置 `ExDataAddress`。

**适用场景**: CPU 地址总线直接连接 CAN 芯片片选。

```ini
[Devices]
1=CAN.dll

[Names]
1=can_ctrl

[DeviceProperty]
1=1,WorkMode=Peli
2=1,BaseAddress=0x4000
3=1,INT_LEVEL=0
4=1,ClockSource(Hz)=7372800

[Connect]
1=1000.INT4,1.INT_CAN
```

> **注意**: 上述为最小配置。完整测试环境应通过 `vtest_script_generate` 生成测试驱动，并添加 `[VPortConnect]` 将 CAN 设备的 `SERIAL` VPort 与测试驱动连接，以便脚本注入/采集 CAN 帧数据。参见下方 FPGA 转接模式的完整示例。

> **关键**: CAN 的 `BaseAddress`、`WorkMode` 等属性必须通过 `vtest_project_generate` 的 `devices[].properties` 参数传入，**禁止手动编辑 VTE 文件**。工具会根据 `BaseAddress` 自动将 CAN 寄存器区域添加到 `[PhyMem]`。示例调用参数：
> ```json
> {
>   "devices": [
>     {"dll_path": "CAN.dll", "display_name": "can_ctrl", "properties": {"BaseAddress": "0x4000", "WorkMode": "Peli", "INT_LEVEL": "0", "ClockSource(Hz)": "7372800"}}
>   ]
> }
> ```

#### 模式二: FPGA 转接模式

CPU 通过 FPGA 的地址寄存器 + 数据寄存器对间接访问 CAN 控制器。需要同时配置 `BaseAddress`（FPGA 地址寄存器的 CPU 地址）和 `ExDataAddress`（FPGA 数据寄存器的 CPU 地址）。

**适用场景**: DSP/FPGA 架构，CPU 通过 FPGA 转接访问多个 CAN 控制器。

**工作原理**:
1. CPU 写 `BaseAddress` → 仿真芯片保存值作为 CAN 寄存器偏移地址
2. CPU 写 `ExDataAddress` → 仿真芯片将数据写入偏移地址指向的寄存器
3. CPU 读 `ExDataAddress` → 仿真芯片从偏移地址指向的寄存器返回数据

**多通道配置**: 每个 CAN 通道配置为一个独立的 VTest 设备实例。

**完整 VTE 配置示例 (C6713 + FPGA 双通道 CAN + 测试驱动)**:

```ini
[ProjectName]
1=C6713_FPGA_CAN_Project

[Cpu]
1=C6713.dll

[CpuFre]
1=225

[BinFiles]
1=C:\project\build\firmware.out

[BinDll]
1=binparser.dll,0x0

[PhyMem]
1=0x00000000,0x0000FFFF,0
2=0x01800000,0x01B7DFFF,2
3=0x01844000,0x01845FFF,2

[Devices]
1=CAN.dll
2=CAN.dll
3=C:\project\.matrix\test-env\drivers\can_test_driver.dll

[Names]
1=CANA
2=CANB
3=can_test_driver

[DeviceProperty]
;; CANA: FPGA 地址寄存器 0x6000, 数据寄存器 0x6002
1=1,WorkMode=Peli
2=1,BaseAddress=0x6000
3=1,ExDataAddress=0x6002
4=1,DataWidth=1
5=1,DataPos=0
6=1,INT_LEVEL=0
7=1,ClockSource(Hz)=7372800
8=1,Channel=0
;; CANB: FPGA 地址寄存器 0x6001, 数据寄存器 0x6003
9=2,WorkMode=Peli
10=2,BaseAddress=0x6001
11=2,ExDataAddress=0x6003
12=2,DataWidth=1
13=2,DataPos=0
14=2,INT_LEVEL=0
15=2,ClockSource(Hz)=7372800
16=2,Channel=1
;; 测试驱动: 指定脚本和结果文件路径
17=3,ScriptFile=C:\project\.matrix\test-env\scripts\can_test.csv
18=3,ResultFile=C:\project\.matrix\test-env\results\can_result.csv

[VPortConnect]
;; CANA SERIAL ↔ 测试驱动 CANA 端口（双向）
1=1.SERIAL,3.CAN_A
;; CANB SERIAL ↔ 测试驱动 CANB 端口（双向）
2=2.SERIAL,3.CAN_B

[Connect]
1=1000.INT4,1.INT_CAN
2=1000.INT5,2.INT_CAN
```

> **说明**: 测试驱动通过 `vtest_script_generate` 工具生成，其 VPort 端口名称（如 `CAN_A`、`CAN_B`）取决于生成时的配置。`[VPortConnect]` 将 CAN 设备的 `SERIAL` VPort 与测试驱动对应端口双向连接，测试脚本可通过此通道注入/采集 CAN 帧数据。如果当前阶段尚未生成测试驱动，可暂时省略设备 3 及其相关配置，后续补充。

#### 两种 CAN 模式对比

| 配置项 | 直接寄存器映射 | FPGA 转接模式 |
|--------|--------------|-------------|
| BaseAddress | CAN 寄存器组基地址 | FPGA 地址寄存器 CPU 地址 |
| ExDataAddress | **不设置**（默认 0） | FPGA 数据寄存器 CPU 地址 |
| 设备数量 | 通常 1 个 | 每个 CAN 通道 1 个 |
| Channel 属性 | 不需要 | **必须设置**（0 或 1） |
| 典型场景 | 单 CAN 控制器 | DSP+FPGA 多通道 CAN |
| CPU 访问方式 | 直接读写 CAN 寄存器 | 先写地址再读写数据 |

#### 固件驱动参考 (FPGA 模式)

```c
// CAN 写操作: 先写地址，再写数据
void dsp_sja_comm_W(unsigned char can_ch, unsigned char addr, unsigned char data) {
    WriteFPGAReg(CAN_CH_REGADDR[can_ch], addr);   // 写 FPGA 地址寄存器
    WriteFPGAReg(CAN_CH_REGDATA[can_ch], data);   // 写 FPGA 数据寄存器
}

// CAN 读操作: 先写地址，再读数据
unsigned char dsp_sja_comm_R(unsigned char can_ch, unsigned char addr) {
    WriteFPGAReg(CAN_CH_REGADDR[can_ch], addr);   // 写 FPGA 地址寄存器
    return ReadFPGAReg(CAN_CH_REGDATA[can_ch]);    // 从 FPGA 数据寄存器读
}
```

### 格式规则

- 键名为从 1 开始的连续整数
- `[Cpu]` 只写 DLL 文件名（如 `C8052.dll`），**不带目录**，VTest 自动从 cpu/ 目录加载
- `[BinFiles]` 中目标码路径**必须为绝对路径**。VTest 支持 OMF51 格式目标码（无扩展名，如 `build\prj`）。**必须使用 `matrix.jsonc` 中 `firmware.output` 的原始路径，禁止猜测或追加扩展名**（如不能将 `build\prj` 改成 `build\prj.hex`）。`vtest_project_generate` 工具会自动将相对路径从项目根目录解析为绝对路径
- `[SourceFiles]` 中源码路径**必须为绝对路径**
- `[Devices]` 中 DLL 路径规则：**自己开发的虚拟设备库必须使用绝对路径**；**vtest\system 自带的库仅写动态库名称**（不带目录）
- `[Names]` 中设备名称使用**英文变量名风格**（如 `sim_uart`、`sim_adc`、`test_driver`），不使用中文、空格或 DLL 文件名
- `[Connect]` 和 `[VPortConnect]` **必须使用数字设备 ID**（VTE 解析器用 `sscanf("%d.%s")`，不支持名称）: CPU 固定 **1000**，其他设备为 `[Devices]` 中的 1-based 序号
- `[DeviceProperty]` 也**必须使用数字设备 ID**
- 路径最大长度 1024 字符
- 注释以 `;` 开头

### 路径规则速查

| Section | 路径要求 | 示例 |
|---------|---------|------|
| `[Cpu]` | 仅动态库名称 | `C8052.dll` |
| `[BinFiles]` | **绝对路径** | `C:\project\prj\Objects\prj` (OMF51 无扩展名也支持) |
| `[SourceFiles]` | **绝对路径** | `C:\project\prj\code.c` |
| `[Devices]` (自开发) | **绝对路径** | `C:\project\.matrix\test-env\sim-models\sim_uart.dll` |
| `[Devices]` (系统自带) | 仅动态库名称 | `binparser.dll` |
| `[BinDll]` | 仅动态库名称 | `binparser.dll` |

### 示例

```ini
[ProjectName]
1=PCU Simulation

[Cpu]
1=arm_cortex_m4

[CpuFre]
1=168000000

;; BinFiles 必须使用绝对路径
[BinFiles]
1=C:\project\build\pcu_firmware.elf

[BinDll]
1=binparser.dll,0x0

;; SourceFiles 必须使用绝对路径
[SourceFiles]
1=C:\project\src\pcu_main.c
2=C:\project\src\pcu_hal.c

;; Devices: 自开发的库使用绝对路径
[Devices]
1=C:\project\.matrix\test-env\sim-models\vdev_adc.dll
2=C:\project\.matrix\test-env\sim-models\vdev_uart.dll
3=C:\project\.matrix\test-env\sim-models\vdev_gpio.dll

[Names]
1=sim_adc
2=sim_uart
3=sim_gpio

;; Connect 使用数字ID: CPU=1000, 设备=1,2,3
[Connect]
1=1.adc_ch0,1000.ADC1_DR_CH0
2=2.tx_data,1000.USART1_DR
3=3.out0,1000.GPIOA_PIN0

[PhyMem]
1=0x08000000,0x080FFFFF,0
2=0x20000000,0x2002FFFF,0
```

## 4. 测试脚本格式

```
#<仿真时间(秒)>,<指令名称>,<参数列表>
```

- **指令名称必须符合 C 语言变量名规则**: 仅允许字母、数字、下划线，不能以数字开头，**禁止中文和特殊字符**
- 参数使用 `|` 分隔多个键值对，`=` 分隔键和值
- 时间值必须单调递增
- 注释以 `;;` 开头
- 每条指令执行时会自动打印 (`vtt.AddLog`) 并记录到接口数据文件 (`.txt`)

### 常用命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `set_adc_input` | `ch0=val\|ch1=val\|...` | 注入 ADC 原始值 (uint16) |
| `read_gpio_state` | `pin=名称` | 读取 GPIO 输出引脚状态 |
| `read_pwm_state` | `ch=索引` | 读取 PWM 占空比 |
| `inject_uart_rx` | `data=十六进制字节` | 注入 UART RX 帧 |
| `capture_uart_tx` | `count=数量` | 捕获 UART TX 帧 |
| `inject_gpio_input` | `pin=名称\|value=0或1` | 注入离散输入信号 |
| `stop_simulation` | `reason=原因` | 结束仿真运行 |

### 接口数据记录

测试驱动在运行期间自动将所有接口数据（串口收发、AD 输入输出、GPIO 状态等）记录到 CSV 格式文件:

- 默认路径与结果 JSON 文件同目录，扩展名为 `.csv`
- 可通过 `[DeviceProperty]` 设置 `RecordFile=<路径>` 指定
- 记录内容包括: 指令执行、VPort 数据收发（含十六进制数据）、Pin 信号变化
- **日志策略**: `vtt.AddLog` 仅用于打印 VPort 传输、测试命令执行等重要事件；Pin 信号变化等频繁事件只写入记录文件，不调用 `AddLog`

### 示例

```
; 指令名称必须为合法 C 标识符
#0.0,set_adc_input,ch0=2867|ch1=2048|ch2=3043|ch3=2458|ch4=3277|ch5=1638
#1.0,read_gpio_state,pin=out0
;; 预期: solar_relay = 1
#3.0,set_adc_input,ch0=3440|ch1=2458|ch2=3330|ch3=1229|ch4=3631|ch5=1638
#3.0002,read_gpio_state,pin=out0
;; 预期: solar_relay = 0 (过压保护 200μs 内断开)
#10.0,stop_simulation,reason=test_complete
```

## 4.5 Phase A 完整性检查（生成后、编译前必须执行）

在进入编译阶段前，**对照 Step 0 中识别的硬件接口列表，逐一确认**：

1. 每个硬件接口是否都有对应的虚拟设备 DLL 生成（通过 `vtest_device_generate`）
2. test_driver 是否已生成（通过 `vtest_script_generate`），且包含所有需要的 VPort 端口
3. VTE 项目文件是否已生成（通过 `vtest_project_generate`），且：
   - `devices` 列表包含所有设备 + test_driver
   - test_driver 的 `properties` 包含 `ScriptFile` 和 `ResultFile`
   - `pin_connections` 和 `vport_connections` 覆盖所有设备间连接
4. 将检查结果写入 execution-log.md：已生成/缺失的设备列表

**常见遗漏**：
- 看门狗设备（仅有 Pin 连接，容易忽略）
- test_driver 缺少 ScriptFile 属性（导致运行时 0 commands loaded）
- UART/RS422 设备的 VPort 连接只连了 CPU←→设备，忘了连 设备←→test_driver

**如果有遗漏，补充生成后再进入编译阶段。**

## 5. 编译验证（必须执行）

生成所有虚拟设备 DLL 源文件后，**必须使用 VS2013 编译**验证通过。VTest DLL 依赖 MFC，GCC/MinGW 无法编译。

### 步骤

1. **确保 vttDevice.h 可访问**: 设置 include 路径指向 VTest 安装目录
2. **使用 `vtest_compile` 工具编译**（禁止用 bash 调用 MSBuild — 中文输出会乱码）:
   ```
   vtest_compile(sln_path=".matrix/test-env/vtest-devices.sln", configuration="Debug", platform="Win32")
   ```
   - 工具自动从 `matrix.jsonc` 的 `vs2013_path`、默认路径、或常见 VS 安装路径解析 MSBuild.exe
   - 返回结构化结果: `status`（success/failed）、`errors`、`warnings`、`dll_files`
   - 并行编译已自动启用（`/m` 参数）
3. **处理编译失败**: 分析 `errors` 数组中的错误信息 → 修复源码 → 再次调用 `vtest_compile`，最多 10 轮
4. **仍失败**: 在 `env-design.json` 中设 `baseline_status = "编译失败"` 并报告

### 编译检查清单

- [ ] 所有设备 DLL 编译零 error（VS2013 v120 toolset, Win32）
- [ ] MFC 动态链接正确（`UseOfMfc=Dynamic`）
- [ ] `MainProc` 通过 .def 文件正确导出
- [ ] `struct VTTFUNCS vtt;` 在 stdafx.cpp 中声明且唯一
- [ ] `vtt.ConfirmDevID(pData)` 在 MainProc 入口处调用
- [ ] `vtt.GetFunctionPointers(dwParam, pData)` 在 VTT_INIT 中调用
- [ ] 端口数组类型为 `vttPORT[]`，VTT_QPORTS 返回 `(vttRES)gPorts`
- [ ] 预编译头 stdafx.h 包含 vttDevice.h

## 9. 环境验证流程（编译后必须执行）

编译成功后，按以下顺序调用 `vtest_runner` 工具验证环境。所有 vtestc 操作都通过此工具完成，禁止用 bash 直接调用 vtestc.exe。

### Step 1: 静态检查（不需要 vtestc）

```
vtest_runner(project_file=".matrix/test-env/project.vte", action="validate_static")
```

检查 VTE 文件格式：必需 section 是否完整、设备 ID 是否一致、内存地址是否重叠。

### Step 2: 加载验证（需要 vtestc）

```
vtest_runner(project_file=".matrix/test-env/project.vte", action="validate")
```

vtestc 加载+初始化（不运行仿真）。检查引脚名、DLL 加载、VM 初始化。
- `status="valid"` → 继续 Step 3
- `status="invalid"` → 读取 `errors` 数组中的 `category` + `suggestion`，修复后重试（最多 5 次）
- 无法修复的错误 → 报告用户，等待确认

### Step 3: 仿真运行

```
vtest_runner(project_file=".matrix/test-env/project.vte", action="run", timeout_ms=60000)
```

完整仿真执行。返回结果自动包含设备 I/O 诊断（`diagnostics` 字段）。
- `status="completed"` 或 `status="device_exit"` → 检查 `test_results` 和 `diagnostics`
- `status="timeout"` → 增大 timeout 或检查死循环
- `status="error"` → 查看 `log_summary.errors`
- `error="vtestc_crash"` → **vtestc 进程崩溃**，见下方崩溃处理流程

> **🔴 vtestc 崩溃识别与处理**
>
> vtestc 崩溃的典型返回：`status="error"`, `error="vtestc_crash"`, stdout 为空。
> 崩溃与正常错误的区别：正常错误会返回 JSON 事件流和 log 消息；崩溃时 **没有任何输出**。
>
> **最常见原因**：设备 DLL 编译使用了**错误的 vttDevice.h**（自创的简化版 vs 真实的 750 行版本），导致：
> - struct 大小不匹配（vtestc 传 12 字节 vttParamMemoryEvent，DLL 期望 16 字节）
> - enum 值偏移（vtestc 发送 VTT_INIT=1，DLL 将其解释为 VTT_QSIZE）
> - VTTFUNCS 函数指针偏移（调用 AddLog 实际跳到 ReadByte 的地址）
>
> **崩溃处理流程**：
> 1. 检查 `.matrix/test-env/include/vttDevice.h` 是否为真实文件（应约 750 行，包含 `class VTTFUNCS`）
> 2. 如果是自创文件（约 100-200 行，`struct VTTFUNCS`），立即用真实文件替换
> 3. 替换后必须**重新编译所有 DLL**（`vtest_compile`）再重新运行
> 4. 如果 vttDevice.h 正确但仍崩溃，检查 DLL 是否为 32 位（Win32）、是否链接了正确的 MFC 版本

### Step 4: 深度诊断（仅在 Step 3 结果异常时）

```
vtest_runner(project_file=".matrix/test-env/project.vte", action="diagnose", timeout_ms=10000)
```

短超时运行 + 设备 I/O 模式分析。返回 `report` 字段包含：设备计数器、连接性问题、FIFO 溢出、校验和错误等。

### Step 5: 强制诊断检查（每次 Phase C 运行后必须执行）

> **⚠ 此步骤不可跳过**，即使 Step 3 返回 `status="completed"` 且基线测试全部通过。基线测试只验证框架加载（DLL 加载、CPU 初始化等），**不验证设备功能**。

1. 调用 `vtest_runner(action="diagnose", timeout_ms=10000)` 获取设备诊断计数器
2. 检查 `diagnostics.device_summaries` 中每个设备的 `counters`：
   - 任何非纯 Pin 设备的 `memread=0 AND memwrite=0` → **必须进入 Phase D (Section 10)**
   - UART 设备 `vport_tx=0` → **必须进入 Phase D**
3. 如果 `diagnostics.issues` 数组不为空 → **必须进入 Phase D**
4. 将诊断结果写入 `execution-log.md`，包含**每个设备的完整计数器值**（MEMREAD, MEMWRITE, VPORT_TX, VPORT_RX, FIFO_PUSH, FIFO_POP, FIFO_OVF）
5. **只有所有设备诊断正常**（所有非 Pin 设备 MEMREAD+MEMWRITE>0），才能声明环境构建完成

**禁止**仅凭基线测试通过就跳过此步骤或声明"环境构建完成"。

### 错误处理原则

- 工具返回的 `errors[].suggestion` 已包含具体修复建议，按建议操作即可
- 可自动修复：引脚名错误（从设备源码 gPorts[] 找到正确名称）、DLL 缺失（重新编译）
- 必须报告用户：连续 3 次重试仍失败、`unknown` 类型错误、无法确定引脚映射

---

## 10. Phase D: 仿真调试循环（C3 诊断异常时触发）

> **⚠ Phase D 不是可选步骤**。Section 9 Step 5 的诊断检查如果发现任何设备异常（MEMREAD=0、VPORT_TX=0 等），**必须**进入 Phase D 修复后才能声明环境构建完成。跳过 Phase D 直接报告"环境已就绪"是不可接受的。

Phase C 验证运行后，如果设备诊断结果异常（如 MEMREAD=0、MEMWRITE=0），进入 Phase D 闭环调试。**目标**：根据诊断计数器和目标软件源码，自动定位问题并修复设备 DLL，直到所有设备正常工作。

### 10.1 触发条件

Phase C (Step 3/4) 返回的 `diagnostics` 中出现以下任一情况即触发 Phase D：

| 条件 | 说明 |
|------|------|
| 非 Pin 设备 MEMREAD=0 且 MEMWRITE=0 | 设备完全未收到内存访问（排除纯 Pin 设备如看门狗） |
| UART 设备 MEMREAD>0 但 VPORT_TX=0 | 有内存交互但无数据输出，协议逻辑未触发 |
| UART 设备 FIFO_PUSH=0 且 VPORT_RX=0 | 无外部数据注入或帧完整性检测阻止入队 |
| 任何设备 FIFO_OVF>0 | FIFO 溢出，处理速度跟不上或未消费 |

**不触发 Phase D 的情况**：
- 纯 Pin 设备（如看门狗）MEMREAD=0 是正常行为
- 所有设备 MEMREAD+MEMWRITE>0 且 UART 的 VPORT_TX>0

### 10.2 D1: 诊断分析 — 解读设备计数器

根据 `diagnostics` 中每个设备的计数器值，使用以下决策树定位问题：

| MEMREAD | MEMWRITE | VPORT_TX | VPORT_RX | FIFO_POP | 诊断结论 | 修复方向 |
|---------|----------|----------|----------|----------|---------|---------|
| 0 | 0 | 0 | 0 | — | **未注册 SetWatchOnMemoryM** 或地址范围错误 | → D4 Pattern 1: 检查 VTT_RESET |
| >0 | 0 | — | — | — | CPU 只读不写，可能是只读状态寄存器设备 | → 可能正常，检查源码确认 |
| >0 | >0 | 0 | 0 | — | 有内存交互但无 VPort 输出，协议触发条件未满足 | → D2 源码追踪 |
| >0 | >0 | 少量 | 0 | — | UART TX 有少量输出但无 RX，帧组装可能有 bug | → D4 Pattern 5: 检查 frame_complete |
| >0 | >0 | >0 | >0 | 0 | VPort 收到数据但未入 FIFO | → D4 Pattern 5: 帧校验/长度检测 |
| >0 | >0 | >0 | 0 | 0 | **⚠ 中断驱动检查**: 固件可能用中断接收，但设备缺少中断 Pin 或 VTE 缺少 Connect | → **D2 源码追踪中断路径** + D4 Pattern 4 |
| >0 | >0 | >0 | >0 | >0 | 基本正常 | → 检查具体测试结果 |

> **⚠ 中断路径诊断规则**：当 UART 设备 MEMREAD>0、MEMWRITE>0（设备本身工作），但 VPORT_RX=0（测试驱动未发送数据）或 FIFO_POP=0（FIFO 数据未被消费），**必须检查固件是否使用中断驱动接收**：
> 1. 在源码中搜索 `interrupt 0`、`interrupt 2` 等外部中断 ISR
> 2. 如果 ISR 中读取了该设备的寄存器地址（如 `XBYTE[0x4000]`），确认为中断驱动模式
> 3. 检查设备 DLL 是否有 Pin 端口（`IOPIN` 类型）用于中断输出
> 4. 检查 VTE `[Connect]` 中是否将该 Pin 连接到 CPU 对应中断引脚（如 `1000.P3_2`）
> 5. 如缺失 → 进入 D4 Pattern 4 修复

**操作步骤**：
1. 读取 Phase C 诊断结果，按上表分类每个设备
2. 将分析结果写入 `execution-log.md` 的 Phase D 章节
3. 对每个异常设备，进入 D2-D5 修复流程

### 10.3 D2: 源码追踪 — 从目标软件代码定位预期行为

当诊断发现设备异常时，**必须从目标软件源码反推设备应有的行为**，而不是凭假设修改。

**追踪步骤**：

1. **提取地址定义**：从头文件（如 `m.h`）中提取该设备相关的所有 XDATA 地址宏定义
2. **搜索地址访问**：在源码（如 `code.c`）中 grep 每个地址的 `XBYTE[]` 访问，记录：
   - 哪些函数访问了这些地址
   - 是读操作还是写操作
   - 访问的触发条件（在哪个函数中、由什么事件驱动）
3. **建立映射表**：

   ```
   设备: sim_fpga_adc
   ┌──────────────┬──────────┬──────────┬──────────────────────────────┐
   │ 地址         │ 方向     │ 函数     │ 触发条件                     │
   ├──────────────┼──────────┼──────────┼──────────────────────────────┤
   │ 0x2020       │ CPU 写   │ AD_Read  │ 主循环调用，写 0x01 启动转换 │
   │ 0x2021       │ CPU 读   │ AD_Read  │ 轮询等待 bit0=1 (转换完成)  │
   │ 0x2030-0x204D│ CPU 读   │ AD_Read  │ 完成后逐字节读取 30 字节    │
   └──────────────┴──────────┴──────────┴──────────────────────────────┘
   ```

4. **对比设备 DLL**：检查设备 DLL 的实现是否覆盖了上述所有访问模式：
   - `SetWatchOnMemoryM` 范围是否覆盖所有地址？
   - `VTT_MEMWRITE` 是否处理了 CPU 的写操作？
   - `VTT_MEMREAD` 是否对状态寄存器 `WriteByte` 回写了正确的值？

**示例推导规则**：

```
IF 源码中有 XBYTE[0x2020] = 0x01  (AD_start_reg 写操作)
AND sim_fpga_adc 的 VTT_RESET 未注册 0x2020-0x204D 的内存监视
THEN:
  1. 添加 vtt.SetWatchOnMemoryM(0x2020, 0x204D, 2, VTTREADWRITE)
  2. VTT_MEMWRITE 中处理 0x2020 写入（启动 AD 转换）
  3. VTT_MEMREAD 中处理 0x2021 读取（返回完成标志）
  4. VTT_MEMREAD 中处理 0x2030+ 读取（返回 AD 数据）
```

### 10.4 D3: 断点验证 — 确认 CPU 执行路径

当需要确认 CPU 是否执行到了特定代码路径时，使用 `vtest_runner` 的断点功能。

**使用场景**：
- D2 追踪发现某函数应该访问设备地址，但诊断显示 MEMREAD/MEMWRITE 仍为 0
- 需要确认前置条件是否满足（如中断是否触发、标志位是否设置）

**操作方法**：

1. **获取函数地址**：从编译输出的 `.lst` 文件或 `.map` 文件获取目标函数入口地址
2. **设置断点运行**：
   ```
   vtest_runner(
     project_file=".matrix/test-env/project.vte",
     action="run",
     timeout_ms=30000,
     breakpoints=["0x1234", "0x5678"]
   )
   ```
3. **分析结果**：
   - 断点命中 → CPU 确实执行到该函数，问题在设备侧
   - 断点未命中 → 前置条件不满足（如中断未使能、定时器未启动、标志位未设置），需要先解决前置问题

**注意**：断点验证是辅助手段，优先通过 D2 源码分析定位问题。仅在分析结论不确定时使用断点确认。

### 10.5 D4: 设备修复 — 5 种常见修复 Pattern

以下是生成代码中最常见的 5 类缺陷及对应修复模板。修复时 **直接编辑设备 `.cpp` 源文件**（在 `vtest_device_generate` 生成的基础上修改）。

#### Pattern 1: 缺失 SetWatchOnMemoryM（最常见）

**症状**：MEMREAD=0, MEMWRITE=0（但设备地址范围正确）

```c
/* VTT_RESET 中添加: */
vtt.SetWatchOnMemoryM(REG_MIN, REG_MAX, 2, VTTREADWRITE);

/* VTT_TERMINATE 中添加: */
vtt.UnSetWatchOnMemoryM(REG_MIN, REG_MAX, 2, VTTREADWRITE);
```

**确定地址范围**：从 D2 建立的映射表取最小和最大地址。

#### Pattern 2: 缺失 VTT_MEMREAD 状态寄存器回写

**症状**：MEMREAD>0 但 CPU 读到的值总是 0 或旧值，导致轮询循环无法退出

```c
case VTT_MEMREAD:
{
    vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
    if (pe->dwAddress == STATUS_REG) {
        BYTE status = 0;
        if (operation_complete) status |= COMPLETE_FLAG;
        vtt.WriteByte(pe->dwAddress, 2, status);  /* 必须回写！ */
    }
    break;
}
```

#### Pattern 3: 缺失 VTT_MEMWRITE 触发逻辑

**症状**：MEMWRITE>0 但设备无响应（无 VPort 输出、无状态变化）

```c
case VTT_MEMWRITE:
{
    vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
    BYTE val = vtt.ReadByte(pe->dwAddress, 2);
    if (pe->dwAddress == START_REG && val == TRIGGER_VALUE) {
        /* 执行操作：填充数据、设置完成标志等 */
        perform_operation();
        vtt.WriteByte(STATUS_REG, 2, COMPLETE_FLAG);
    }
    break;
}
```

#### Pattern 4: UART 缺失中断触发（中断驱动接收不工作）

**症状**：UART 设备 MEMREAD>0、MEMWRITE>0，可能 VPORT_TX>0，但 FIFO_POP=0（CPU 从未读取 FIFO 数据）。根因通常是固件使用外部中断（`interrupt 0` 等）接收数据，但设备缺少中断 Pin 或 VTE 缺少 Pin 连接。

**完整修复步骤**（按顺序执行）：

**Step 1: 确认固件中断模式**
```
在源码中搜索: interrupt 0, interrupt 2 等外部中断 ISR
如果 ISR 中读取了该设备��� XDATA 寄存器 → 确认为中断驱动接收
记录: 中断号(0=INT0/P3_2, 2=INT1/P3_3) 和触发方式(电平/边沿)
```

**Step 2: 添加中断 Pin 端口到设备 DLL**
```c
/* 在 PORT_ID enum 中添加 INT_PIN */
enum DEVICE_PORT_ID {
    TX_DATA = 0,
    RX_DATA = 1,
    INT_PIN = 2,    /* ← 新增 */
    PORT_COUNT = 3, /* ← 更新计数 */
};

/* 在 gPorts 数组中添加 */
static vttPORT gPorts[PORT_COUNT] = {
    { TX_DATA,  "TX_DATA",  VIOPORT },
    { RX_DATA,  "RX_DATA",  VIOPORT },
    { INT_PIN,  "INT_PIN",  IOPIN },   /* ← 新增，必须是 IOPIN */
};
```

**Step 3: 在 VTT_VWBYTES 中添加中断触发**
```c
/* 在 FIFO push 之后添加: */
if (g_rx_fifo.count > 0) {
    vtt.PinConnect(INT_PIN, 0);  /* 低电平触发外部中断 */
}
```

**Step 4: 在 VTT_MEMREAD 的 rx_data 寄存器处理中添加中断释放**
```c
if (pe->dwAddress == REG_UART) {
    BYTE rxByte = 0;
    fifo_pop(&rxByte);
    vtt.WriteByte(pe->dwAddress, 2, rxByte);
    /* FIFO 空时释放中断 */
    if (g_rx_fifo.count == 0) {
        vtt.PinConnect(INT_PIN, 1);  /* 恢复高电平 */
    }
}
```

**Step 5: 更新 VTE 项目文件**
```ini
;; 在 [Connect] 中添加中断引脚连接
;; INT0 → P3_2, INT1 → P3_3
N=1000.P3_2,<设备ID>.INT_PIN

;; 确保 DeviceProperty 中 CPU 的 PortEnable 包含 P3
N=1000, PortEnable=1,3
```

**Step 6: 重编译 + 重验证**（按 D5 步骤）

**验证标准**：修复后诊断应显示 FIFO_POP>0 且 FIFO_PUSH>0（FIFO 有数据进出），表明中断驱动接收通路建立。

#### Pattern 5: 帧长度/完成检测缺失

**症状**：UART 收到 VPort 数据（VPORT_RX>0）但 FIFO_PUSH=0（帧完整性检测失败）

```c
/* 在帧接收逻辑中，根据协议格式确定帧长度 */
/* 方式 A: 固定长度帧 */
if (g_rx_frame.pos >= FIXED_FRAME_LENGTH) {
    g_rx_frame.frame_complete = 1;
}

/* 方式 B: 包含长度字段的帧 */
if (g_rx_frame.pos == HEADER_LEN + LENGTH_FIELD_OFFSET + 1) {
    g_rx_frame.expected_len = HEADER_LEN + g_rx_frame.buffer[LENGTH_FIELD_OFFSET] + CHECKSUM_LEN;
}
if (g_rx_frame.expected_len > 0 && g_rx_frame.pos >= g_rx_frame.expected_len) {
    g_rx_frame.frame_complete = 1;
}
```

### 10.6 D5: 重编译 + 重验证

修改设备源码后，按以下步骤验证修复效果：

1. **编译**: `vtest_compile(sln_path=".matrix/test-env/vtest-devices.sln")`
2. **加载验证**: `vtest_runner(action="validate")`
3. **短时间运行**: `vtest_runner(action="run", timeout_ms=30000)` — 用较短超时快速验证
4. **检查诊断**: 对比修复前后的设备计数器

将每轮修复的操作和结果追加写入 `execution-log.md`：
```markdown
## Phase D: 仿真调试循环

### D-Round 1
**异常设备**: sim_fpga_adc (MEMREAD=0, MEMWRITE=0)
**诊断**: 缺失 SetWatchOnMemoryM
**修复**: 在 VTT_RESET 中添加 vtt.SetWatchOnMemoryM(0x2020, 0x204D, 2, VTTREADWRITE)
**编译**: ✅ 成功
**验证**: MEMREAD=152, MEMWRITE=48 → ✅ 修复成功
```

### 10.7 迭代退出条件

| 条件 | 动作 |
|------|------|
| 所有非 Pin 设备 MEMREAD + MEMWRITE > 0 | ✅ 退出 Phase D |
| UART 设备 VPORT_TX > 0 且 VPORT_RX > 0（双向数据通路建立） | ✅ 该设备调试完成 |
| 单个设备连续 3 轮修复无改善 | ⚠ 标记为需人工介入，继续修复其他设备 |
| 总计 5 轮迭代仍有设备异常 | ⚠ 报告用户剩余问题，退出 Phase D |

**每轮迭代只修复一个设备的一个问题**（避免同时改多处导致无法判断修复效果）。

---

## 6. 常见错误清单

| 错误 | 症状 | 修复 |
|------|------|------|
| 未调 `vtt.ConfirmDevID(pData)` | 多设备实例时 ID 混乱 | MainProc 入口处 switch 之前调用 |
| `VTT_INIT` 未调 `GetFunctionPointers` | 运行时所有 API 调用崩溃 | 添加 `vtt.GetFunctionPointers(dwParam, pData)` |
| `GetFunctionPointers` 参数顺序错误 | API 函数指针为 NULL | 第一参数是 dwParam (HINSTANCE)，第二是 pData |
| VTT_QPORTS 返回方式错误 | 端口连接失败 | 必须 `return (vttRES)gPorts`，不是通过 pData 指针 |
| MainProc 签名错误 | VTest 无法调用设备 | 必须是 `extern "C" vttRES WINAPI MainProc(vttMESSAGE, void*, DWORD)` |
| 缺少 .def 导出文件 | MainProc 符号未导出 | 添加 .def 文件导出 MainProc |
| 未使用 MFC 编译 | 编译失败 (afxtempl.h) | vcxproj 设置 `UseOfMfc=Dynamic`，VS2013 编译 |
| VTTFUNCS 放在设备结构体中 | 多设备实例覆盖函数指针 | 必须在 stdafx.cpp 中声明全局 `struct VTTFUNCS vtt;` |
| Pin 名与 VTE [Connect] 不匹配 | 连接建立失败 | 统一 DLL 端口名和 VTE 配置名 |
| [PhyMem] 内存区间重叠 | 仿真内存访问异常 | 检查 Flash/SRAM/外设地址不重叠 |
| [Devices] ID 不连续 | 设备加载顺序异常 | ID 从 1 开始连续递增 |
| 定时器回调中未用 `DevID()` | 多设备实例时混乱 | 通过 `vtt.DevID()` 获取当前设备 ID |

## 7. 模板文件

本技能的 `templates/` 目录下提供经过验证的代码模板：

| 文件 | 用途 |
|------|------|
| `vdev_template.c` | 通用虚拟设备 DLL 骨架 — 正确的 MainProc 签名和 VTT 消息处理 |
| `stdafx.h` | 预编译头 — 包含 MFC 和 vttDevice.h |
| `stdafx.cpp` | 预编译头源 — 声明全局 `struct VTTFUNCS vtt;` |
| `targetver.h` | SDK 版本目标 |
| `device_template.def` | DLL 导出定义 — 导出 MainProc |
| `project_template.vte` | VTE 项目文件模板 — 包含所有 Section 占位 |
| `test_script_template.txt` | 测试脚本模板 — 包含格式规范和常用命令 |

**使用方式**: 读取模板 → 复制为目标文件 → 替换占位内容 → `vtest_compile` 工具编译验证。

## 8. 测试驱动使用手册

`vtest_script_generate` 工具在生成测试驱动 DLL 和基线测试脚本的同时，会自动生成一份 **测试驱动使用手册** (`<driver-name>-manual.md`)，输出到 `.matrix/test-env/drivers/` 目录。

### 手册内容

| 章节 | 内容 |
|------|------|
| 概述 | 测试驱动工作原理（脚本加载 → 定时执行 → 结果输出） |
| VTE 配置 | 如何在 .vte 文件中注册测试驱动并通过 DeviceProperty 指定脚本路径 |
| 端口列表 | 测试驱动所有 VPort 端口名称和类型 |
| 脚本格式 | `#<时间>,<指令>,<参数>` 格式规范和语法规则 |
| 测试指令参考 | 每条可用测试指令的名称、参数、关联接口和预期响应 |
| 样例测试脚本 | 基于项目配置生成的完整可运行样例脚本 |
| 测试结果输出 | 结果 JSON 格式说明和字段定义 |
| 编译说明 | MSBuild 编译命令和环境要求 |

手册中的测试指令参考和样例脚本是根据 `test_items` 参数自动提取的，确保与实际生成的测试脚本完全一致。

