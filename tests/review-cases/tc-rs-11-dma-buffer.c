/**
 * 测试用例：RS-11 DMA 缓冲区所有权冲突（DMA Buffer Ownership Conflict）
 *
 * 规则说明：
 *   Inspector 检查 DMA 传输进行期间 CPU 对同一缓冲区的写操作，
 *   以及 DMA 完成中断与主程序读取之间缺少同步机制的场景。
 *   DMA 和 CPU 并发访问同一内存区域会导致数据损坏，
 *   且这种冲突不会产生任何硬件异常，难以通过测试发现。
 *
 * 缺陷注入点：
 *   1. start_adc_dma() + process_samples()：
 *      DMA 正在将 ADC 数据搬运到 adc_buf 期间，
 *      主程序在 process_samples() 中读取同一 adc_buf，
 *      读到的是 DMA 部分写入的混合数据。
 *   2. prepare_tx_data() + start_spi_tx_dma()：
 *      先填充发送缓冲区，再启动 DMA 发送，但填充和启动之间
 *      若有中断抢占修改缓冲区，DMA 将发送被修改的数据。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] DMA buffer conflict: adc_buf DMA 写入期间 CPU 读取
 *   - DEF-CR-xxx [major]    DMA buffer conflict: tx_buf 填充到 DMA 启动之间无原子保证
 */

#include <stdint.h>
#include <string.h>

#define ADC_BUF_SIZE    256U
#define SPI_TX_BUF_SIZE  64U

/* DMA 传输中的缓冲区（CPU 与 DMA 共享） */
uint16_t adc_buf[ADC_BUF_SIZE];    /* ADC DMA 目标缓冲区 */
uint8_t  tx_buf[SPI_TX_BUF_SIZE];  /* SPI TX DMA 源缓冲区 */

/* 状态标志（缺少 volatile 是额外问题，此处聚焦所有权冲突） */
volatile uint8_t g_adc_dma_busy  = 0;
volatile uint8_t g_spi_tx_busy   = 0;

/* 平台 API */
extern void dma_start_adc(uint16_t *buf, uint16_t count);   /* 启动 ADC DMA */
extern void dma_start_spi_tx(const uint8_t *buf, uint8_t count); /* 启动 SPI TX DMA */
extern uint8_t dma_adc_is_complete(void);
extern void build_telemetry_frame(uint8_t *dst, const uint16_t *adc, uint16_t count);
extern void handle_rx_interrupt(uint8_t *buf); /* ISR，可能修改 tx_buf */

/**
 * 启动 ADC DMA 连续采样（在 Timer ISR 中调用）。
 */
void start_adc_dma(void)
{
    g_adc_dma_busy = 1;
    dma_start_adc(adc_buf, ADC_BUF_SIZE);
}

/**
 * 处理 ADC 采样数据（在主循环中调用）。
 *
 * 缺陷：未检查 DMA 是否完成即读取 adc_buf。
 *       DMA 正在向 adc_buf[N..255] 写入新数据，
 *       同时主程序读取 adc_buf[0..255] 处理，
 *       读到的数据混合了上一帧旧数据和当前帧新数据。
 */
uint32_t process_samples(void)
{
    /* BUG: 未等待 DMA 完成（应检查 g_adc_dma_busy == 0 或使用完成信号量）*/
    uint32_t sum = 0;
    for (uint16_t i = 0; i < ADC_BUF_SIZE; i++) {
        sum += adc_buf[i];   /* 可能读到 DMA 正在写入中的撕裂数据 */
    }
    return sum / ADC_BUF_SIZE;
}

/**
 * 准备遥测发送帧并启动 DMA 发送。
 *
 * 缺陷：build_telemetry_frame 填充 tx_buf 之后，
 *       若发生 RX 中断（handle_rx_interrupt 也修改 tx_buf），
 *       DMA 发送的将是被中断修改后的数据。
 *       tx_buf 填充到 DMA 启动之间需要关中断保护。
 */
void send_telemetry(const uint16_t *sensor_data, uint16_t count)
{
    /* BUG: 填充完成到 DMA 启动之间，ISR 可能修改 tx_buf */
    build_telemetry_frame(tx_buf, sensor_data, count);

    /* 若此处发生 handle_rx_interrupt，tx_buf 被覆盖 */

    g_spi_tx_busy = 1;
    dma_start_spi_tx(tx_buf, SPI_TX_BUF_SIZE);   /* DMA 将发送被修改的数据 */
}
