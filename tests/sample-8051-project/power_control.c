/*===========================================================================
 * 卫星电源控制器 - 电源管理模块
 * SAFETY_CRITICAL
 *===========================================================================*/

#include "power_control.h"

/*---------------------------------------------------------------------------
 * 模块内部变量 (XDATA 存储区)
 *---------------------------------------------------------------------------*/
static SystemState  xdata g_sys_state;
static ChargeState  xdata g_chg_state;
static unsigned int xdata g_fault_word;
static unsigned char xdata g_load_cmd;      /* 负载开关指令值 */
static unsigned char xdata g_load_status;   /* 负载开关实际状态 */
static unsigned char xdata g_mppt_dac;      /* MPPT DAC 当前值 */
static unsigned int xdata g_prev_power;     /* 上一周期功率 (mW) */
static signed char  xdata g_mppt_dir;       /* MPPT 调整方向 (+1/-1) */
static unsigned char xdata g_saved_loads;   /* 欠压保护前的负载状态 */

/*---------------------------------------------------------------------------
 * 系统初始化
 * SRS-001
 *---------------------------------------------------------------------------*/
/* SAFETY_CRITICAL */
void power_init(void)
{
    /* 初始化全局状态 */
    g_sys_state   = STATE_SAFE_MODE;
    g_chg_state   = CHG_STOPPED;
    g_fault_word  = 0x0000;
    g_load_cmd    = 0x00;
    g_load_status = 0x00;
    g_mppt_dac    = MPPT_DAC_INIT;
    g_prev_power  = 0;
    g_mppt_dir    = 1;
    g_saved_loads = 0x00;

    /* 所有负载开关断开 */
    P0 = 0x00;

    /* 停止充电、解除短路保护 */
    CHG_EN   = 0;
    SA_SHORT = 0;

    /* 设置 MPPT DAC 初始值 */
    DAC_DATA = g_mppt_dac;
    DAC_CTRL = 0x81;  /* 使能 + 更新 */

    /* 配置定时器 0: 模式 1 (16-bit), 10 ms 周期 */
    TMOD = (TMOD & 0xF0) | 0x01;
    TH0  = TIMER0_RELOAD_H;
    TL0  = TIMER0_RELOAD_L;
    TR0  = 1;   /* 启动定时器 */
    ET0  = 1;   /* 使能定时器 0 中断 */

    /* 配置 UART: 模式 1 (8-bit), 9600 bps */
    SCON = 0x50;            /* 模式 1, 允许接收 */
    PCON |= 0x80;           /* SMOD = 1, 波特率翻倍 */
    /* 使用定时器 1 作为波特率发生器 (自动重载模式) */
    TMOD = (TMOD & 0x0F) | 0x20;
    /* TH1/TL1 重载值设为 9600 bps */
    ES   = 1;               /* 使能串口中断 */

    /* 使能看门狗 */
    WDT_CTRL = 0x80;

    /* 使能总中断 */
    EA = 1;
}

/*---------------------------------------------------------------------------
 * ADC 全通道扫描
 * SRS-002, SRS-003, SRS-005, SRS-007
 *---------------------------------------------------------------------------*/
void adc_scan_all(void)
{
    unsigned char idata ch;
    unsigned int  xdata *result_ptr;
    AdcData       xdata *p_adc;

    /* 获取全局 ADC 数据缓冲区 */
    extern AdcData xdata g_adc_data;
    p_adc = &g_adc_data;
    result_ptr = (unsigned int xdata *)p_adc;

    for (ch = 0; ch < ADC_NUM_CHANNELS; ch++) {
        /* 选择通道并启动转换 */
        ADC_CTRL = ADC_START_BIT | (ch & 0x07);

        /* 等待转换完成 */
        while (!(ADC_CTRL & ADC_DONE_BIT))
            ;

        /* 读取 12-bit 结果 */
        if (ch < 7) {
            result_ptr[ch] = ((unsigned int)(ADC_DATH & 0x0F) << 8) | ADC_DATL;
        }
    }
}

/*---------------------------------------------------------------------------
 * ADC 标定
 * SRS-002, SRS-003, SRS-005, SRS-007
 *---------------------------------------------------------------------------*/
void adc_calibrate(AdcData *raw, CalibratedData *cal)
{
    unsigned long idata temp32;

    if (raw == (AdcData *)0 || cal == (CalibratedData *)0) {
        return;
    }

    /* V_SA: 10 mV/LSB */
    cal->v_sa_mv = raw->v_sa_raw * 10;

    /* I_SA: 1 mA/LSB */
    cal->i_sa_ma = raw->i_sa_raw;

    /* V_BAT: 5.86 mV/LSB => raw * 1506 / 256 (Q8 定点运算) */
    temp32 = (unsigned long)raw->v_bat_raw * 1506UL;
    cal->v_bat_mv = (unsigned int)(temp32 >> 8);

    /* V_BUS: 10 mV/LSB (与 V_SA 相同标定) */
    cal->v_bus_mv = raw->v_bus_raw * 10;

    /* P_SA = V_SA * I_SA / 1000 (mW)
     * V_SA 单位 mV, I_SA 单位 mA => V*I/1000 = mW */
    temp32 = (unsigned long)cal->v_sa_mv * (unsigned long)cal->i_sa_ma;
    cal->p_sa_mw = (unsigned int)(temp32 / 1000UL);
}

/*---------------------------------------------------------------------------
 * MPPT 扰动观察法 (P&O)
 * SRS-004
 *---------------------------------------------------------------------------*/
/* SAFETY_CRITICAL */
void mppt_update(CalibratedData *cal)
{
    unsigned int idata current_power;

    if (cal == (CalibratedData *)0) {
        return;
    }

    /* 传感器故障时冻结 DAC */
    if (g_fault_word & FAULT_SA_SENSOR) {
        return;
    }

    /* 太阳能阵列过压时 DAC 置最小 */
    if (g_fault_word & FAULT_SA_OVERVOLT) {
        g_mppt_dac = MPPT_DAC_MIN;
        DAC_DATA = g_mppt_dac;
        DAC_CTRL |= 0x01;
        return;
    }

    current_power = cal->p_sa_mw;

    /* P&O 算法核心 */
    if (current_power > g_prev_power) {
        /* 功率增大, 维持方向 */
    } else if (current_power < g_prev_power) {
        /* 功率减小, 反转方向 */
        g_mppt_dir = -g_mppt_dir;
    }
    /* 功率不变时不调整方向 */

    /* 调整 DAC */
    if (g_mppt_dir > 0 && g_mppt_dac < MPPT_DAC_MAX) {
        g_mppt_dac++;
    } else if (g_mppt_dir < 0 && g_mppt_dac > MPPT_DAC_MIN) {
        g_mppt_dac--;
    }

    /* 安全限幅 */
    if (g_mppt_dac < MPPT_DAC_MIN) g_mppt_dac = MPPT_DAC_MIN;
    if (g_mppt_dac > MPPT_DAC_MAX) g_mppt_dac = MPPT_DAC_MAX;

    /* 更新 DAC 输出 */
    DAC_DATA = g_mppt_dac;
    DAC_CTRL |= 0x01;

    g_prev_power = current_power;
}

/*---------------------------------------------------------------------------
 * 蓄电池充放电管理
 * SRS-006
 *---------------------------------------------------------------------------*/
/* SAFETY_CRITICAL */
void battery_manage(CalibratedData *cal)
{
    if (cal == (CalibratedData *)0) {
        return;
    }

    switch (g_chg_state) {
    case CHG_CHARGING:
        /* 过充保护: V_BAT >= 19.6V 时停止充电 */
        if (cal->v_bat_mv >= V_BAT_OVERCHG_MV) {
            CHG_EN = 0;
            g_chg_state = CHG_STOPPED;
            g_fault_word |= FAULT_BAT_OVERCHG;
        }
        /* 欠压保护: V_BAT <= 14.0V 时进入欠压模式 */
        if (cal->v_bat_mv <= V_BAT_UNDERVOLT_MV) {
            g_chg_state = CHG_UNDERVOLT;
            g_fault_word |= FAULT_BAT_UNDERVOLT;
            load_shed_noncritical();
        }
        break;

    case CHG_STOPPED:
        /* 恢复充电: V_BAT < 19.0V 且有太阳能功率 */
        if (cal->v_bat_mv < V_BAT_RESUME_MV && cal->p_sa_mw > 0) {
            CHG_EN = 1;
            g_chg_state = CHG_CHARGING;
            g_fault_word &= ~FAULT_BAT_OVERCHG;
        }
        /* 欠压检测 */
        if (cal->v_bat_mv <= V_BAT_UNDERVOLT_MV) {
            g_chg_state = CHG_UNDERVOLT;
            g_fault_word |= FAULT_BAT_UNDERVOLT;
            load_shed_noncritical();
        }
        break;

    case CHG_UNDERVOLT:
        /* 欠压恢复: V_BAT > 14.5V */
        if (cal->v_bat_mv > V_BAT_UV_RESUME_MV) {
            g_chg_state = CHG_CHARGING;
            g_fault_word &= ~FAULT_BAT_UNDERVOLT;
            load_restore_noncritical();
            CHG_EN = 1;
        }
        break;

    default:
        g_chg_state = CHG_STOPPED;
        break;
    }
}

/*---------------------------------------------------------------------------
 * 母线电压保护
 * SRS-007
 *---------------------------------------------------------------------------*/
/* SAFETY_CRITICAL */
void bus_protect(CalibratedData *cal)
{
    if (cal == (CalibratedData *)0) {
        return;
    }

    /* 过压保护: V_BUS > 32.0V => 太阳能阵列短路 */
    if (cal->v_bus_mv > V_BUS_OVERVOLT_MV) {
        SA_SHORT = 1;
        g_fault_word |= FAULT_BUS_OVERVOLT;
    } else {
        SA_SHORT = 0;
        g_fault_word &= ~FAULT_BUS_OVERVOLT;
    }

    /* 欠压告警: V_BUS < 25.0V */
    if (cal->v_bus_mv < V_BUS_UNDERVOLT_MV) {
        g_fault_word |= FAULT_BUS_UNDERVOLT;
    } else {
        g_fault_word &= ~FAULT_BUS_UNDERVOLT;
    }
}

/*---------------------------------------------------------------------------
 * 负载开关控制
 * SRS-008
 *---------------------------------------------------------------------------*/
void load_switch_set(unsigned char channel, unsigned char on_off)
{
    unsigned char idata mask;

    if (channel > 7) {
        return;
    }

    mask = (unsigned char)(1 << channel);

    if (on_off) {
        g_load_cmd |= mask;
    } else {
        /* 关键负载 (0, 1) 不允许通过指令关闭 */
        if (channel < 2) {
            return;
        }
        g_load_cmd &= ~mask;
    }

    /* 输出到端口 */
    P0 = g_load_cmd;
}

void load_switch_check(void)
{
    unsigned char idata actual;

    actual = P0;
    g_load_status = actual;

    if (actual != g_load_cmd) {
        g_fault_word |= FAULT_LOAD_MISMATCH;
    } else {
        g_fault_word &= ~FAULT_LOAD_MISMATCH;
    }
}

/* SAFETY_CRITICAL */
void load_shed_noncritical(void)
{
    g_saved_loads = g_load_cmd;
    g_load_cmd &= CRITICAL_LOAD_MASK;  /* 仅保留关键负载 */
    P0 = g_load_cmd;
}

void load_restore_noncritical(void)
{
    g_load_cmd = g_saved_loads;
    P0 = g_load_cmd;
}

/*---------------------------------------------------------------------------
 * 故障检测
 * SRS-010
 *---------------------------------------------------------------------------*/
/* SAFETY_CRITICAL */
void fault_detect(CalibratedData *cal)
{
    if (cal == (CalibratedData *)0) {
        return;
    }

    /* 太阳能阵列过压 */
    if (cal->v_sa_mv > V_SA_MAX_MV) {
        g_fault_word |= FAULT_SA_OVERVOLT;
    } else {
        g_fault_word &= ~FAULT_SA_OVERVOLT;
    }

    /* 太阳能阵列传感器故障 (ADC 满量程或零) */
    if (cal->v_sa_mv == 0 && cal->i_sa_ma == 0) {
        /* 同时为零可能是正常 (夜间), 不报故障 */
    } else if (cal->v_sa_mv > 40950) {
        g_fault_word |= FAULT_SA_SENSOR;
    } else {
        g_fault_word &= ~FAULT_SA_SENSOR;
    }

    /* 蓄电池过充/欠压在 battery_manage 中处理 */

    /* 母线过压/欠压在 bus_protect 中处理 */

    /* 负载开关状态不一致在 load_switch_check 中处理 */

    /* 致命故障立即处理 */
    if (g_fault_word & FAULT_SA_OVERVOLT) {
        g_mppt_dac = MPPT_DAC_MIN;
        DAC_DATA = g_mppt_dac;
        DAC_CTRL |= 0x01;
    }
    if (g_fault_word & FAULT_BAT_UNDERVOLT) {
        load_shed_noncritical();
    }
    if (g_fault_word & FAULT_BUS_OVERVOLT) {
        SA_SHORT = 1;
    }
}

/*---------------------------------------------------------------------------
 * 看门狗喂狗
 *---------------------------------------------------------------------------*/
void watchdog_feed(void)
{
    WDT_CTRL |= 0x01;  /* 喂狗位 */
}

/*---------------------------------------------------------------------------
 * 状态查询函数
 *---------------------------------------------------------------------------*/
SystemState get_system_state(void)
{
    return g_sys_state;
}

ChargeState get_charge_state(void)
{
    return g_chg_state;
}

unsigned int get_fault_word(void)
{
    return g_fault_word;
}

unsigned char get_load_status(void)
{
    return g_load_status;
}

unsigned char get_mppt_dac(void)
{
    return g_mppt_dac;
}

/*---------------------------------------------------------------------------
 * 组装遥测数据包
 * SRS-009
 *---------------------------------------------------------------------------*/
void build_telemetry(CalibratedData *cal, TelemetryPacket *pkt)
{
    if (cal == (CalibratedData *)0 || pkt == (TelemetryPacket *)0) {
        return;
    }

    pkt->v_sa       = cal->v_sa_mv;
    pkt->i_sa       = cal->i_sa_ma;
    pkt->p_sa       = cal->p_sa_mw;
    pkt->v_bat      = cal->v_bat_mv;
    pkt->v_bus      = cal->v_bus_mv;
    pkt->chg_state  = (unsigned char)g_chg_state;
    pkt->load_status = g_load_status;
    pkt->mppt_dac   = g_mppt_dac;
    pkt->fault_word = g_fault_word;
}
