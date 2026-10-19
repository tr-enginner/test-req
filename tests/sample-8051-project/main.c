/*===========================================================================
 * 卫星电源控制器 (PCU) - 主程序
 * MCU: 8051 兼容 (12 MHz)
 * SAFETY_CRITICAL
 *===========================================================================*/

#include "power_control.h"
#include "telemetry.h"

/*---------------------------------------------------------------------------
 * 全局变量 (XDATA 存储区)
 *---------------------------------------------------------------------------*/
AdcData         xdata g_adc_data;     /* ADC 原始数据 */
CalibratedData  xdata g_cal_data;     /* 标定后工程量 */
TelemetryPacket xdata g_tlm_pkt;      /* 遥测数据包 */

/*---------------------------------------------------------------------------
 * 定时计数器 (IDATA 快速访问)
 *---------------------------------------------------------------------------*/
static unsigned char idata tick_10ms;  /* 10 ms 节拍计数 */
static bit flag_100ms;                 /* 100 ms 采集标志 */
static bit flag_1s;                    /* 1 s 遥测/MPPT 标志 */

/*---------------------------------------------------------------------------
 * 定时器 0 中断服务程序 (10 ms 周期)
 * SRS-001, NFR-001
 *---------------------------------------------------------------------------*/
void timer0_isr(void) interrupt 1 using 1
{
    /* 重载定时器 */
    TH0 = TIMER0_RELOAD_H;
    TL0 = TIMER0_RELOAD_L;

    tick_10ms++;

    /* 100 ms 节拍 (每 10 次) */
    if (tick_10ms % 10 == 0) {
        flag_100ms = 1;
    }

    /* 1 s 节拍 (每 100 次) */
    if (tick_10ms >= 100) {
        tick_10ms = 0;
        flag_1s = 1;
    }

    /* 喂狗 */
    watchdog_feed();
}

/*---------------------------------------------------------------------------
 * 遥控指令处理: MPPT 模式切换
 * IR-001
 *---------------------------------------------------------------------------*/
static void cmd_mppt_mode(unsigned char param_h, unsigned char param_l)
{
    /* param_h: 0=自动, 1=手动固定电压 */
    /* param_l: 手动模式时的 DAC 值 */
    if (param_h == 1 && param_l >= MPPT_DAC_MIN && param_l <= MPPT_DAC_MAX) {
        /* 手动模式: 直接设置 DAC */
        DAC_DATA = param_l;
        DAC_CTRL |= 0x01;
    }
    /* 自动模式: 不做额外处理, mppt_update() 持续运行 */
}

/*---------------------------------------------------------------------------
 * 主程序
 *---------------------------------------------------------------------------*/
void main(void)
{
    /* Phase 1: 系统初始化 (SRS-001) */
    power_init();
    telemetry_init();

    /* 注册遥控指令处理器 */
    telecommand_register(CMD_MPPT_MODE, cmd_mppt_mode);

    /* 使能关键负载 (星务计算机 + 测控应答机) */
    load_switch_set(0, 1);
    load_switch_set(1, 1);

    tick_10ms  = 0;
    flag_100ms = 0;
    flag_1s    = 0;

    /* Phase 2: 主循环 */
    while (1) {

        /* ---- 100 ms 任务: ADC 采集 + 控制 ---- */
        if (flag_100ms) {
            flag_100ms = 0;

            /* 采集所有 ADC 通道 (SRS-002, SRS-003, SRS-005, SRS-007) */
            adc_scan_all();

            /* 标定 */
            adc_calibrate(&g_adc_data, &g_cal_data);

            /* 故障检测 (SRS-010) */
            fault_detect(&g_cal_data);

            /* 蓄电池充放电管理 (SRS-006) */
            battery_manage(&g_cal_data);

            /* 母线保护 (SRS-007) */
            bus_protect(&g_cal_data);

            /* 负载开关状态检查 (SRS-008) */
            load_switch_check();
        }

        /* ---- 1 s 任务: MPPT + 遥测 ---- */
        if (flag_1s) {
            flag_1s = 0;

            /* MPPT 控制 (SRS-004) */
            mppt_update(&g_cal_data);

            /* 组装遥测数据包 (SRS-009) */
            build_telemetry(&g_cal_data, &g_tlm_pkt);

            /* 发送遥测 (SRS-009) */
            telemetry_send(&g_tlm_pkt);
        }

        /* ---- 遥控指令处理 (IR-001) ---- */
        telecommand_process();

        /* 翻转运行指示灯 */
        LED_RUN = ~LED_RUN;
    }
}
