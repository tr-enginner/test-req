/**
 * @file pcu_main.c
 * @brief 卫星电源控制单元 (PCU) 主程序
 */

#include "pcu_hal.h"
#include "pcu_mppt.h"
#include "pcu_charge.h"
#include "pcu_protect.h"
#include "pcu_telemetry.h"

/* 全局状态 */
static PCU_State g_pcu_state;
static volatile uint32_t g_tick_count = 0;

/* ADC 采样缓冲区 */
static uint16_t g_adc_buffer[6];

/* 遥测帧缓冲区 */
static uint8_t g_tm_frame[64];

void SysTick_Handler(void)
{
    g_tick_count++;
}

void ADC_DMA_IRQHandler(void)
{
    /* ADC DMA 传输完成中断 */
    HAL_ADC_ReadDMA(g_adc_buffer, 6);
    g_pcu_state.solar_voltage  = ADC_TO_VOLTAGE(g_adc_buffer[0], 50.0f);
    g_pcu_state.solar_current  = ADC_TO_CURRENT(g_adc_buffer[1], 10.0f);
    g_pcu_state.battery_voltage = ADC_TO_VOLTAGE(g_adc_buffer[2], 35.0f);
    g_pcu_state.battery_current = ADC_TO_CURRENT_BIDI(g_adc_buffer[3], 5.0f);
    g_pcu_state.bus_voltage    = ADC_TO_VOLTAGE(g_adc_buffer[4], 35.0f);
    g_pcu_state.temperature    = ADC_TO_TEMP(g_adc_buffer[5]);
}

void UART_RX_IRQHandler(void)
{
    uint8_t byte = HAL_UART_ReadByte();
    Telemetry_ProcessRxByte(&g_pcu_state, byte);
}

static void PCU_Init(void)
{
    HAL_GPIO_Init();
    HAL_ADC_Init();
    HAL_PWM_Init();
    HAL_UART_Init(115200);

    /* 初始状态: 所有负载开关断开, 太阳能阵列断开 */
    HAL_GPIO_Write(GPIO_SOLAR_RELAY, 0);
    HAL_GPIO_Write(GPIO_LOAD_SW1, 0);
    HAL_GPIO_Write(GPIO_LOAD_SW2, 0);
    HAL_GPIO_Write(GPIO_LOAD_SW3, 0);
    HAL_GPIO_Write(GPIO_STATUS_LED, 1);  /* 点亮状态灯 */

    MPPT_Init(&g_pcu_state);
    Charge_Init(&g_pcu_state);
    Protect_Init(&g_pcu_state);
    Telemetry_Init(&g_pcu_state);

    g_pcu_state.mode = PCU_MODE_STANDBY;
}

static void PCU_MainLoop(void)
{
    static uint32_t last_mppt_tick = 0;
    static uint32_t last_tm_tick = 0;

    /* 100ms MPPT 调节周期 */
    if (g_tick_count - last_mppt_tick >= 100) {
        last_mppt_tick = g_tick_count;
        if (g_pcu_state.mode == PCU_MODE_NORMAL) {
            MPPT_Update(&g_pcu_state);
            Charge_Update(&g_pcu_state);
        }
    }

    /* 1s 遥测上报周期 */
    if (g_tick_count - last_tm_tick >= 1000) {
        last_tm_tick = g_tick_count;
        Telemetry_SendFrame(&g_pcu_state, g_tm_frame);
    }

    /* 持续保护检测 */
    Protect_Check(&g_pcu_state);
}

int main(void)
{
    PCU_Init();

    /* 接通太阳能阵列, 进入正常模式 */
    HAL_GPIO_Write(GPIO_SOLAR_RELAY, 1);
    g_pcu_state.mode = PCU_MODE_NORMAL;

    while (1) {
        PCU_MainLoop();
    }
}
