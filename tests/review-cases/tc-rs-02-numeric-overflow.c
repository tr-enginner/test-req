/**
 * 测试用例：RS-02 数值溢出/下溢（Numeric Overflow / Underflow）
 *
 * 规则说明：
 *   Inspector 需追踪算术表达式中间结果的数据类型宽度，
 *   检查是否在扩宽转换之前就发生了溢出截断。
 *   静态工具通常无法确定运行时值域，此类缺陷需语义推理。
 *
 * 缺陷注入点：
 *   1. calc_power()：uint16_t * uint16_t 结果未扩宽，乘积超 65535 时截断。
 *   2. calc_velocity()：uint16_t 减法可能下溢（被减数 < 减数时回绕至大正数）。
 *   3. accumulate_adc()：uint16_t 累加 256 个样本，中间和可能溢出。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [major] integer overflow: uint16×uint16 结果存入 uint16_t
 *   - DEF-CR-xxx [major] integer underflow: uint16 减法无下溢保护
 *   - DEF-CR-xxx [major] integer overflow: 累加未扩宽至 uint32
 */

#include <stdint.h>

#define ADC_SAMPLE_COUNT  256U

/**
 * 计算电功率：P = V * I（单位：mV * mA = µW）
 *
 * 缺陷：voltage_mv 和 current_ma 均可达 ~3000，乘积最大 ~9,000,000，
 *       超出 uint16_t 最大值 65535，结果截断。
 */
uint16_t calc_power(uint16_t voltage_mv, uint16_t current_ma)
{
    /* BUG: 应先转换为 uint32_t 再相乘 */
    uint16_t power_uw = voltage_mv * current_ma;   /* 溢出截断 */
    return power_uw;
}

/**
 * 计算速度增量：delta = current_speed - last_speed
 *
 * 缺陷：两个 uint16_t 相减，若 current < last（减速场景），
 *       结果回绕为接近 65535 的��正数，应使用有符号类型或判断方向。
 */
uint16_t calc_velocity_delta(uint16_t current_speed, uint16_t last_speed)
{
    /* BUG: 减速时 current < last，无符号回绕 */
    return current_speed - last_speed;
}

/**
 * 对 ADC 采样值求和（用于均值滤波）
 *
 * 缺陷：256 个 12 位 ADC 值（最大 4095）之和最大为 256×4095 = 1,048,320，
 *       超出 uint16_t（65535），累加过程中发生溢出。
 */
uint16_t accumulate_adc(const uint16_t *samples)
{
    uint16_t sum = 0;
    /* BUG: sum 应为 uint32_t */
    for (uint16_t i = 0; i < ADC_SAMPLE_COUNT; i++) {
        sum += samples[i];   /* 累加溢出 */
    }
    return sum / ADC_SAMPLE_COUNT;
}
