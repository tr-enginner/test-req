/**
 * 测试用例：RS-13 资源泄漏（Resource Leak）
 *
 * 规则说明：
 *   Inspector 追踪资源获取点（动态内存分配、外设锁定、互斥量获取、
 *   文件句柄打开等），检查所有退出路径（正常返回、错误返回、异常跳转）
 *   是否均有对应的释放操作。
 *   嵌入式系统中即使不使用标准 malloc，也存在外设独占锁、
 *   DMA 通道占用、共享总线仲裁等需要显式释放的资源。
 *
 * 缺陷注入点：
 *   1. send_can_frame()：获取 CAN 发送邮箱后，若帧过长提前返回，
 *      邮箱永不释放，后续发送全部阻塞。
 *   2. spi_read_register()：获取 SPI 总线互斥量后，读取失败时
 *      跳过 release，总线锁死。
 *   3. allocate_and_process()：malloc 成功后若处理步骤失败，
 *      错误路径没有 free，产生内存泄漏（适用于使用堆的嵌入式场景）。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] resource leak: CAN 邮箱在长帧错误路径未释放
 *   - DEF-CR-xxx [critical] resource leak: SPI 互斥量在读失败路径未释放
 *   - DEF-CR-xxx [major]    resource leak: malloc 内存在处理失败路径未 free
 */

#include <stdint.h>
#include <stdlib.h>

/* 外部 API */
extern int8_t   can_acquire_mailbox(void);      /* 返回邮箱号，-1 表示无可用 */
extern void     can_release_mailbox(int8_t mb);
extern int8_t   can_fill_mailbox(int8_t mb, const uint8_t *data, uint8_t len);
extern int8_t   can_transmit(int8_t mb);

extern int8_t   spi_mutex_take(uint32_t timeout_ms);  /* 0=成功，-1=超时 */
extern void     spi_mutex_give(void);
extern int8_t   spi_read_bytes(uint8_t reg, uint8_t *buf, uint8_t len); /* 0=OK */

extern int8_t   validate_packet(const uint8_t *buf, uint16_t len);
extern int8_t   process_packet(uint8_t *buf, uint16_t len);

/* ===== 缺陷 1：CAN 邮箱在错误路径未释放 ===== */

#define CAN_MAX_DLC  8U

/**
 * 发送 CAN 帧。
 *
 * 缺陷：获取邮箱后，若 len > CAN_MAX_DLC 提前 return，
 *       邮箱未调用 can_release_mailbox() 释放，
 *       系统中仅有的几个发送邮箱被永久占用，后续发送全部失败。
 */
int8_t send_can_frame(const uint8_t *data, uint8_t len)
{
    int8_t mailbox = can_acquire_mailbox();
    if (mailbox < 0) {
        return -1;   /* 无可用邮箱，正常返回（无泄漏）*/
    }

    /* BUG: 超长帧时直接 return，未释放 mailbox */
    if (len > CAN_MAX_DLC) {
        return -2;   /* 泄漏：mailbox 未 release */
    }

    if (can_fill_mailbox(mailbox, data, len) != 0) {
        /* BUG: 填充失败时也未释放 */
        return -3;   /* 泄漏：mailbox 未 release */
    }

    can_transmit(mailbox);
    can_release_mailbox(mailbox);   /* 正常路径：正确释放 */
    return 0;
}

/* ===== 缺陷 2：SPI 互斥量在失败路径未释放 ===== */

/**
 * 通过 SPI 读取传感器寄存器。
 *
 * 缺陷：获取 SPI 总线互斥量后，读取操作失败时直接 return，
 *       互斥量未调用 spi_mutex_give() 释放，
 *       其他任务/ISR 再次调用 spi_mutex_take() 将永久阻塞。
 */
int8_t spi_read_register(uint8_t reg, uint8_t *buf, uint8_t len)
{
    if (spi_mutex_take(100) != 0) {
        return -1;   /* 超时，未获取到互斥量（无泄漏）*/
    }

    /* BUG: 读取失败时直接 return，互斥量未释放 */
    if (spi_read_bytes(reg, buf, len) != 0) {
        return -2;   /* 泄漏：spi_mutex_give() 未调用 */
    }

    spi_mutex_give();   /* 正常路径：正确释放 */
    return 0;
}

/* ===== 缺陷 3：堆内存在处理失败路径未释放 ===== */

/**
 * 分配缓冲区，验证并处理数据包。
 *
 * 缺陷：malloc 成功后，validate_packet 或 process_packet 失败时
 *       直接 return，buf 指向的内存未 free，产生堆内存泄漏。
 *       嵌入式堆通常极小（数 KB），多次泄漏后分配失败，系统功能丧失。
 */
int8_t allocate_and_process(uint16_t pkt_len)
{
    uint8_t *buf = (uint8_t *)malloc(pkt_len);
    if (buf == NULL) {
        return -1;   /* 分配失败（无泄漏）*/
    }

    /* BUG: 验证失败时直接 return，buf 未 free */
    if (validate_packet(buf, pkt_len) != 0) {
        return -2;   /* 泄漏 */
    }

    /* BUG: 处理失败时直接 return，buf 未 free */
    if (process_packet(buf, pkt_len) != 0) {
        return -3;   /* 泄漏 */
    }

    free(buf);   /* 正常路径：正确释放 */
    return 0;
}
