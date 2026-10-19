/**
 * 测试用例：RS-04 中断非原子访问（Interrupt Non-Atomic Access）
 *
 * 规则说明：
 *   Inspector 检查 ISR 与非 ISR 上下文共享的多字节变量，
 *   在未保护的情况下进行多步读写是否会导致数据撕裂（data tearing）。
 *   struct 多字段赋值和超字长变量是两个典型场景。
 *
 * 缺陷注入点：
 *   1. update_imu_data()：主程序对 g_imu 结构体三字段分步赋值，
 *      ISR 可能在字段间隙读到半更新状态。
 *   2. increment_timestamp()：8 位 MCU 上对 uint32_t 做 ++，
 *      编译为 4 条字节操作，ISR 可在字节间读到撕裂值。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] non-atomic access: g_imu 多字段赋值无临界区
 *   - DEF-CR-xxx [critical] non-atomic access: uint32_t ++ 在 8 位 MCU 非原子
 */

#include <stdint.h>

/* 目标平台：8 位 MCU（字长 8 bit），uint32_t 操作需 4 条指令 */

typedef struct {
    int16_t  accel_x;
    int16_t  accel_y;
    int16_t  accel_z;
} ImuData_t;

/* 由主程序写入，由 ISR 读取用于姿态解算触发 */
volatile ImuData_t g_imu;

/* 由主程序递增，由定时器 ISR 读取用于超时检测 */
volatile uint32_t g_timestamp_ms;

/* 外部 ISR（只读访问，可能读到撕裂值） */
extern void ATTITUDE_IRQHandler(void);   /* 读取 g_imu */
extern void TIMER1_IRQHandler(void);     /* 读取 g_timestamp_ms */

/**
 * 主程序更新 IMU 数据（由 SPI DMA 完成回调调用）。
 *
 * 缺陷：三次赋值之间中断未关闭，ATTITUDE_IRQHandler 可能读到
 *       accel_x 已更新但 accel_y/accel_z 仍为旧值的混合状态。
 */
void update_imu_data(int16_t ax, int16_t ay, int16_t az)
{
    /* BUG: 应在 __disable_irq()/__enable_irq() 内完成三次赋值 */
    g_imu.accel_x = ax;   /* 步骤 1 */
    g_imu.accel_y = ay;   /* 步骤 2 — ISR 可能在此抢占 */
    g_imu.accel_z = az;   /* 步骤 3 */
}

/**
 * 主程序递增系统时间戳（在 SysTick 中断外的软件计数场景）。
 *
 * 缺陷：8 位 MCU 上 uint32_t++ 编译为：
 *   LD r0, [g_timestamp_ms]   ; 低字节
 *   LD r1, [g_timestamp_ms+1] ; ...（共 4 次 load）
 *   INC
 *   ST [g_timestamp_ms], r0   ; 4 次 store
 * TIMER1_IRQHandler 可在中间读到部分更新的值。
 */
void increment_timestamp(void)
{
    /* BUG: 应关中断或使用原子操作 */
    g_timestamp_ms++;
}
