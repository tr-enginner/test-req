/**
 * @file vdev_adc.c
 * @brief VTest 虚拟 ADC 外设设备 DLL
 *
 * 仿真 PCU 的 6 通道 12-bit ADC 采样。
 * 通过 VPort 接收测试驱动注入的模拟量数据，
 * 映射到 CPU 的 ADC 数据寄存器。
 *
 * === 由 EnvArchitect 智能体自动生成 ===
 */

#include "stdafx.h"
#include <string.h>
#include <stdio.h>

/* ========== 常量定义 ========== */

#define ADC_CHANNELS    6
#define ADC_RESOLUTION  4095   /* 12-bit */

/* ========== 端口定义 ========== */

enum ADC_PORT_ID {
    ADC_CH0 = 0,
    ADC_CH1,
    ADC_CH2,
    ADC_CH3,
    ADC_CH4,
    ADC_CH5,
    DMA_COMPLETE,
    ADC_INPUT,     /* 输入 VPort: 6x uint16_t */
    PORT_COUNT,
    TIMER_SAMPLE = 100,
};

static vttPORT gPorts[PORT_COUNT] = {
    { ADC_CH0,       "adc_ch0",       IOPIN },
    { ADC_CH1,       "adc_ch1",       IOPIN },
    { ADC_CH2,       "adc_ch2",       IOPIN },
    { ADC_CH3,       "adc_ch3",       IOPIN },
    { ADC_CH4,       "adc_ch4",       IOPIN },
    { ADC_CH5,       "adc_ch5",       IOPIN },
    { DMA_COMPLETE,  "dma_complete",  IOPIN },
    { ADC_INPUT,     "adc_input",     VIOPORT },
};

/* ========== 设备属性 ========== */

static LPCTSTR gAttrName[] = {
    "SampleRate",
};

/* ========== 设备状态 (全局) ========== */

static struct {
    unsigned short adc_values[ADC_CHANNELS];
    int sample_rate;
    int initialized;
} g_state;

/* ══════════════════════════════════════════════════════════════
 * MainProc — DLL 入口函数，VTest 通过此函数通信
 *
 * 签名必须严格为: extern "C" vttRES WINAPI MainProc(vttMESSAGE, void*, DWORD)
 * 通过 .def 文件导出。
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
        /* 初始化 ADC 值为中间值 */
        {
            int i;
            for (i = 0; i < ADC_CHANNELS; i++)
                g_state.adc_values[i] = ADC_RESOLUTION / 2;
        }
        vtt.AddLog("[vdev_adc] Initialized (6-ch 12-bit ADC, ID=%d)\n", vtt.DevID());
        break;

    case VTT_QPORTS:
        return (vttRES)gPorts;

    case VTT_QPROPERTY:
        if (dwParam < sizeof(gAttrName) / sizeof(gAttrName[0]))
            return (vttRES)gAttrName[dwParam];
        return 0;

    case VTT_SETPROPERTY:
    {
        CString sPara = (LPCTSTR)dwParam;
        if (sPara.Find("SampleRate=") >= 0) {
            CString sVal = sPara.Mid(sPara.Find('=') + 1);
            g_state.sample_rate = (int)strtol(sVal, NULL, 0);
        }
        break;
    }

    case VTT_RESET:
        if (!g_state.initialized) break;
        /* 创建采样定���器 */
        if (g_state.sample_rate > 0) {
            double period = 1.0 / (double)g_state.sample_rate;
            vtt.CreateTimer(TIMER_SAMPLE, CYCLE_TIMER, period);
        } else {
            vtt.CreateTimer(TIMER_SAMPLE, CYCLE_TIMER, 0.001); /* 默认 1kHz */
        }
        vtt.AddLog("[vdev_adc] Reset\n");
        break;

    case VTT_TERMINATE:
        /* vtt.DeleteTimer(TIMER_SAMPLE); */
        g_state.initialized = 0;
        vtt.AddLog("[vdev_adc] Terminated\n");
        break;

    case VTT_CLOCK:
    {
        if (!g_state.initialized) break;
        /* 采样定时器触发: 将 ADC 值输出到各 Pin */
        int i;
        for (i = 0; i < ADC_CHANNELS; i++) {
            vtt.PinConnect(ADC_CH0 + i, (DWORD)g_state.adc_values[i]);
        }
        /* 触发 DMA 完成中断 */
        vtt.PinConnect(DMA_COMPLETE, 1);
        vtt.PinConnect(DMA_COMPLETE, 0);
        break;
    }

    case VTT_VWBYTES:
    {
        if (!g_state.initialized) break;
        vttParamVWBytes *p = (vttParamVWBytes *)dwParam;
        /* VPort 写入: 测试驱动注入 ADC 数据 (6x uint16_t = 12 bytes) */
        if (p->nSize >= ADC_CHANNELS * 2) {
            int i;
            for (i = 0; i < ADC_CHANNELS; i++) {
                g_state.adc_values[i] = (unsigned short)(p->pByte[i*2] |
                                                          (p->pByte[i*2+1] << 8));
                if (g_state.adc_values[i] > ADC_RESOLUTION)
                    g_state.adc_values[i] = ADC_RESOLUTION;
            }
            vtt.AddLog("[vdev_adc] ADC data injected: ch0=%d ch1=%d ch2=%d ch3=%d ch4=%d ch5=%d\n",
                       g_state.adc_values[0], g_state.adc_values[1],
                       g_state.adc_values[2], g_state.adc_values[3],
                       g_state.adc_values[4], g_state.adc_values[5]);
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
