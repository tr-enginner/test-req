/**
 * @file vdev_gpio.c
 * @brief VTest 虚拟 GPIO 外设设备 DLL
 *
 * 仿真 PCU 的 GPIO 离散量接口 (IF-004)。
 * - 5 路输出监控: solar_relay, load_sw1/2/3, status_led
 * - 2 路输入注入: overcurrent, overtemp
 * - 事件记录: 每次输出变化记录仿真时间戳
 *
 * === 由 EnvArchitect 智能体自动生成 ===
 */

#include "stdafx.h"
#include <string.h>
#include <stdio.h>

/* ========== 常量定义 ========== */

#define MAX_EVENTS  1024
#define OUTPUT_PINS 5
#define INPUT_PINS  2

/* ========== 端口定义 ========== */

enum GPIO_PORT_ID {
    OUT0 = 0,       /* solar_relay */
    OUT1,            /* load_sw1 */
    OUT2,            /* load_sw2 */
    OUT3,            /* load_sw3 */
    OUT4,            /* status_led */
    IN0,             /* overcurrent detect */
    IN1,             /* overtemp detect */
    OUTPUT_MONITOR,  /* VPort: 输出状态给测试驱动 */
    INPUT_INJECT,    /* VPort: 从测试驱动接收输入注入 */
    PORT_COUNT,
};

static vttPORT gPorts[PORT_COUNT] = {
    { OUT0,            "out0",            IOPIN },
    { OUT1,            "out1",            IOPIN },
    { OUT2,            "out2",            IOPIN },
    { OUT3,            "out3",            IOPIN },
    { OUT4,            "out4",            IOPIN },
    { IN0,             "in0",             IOPIN },
    { IN1,             "in1",             IOPIN },
    { OUTPUT_MONITOR,  "output_monitor",  VIOPORT },
    { INPUT_INJECT,    "input_inject",    VIOPORT },
};

/* ========== 事件记录 ========== */

typedef struct {
    double timestamp;
    int    pin_index;
    int    old_value;
    int    new_value;
} GPIO_Event;

/* ========== 设备状态 (全局) ========== */

static struct {
    int         output_state[OUTPUT_PINS];
    int         input_state[INPUT_PINS];
    GPIO_Event  events[MAX_EVENTS];
    int         event_count;
    int         initialized;
} g_state;

static void record_event(int pin, int old_val, int new_val)
{
    if (g_state.event_count < MAX_EVENTS) {
        GPIO_Event *e = &g_state.events[g_state.event_count++];
        e->timestamp = vtt.GetRunTime();
        e->pin_index = pin;
        e->old_value = old_val;
        e->new_value = new_val;
    }
}

/* ══════════════════════════════════════════════════════════════
 * MainProc — DLL 入口函数，VTest 通过此函数通信
 * ══════════════════════════════════════════════════════════════ */
extern "C" vttRES WINAPI MainProc(vttMESSAGE Msg, void *pData, DWORD dwParam)
{
    vtt.ConfirmDevID(pData);

    switch (Msg) {
    case VTT_QSIZE:
        return (vttRES)sizeof(TCHIP_HEADER);

    case VTT_INIT:
        vtt.GetFunctionPointers(dwParam, pData);
        ((TCHIP_HEADER *)pData)->nPortCount = PORT_COUNT;
        memset(&g_state, 0, sizeof(g_state));
        g_state.initialized = 1;
        vtt.AddLog("[vdev_gpio] Initialized (5 out + 2 in, ID=%d)\n", vtt.DevID());
        break;

    case VTT_QPORTS:
        return (vttRES)gPorts;

    case VTT_QPROPERTY:
        return 0;

    case VTT_SETPROPERTY:
        break;

    case VTT_RESET:
        if (!g_state.initialized) break;
        g_state.event_count = 0;
        vtt.AddLog("[vdev_gpio] Reset\n");
        break;

    case VTT_TERMINATE:
        g_state.initialized = 0;
        vtt.AddLog("[vdev_gpio] Terminated (%d events recorded)\n", g_state.event_count);
        break;

    case VTT_PINCONNECT:
    {
        if (!g_state.initialized) break;
        vttParamPinConnect *p = (vttParamPinConnect *)dwParam;
        /* CPU 写 GPIO 输出引脚 */
        if (p->nPinID >= OUT0 && p->nPinID <= OUT4) {
            int idx = p->nPinID - OUT0;
            int old_val = g_state.output_state[idx];
            int new_val = p->dwValue ? 1 : 0;
            if (old_val != new_val) {
                g_state.output_state[idx] = new_val;
                record_event(idx, old_val, new_val);
                /* 通过 VPort 通知测试驱动 */
                unsigned char buf[6];
                buf[0] = (unsigned char)idx;
                buf[1] = (unsigned char)new_val;
                float t = (float)vtt.GetRunTime();
                memcpy(&buf[2], &t, 4);
                vtt.WriteVPort(OUTPUT_MONITOR, buf, 6);
            }
        }
        break;
    }

    case VTT_VWBYTES:
    {
        if (!g_state.initialized) break;
        vttParamVWBytes *p = (vttParamVWBytes *)dwParam;
        /* 测试驱动注入 GPIO 输入 */
        if (p->vttPinID == INPUT_INJECT && p->nSize >= 2) {
            int pin_idx = p->pByte[0];     /* 0=overcurrent, 1=overtemp */
            int value   = p->pByte[1];
            if (pin_idx < INPUT_PINS) {
                g_state.input_state[pin_idx] = value;
                vtt.PinConnect(IN0 + pin_idx, (DWORD)value);
                vtt.AddLog("[vdev_gpio] Input inject: pin=%d value=%d\n", pin_idx, value);
            }
        }
        break;
    }

    case VTT_SAVE:
        return TRUE;

    case VTT_LOAD:
        return TRUE;

    default:
        break;
    }
    return (vttRES)FALSE;
}
