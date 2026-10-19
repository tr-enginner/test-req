/**
 * 测试用例：RS-24 错误码忽略后使用无效结果（Ignored Error Return → Invalid Result Use）
 *
 * 规则说明：
 *   Inspector 检查"返回值既传递错误状态、又产生输出结果"的函数模式。
 *   当调用者忽略返回的错误码，直接使用函数写入的输出参数或全局状态时，
 *   输出值在错误路径上通常是未定义的、过时的或人为填充的安全默认值，
 *   后续基于该值做出的控制决策可能完全错误。
 *   常见于：SPI/I²C 读取、ADC 采样、CRC 校验、Flash 读取等硬件操作函数。
 *
 * 缺陷注入点：
 *   1. read_sensor_and_act()：spi_read_register 超时返回 -1，rx_buf 内容无效，
 *      调用者不检查返回值直接用 rx_buf[0] 做控制决策。
 *   2. update_config()：flash_read_config 读取失败时 cfg 结构体为全零或旧值，
 *      调用者忽略返回值直接用 cfg 覆盖运行时参数。
 *   3. compute_checksum_and_send()：crc_verify 返回 -1 表示校验失败，
 *      调用者不检查，继续发送被认为校验通过的数据包。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] logic_error: spi_read 失败后 rx_buf 无效，调用者直接使用
 *   - DEF-CR-xxx [critical] logic_error: flash_read 失败后 cfg 内容无效，直接应用配置
 *   - DEF-CR-xxx [major]    logic_error: crc_verify 错误返回值被忽略，继续发送
 */

#include <stdint.h>
#include <string.h>

/* 外部函数：返回 0 表示成功，非零表示错误；同时通过参数或全局变量产生输出 */
extern int8_t  spi_read_register(uint8_t reg, uint8_t *rx_buf, uint8_t len);
extern int8_t  flash_read_config(uint32_t addr, void *cfg, uint16_t size);
extern int8_t  crc_verify(const uint8_t *data, uint16_t len, uint16_t *crc_out);
extern int8_t  adc_read_blocking(uint8_t ch, uint16_t *raw_out, uint32_t timeout_ms);

extern void    set_motor_speed(uint8_t speed);
extern void    apply_runtime_config(const void *cfg);
extern int8_t  uart_send(const uint8_t *data, uint16_t len);
extern void    trigger_fault(uint8_t code);

/* ===== 缺陷 1：SPI 读取失败，rx_buf 内容无效后直接使用 ===== */

#define MOTOR_CTRL_REG   0x10U
#define RX_BUF_SIZE       4U

/**
 * 读取电机控制寄存器并设置转速。
 *
 * 缺陷：spi_read_register 超时（如从设备无响应）时返回 -1，
 *       rx_buf 可能未被写入（保持初始化值 0 或上次调用残留值），
 *       调用者不检查返回值，直接用 rx_buf[0] 设置电机转速，
 *       导致在通信故障时使用错误的转速值驱动电机。
 */
void read_sensor_and_act(void)
{
    uint8_t rx_buf[RX_BUF_SIZE] = {0};

    /* BUG: 返回值未检查。失败时 rx_buf 内容无效，但仍被使用 */
    spi_read_register(MOTOR_CTRL_REG, rx_buf, RX_BUF_SIZE);

    set_motor_speed(rx_buf[0]);   /* 基于可能无效的值驱动执行机构 */
}

/* ===== 缺陷 2：Flash 读取失败，配置直接生效 ===== */

typedef struct {
    uint16_t max_current_ma;
    uint16_t cutoff_voltage_mv;
    uint8_t  protection_level;
    uint8_t  reserved[3];
} RuntimeConfig_t;

#define CONFIG_FLASH_ADDR   0x08010000UL

/**
 * 从 Flash 加载配置并应用到运行时。
 *
 * 缺陷：flash_read_config 返回非零（Flash CRC 校验失败、读取超时等），
 *       cfg 结构体内容为全零（memset 初始化）或上次成功读取的残留值，
 *       调用者不检查返回值直接调用 apply_runtime_config(&cfg)，
 *       以损坏的配置（如 cutoff_voltage_mv=0）覆盖正在运行的系统参数，
 *       可能导致立即触发欠压保护或禁用所有保护。
 */
void update_config(void)
{
    RuntimeConfig_t cfg;
    memset(&cfg, 0, sizeof(cfg));

    /* BUG: 返回值未检查。Flash 读取失败时 cfg 为全零，仍被应用 */
    flash_read_config(CONFIG_FLASH_ADDR, &cfg, sizeof(cfg));

    apply_runtime_config(&cfg);   /* 可能应用全零或损坏的配置 */
}

/* ===== 缺陷 3：CRC 校验错误被忽略，继续发送数据 ===== */

#define PKT_MAX_LEN   128U

/**
 * 对数据包计算 CRC 并发送。
 *
 * 缺陷：crc_verify 返回 -1 表示数据损坏（CRC 不匹配），
 *       调用者忽略返回值，直接将损坏的数据包发送出去，
 *       接收端解析到错误数据，可能执行非预期命令。
 */
void compute_checksum_and_send(uint8_t *pkt, uint16_t pkt_len)
{
    uint16_t crc = 0;

    /* BUG: 返回值未检查。校验失败时 crc 为部分计算值，仍继续发送 */
    crc_verify(pkt, pkt_len - 2U, &crc);

    /* 将 CRC 附加到包末（无论校验是否通过）*/
    pkt[pkt_len - 2U] = (uint8_t)(crc >> 8);
    pkt[pkt_len - 1U] = (uint8_t)(crc & 0xFFU);

    uart_send(pkt, pkt_len);   /* 发送可能损坏的数据包 */
}

/* ===== 调用场景：ADC 读取失败后继续使用 raw_out ===== */

/**
 * 采集电池电压并判断保护阈值。
 *
 * 缺陷：adc_read_blocking 超时返回 -1，raw_out 未被写入，
 *       保持声明时的初始值 0，调用者用 0 判断欠压，
 *       触发误保护动作（0mV < 任何阈值）。
 */
void check_battery_voltage(void)
{
    uint16_t raw_out = 0;

    /* BUG: 超时返回值未检查，raw_out = 0 被当作有效的 ADC 值 */
    adc_read_blocking(0, &raw_out, 10U);

    if (raw_out < 1000U) {          /* 0 永远满足此条件 */
        trigger_fault(0x01);        /* 误触发欠压保护 */
    }
}
