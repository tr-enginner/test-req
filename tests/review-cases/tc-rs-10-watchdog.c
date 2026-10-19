/**
 * 测试用例：RS-10 看门狗未刷新路径（Watchdog Starvation）
 *
 * 规则说明：
 *   Inspector 检查代码中可能长时间执行而不调用看门狗喂狗函数的路径，
 *   包括大数据块处理循环、错误重试循环、等待外设就绪的阻塞式轮询等。
 *   若这些路径执行时间超过看门狗超时时间，系统将意外复位。
 *
 * 缺陷注入点：
 *   1. process_flash_data()：遍历 64KB 数据块进行 CRC 计算，
 *      每轮约 100µs，总计 6.5s，超过典型看门狗 1-2s 超时，
 *      循环内未喂狗。
 *   2. wait_sensor_ready()：阻塞式轮询传感器就绪标志，
 *      传感器故障时永久阻塞，看门狗永不刷新。
 *   3. retry_comm()：通信失败重试循环，每次重试包含 500ms 延时，
 *      最多重试 10 次共 5s，循环内未喂狗。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [major] watchdog starvation: process_flash_data 循环约 6.5s 不喂狗
 *   - DEF-CR-xxx [critical] watchdog starvation: wait_sensor_ready 传感器故障时永久阻塞
 *   - DEF-CR-xxx [major] watchdog starvation: retry_comm 最坏情况 5s 不喂狗
 */

#include <stdint.h>

#define FLASH_SIZE_BYTES  (64U * 1024U)   /* 64KB */
#define MAX_RETRY_COUNT   10U
#define RETRY_DELAY_MS    500U

/* 平台 API */
extern void     wdt_feed(void);                /* 喂狗 */
extern uint8_t  flash_read_byte(uint32_t addr);
extern uint8_t  sensor_is_ready(void);
extern int8_t   comm_send_packet(const uint8_t *buf, uint8_t len);
extern void     delay_ms(uint32_t ms);

/* ===== 缺陷 1：大数据块处理循环 ===== */

/**
 * 对 Flash 全量数据计算 CRC-32（完整性校验，上电时执行）。
 *
 * 缺陷：64KB × 约 100ns/字节处理时间 ≈ 6.5ms（理想），
 *       若 Flash 访问慢（如读等待周期多），实际可达数秒。
 *       循环内无喂狗，看门狗（典型 1s）将触发意外复位。
 */
uint32_t process_flash_data(void)
{
    uint32_t crc = 0xFFFFFFFFUL;

    /* BUG: 长循环内未调用 wdt_feed() */
    for (uint32_t addr = 0; addr < FLASH_SIZE_BYTES; addr++) {
        uint8_t byte = flash_read_byte(addr);
        /* CRC 计算... */
        crc ^= byte;
        for (uint8_t bit = 0; bit < 8; bit++) {
            if (crc & 1U) {
                crc = (crc >> 1) ^ 0xEDB88320UL;
            } else {
                crc >>= 1;
            }
        }
        /* BUG: 应每隔 N 次迭代调用 wdt_feed() */
    }
    return crc ^ 0xFFFFFFFFUL;
}

/* ===== 缺陷 2：阻塞式轮询 ===== */

/**
 * 等待传感器进入就绪状态。
 *
 * 缺陷：传感器硬件故障（I2C 总线卡死、传感器损坏）时，
 *       sensor_is_ready() 永远返回 0，函数永不退出。
 *       看门狗超时后系统复位，但没有超时退出机制，
 *       复位后再��进入同一死循环，系统反复复位。
 */
void wait_sensor_ready(void)
{
    /* BUG: 无超时退出，无喂狗，传感器故障时永久阻塞 */
    while (!sensor_is_ready()) {
        /* 空等待 */
    }
}

/* ===== 缺陷 3：重试循环 ===== */

/**
 * 发送数据包，失败时重试。
 *
 * 缺陷：每次重试间隔 500ms，最多 10 次，总计最坏 5s。
 *       整个重试过程内未喂狗，超过典型看门狗超时。
 */
int8_t retry_comm(const uint8_t *buf, uint8_t len)
{
    for (uint8_t attempt = 0; attempt < MAX_RETRY_COUNT; attempt++) {
        if (comm_send_packet(buf, len) == 0) {
            return 0;   /* 成功 */
        }
        /* BUG: 累计等待时间可达 5s，中间未喂狗 */
        delay_ms(RETRY_DELAY_MS);
    }
    return -1;   /* 失败 */
}
