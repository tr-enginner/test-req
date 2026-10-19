/**
 * 测试用例：RS-15 悬空指针与释放后使用（Dangling Pointer / Use-After-Free）
 *
 * 规则说明：
 *   Inspector 追踪指针生命周期，检查指针是否在其所指对象已失效后继续使用：
 *   - 指向局部变量的指针逃逸出函数作用域（栈变量地址外传）
 *   - 指向已释放堆内存的指针再次读写（use-after-free）
 *   - 指向已被覆盖缓冲区的旧指针继续使用（缓冲区重用后的悬空）
 *   此类缺陷会导致读到随机栈数据或写入已被重用的内存，行为不可预测，
 *   且触发时机与调用序列强相关，难以复现和定位。
 *
 * 缺陷注入点：
 *   1. get_temp_buffer()：返回局部数组的指针，函数返回后栈帧释放，
 *      调用者持有悬空指针并写入。
 *   2. free_and_use()：free(buf) 后继续使用 buf 指针读取内容。
 *   3. register_callback()：将局部结构体地址注册为回调参数，
 *      注册函数返回后结构体已销毁，回调触发时访问悬空地址。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] dangling pointer: 返回局部数组地址，调用者写入已释放栈
 *   - DEF-CR-xxx [critical] use-after-free: free 后继续读取 buf 内容
 *   - DEF-CR-xxx [critical] dangling pointer: 局部结构体地址注册为回调参数
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* ===== 缺陷 1：返回局部变量地址 ===== */

/**
 * 获取临时缓冲区指针。
 *
 * 缺陷：tmp_buf 是局部数组，存在于本函数的栈帧中。
 *       函数返回后，栈帧被后续调用覆盖，
 *       调用者通过返回的指针读写的是已被复用的栈内存。
 */
uint8_t *get_temp_buffer(uint8_t size)
{
    uint8_t tmp_buf[64];   /* 局部数组，存在于栈 */
    memset(tmp_buf, 0, size);
    /* BUG: 返回局部变量地址，函数返回后栈帧失效 */
    return tmp_buf;        /* 悬空指针 */
}

/**
 * 调用者使用悬空指针写入。
 */
void caller_uses_dangling(void)
{
    uint8_t *buf = get_temp_buffer(32);
    /* 此时 buf 指向的栈空间已被当前函数自身的栈帧覆盖 */
    buf[0] = 0xAA;   /* 写入随机栈区域，破坏其他局部变量 */
    buf[1] = 0xBB;
}

/* ===== 缺陷 2：释放后使用（Use-After-Free）===== */

/**
 * 处理数据包后释放缓冲区，但随后继续访问已释放内存。
 *
 * 缺陷：free(buf) 后，buf 指向的内存可能被下一次 malloc 重用，
 *       继续读取 buf[0] 得到的是被其他分配覆盖后的不确定值。
 */
extern uint8_t *allocate_packet_buf(uint16_t size);
extern int8_t   transmit_ack(uint8_t seq);

void free_and_use(uint16_t size)
{
    uint8_t *buf = allocate_packet_buf(size);
    if (buf == NULL) return;

    buf[0] = 0x01;   /* 写入序列号 */
    buf[1] = 0xAA;   /* 写入命令 */

    /* 处理完成，释放缓冲区 */
    free(buf);

    /* BUG: free 后继续读取 buf[0]（use-after-free）*/
    uint8_t seq = buf[0];        /* 读到不确定值 */
    transmit_ack(seq);           /* 基于损坏的序列号发送 ACK */
}

/* ===== 缺陷 3：局部结构体地址注册为回调参数 ===== */

typedef struct {
    uint8_t  channel;
    uint16_t period_ms;
    uint8_t  repeat;
} TimerConfig_t;

typedef void (*timer_cb_t)(void *arg);

extern void register_timer(uint16_t period_ms, timer_cb_t cb, void *arg);
extern void timer_callback(void *arg);   /* 回调中访问 arg->channel */

/**
 * 配置并注册定时器。
 *
 * 缺陷：cfg 是局部结构体，函数返回后栈帧被销毁。
 *       但 &cfg 已注册为定时器回调参数，
 *       回调触发时（数百毫秒后）访问的是已被覆盖的栈内存。
 */
void setup_timer(uint8_t ch, uint16_t period)
{
    TimerConfig_t cfg;          /* 局部变量，存在于当前栈帧 */
    cfg.channel   = ch;
    cfg.period_ms = period;
    cfg.repeat    = 1;

    /* BUG: 传入 &cfg，但函数返回后 cfg 已失效 */
    register_timer(period, timer_callback, &cfg);
    /* 函数返回 → cfg 所在栈帧被销毁 → 回调将访问悬空地址 */
}
