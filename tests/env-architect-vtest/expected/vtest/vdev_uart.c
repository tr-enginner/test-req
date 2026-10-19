/**
 * @file vdev_uart.c
 * @brief VTest 虚拟 UART 外设设备 DLL
 *
 * 仿真 PCU 的 USART1 遥测遥控接口 (IF-003)。
 * - TX 方向: 捕获 PCU 发出的遥测帧，转发到测试驱动 VPort
 * - RX 方向: 接收测试驱动注入的遥控帧，写入 CPU USART1 数据寄存器
 *
 * === 由 EnvArchitect 智能体自动生成 ===
 */

#include "stdafx.h"
#include <string.h>
#include <stdio.h>

/* ========== 常量定义 ========== */

#define UART_BUF_SIZE  256
#define FRAME_SYNC_0   0xEB
#define FRAME_SYNC_1   0x90

/* ========== 端口定义 ========== */

enum UART_PORT_ID {
    TX_DATA = 0,       /* Pin: 连接 CPU USART1_DR (TX 方向) */
    RX_DATA,           /* Pin: 连接 CPU USART1_DR (RX 方向) */
    RX_IRQ,            /* Pin: 连接 CPU USART1 中断 */
    TX_CAPTURE,        /* VPort: 输出捕获到的遥测帧 */
    RX_INJECT,         /* VPort: 输入待注入的遥控帧 */
    PORT_COUNT,
    TIMER_RX_BYTE = 100,
};

static vttPORT gPorts[PORT_COUNT] = {
    { TX_DATA,     "tx_data",     IOPIN },
    { RX_DATA,     "rx_data",     IOPIN },
    { RX_IRQ,      "rx_irq",      IOPIN },
    { TX_CAPTURE,  "tx_capture",  VIOPORT },
    { RX_INJECT,   "rx_inject",   VIOPORT },
};

/* ========== 设备属性 ========== */

static LPCTSTR gAttrName[] = {
    "BaudRate",
};

/* ========== 设备状态 (全局) ========== */

static struct {
    unsigned int  baudrate;
    /* TX 捕获 */
    unsigned char tx_buf[UART_BUF_SIZE];
    int           tx_pos;
    /* RX 注入 */
    unsigned char rx_buf[UART_BUF_SIZE];
    int           rx_len;
    int           rx_pos;
    int           initialized;
} g_state;

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
        g_state.baudrate = 115200;
        g_state.initialized = 1;
        vtt.AddLog("[vdev_uart] Initialized (115200 baud, ID=%d)\n", vtt.DevID());
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
        if (sPara.Find("BaudRate=") >= 0) {
            CString sVal = sPara.Mid(sPara.Find('=') + 1);
            g_state.baudrate = (unsigned int)strtoul(sVal, NULL, 0);
        }
        break;
    }

    case VTT_RESET:
        if (!g_state.initialized) break;
        g_state.tx_pos = 0;
        g_state.rx_pos = 0;
        g_state.rx_len = 0;
        vtt.AddLog("[vdev_uart] Reset\n");
        break;

    case VTT_TERMINATE:
        g_state.initialized = 0;
        vtt.AddLog("[vdev_uart] Terminated\n");
        break;

    case VTT_PINCONNECT:
    {
        if (!g_state.initialized) break;
        vttParamPinConnect *p = (vttParamPinConnect *)dwParam;
        /* CPU 写 USART1_DR → 捕获 TX 字节 */
        if (p->nPinID == TX_DATA) {
            if (g_state.tx_pos < UART_BUF_SIZE) {
                g_state.tx_buf[g_state.tx_pos++] = (unsigned char)(p->dwValue & 0xFF);
            }
            /* 帧检测: 超过最小帧长度时尝试转发 */
            if (g_state.tx_pos >= 6) {
                int frame_len = g_state.tx_buf[2] + 6;
                if (g_state.tx_pos >= frame_len) {
                    vtt.WriteVPort(TX_CAPTURE, g_state.tx_buf, frame_len);
                    g_state.tx_pos = 0;
                }
            }
        }
        break;
    }

    case VTT_VWBYTES:
    {
        if (!g_state.initialized) break;
        vttParamVWBytes *p = (vttParamVWBytes *)dwParam;
        /* 测试驱动通过 VPort 注入遥控帧 */
        if (p->vttPinID == RX_INJECT && p->nSize <= UART_BUF_SIZE) {
            memcpy(g_state.rx_buf, p->pByte, p->nSize);
            g_state.rx_len = p->nSize;
            g_state.rx_pos = 0;
            /* 按波特率时序逐字节发送: 每字节约 86.8μs @115200 */
            double byte_period = 10.0 / (double)g_state.baudrate;
            vtt.CreateTimer(TIMER_RX_BYTE, CYCLE_TIMER, byte_period);
            vtt.AddLog("[vdev_uart] RX inject: %d bytes\n", p->nSize);
        }
        break;
    }

    case VTT_CLOCK:
    {
        if (!g_state.initialized) break;
        /* RX 字节发送定时器 */
        if (g_state.rx_pos < g_state.rx_len) {
            vtt.PinConnect(RX_DATA, (DWORD)g_state.rx_buf[g_state.rx_pos]);
            vtt.PinConnect(RX_IRQ, 1);
            vtt.PinConnect(RX_IRQ, 0);
            g_state.rx_pos++;
        } else if (g_state.rx_len > 0) {
            /* 帧发送完毕 */
            g_state.rx_len = 0;
            /* vtt.DeleteTimer(TIMER_RX_BYTE); */
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
