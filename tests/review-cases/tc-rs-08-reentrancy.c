/**
 * 测试用例：RS-08 重入性风险（Reentrancy）
 *
 * 规则说明：
 *   Inspector 检查同时从主程序和 ISR 两个上下文调用的函数，
 *   是否使用了 static 局部变量或全局变量保存中间状态。
 *   当 ISR 重入时，这些静态状态被覆盖，导致主程序上下文数据损坏。
 *
 * 缺陷注入点：
 *   1. uart_send_byte()：使用 static 变量追踪发送缓冲区位置，
 *      主程序和 UART_TX_IRQ 均调用，ISR 重入覆盖 static 指针。
 *   2. crc16_update()：使用 static crc 累加器，
 *      主程序计算报文 CRC 期间被 ISR 调用，ISR 损坏主程序 CRC 状态。
 *   3. log_event()：使用 static 环形缓冲区写指针，
 *      主程序和多个 ISR 均调用，写指针在并发下损坏。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] reentrancy: uart_send_byte static 指针被 ISR 重入覆盖
 *   - DEF-CR-xxx [critical] reentrancy: crc16_update static 累加器被 ISR 破坏
 *   - DEF-CR-xxx [major]    reentrancy: log_event static 写指针多上下文竞争
 */

#include <stdint.h>
#include <stddef.h>

#define UART_BUF_SIZE   128U
#define LOG_BUF_SIZE    256U

/* 外部 ISR 声明 */
extern void UART_TX_IRQHandler(void);   /* 调用 uart_send_byte */
extern void ERROR_IRQHandler(void);     /* 调用 crc16_update 和 log_event */

/* ===== 缺陷 1：UART 发送函数使用 static 状态 ===== */

/**
 * 发送单字节至 UART（简化实现）。
 *
 * 缺陷：static tx_buf 和 tx_pos 在主程序调用时设置，
 *       若 UART_TX_IRQHandler 中再次调用本函数（重入），
 *       tx_buf/tx_pos 被覆盖，主程序发送路径数据损坏。
 */
void uart_send_byte(uint8_t byte)
{
    static uint8_t  tx_buf[UART_BUF_SIZE];   /* BUG: static，重入时被覆盖 */
    static uint8_t  tx_pos = 0;              /* BUG: static，重入时被覆盖 */

    if (tx_pos < UART_BUF_SIZE) {
        tx_buf[tx_pos++] = byte;
    }
    /* 触发发送寄存器写入... */
}

/* ===== 缺陷 2：CRC 计算使用 static 累加器 ===== */

/**
 * 增量更新 CRC-16。
 *
 * 缺陷：static crc 跨调用保存状态，供调用者分段输入数据。
 *       主程序正在逐字节计算报文 CRC 时，被 ERROR_IRQHandler 调用，
 *       ISR 修改 static crc，主程序恢复后基于被破坏的 crc 继续计算，
 *       最终 CRC 结果错误。
 */
uint16_t crc16_update(uint8_t byte, uint8_t reset)
{
    static uint16_t crc = 0xFFFF;   /* BUG: static，ISR 重入时损坏主程序 CRC */

    if (reset) {
        crc = 0xFFFF;
        return crc;
    }
    crc ^= (uint16_t)byte;
    for (uint8_t i = 0; i < 8; i++) {
        if (crc & 0x0001) {
            crc = (crc >> 1) ^ 0xA001;
        } else {
            crc >>= 1;
        }
    }
    return crc;
}

/* ===== 缺陷 3：日志函数使用 static 写指针 ===== */

typedef struct {
    uint8_t  level;
    uint8_t  code;
} LogEntry_t;

/**
 * 写入日志条目到环形缓冲区。
 *
 * 缺陷：static write_idx 被主程序和多个 ISR 共享，
 *       无临界区保护，并发写入导致索引损坏或条目覆盖。
 */
void log_event(uint8_t level, uint8_t code)
{
    static LogEntry_t log_buf[LOG_BUF_SIZE];   /* BUG: static，多上下文共享 */
    static uint8_t    write_idx = 0;           /* BUG: static，并发修改损坏 */

    log_buf[write_idx].level = level;
    log_buf[write_idx].code  = code;
    write_idx = (write_idx + 1) % LOG_BUF_SIZE;
}
