/**
 * 测试用例：RS-25 非对齐内存访问（Misaligned Memory Access）
 *
 * 规则说明：
 *   Inspector 检查通过指针强制转换访问多字节整数的代码，
 *   验证在转换时目标指针的对齐要求是否得到满足。
 *   - Cortex-M0 / M0+：不支持非对齐访问，HardFault 立即触发
 *   - Cortex-M3 / M4：默认支持非对齐访问但性能下降，
 *     若 CCR.UNALIGN_TRP=1（某些 RTOS 会设置）同样触发 HardFault
 *   触发条件取决于缓冲区在运行时的起始地址，静态工具难以判断，
 *   Inspector 需追踪缓冲区来源（协议帧、DMA 目标、栈偏移）推断对齐保证。
 *
 * 缺陷注入点：
 *   1. parse_modbus_frame()：接收缓冲区 uint8_t[]，按字节偏移 1 强转为 uint16_t*，
 *      地址 &buf[1] 为奇数地址，uint16_t 要求 2 字节对齐，触发非对齐访问。
 *   2. get_timestamp_from_packet()：从字节流偏移 3 处读取 uint32_t，
 *      4 字节对齐要求未满足（偏移 3 不是 4 的倍数）。
 *   3. cast_config_buffer()：将动态分配（malloc）的 uint8_t* 直接强转为结构体指针，
 *      malloc 保证最大对齐，但若缓冲来自栈上字节数组则对齐无保证。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] alignment_error: &buf[1] 强转 uint16_t*，奇数地址不对齐
 *   - DEF-CR-xxx [critical] alignment_error: 偏移 3 处读 uint32_t，4 字节对齐不满足
 *   - DEF-CR-xxx [major]    alignment_error: 栈字节数组强转结构体指针，对齐无保证
 */

#include <stdint.h>
#include <string.h>
#include <stdlib.h>

/* ===== 缺陷 1：字节流偏移 1 处强转 uint16_t* ===== */

/**
 * Modbus RTU 帧格式（示例）：
 *   [0] 从站地址 (uint8_t)
 *   [1-2] 寄存器地址 (uint16_t, 大端)
 *   [3-4] 寄存器数量 (uint16_t, 大端)
 *   [5-6] CRC (uint16_t, 小端)
 *
 * 缺陷：&frame[1] 为奇数地址（若 frame 起始为偶数地址），
 *       强转为 uint16_t* 后解引用，在 Cortex-M0 上触发 HardFault。
 *       正确做法：用 memcpy 或手动移位拼字节。
 */
typedef struct {
    uint8_t  slave_addr;
    uint16_t reg_addr;    /* 若直接 cast，可能非对齐 */
    uint16_t reg_count;
} ModbusRequest_t;

void parse_modbus_frame(const uint8_t *frame, uint8_t frame_len,
                        ModbusRequest_t *out)
{
    if (frame_len < 5) return;

    out->slave_addr = frame[0];

    /* BUG: &frame[1] 可能为奇数地址，uint16_t 要求 2 字节对齐 */
    out->reg_addr  = *(const uint16_t *)(&frame[1]);   /* 非对齐访问 */
    out->reg_count = *(const uint16_t *)(&frame[3]);   /* 同上 */

    /* 正确做法：
     * uint16_t tmp;
     * memcpy(&tmp, &frame[1], sizeof(uint16_t));
     * out->reg_addr = tmp; */
}

/* ===== 缺陷 2：偏移 3 处读取 uint32_t（4 字节对齐不满足）===== */

/**
 * 从遥测数据包中提取时间戳（位于字节偏移 3）。
 *
 * 缺陷：偏移 3 不是 4 的倍数，uint32_t 要求 4 字节对齐，
 *       *(uint32_t*)(&pkt[3]) 在 M0 上 HardFault，
 *       在 M3/M4（CCR.UNALIGN_TRP=0）上有额外总线周期，
 *       但若 M4 配置了严格对齐检查（如 FreeRTOS 默认开启），同样 fault。
 */
uint32_t get_timestamp_from_packet(const uint8_t *pkt, uint8_t pkt_len)
{
    if (pkt_len < 7) return 0;

    /* BUG: pkt+3 的地址为 base+3，不满足 uint32_t 的 4 字节对齐要求 */
    return *(const uint32_t *)(&pkt[3]);   /* 非对齐读取 */

    /* 正确做法：
     * uint32_t ts;
     * memcpy(&ts, &pkt[3], sizeof(uint32_t));
     * return ts; */
}

/* ===== 缺陷 3：栈字节数组强转结构体指针 ===== */

typedef struct {
    uint32_t magic;         /* 需 4 字节对齐 */
    uint16_t version;
    uint16_t length;
    uint8_t  payload[56];
} ConfigHeader_t;           /* sizeof = 64，alignof = 4 */

extern int8_t read_config_bytes(uint8_t *buf, uint16_t len);

/**
 * 从字节缓冲区解析配置头。
 *
 * 缺陷：raw_buf 是 uint8_t 数组，编译器只保证 1 字节对齐，
 *       强转为 ConfigHeader_t* 后访问 hdr->magic（uint32_t），
 *       若 raw_buf 的实际地址不是 4 的倍数，触发非对齐访问。
 *       栈上数组的起始地址取决于编译器分配，不可依赖其满足更严格的对齐。
 */
void cast_config_buffer(void)
{
    uint8_t raw_buf[sizeof(ConfigHeader_t)];   /* 仅保证 1 字节对齐 */

    if (read_config_bytes(raw_buf, sizeof(raw_buf)) != 0) return;

    /* BUG: raw_buf 不保证 4 字节对齐，强转后访问 uint32_t 字段可能非对齐 */
    const ConfigHeader_t *hdr = (const ConfigHeader_t *)raw_buf;

    if (hdr->magic != 0xDEADBEEFUL) return;   /* 非对齐读取 uint32_t */

    /* 正确做法：
     * ConfigHeader_t hdr;
     * memcpy(&hdr, raw_buf, sizeof(hdr));
     * if (hdr.magic != 0xDEADBEEF) return; */
}
