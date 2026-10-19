/**
 * 测试用例：RS-20 未初始化变量使用（Uninitialized Variable Use）
 *
 * 规则说明：
 *   Inspector 检查局部变量/结构体在所有执行路径上是否均已赋值再使用，
 *   以及结构体部分初始化后访问未赋值字段的场景：
 *   - 条件分支中只在部分分支赋值，其他分支直接使用
 *   - 结构体用 {.field = val} 部分初始化，其余字段为不确定值
 *   - 错误处理分支 return 前访问未初始化的输出参数
 *   嵌入式系统栈内存不清零，未初始化变量的值取决于上一次函数调用
 *   留在栈上的数据，行为随调用序列变化，难以复现。
 *
 * 缺陷注入点：
 *   1. parse_header()：result 只在成功路径赋值，校验失败路径直接 return result
 *   2. init_sensor_config()：结构体部分初始化，threshold 字段未赋值
 *   3. get_register_value()：out 指针在读取失败时未写入，调用者使用垃圾值
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [major] uninitialized: parse_header result 在失败路径未初始化
 *   - DEF-CR-xxx [major] uninitialized: SensorConfig threshold 字段未初始化
 *   - DEF-CR-xxx [major] uninitialized: get_register_value 失败路径 *out 未写入
 */

#include <stdint.h>
#include <string.h>

/* ===== 缺陷 1：局部变量在部分分支未赋值 ===== */

typedef struct {
    uint8_t  cmd;
    uint16_t length;
    uint8_t  version;
} Header_t;

extern int8_t  validate_magic(const uint8_t *buf);
extern uint8_t extract_version(const uint8_t *buf);

/**
 * 解析协议帧头。
 *
 * 缺陷：result 声明但未初始化（栈上随机值），
 *       validate_magic 失败时直接 return result，
 *       调用者得到随机垃圾值的 Header_t，用于后续帧解析。
 */
Header_t parse_header(const uint8_t *buf, uint8_t len)
{
    Header_t result;   /* BUG: 未初始化，含随机栈数据 */

    if (len < 4) {
        return result;   /* 返回未初始化的结构体 */
    }

    if (validate_magic(buf) != 0) {
        return result;   /* BUG: 校验失败，返回未初始化的 result */
    }

    /* 成功路径才赋值 */
    result.cmd     = buf[0];
    result.length  = (uint16_t)((buf[1] << 8) | buf[2]);
    result.version = extract_version(buf);
    return result;
}

/* ===== 缺陷 2：结构体部分初始化，未赋值字段含随机值 ===== */

typedef struct {
    uint8_t  channel;
    uint8_t  gain;
    uint16_t threshold;    /* 报警阈值，未初始化 */
    uint8_t  filter_order; /* 滤波阶数，未初始化 */
    uint8_t  enabled;
} SensorConfig_t;

extern void apply_sensor_config(const SensorConfig_t *cfg);
extern uint16_t DEFAULT_THRESHOLD;

/**
 * 初始化传感器配置。
 *
 * 缺陷：使用指定字段初始化（designated initializer 风格），
 *       threshold 和 filter_order 字段遗漏赋值，
 *       apply_sensor_config 读取 cfg->threshold 时得到随机栈值，
 *       可能设置极低或极高的报警阈值，导致系统立即报警或永不报警。
 *
 * 注意：在 C 中，局部结构体 partial 初始化（非全局/静态）
 *       未指定字段为不确定值，不同于全局变量的零初始化。
 */
void init_sensor_config(uint8_t channel)
{
    SensorConfig_t cfg;
    cfg.channel = channel;
    cfg.gain    = 4;
    cfg.enabled = 1;
    /* BUG: threshold 和 filter_order 未赋值，含随机栈数据 */

    apply_sensor_config(&cfg);   /* cfg.threshold 为随机值 */
}

/* ===== 缺陷 3：输出参数在失败路径未写入 ===== */

extern int8_t hw_read_register(uint8_t addr, uint8_t *val);   /* 0=OK，-1=err */

/**
 * 读取硬件寄存器值，通过输出参数返回。
 *
 * 缺陷：hw_read_register 失败时函数返回 -1，
 *       但 *out 未被写入任何值，调用者若不检查返回值，
 *       直接使用 *out 将读到其原始值（调用前栈上的随机数）。
 *       即使调用者检查了返回值，此模式也容易在代码演进中引入 bug。
 */
int8_t get_register_value(uint8_t addr, uint8_t *out)
{
    uint8_t raw;

    if (hw_read_register(addr, &raw) != 0) {
        /* BUG: 失败路径 *out 未写入，调用者可能使用原有的随机值 */
        return -1;
        /* 应添加: *out = 0; 或 *out = SAFE_DEFAULT_VALUE; */
    }

    *out = raw;
    return 0;
}

/**
 * 调用者未检查返回值的使用场景（展示触发路径）。
 */
void caller_ignores_error(void)
{
    uint8_t reg_val;   /* 未初始化 */
    get_register_value(0x10, &reg_val);   /* 忽略返回值 */
    /* 若 hw_read_register 失败，reg_val 仍为随机栈值 */
    if (reg_val > 100) {   /* 基于随机值做决策 */
        /* 执行错误的控制动作 */
    }
}
