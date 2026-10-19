/*===========================================================================
 * 卫星电源控制器 - 遥测遥控通信模块
 *===========================================================================*/

#include "telemetry.h"

/*---------------------------------------------------------------------------
 * 模块内部变量
 *---------------------------------------------------------------------------*/
static unsigned char xdata tx_buf[UART_TX_BUF_SIZE];
static unsigned char xdata rx_buf[8];
static unsigned char idata rx_idx;
static unsigned char idata rx_state;   /* 0=等帧头H, 1=等帧头L, 2=收数据 */
static bit           rx_frame_ready;

/* 指令处理回调表 (最多 4 条指令) */
#define MAX_CMD_HANDLERS 4
static unsigned char code cmd_codes[MAX_CMD_HANDLERS];
static CmdHandler    code cmd_handlers[MAX_CMD_HANDLERS];
static unsigned char idata cmd_count;

/*---------------------------------------------------------------------------
 * 遥测初始化
 *---------------------------------------------------------------------------*/
void telemetry_init(void)
{
    rx_idx = 0;
    rx_state = 0;
    rx_frame_ready = 0;
    cmd_count = 0;
}

/*---------------------------------------------------------------------------
 * UART 发送单字节 (阻塞等待)
 *---------------------------------------------------------------------------*/
void uart_send_byte(unsigned char dat)
{
    SBUF = dat;
    while (!TI)
        ;
    TI = 0;
}

/*---------------------------------------------------------------------------
 * 计算校验和 (字节累加和取反 + 1, 即补码)
 *---------------------------------------------------------------------------*/
static unsigned char calc_checksum(unsigned char *buf, unsigned char len)
{
    unsigned char idata sum = 0;
    unsigned char idata i;

    for (i = 0; i < len; i++) {
        sum += buf[i];
    }
    return (unsigned char)(~sum + 1);
}

/*---------------------------------------------------------------------------
 * 发送遥测帧
 * SRS-009
 * 帧格式: 0xEB 0x90 <len> <data...> <checksum>
 *---------------------------------------------------------------------------*/
void telemetry_send(TelemetryPacket *pkt)
{
    unsigned char idata idx;
    unsigned char idata checksum;

    if (pkt == (TelemetryPacket *)0) {
        return;
    }

    idx = 0;

    /* 数据区填充 */
    tx_buf[idx++] = (unsigned char)(pkt->v_sa >> 8);     /* V_SA 高字节 */
    tx_buf[idx++] = (unsigned char)(pkt->v_sa & 0xFF);    /* V_SA 低字节 */
    tx_buf[idx++] = (unsigned char)(pkt->i_sa >> 8);      /* I_SA 高字节 */
    tx_buf[idx++] = (unsigned char)(pkt->i_sa & 0xFF);    /* I_SA 低字节 */
    tx_buf[idx++] = (unsigned char)(pkt->p_sa >> 8);      /* P_SA 高字节 */
    tx_buf[idx++] = (unsigned char)(pkt->p_sa & 0xFF);    /* P_SA 低字节 */
    tx_buf[idx++] = (unsigned char)(pkt->v_bat >> 8);     /* V_BAT 高字节 */
    tx_buf[idx++] = (unsigned char)(pkt->v_bat & 0xFF);   /* V_BAT 低字节 */
    tx_buf[idx++] = (unsigned char)(pkt->v_bus >> 8);     /* V_BUS 高字节 */
    tx_buf[idx++] = (unsigned char)(pkt->v_bus & 0xFF);   /* V_BUS 低字节 */
    tx_buf[idx++] = pkt->chg_state;                        /* 充电状态 */
    tx_buf[idx++] = pkt->load_status;                      /* 负载开关状态 */
    tx_buf[idx++] = pkt->mppt_dac;                         /* MPPT DAC */
    tx_buf[idx++] = (unsigned char)(pkt->fault_word >> 8);/* 故障字高字节 */
    tx_buf[idx++] = (unsigned char)(pkt->fault_word & 0xFF);/* 故障字低字节 */

    /* 计算数据区校验和 */
    checksum = calc_checksum(tx_buf, idx);

    /* 发送帧 */
    uart_send_byte(TLM_FRAME_SYNC_H);  /* 帧头 */
    uart_send_byte(TLM_FRAME_SYNC_L);
    uart_send_byte(idx);                 /* 数据长度 */

    {
        unsigned char idata i;
        for (i = 0; i < idx; i++) {
            uart_send_byte(tx_buf[i]);
        }
    }

    uart_send_byte(checksum);            /* 校验和 */
}

/*---------------------------------------------------------------------------
 * UART 接收中断处理 (串口 ISR 中调用)
 * IR-001
 *---------------------------------------------------------------------------*/
void uart_rx_isr(void) interrupt 4 using 2
{
    unsigned char idata dat;

    if (RI) {
        RI = 0;
        dat = SBUF;

        switch (rx_state) {
        case 0:  /* 等待帧头高字节 */
            if (dat == TLM_FRAME_SYNC_H) {
                rx_state = 1;
            }
            break;

        case 1:  /* 等待帧头低字节 */
            if (dat == TLM_FRAME_SYNC_L) {
                rx_state = 2;
                rx_idx = 0;
            } else {
                rx_state = 0;
            }
            break;

        case 2:  /* 接收数据 (固定 4 字节: cmd + param_h + param_l + checksum) */
            rx_buf[rx_idx++] = dat;
            if (rx_idx >= 4) {
                rx_frame_ready = 1;
                rx_state = 0;
            }
            break;

        default:
            rx_state = 0;
            break;
        }
    }
}

/*---------------------------------------------------------------------------
 * 处理接收到的遥控指令
 * IR-001
 *---------------------------------------------------------------------------*/
void telecommand_process(void)
{
    unsigned char idata cmd;
    unsigned char idata param_h, param_l;
    unsigned char idata checksum;
    unsigned char idata i;

    if (!rx_frame_ready) {
        return;
    }
    rx_frame_ready = 0;

    /* 校验 */
    checksum = calc_checksum(rx_buf, 3);
    if (checksum != rx_buf[3]) {
        return;  /* 校验失败, 丢弃 */
    }

    cmd     = rx_buf[0];
    param_h = rx_buf[1];
    param_l = rx_buf[2];

    /* 查找指令处理器 */
    for (i = 0; i < cmd_count; i++) {
        if (cmd_codes[i] == cmd && cmd_handlers[i] != (CmdHandler)0) {
            cmd_handlers[i](param_h, param_l);
            return;
        }
    }

    /* 内置指令处理 */
    switch (cmd) {
    case CMD_LOAD_SWITCH:
        load_switch_set(param_h, param_l);
        break;

    case CMD_RESET:
        /* 软件复位: 跳转到 0x0000 */
        ((void (code *)(void))0x0000)();
        break;

    default:
        break;
    }
}

/*---------------------------------------------------------------------------
 * 注册遥控指令处理回调
 *---------------------------------------------------------------------------*/
void telecommand_register(unsigned char cmd_code, CmdHandler handler)
{
    if (cmd_count < MAX_CMD_HANDLERS) {
        cmd_codes[cmd_count] = cmd_code;
        cmd_handlers[cmd_count] = handler;
        cmd_count++;
    }
}
