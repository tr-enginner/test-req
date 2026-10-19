/**
 * 测试用例：RS-01 数组/缓冲区越界（Array / Buffer Out-of-Bounds）
 *
 * 规则说明：
 *   Inspector 需追踪数组索引来源，检查外部输入是否在使用前经过上限验证。
 *   跨函数的数据流（调用者传入长度字段直接用作索引）是静态工具无法发现的典型场景。
 *
 * 缺陷注入点：
 *   1. parse_frame()：frame->length 来自网络帧，直接用作 payload_buf 索引，无上限检查。
 *   2. copy_sensor_data()：caller 传入 count，未在使用前校验是否超出 dst 大小。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] buffer out-of-bounds: frame->length 未验证上限即用作下标
 *   - DEF-CR-xxx [critical] buffer out-of-bounds: count 未验证上限即驱动 memcpy
 */

#include <stdint.h>
#include <string.h>

#define MAX_PAYLOAD   64U
#define SENSOR_COUNT   8U

/* 接收帧结构体，length 来自外部网络 */
typedef struct {
    uint8_t  cmd;
    uint8_t  length;   /* 取自帧原始字节，未经校验 */
    uint8_t  data[128];
} RxFrame_t;

static uint8_t payload_buf[MAX_PAYLOAD];
static float   sensor_values[SENSOR_COUNT];

/**
 * 解析接收帧：将帧 data 字段前 length 字节写入 payload_buf。
 *
 * 缺陷：frame->length 由外部输入决定，最大可为 255，
 *       而 payload_buf 仅 64 字节，越界写入覆盖相邻内存。
 */
void parse_frame(const RxFrame_t *frame)
{
    /* BUG: 未检查 frame->length <= MAX_PAYLOAD */
    for (uint8_t i = 0; i < frame->length; i++) {
        payload_buf[i] = frame->data[i];   /* 越界写入 */
    }
}

/**
 * 将传感器读值数组拷贝到目标缓冲区。
 *
 * 缺陷：count 由调用者控制，若调用者传入 > SENSOR_COUNT 的值，
 *       memcpy 大小超过 src 实际大小，读取越界内存。
 */
void copy_sensor_data(float *dst, const float *src, uint8_t count)
{
    /* BUG: 未检查 count <= SENSOR_COUNT */
    memcpy(dst, src, count * sizeof(float));   /* 可能越界读 */
}

/* 调用示例（展示触发路径） */
void process_packet(const RxFrame_t *frame)
{
    parse_frame(frame);                    /* frame->length = 0xFF 时越界 */

    float local_buf[4];
    copy_sensor_data(local_buf, sensor_values, 8); /* count=8 超出 local_buf[4] */
}
