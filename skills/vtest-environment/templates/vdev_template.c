/**
 * @file  vdev_TEMPLATE.c
 * @brief VTest Virtual Device DLL Template
 *
 * Based on real VTest source code (bus1553, CAN device implementations).
 *
 * Usage:
 *   1. Copy this file and rename to vdev_<your_device>.c
 *   2. Create matching stdafx.h, stdafx.cpp, and <device>.def
 *   3. Define your device class/state (or use simple global state)
 *   4. Define ports in gPorts[] array
 *   5. Implement message handlers for your device's behavior
 *   6. Build with VS2013: DynamicLibrary, MFC Dynamic, Win32, v120 toolset
 *
 * Key rules (from vttDevice.h):
 *   - MainProc: extern "C" vttRES WINAPI MainProc(vttMESSAGE, void*, DWORD)
 *   - VTTFUNCS vtt: global instance, declared in stdafx.cpp
 *   - VTT_INIT: call vtt.GetFunctionPointers(dwParam, pData)
 *   - MainProc entry: call vtt.ConfirmDevID(pData)
 *   - VTT_QSIZE: return sizeof(TCHIP_HEADER)
 *   - VTT_QPORTS: return (vttRES)gPorts
 *   - Export: only MainProc, via .def file
 */

#include "stdafx.h"
#include "vttDevice.h"
#include <string.h>

/* ========== Port/Pin Definitions ========== */

/*
 * Port types:
 *   IOPIN   - Single signal (Pin): PinConnect / VTT_PINCONNECT
 *   VIOPORT - Bulk data (VPort):   WriteVPort / VTT_VWBYTES
 *   IOPORT  - General I/O port
 *
 * Port names MUST match the names used in VTE [Connect] / [VPortConnect].
 * iID values must be unique within each type (pins separate from vports).
 */
enum DEVICE_PORT_ID {
    PIN_INT = 0,       /* Interrupt pin (output to CPU) */
    SERIAL  = 1,       /* Serial VPort (bidirectional data) */
    PORT_COUNT = 2,

    TIMER_SAMPLE = 100, /* Timer IDs (not in port array) */
};

static vttPORT gPorts[PORT_COUNT] = {
    { PIN_INT,  "PIN_INT",  IOPIN },    /* Interrupt signal */
    { SERIAL,   "SERIAL",   VIOPORT },  /* Serial data port */
};

/* ========== Device Properties ========== */

static LPCTSTR gAttrName[] = {
    "BaseAddress",
    /* Add more configurable properties here */
};

/* ========== Device State ========== */

static DWORD g_baseAddress = 0;

/*
 * ========== UART Memory-Mapped Mode Example ==========
 *
 * For UART/RS422 devices, use a RX FIFO + SetWatchOnMemoryM pattern:
 *
 * #define UART_FIFO_SIZE 256
 * static struct {
 *     BYTE buffer[UART_FIFO_SIZE];
 *     int  head, tail, count;
 * } g_rx_fifo;
 *
 * static void fifo_reset(void) { ... }
 * static int  fifo_push(BYTE data) { ... }
 * static int  fifo_pop(BYTE *data) { ... }
 *
 * #define UART_STATUS_RX_READY  0x01
 * #define UART_STATUS_TX_EMPTY  0x02
 */

/* ========== MainProc — DLL Entry Point ========== */

extern "C" vttRES WINAPI MainProc(vttMESSAGE Msg, void *pData, DWORD dwParam)
{
    vtt.ConfirmDevID(pData);  /* MUST be called at every MainProc entry */

    switch (Msg) {

    case VTT_QSIZE:
        /* Return size for VTest to allocate. For simple devices
         * that store state globally, just return sizeof(TCHIP_HEADER). */
        return (vttRES)sizeof(TCHIP_HEADER);

    case VTT_INIT:
        /* Initialize API function pointers — dwParam is HINSTANCE of VTest core */
        vtt.GetFunctionPointers(dwParam, pData);
        ((TCHIP_HEADER *)pData)->nPortCount = PORT_COUNT;
        /* TODO: Create device object, store via vtt.SetUserPtr() */
        vtt.AddLog("[TEMPLATE] Device initialized (ID=%d)\n", vtt.DevID());
        break;

    case VTT_QPORTS:
        /* Return pointer to port definition array */
        return (vttRES)gPorts;

    case VTT_QPROPERTY:
        /* Return property names one by one; return 0 when done */
        if (dwParam < sizeof(gAttrName) / sizeof(gAttrName[0]))
            return (vttRES)gAttrName[dwParam];
        return 0;

    case VTT_SETPROPERTY:
    {
        /* Parse property string: "key=value" */
        CString sPara = (LPCTSTR)dwParam;
        if (sPara.Find("BaseAddress=") >= 0) {
            CString sVal = sPara.Mid(sPara.Find('=') + 1);
            g_baseAddress = (DWORD)strtoul(sVal, NULL, 0);
        }
        /* TODO: Parse additional device properties */
        break;
    }

    case VTT_RESET:
        /* Set up timers, memory watches, initialize simulation state */
        /* Example: periodic sampling timer at 1ms */
        /* vtt.CreateTimer(TIMER_SAMPLE, CYCLE_TIMER, 0.001); */

        /* Example: watch CPU writes to device register range */
        /* vtt.SetWatchOnMemoryM(g_baseAddress, g_baseAddress + 0xFF, 0, VTTWRITE); */

        /* UART example: monitor XDATA register range for CPU read/write.
         * memType=2 = MCS-51 XDATA; VTTREADWRITE = intercept both reads and writes.
         * This enables VTT_MEMREAD and VTT_MEMWRITE callbacks for the address range.
         *
         * vtt.SetWatchOnMemoryM(REG_BASE, REG_BASE + 0x0F, 2, VTTREADWRITE);
         * fifo_reset();
         */
        vtt.AddLog("[TEMPLATE] Device reset\n");
        break;

    case VTT_TERMINATE:
        /* Cleanup: delete timers, free device objects */
        /* vtt.DeleteTimer(TIMER_SAMPLE); */
        /* delete (MyDeviceClass*)vtt.GetUserPtr(); vtt.SetUserPtr(NULL); */

        /* UART example: remove memory watch set in VTT_RESET
         * vtt.UnSetWatchOnMemoryM(REG_BASE, REG_BASE + 0x0F, 2, VTTREADWRITE);
         */
        vtt.AddLog("[TEMPLATE] Device terminated\n");
        break;

    case VTT_CLOCK:
        /* Timer fired — dwParam is the timer/pin ID */
        /* Example:
         * if (dwParam == TIMER_SAMPLE) {
         *     // Read sensor data, update state, trigger interrupt
         *     vtt.PinConnect(PIN_INT, 1);  // Assert interrupt
         * }
         */
        break;

    case VTT_PINCONNECT:
    {
        /* Pin level change from CPU or another device */
        vttParamPinConnect *p = (vttParamPinConnect *)dwParam;
        /* p->nPinID = pin ID, p->dwValue = new value */
        (void)p;
        break;
    }

    case VTT_VWBYTES:
    {
        /* VPort bulk data received */
        vttParamVWBytes *p = (vttParamVWBytes *)dwParam;
        if (p->vttPinID == SERIAL) {
            /* TODO: Process incoming serial data */
            /* p->pByte = data pointer, p->nSize = byte count */
            vtt.AddLog("[TEMPLATE] VPort data: port=%d size=%d\n",
                       p->vttPinID, p->nSize);
        }
        break;
    }

    case VTT_MEMREAD:
    {
        /* CPU read from watched memory address */
        vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
        /* TODO: Return register value to CPU memory */

        /* UART example: CPU reads RX data register — pop from FIFO and write back
         *
         * if (pe->dwAddress == REG_RX_DATA) {
         *     BYTE rxByte = 0;
         *     fifo_pop(&rxByte);
         *     vtt.WriteByte(pe->dwAddress, 2, rxByte);  // Write back so CPU sees the value
         * } else if (pe->dwAddress == REG_STATUS) {
         *     BYTE st = UART_STATUS_TX_EMPTY;
         *     if (g_rx_fifo.count > 0) st |= UART_STATUS_RX_READY;
         *     vtt.WriteByte(pe->dwAddress, 2, st);
         * }
         */
        (void)pe;
        break;
    }

    case VTT_MEMWRITE:
    {
        /* CPU write to watched memory address */
        vttParamMemoryEvent *pe = (vttParamMemoryEvent *)dwParam;
        /* TODO: Process register write from CPU */

        /* UART example: CPU writes TX data register — read byte and send via VPort
         *
         * if (pe->dwAddress == REG_TX_DATA) {
         *     BYTE txByte = vtt.ReadByte(pe->dwAddress, 2);
         *     vtt.WriteVPort(SERIAL, &txByte, 1);  // Send to connected test driver
         * }
         */
        (void)pe;
        break;
    }

    case VTT_SAVE:
        /* Save device state to file: (LPCTSTR)dwParam = file path */
        return TRUE;

    case VTT_LOAD:
        /* Load device state from file: (LPCTSTR)dwParam = file path */
        return TRUE;

    default:
        break;
    }
    return (vttRES)FALSE;
}
