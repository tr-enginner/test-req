/**
 * @file pcu_hal.h
 * @brief PCU 硬件抽象层定义
 */
#ifndef PCU_HAL_H
#define PCU_HAL_H

#include <stdint.h>

/* ADC 转换宏 */
#define ADC_TO_VOLTAGE(raw, max_v)     ((float)(raw) / 4095.0f * (max_v))
#define ADC_TO_CURRENT(raw, max_i)     ((float)(raw) / 4095.0f * (max_i))
#define ADC_TO_CURRENT_BIDI(raw, max)  (((float)(raw) / 4095.0f - 0.5f) * 2.0f * (max))
#define ADC_TO_TEMP(raw)               (((float)(raw) / 4095.0f * 3.3f - 0.5f) * 100.0f)

/* GPIO 引脚定义 */
#define GPIO_SOLAR_RELAY    0   /* OUT0: 太阳能阵列开关 */
#define GPIO_LOAD_SW1       1   /* OUT1: 非关键负载 */
#define GPIO_LOAD_SW2       2   /* OUT2: 次关键负载 */
#define GPIO_LOAD_SW3       3   /* OUT3: 关键负载 */
#define GPIO_STATUS_LED     4   /* OUT4: 状态指示灯 */
#define GPIO_SOLAR_OC_DET   5   /* IN0: 太阳能过流检测 */
#define GPIO_BATT_OT_DET    6   /* IN1: 蓄电池过温检测 */

/* PCU 工作模式 */
typedef enum {
    PCU_MODE_STANDBY = 0,
    PCU_MODE_NORMAL,
    PCU_MODE_CHARGING,
    PCU_MODE_PROTECTION,
    PCU_MODE_LOW_POWER
} PCU_Mode;

/* PCU 全局状态 */
typedef struct {
    PCU_Mode mode;
    float solar_voltage;      /* V, 0-50 */
    float solar_current;      /* A, 0-10 */
    float battery_voltage;    /* V, 0-35 */
    float battery_current;    /* A, -5~+5 */
    float bus_voltage;        /* V, 0-35 */
    float temperature;        /* degC, -40~+85 */
    float mppt_duty;          /* PWM duty, 0-1 */
    float charge_duty;        /* PWM duty, 0-1 */
    uint8_t load_enable[3];   /* 负载开关状态 */
    uint8_t solar_relay;      /* 太阳能继电器状态 */
    uint8_t fault_flags;      /* 故障标志位 */
} PCU_State;

/* HAL 函数声明 */
void     HAL_GPIO_Init(void);
void     HAL_GPIO_Write(uint8_t pin, uint8_t value);
uint8_t  HAL_GPIO_Read(uint8_t pin);
void     HAL_ADC_Init(void);
void     HAL_ADC_ReadDMA(uint16_t *buf, uint8_t channels);
void     HAL_PWM_Init(void);
void     HAL_PWM_SetDuty(uint8_t channel, float duty);
void     HAL_UART_Init(uint32_t baudrate);
void     HAL_UART_Send(const uint8_t *data, uint16_t len);
uint8_t  HAL_UART_ReadByte(void);

/* 子模块声明 (前向声明) */
void MPPT_Init(PCU_State *s);
void MPPT_Update(PCU_State *s);
void Charge_Init(PCU_State *s);
void Charge_Update(PCU_State *s);
void Protect_Init(PCU_State *s);
void Protect_Check(PCU_State *s);
void Telemetry_Init(PCU_State *s);
void Telemetry_SendFrame(PCU_State *s, uint8_t *frame);
void Telemetry_ProcessRxByte(PCU_State *s, uint8_t byte);

#endif /* PCU_HAL_H */
