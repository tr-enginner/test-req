/**
 * 测试用例：RS-06 中断不安全读-修改-写（Interrupt-Unsafe RMW）
 *
 * 规则说明：
 *   Inspector 检查对共享变量的复合赋值操作（|=、&=、^=、+=、-=），
 *   在没有中断保护时，这些操作在 C 层面是原子的，
 *   但在汇编层面是读-修改-写三步，ISR 可在中间两步之间抢占，
 *   导致主程序或 ISR 的更新丢失。
 *
 * 缺陷注入点：
 *   1. g_event_flags：主程序和 ISR 均执行 |= 操作，无保护时互相覆盖。
 *   2. g_status_reg：主程序 &= 清位，ISR |= 置位，两者并发导致位丢失。
 *   3. g_packet_count：主程序 ++，ISR 也 ++，非原子导致计数丢失。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] interrupt-unsafe RMW: g_event_flags |= 无保护
 *   - DEF-CR-xxx [critical] interrupt-unsafe RMW: g_status_reg 读改写竞争
 *   - DEF-CR-xxx [critical] interrupt-unsafe RMW: g_packet_count++ 竞争
 */

#include <stdint.h>

/* 平台中断控制原语（ARM Cortex-M） */
extern void __disable_irq(void);
extern void __enable_irq(void);

/* 事件标志位定义 */
#define EVENT_BUTTON   (1U << 0)
#define EVENT_TIMER    (1U << 1)
#define EVENT_UART_RX  (1U << 2)
#define EVENT_SENSOR   (1U << 3)

/* 状态寄存器位定义 */
#define STATUS_BUSY    (1U << 4)
#define STATUS_ERROR   (1U << 5)

/* 共享变量（无中断保护） */
volatile uint8_t g_event_flags  = 0;
volatile uint8_t g_status_reg   = 0;
volatile uint16_t g_packet_count = 0;

/* ===== ISR 上下文 ===== */

void UART_RX_IRQHandler(void)
{
    /* BUG: |= 为 RMW，若主程序同时执行 |=，结果可能丢失一个事件 */
    g_event_flags |= EVENT_UART_RX;
    g_packet_count++;              /* BUG: ++ 为 RMW，与主程序 ++ 竞争 */
}

void TIMER_IRQHandler(void)
{
    /* BUG: 与主程序的 &= 操作并发，可能恢复已被清除的 STATUS_BUSY */
    g_status_reg |= STATUS_ERROR;
}

/* ===== 主程序上下文 ===== */

/**
 * 主程序置位按键事件并清除忙状态。
 *
 * 缺陷：两次 RMW 操作均无中断保护，ISR 可能在 load 和 store 之间抢占：
 *   g_event_flags |= EVENT_BUTTON：
 *     load  r0, g_event_flags   ; 读旧值
 *     ISR 抢占，g_event_flags |= EVENT_UART_RX（ISR 写入 bit2）
 *     or    r0, #EVENT_BUTTON   ; 主程序基于旧值修改
 *     store g_event_flags, r0   ; 覆盖 ISR 写入的 bit2 → EVENT_UART_RX 丢失
 */
void handle_button_press(void)
{
    /* BUG: 应在 __disable_irq()/__enable_irq() 内 */
    g_event_flags |= EVENT_BUTTON;
    g_status_reg  &= (uint8_t)~STATUS_BUSY;
    g_packet_count++;
}

/**
 * 消费并清除事件标志。
 *
 * 缺陷：先读后清，ISR 可能在读和清之间置位新事件，导致新事件被连带清除。
 */
uint8_t consume_events(void)
{
    /* BUG: 读和清之间 ISR 可能置位新事件，新事件被清除 */
    uint8_t events = g_event_flags;
    g_event_flags = 0;
    return events;
}
