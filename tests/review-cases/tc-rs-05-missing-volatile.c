/**
 * 测试用例：RS-05 缺少 volatile 限定（Missing volatile）
 *
 * 规则说明：
 *   Inspector 识别 ISR 与主程序共享的标志/数据变量，
 *   检查是否用 volatile 防止编译器将变量缓存到寄存器。
 *   volatile 缺失时，编译器可能将主程序中的轮询循环优化为死循环，
 *   或将 ISR 的写操作视为无副作用而消除。
 *
 * 缺陷注入点：
 *   1. g_data_ready：ISR 写 1，主程序 while 循环检测，缺少 volatile，
 *      编译器将 while(!g_data_ready) 优化为 while(1)（永不退出）。
 *   2. g_adc_raw：ISR 更新，主程序读取，缺少 volatile，
 *      编译器可能将读取提升到循环外（只读一次）。
 *   3. g_error_code：主程序写入，ISR 读取，缺少 volatile，
 *      ISR 可能读到被优化掉的过时寄存器值。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] missing volatile: g_data_ready ISR 写/主轮询
 *   - DEF-CR-xxx [critical] missing volatile: g_adc_raw ISR 写/主读取
 *   - DEF-CR-xxx [major]    missing volatile: g_error_code 主写/ISR 读
 */

#include <stdint.h>

/* ===== 缺陷变量：均缺少 volatile ===== */

/* ISR 置 1，主程序轮询等待 */
uint8_t g_data_ready = 0;       /* BUG: 应为 volatile uint8_t */

/* ADC DMA 完成 ISR 更新，主程序读取处理 */
uint16_t g_adc_raw = 0;         /* BUG: 应为 volatile uint16_t */

/* 主程序写入错误码，ISR 读取决定是否跳过操作 */
uint8_t g_error_code = 0;       /* BUG: 应为 volatile uint8_t */

/* ===== ISR（模拟：由硬件中断触发）===== */

/**
 * ADC DMA 完成中断：更新原始采样值并置数据就绪标志。
 */
void DMA1_IRQHandler(void)
{
    g_adc_raw    = 2048;   /* 模拟 ADC 读值 */
    g_data_ready = 1;      /* 通知主程序 */
}

/* ===== 主程序路径 ===== */

/**
 * 主循环中等待 ADC 数据就绪。
 *
 * 缺陷：g_data_ready 无 volatile，编译器在 -O2 下��条件
 *       优化为常量 false，循环永不退出（挂死）。
 */
void wait_for_adc(void)
{
    /* BUG: g_data_ready 无 volatile，编译器优化为死循环 */
    while (!g_data_ready) {
        /* 等待 ISR 置位 */
    }
}

/**
 * 处理 ADC 数据。
 *
 * 缺陷：g_adc_raw 无 volatile，编译器可能将读取提升，
 *       在多次迭代中只读一次（始终使用寄存器缓存值）。
 */
uint32_t process_adc_loop(uint8_t iterations)
{
    uint32_t sum = 0;
    for (uint8_t i = 0; i < iterations; i++) {
        /* BUG: g_adc_raw 无 volatile，每次迭代可能不重新从内存读取 */
        sum += g_adc_raw;
    }
    return sum;
}
