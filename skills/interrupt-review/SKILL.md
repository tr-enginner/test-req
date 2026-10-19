---
name: interrupt-review
description: "中断数据访问冲突审查方法论：C1-C5五类冲突模式识别、保护原语动态发现、冲突判定规则"
metadata:
  agent: "isr-reviewer"
  category: "quality"
---

# 中断数据访问冲突审查方法论

本技能指导 ISR-Reviewer 智能体系统化审查嵌入式软件中ISR（中断服务例程）与非ISR代码之间的共享变量访问冲突。

核心原则：
1. **动态发现**：保护原语基于编译环境和项目代码动态推断，不预设固定模式
2. **全局视角**：一次扫描整个项目，建立完整的共享变量图谱
3. **volatile ≠ 安全**：volatile 只防编译器优化，不防多指令分裂

---

## 1. 五类冲突模式（C1–C5）

### C1: 原子变量不同步

**定义**：单个变量在源码级的一次访问操作涉及多个步骤（如结构体的多字段赋值），ISR在步骤间抢占导致变量内容不一致。

**典型场景**：
```c
// 主循环中
typedef struct { uint16_t x; uint16_t y; } Point;
volatile Point position;  // volatile 不保护多字段赋值的原子性

void update_position(uint16_t new_x, uint16_t new_y) {
    position.x = new_x;  // ← ISR 可能在此处抢占
    position.y = new_y;  // ← 导致 ISR 读到 (new_x, old_y)
}

// ISR 中
void Timer_IRQHandler(void) {
    Point p = position;   // 可能读到不一致的 (new_x, old_y)
    process(p.x, p.y);
}
```

**检测要点**：
- 识别源码级多步赋值/读取的变量（结构体、联合体多字段操作）
- 检查多步操作是否在关中断保护内
- volatile 修饰不能替代关中断保护

### C2: 数组变量多步骤访问

**定义**：数组的多个元素在源码级分多步读写（循环遍历、逐元素拷贝），ISR在步骤间抢占导致元素间数据不一致。

**典型场景**：
```c
volatile uint16_t adc_buffer[8];

// ISR: DMA 完成后更新缓冲区
void DMA_IRQHandler(void) {
    for (int i = 0; i < 8; i++)
        adc_buffer[i] = DMA_DATA[i];
}

// 主循环: 逐元素拷贝处理
void process_adc(void) {
    uint16_t local[8];
    for (int i = 0; i < 8; i++)
        local[i] = adc_buffer[i];  // ISR 可能在循环中间更新 buffer
    // local[] 中前几个元素来自旧数据，后几个来自新数据
    compute_average(local, 8);
}
```

**检测要点**：
- 识别对共享数组的循环遍历或逐元素操作
- 检查整个遍历序列（不是单个元素访问）是否在关中断保护内
- 双缓冲模式（读写缓冲区分离 + 原子索引切换）视为有效保护

### C3: 超字长变量编译级分裂

**定义**：变量宽度超过处理器字长，编译器将一次访问拆为多条 load/store 指令，ISR在指令间抢占导致变量内数据不一致。

**典型场景**：
```c
// 8位 MCU (字长 = 8 bit)
volatile uint32_t system_tick;  // 32位 → 编译为4字节操作

// ISR
void Timer_IRQHandler(void) {
    system_tick++;  // 编译为: load 4 bytes → add → store 4 bytes
}

// 主循环
uint32_t get_tick(void) {
    return system_tick;  // 编译为 4 次单字节 load
    // ISR 可能在第2字节和第3字节 load 之间更新，导致读到混合值
}
```

**检测要点**：
- **关键前提**：必须知道处理器字长（从 `target_cpu` 推断）
- 变量类型宽度 > 处理器字长 → 存在 C3 风险
- 常见超字长类型（按平台）：
  - 8位MCU: uint16_t, uint32_t, float, double, 所有多字节结构体
  - 16位MCU: uint32_t, float, double, 64位类型
  - 32位MCU: uint64_t, double (部分平台), 大结构体
- volatile 不能防止此类分裂！volatile 只保证编译器逐字节访问而非优化到寄存器，但每次字节访问间仍可被抢占

### C4: 关联变量组不同步

**定义**：多个逻辑上关联的独立变量在源码级分步更新，ISR在更新间隙抢占导致关联性破坏。

**典型场景**：
```c
volatile float temperature;
volatile uint8_t temp_valid;

// ISR: 传感器采样完成
void ADC_IRQHandler(void) {
    temperature = read_sensor();  // ← ISR 可能在此处被更高优先级中断抢占
    temp_valid = 1;               //    或主循环在这两行之间读取
}

// 主循环
void display_temp(void) {
    if (temp_valid) {
        show(temperature);  // 可能显示旧 temperature + 新 temp_valid
        temp_valid = 0;
    }
}
```

**检测要点**：
- 需要 LLM 语义分析识别变量间的逻辑关联（ast-grep 无法独立判断）
- 常见关联模式：数据 + 有效标志、X/Y/Z 坐标组、值 + 时间戳、缓冲区 + 长度
- 检查关联变量组的更新是否在同一个关中断保护区内

### C5: 多步骤操作窗口（RMW）

**定义**：读-修改-写（Read-Modify-Write）序列在中间步骤被ISR抢占，导致丢失更新或基于过时值的修改。

**典型场景**：
```c
volatile uint8_t event_flags;

// ISR
void EXTI_IRQHandler(void) {
    event_flags |= EVENT_BUTTON;  // RMW: load → OR → store
}

// 主循环
void clear_event(void) {
    event_flags &= ~EVENT_BUTTON;  // RMW: load → AND → store
    // 如果 ISR 在 load 和 store 之间触发，ISR 写入的标志位被覆盖
}
```

**检测要点**：
- 识别 RMW 模式：`var++`、`var--`、`var += expr`、`var |= mask`、`var &= mask`、`if(var) var = ...`
- 即使变量宽度 ≤ 处理器字长（C1/C3 安全），RMW 仍然不安全
- 检查 RMW 操作是否在关中断保护内
- ARM Cortex-M 的 bit-band 操作对单 bit 读写是原子的，但 `|=` 和 `&=` 不是

---

## 2. 保护原语动态发现方法

**禁止预设固定的保护函数名列表。** 按以下流程动态发现：

### 2.1 从编译环境推断平台原语

读取 `compilation-env.json` 中的 `compiler_dialect` 和 `target_cpu`，根据平台知识推断：

- **ARM Cortex-M + GCC/armclang**: `__disable_irq()/__enable_irq()`, `__get_PRIMASK()/__set_PRIMASK()`, `__LDREX/__STREX` 系列
- **ARM Cortex-M + ARMCC/Keil**: `__disable_irq()/__enable_irq()`, 可能有 `__svc` 包装
- **8051/C51 + Keil**: `EA = 0 / EA = 1`（全局中断使能位）
- **IAR**: `__disable_interrupt()/__enable_interrupt()`
- **RTOS 环境**: `taskENTER_CRITICAL()/taskEXIT_CRITICAL()`（FreeRTOS）, `OS_ENTER_CRITICAL()/OS_EXIT_CRITICAL()`（uC/OS）等
- 其他平台根据 LLM 对该平台的知识推断

### 2.2 从项目代码发现自定义封装

使用 `astgrep_run` 搜索：
- `#define` 宏定义中包含中断控制操作的封装
- 内联函数中包含中断控制操作的封装
- 项目头文件中的 critical section 工具函数

使用 `grep` 补充搜索：
- `critical`、`irq_lock`、`irq_save`、`interrupt` 等关键词在宏/函数定义中的出现

### 2.3 从 Code Wiki 获取

如果 `.matrix/wiki/index.json` 存在，读取模块和函数 wiki 中标注为中断相关的工具函数。

### 2.4 构建保护原语清单

综合以上发现，构建清单格式：

| 原语名称 | 类型 | 保护范围 | 发现来源 |
|---------|------|---------|---------|
| `__disable_irq()/__enable_irq()` | 全局中断开关 | 成对调用之间 | 平台推断 |
| `ENTER_CRITICAL()/EXIT_CRITICAL()` | 临界区宏 | 成对调用之间 | 项目代码搜索 |
| `__LDREX/__STREX` | 原子操作指令 | 单次操作 | 平台推断 |

---

## 3. 冲突判定规则

### 3.1 判定流程

对共享变量图谱中的每个风险变量：

1. 确认风险类别（C1-C5，可能多个）
2. 定位所有访问点的源码
3. 检查每个访问点是否被保护原语包裹
4. 判定保护是否**完整覆盖**整个多步骤序列

### 3.2 严重程度映射

| 模式 | 无保护 | 保护不完整 |
|------|--------|-----------|
| C1 原子变量（多步源码操作） | critical | major |
| C2 数组多步骤 | critical | major |
| C3 超字长编译分裂 | critical | major |
| C4 关联变量组 | major | major |
| C5 RMW 操作 | critical | major |

**特殊规则**：volatile 修饰但无关中断保护的超字长变量 → 至少 major

### 3.3 volatile 陷阱

**volatile 的作用**：
- 防止编译器将变量优化到寄存器（每次访问都从内存读取）
- 防止编译器重排序对该变量的访问
- 防止编译器消除"看似冗余"的读写操作

**volatile 不能做的**：
- 不能使多条指令成为原子操作
- 不能防止 ISR 在多条指令之间抢占
- 不能保证 RMW 操作的原子性

**结论**：volatile 是共享变量的**必要但不充分**条件。缺少 volatile 是额外的缺陷（编译器可能优化掉关键访问），但有 volatile 不等于安全。

---

## 4. 误报规避

以下情况不应报告为缺陷：

1. **只读共享变量**：变量在 ISR 中只读不写，且在 ISR 外的写操作完成后才启用中断 → 安全
2. **单字长原子变量**：变量宽度 ≤ 处理器字长，且不涉及 RMW 操作 → 单次 load/store 在大多数架构上是原子的（C5 除外）
3. **编译器/硬件保证的原子操作**：ARM Cortex-M 的 32位对齐 load/store 是原子的；8051 的 `bit` 类型操作是原子的
4. **已在临界区内**：访问点已被有效的保护原语完整包裹
5. **单次初始化**：变量只在中断使能前写入一次，之后只读 → 安全
6. **双缓冲/乒乓缓冲**：读写使用不同缓冲区，索引切换是原子的 → 安全（需验证索引切换确实是原子的）

---

## 5. 报告内容指南

> **注意**：报告的结构模板在 `templates/interrupt-review.md` 文件中。本节提供各部分的**内容填写指南**，不重复模板结构。

### 各部分内容要求

1. **审查环境**：从 `compilation-env.json` 提取 target_cpu、compiler_dialect，从分析过程中获取 ISR 数量、共享变量数量、保护原语列表。
2. **共享变量图谱**：每行一个共享变量，必须包含声明位置（文件:行号）、ISR端和非ISR端的访问函数及位置、风险类别（可多个，如 C1/C3）、保护状态、判定结果（SAFE/UNSAFE）。
3. **冲突分析详情**：每个缺陷独立小节，必须包含具体代码位置（ISR端 + 非ISR端）、冲突模式编号和名称、具体的风险分析（解释为什么不安全）、可操作的修复建议。
4. **统计摘要**：按 severity 和冲突模式（C1-C5）两个维度汇总。
5. **保护建议**：针对项目整体的保护策略建议（如：统一使用 ENTER_CRITICAL/EXIT_CRITICAL 宏对；对超字长共享变量统一加关中断保护；采用双缓冲模式替代逐元素拷贝等）。
