/**
 * 测试用例：RS-09 寄存器访问序列错误（Register Access Sequence）
 *
 * 规则说明：
 *   Inspector 检查外设初始化的寄存器写入顺序是否符合 MCU 参考手册要求。
 *   错误的初始化顺序会导致外设进入未定义状态，首次操作产生错误结果。
 *   此类缺陷需要对照硬件手册进行语义分析，静态工具无法检测。
 *
 * 场景：STM32 风格 MCU 的 DMA + UART 初始化
 *
 * 缺陷注入点：
 *   1. dma_init_wrong()：先使能 DMA 通道（DMA_EN），再设置源/目标地址，
 *      导致 DMA 以地址 0x00000000 启动第一次传输。
 *   2. spi_init_wrong()：先使能 SPI（SPE=1），再配置波特率分频，
 *      第一个时钟已以默认（最大）速率发出，从设备未能锁相。
 *
 * 正确顺序（注释中给出）：
 *   DMA：配置地址 → 配置长度 → 配置控制 → 最后置 EN
 *   SPI：配置所有寄存器 → 最后置 SPE
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] register sequence: DMA_CCR EN 位在地址配置前置��
 *   - DEF-CR-xxx [critical] register sequence: SPI_CR1 SPE 在波特率配置前置位
 */

#include <stdint.h>

/* 模拟寄存器地址（STM32F1 风格） */
#define DMA1_BASE    0x40020000UL
#define SPI1_BASE    0x40013000UL

typedef struct {
    volatile uint32_t CCR;    /* 配置寄存器，bit0=EN */
    volatile uint32_t CNDTR;  /* 数据长度 */
    volatile uint32_t CPAR;   /* 外设地址 */
    volatile uint32_t CMAR;   /* 内存地址 */
} DMA_Channel_t;

typedef struct {
    volatile uint32_t CR1;    /* 控制寄存器1，bit6=SPE，bit3:5=BR（波特率） */
    volatile uint32_t CR2;
    volatile uint32_t SR;
    volatile uint32_t DR;
} SPI_t;

#define DMA1_CH1   ((DMA_Channel_t *)(DMA1_BASE + 0x08))
#define SPI1       ((SPI_t *)SPI1_BASE)

#define DMA_CCR_EN     (1U << 0)
#define DMA_CCR_MINC   (1U << 7)   /* 内存地址自增 */
#define DMA_CCR_DIR    (1U << 4)   /* 读内存→写外设 */
#define SPI_CR1_SPE    (1U << 6)   /* SPI 使能 */
#define SPI_CR1_BR_DIV8 (0x2U << 3) /* 波特率 = fPCLK/8 */
#define SPI_CR1_MSTR   (1U << 2)   /* 主机模式 */

extern uint8_t g_tx_buffer[64];
extern uint32_t SPI1_DR_ADDR;

/**
 * DMA 初始化（错误顺序）。
 *
 * 缺陷：第一步就置位 EN，此时 CPAR/CMAR 均为复位值 0x00000000，
 *       DMA 以非法地址启动传输，触发总线错误或写入错误内存区域。
 */
void dma_init_wrong(void)
{
    /* BUG: EN 应该是最后一步 */
    DMA1_CH1->CCR  = DMA_CCR_EN | DMA_CCR_MINC | DMA_CCR_DIR;  /* 步骤1：使能（错误！）*/
    DMA1_CH1->CNDTR = 64;                                        /* 步骤2：长度 */
    DMA1_CH1->CPAR  = (uint32_t)&SPI1_DR_ADDR;                  /* 步骤3：目标地址 */
    DMA1_CH1->CMAR  = (uint32_t)g_tx_buffer;                    /* 步骤4：源地址 */
}

/**
 * DMA 初始化（正确顺序，供对比）。
 */
void dma_init_correct(void)
{
    DMA1_CH1->CCR   = 0;                              /* 步骤1：先禁用/清零 */
    DMA1_CH1->CNDTR = 64;                             /* 步骤2：配置长度 */
    DMA1_CH1->CPAR  = (uint32_t)&SPI1_DR_ADDR;       /* 步骤3：配置目标 */
    DMA1_CH1->CMAR  = (uint32_t)g_tx_buffer;         /* 步骤4：配置源 */
    DMA1_CH1->CCR   = DMA_CCR_MINC | DMA_CCR_DIR | DMA_CCR_EN;  /* 步骤5：最后使能 */
}

/**
 * SPI 初始化（错误顺序）。
 *
 * 缺陷：SPE 在波特率和模式配置之前置位，SPI 以默认配置（fPCLK/2，模式0）
 *       发出第一个时钟，从设备可能以此默认速率采样，后续重配置无效。
 */
void spi_init_wrong(void)
{
    /* BUG: SPE 应该是最后置位 */
    SPI1->CR1 = SPI_CR1_SPE | SPI_CR1_MSTR;           /* 步骤1：使能（错误！）*/
    SPI1->CR1 |= SPI_CR1_BR_DIV8;                     /* 步骤2：配置波特率（已使能后修改）*/
}

/**
 * SPI 初始化（正确顺序，供对比）。
 */
void spi_init_correct(void)
{
    SPI1->CR1 = SPI_CR1_MSTR | SPI_CR1_BR_DIV8;       /* 步骤1：配置模式和波特率 */
    SPI1->CR2 = 0;                                     /* 步骤2：配置其他控制 */
    SPI1->CR1 |= SPI_CR1_SPE;                          /* 步骤3：最后使能 */
}
