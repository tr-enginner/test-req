/**
 * 测试用例：RS-07 优先级反演（Priority Inversion）
 *
 * 规则说明：
 *   Inspector 检查高优先级 ISR 依赖低优先级 ISR 才能更新的共享状态。
 *   当低优先级 ISR 被更高优先级 ISR 抢占时，高优先级 ISR 读到的是过时数据，
 *   导致控制逻辑基于错误的状态做决策。
 *
 * 场景描述：
 *   中断优先级（数字越小优先级越高）：
 *     TIMER_IRQ（优先级 0，最高）：控制循环，读取 g_control_params
 *     COMM_IRQ （优先级 2，中等）：更新 g_control_params
 *     SENSOR_IRQ（优先级 3，最低）：更新 g_sensor_state
 *
 * 缺陷：
 *   1. TIMER_IRQ 读取 g_control_params，但 g_control_params 由 COMM_IRQ 更新。
 *      COMM_IRQ 正在更新中途被 TIMER_IRQ 抢占，TIMER_IRQ 读到半更新状态。
 *   2. TIMER_IRQ 还读取 g_sensor_state，而 SENSOR_IRQ 优先级低于 COMM_IRQ，
 *      可能长时间得不到执行，导致 TIMER_IRQ 反复读到过时的传感器值。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [major] priority inversion: TIMER_IRQ 依赖 COMM_IRQ 更新的数据，
 *                                            COMM_IRQ 更新中途被 TIMER_IRQ 抢占
 *   - DEF-CR-xxx [major] priority inversion: TIMER_IRQ 长期读到 SENSOR_IRQ 的过时值
 */

#include <stdint.h>

/* 控制参数（由 COMM_IRQ 更新，TIMER_IRQ 读取） */
typedef struct {
    int16_t  kp;          /* 比例增益 */
    int16_t  ki;          /* 积分增益 */
    int16_t  setpoint;    /* 目标值 */
} ControlParams_t;

/* 传感器状态（由 SENSOR_IRQ 更新，TIMER_IRQ 读取） */
typedef struct {
    int16_t  temperature;
    uint8_t  valid;
} SensorState_t;

/* 共享状态（无跨优先级保护） */
volatile ControlParams_t g_control_params = {10, 1, 500};
volatile SensorState_t   g_sensor_state   = {0, 0};
volatile int32_t         g_integral       = 0;

/* ===== 优先级 0（最高）：控制循环定时器 ISR ===== */
/**
 * 每 1ms 执行一次 PID 控制计算。
 *
 * 缺陷 1：直接读取 g_control_params，而 COMM_IRQ（优先级 2）正在分步更新：
 *   先写 kp=20（新值），再写 ki=2（新值），再写 setpoint=600
 *   若 TIMER_IRQ 在 kp 已更新、ki 未更新时抢占，
 *   将使用新 kp + 旧 ki 的混合参数，产生错误控制输出。
 *
 * 缺陷 2：读取 g_sensor_state，而 SENSOR_IRQ 优先级为 3，
 *   可能长时间被优先级 2 的 COMM_IRQ 饿死，TIMER_IRQ 反复使用过时温度值。
 */
void TIMER0_IRQHandler(void)   /* 优先级 0 */
{
    /* BUG: 读取时 COMM_IRQ 可能正在中途更新 g_control_params */
    int16_t kp       = g_control_params.kp;
    int16_t ki       = g_control_params.ki;
    int16_t setpoint = g_control_params.setpoint;

    /* BUG: g_sensor_state 可能因 SENSOR_IRQ 长期得不到执行而过时 */
    int16_t measured = g_sensor_state.temperature;

    int16_t error = setpoint - measured;
    g_integral += ki * error;                      /* 积分累加 */
    int32_t output = kp * error + g_integral;      /* PID 输出 */
    (void)output;
}

/* ===== 优先级 2（中等）：通信 ISR，更新控制参数 ===== */
void COMM_IRQHandler(void)   /* 优先级 2 */
{
    /* BUG: 三步赋值期间随时可被 TIMER0_IRQHandler 抢占 */
    g_control_params.kp       = 20;    /* 步骤 1 */
    g_control_params.ki       = 2;     /* 步骤 2 — TIMER_IRQ 可在此抢占 */
    g_control_params.setpoint = 600;   /* 步骤 3 */
}

/* ===== 优先级 3（最低）：传感器采样 ISR ===== */
void SENSOR_IRQHandler(void)   /* 优先级 3，可被 COMM_IRQ 饿死 */
{
    g_sensor_state.temperature = 25;
    g_sensor_state.valid       = 1;
}
