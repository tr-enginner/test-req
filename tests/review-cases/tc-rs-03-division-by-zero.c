/**
 * 测试用例：RS-03 除零错误（Division by Zero）
 *
 * 规则说明：
 *   Inspector 需追踪除数变量的来源（传感器读值、配置参数、时间差、计算结果），
 *   验证在执行除法/取模运算前是否有零值防护。
 *   跨函数的除数来源追踪是静态工具无法处理的典型场景。
 *
 * 缺陷注入点：
 *   1. calc_frequency()：interval_ms 来自两次时间戳差值，理论上可为 0。
 *   2. normalize_sensor()：range 由外部配置读取，配置错误时可能为 0。
 *   3. calc_average()：count 由调用者传入，未防护直接做除数。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] division by zero: interval_ms 可能为 0
 *   - DEF-CR-xxx [critical] division by zero: range 配置值未��验
 *   - DEF-CR-xxx [critical] division by zero: count 参数未校验
 */

#include <stdint.h>

/* 外部接口 */
extern uint32_t get_tick_ms(void);
extern int16_t  read_config_range(void);   /* 返回用户配置的量程，可能误配置为 0 */

/**
 * 计算脉冲频率：freq = 1000 / interval_ms（Hz）
 *
 * 缺陷：若两次中断时间戳相同（高频噪声或计时精度不足），interval_ms = 0，触发除零。
 */
uint32_t calc_frequency(uint32_t last_tick)
{
    uint32_t now = get_tick_ms();
    uint32_t interval_ms = now - last_tick;

    /* BUG: 未检查 interval_ms != 0 */
    return 1000U / interval_ms;
}

/**
 * 将传感器原始值归一化到 [0, 1000]。
 *
 * 缺陷：range 从配置读取，用户可能配置为 0（如未初始化默认值），
 *       导致除零，造成硬件异常或死机。
 */
int32_t normalize_sensor(int16_t raw_value)
{
    int16_t range = read_config_range();

    /* BUG: 未检查 range != 0 */
    return (int32_t)raw_value * 1000 / range;
}

/**
 * 计算样本均值。
 *
 * 缺陷：count 由调用者控制，若调用者传入 0（空数组场景），触发除零。
 */
int32_t calc_average(const int32_t *samples, uint8_t count)
{
    int32_t sum = 0;
    for (uint8_t i = 0; i < count; i++) {
        sum += samples[i];
    }
    /* BUG: 未检查 count != 0 */
    return sum / count;
}
