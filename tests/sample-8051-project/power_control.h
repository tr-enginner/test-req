#ifndef POWER_CONTROL_H
#define POWER_CONTROL_H

/*===========================================================================
 * 卫星电源控制器 - 电源管理模块头文件
 *===========================================================================*/

#include "hw_config.h"

/*---------------------------------------------------------------------------
 * 类型定义
 *---------------------------------------------------------------------------*/

/* ADC 标定系数 (定点数, Q8 格式) */
/* V_SA: 10 mV/LSB => raw * 10 mV, 用 16-bit 无符号表示 mV */
/* I_SA: 1 mA/LSB  => raw * 1 mA,  用 16-bit 无符号表示 mA */
/* V_BAT: 5.86 mV/LSB => raw * 1506 / 256 mV (Q8 近似) */
/* V_BUS: 同 V_SA 标定 */

/* 系统运行状态 */
typedef enum {
    STATE_SAFE_MODE = 0,   /* 安全模式 (初始化后默认) */
    STATE_NORMAL,          /* 正常工作模式 */
    STATE_UNDERVOLT,       /* 欠压保护模式 */
    STATE_FAULT            /* 故障模式 */
} SystemState;

/* 蓄电池充电状态 */
typedef enum {
    CHG_STOPPED = 0,       /* 停止充电 */
    CHG_CHARGING,          /* 正在充电 */
    CHG_UNDERVOLT          /* 欠压保护中 */
} ChargeState;

/* 故障字位定义 */
#define FAULT_SA_OVERVOLT    0x0001  /* bit 0: 太阳能阵列过压 */
#define FAULT_SA_SENSOR      0x0002  /* bit 1: 太阳能阵列传感器故障 */
#define FAULT_BAT_OVERCHG    0x0004  /* bit 2: 蓄电池过充 */
#define FAULT_BAT_UNDERVOLT  0x0008  /* bit 3: 蓄电池过放 */
#define FAULT_BUS_OVERVOLT   0x0010  /* bit 4: 母线过压 */
#define FAULT_BUS_UNDERVOLT  0x0020  /* bit 5: 母线欠压 */
#define FAULT_LOAD_MISMATCH  0x0040  /* bit 6: 负载开关状态不一致 */
#define FAULT_WDT_WARNING    0x0080  /* bit 7: 看门狗预警 */

/* ADC 原始数据结构 (存储在 XDATA 区) */
typedef struct {
    unsigned int  v_sa_raw;     /* 太阳能阵列电压 ADC 值 */
    unsigned int  i_sa_raw;     /* 太阳能阵列电流 ADC 值 */
    unsigned int  v_bat_raw;    /* 蓄电池电压 ADC 值 */
    unsigned int  v_bus_raw;    /* 母线电压 ADC 值 */
    unsigned int  temp_bat_raw; /* 蓄电池温度 ADC 值 */
    unsigned int  temp_pcu_raw; /* PCU 板温 ADC 值 */
    unsigned int  i_load_raw;   /* 总负载电流 ADC 值 */
} AdcData;

/* 标定后的工程量 (mV / mA 单位, 16-bit 无符号) */
typedef struct {
    unsigned int  v_sa_mv;      /* 太阳能阵列电压 (mV) */
    unsigned int  i_sa_ma;      /* 太阳能阵列电流 (mA) */
    unsigned int  v_bat_mv;     /* 蓄电池电压 (mV) */
    unsigned int  v_bus_mv;     /* 母线电压 (mV) */
    unsigned int  p_sa_mw;     /* 太阳能阵列功率 (mW), 截断到 16-bit */
} CalibratedData;

/* 遥测数据包 */
typedef struct {
    unsigned int  v_sa;         /* 太阳能阵列电压 (mV) */
    unsigned int  i_sa;         /* 太阳能阵列电流 (mA) */
    unsigned int  p_sa;         /* 太阳能阵列功率 (mW) */
    unsigned int  v_bat;        /* 蓄电池电压 (mV) */
    unsigned int  v_bus;        /* 母线电压 (mV) */
    unsigned char chg_state;    /* 充电状态 */
    unsigned char load_status;  /* 负载开关状态位图 */
    unsigned char mppt_dac;     /* MPPT DAC 当前值 */
    unsigned int  fault_word;   /* 故障字 */
} TelemetryPacket;

/*---------------------------------------------------------------------------
 * 阈值常量 (mV / mA 单位)
 *---------------------------------------------------------------------------*/

/* 太阳能阵列 */
#define V_SA_MAX_MV          38000   /* 有效上限 38.0 V */

/* 蓄电池 */
#define V_BAT_OVERCHG_MV     19600   /* 过充保护 19.6 V */
#define V_BAT_RESUME_MV      19000   /* 恢复充电 19.0 V */
#define V_BAT_UNDERVOLT_MV   14000   /* 欠压保护 14.0 V */
#define V_BAT_UV_RESUME_MV   14500   /* 欠压恢复 14.5 V */

/* 母线 */
#define V_BUS_NOMINAL_MV     28000   /* 标称 28.0 V */
#define V_BUS_OVERVOLT_MV    32000   /* 过压保护 32.0 V */
#define V_BUS_UNDERVOLT_MV   25000   /* 欠压告警 25.0 V */
#define V_BUS_NORMAL_MIN_MV  26000   /* 正常下限 26.0 V */
#define V_BUS_NORMAL_MAX_MV  30000   /* 正常上限 30.0 V */

/* MPPT */
#define MPPT_DAC_MIN         100     /* 最小允许 DAC 值 (10.0 V) */
#define MPPT_DAC_MAX         250     /* 最大允许 DAC 值 (25.0 V) */
#define MPPT_DAC_INIT        178     /* 初始 DAC 值 (70% Voc) */

/* 关键负载掩码 (LOAD_SW[0] 和 LOAD_SW[1] 不可切断) */
#define CRITICAL_LOAD_MASK   0x03

/*---------------------------------------------------------------------------
 * 公有函数声明
 *---------------------------------------------------------------------------*/

/* 系统初始化 */
void power_init(void);

/* ADC 采集 (在定时器中断中调用) */
void adc_scan_all(void);

/* ADC 原始值标定为工程量 */
void adc_calibrate(AdcData *raw, CalibratedData *cal);

/* MPPT 控制 (1 s 周期调用) */
void mppt_update(CalibratedData *cal);

/* 蓄电池充放电管理 */
void battery_manage(CalibratedData *cal);

/* 母线保护 */
void bus_protect(CalibratedData *cal);

/* 负载开关控制 */
void load_switch_set(unsigned char channel, unsigned char on_off);
void load_switch_check(void);
void load_shed_noncritical(void);
void load_restore_noncritical(void);

/* 故障检测 */
void fault_detect(CalibratedData *cal);

/* 看门狗喂狗 */
void watchdog_feed(void);

/* 获取全局状态 */
SystemState    get_system_state(void);
ChargeState    get_charge_state(void);
unsigned int   get_fault_word(void);
unsigned char  get_load_status(void);
unsigned char  get_mppt_dac(void);

/* 组装遥测数据包 */
void build_telemetry(CalibratedData *cal, TelemetryPacket *pkt);

#endif /* POWER_CONTROL_H */
