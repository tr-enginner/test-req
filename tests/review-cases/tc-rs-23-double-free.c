/**
 * 测试用例：RS-23 双重释放（Double Free）
 *
 * 规则说明：
 *   Inspector 追踪 free() 调用，检查同一指针是否能在两条不同的执行路径上
 *   各被释放一次，或在同一路径上被释放两次。
 *   双重释放会破坏堆管理器的空闲链表元数据，导致后续 malloc 返回已分配内存
 *   （"use-after-free via allocator confusion"），行为完全不可预���。
 *   此类缺陷与 RS-15（释放后使用）有所不同：
 *   RS-15 关注释放后"读写"；RS-23 关注同一指针被"释放两次"。
 *
 * 缺陷注入点：
 *   1. process_and_report()：正常路径和错误路径均调用 free(buf)，
 *      错误路径在 free 后仍执行到函数末尾的 free(buf)，释放两次。
 *   2. cleanup_session()：session 对象在 destroy_session() 内被 free，
 *      调用者随后又对同一指针调用 free(session)，双重释放。
 *   3. handle_two_errors()：两个独立错误处理分支都执行 goto error，
 *      error 标签处统一 free(buf)，若两个分支均触发则 free 两次
 *      （此处简化为两个独立错误均到达同一 free）。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] double_free: process_and_report 错误路径与末尾均 free(buf)
 *   - DEF-CR-xxx [critical] double_free: cleanup_session 内部 free 后调用者再次 free
 *   - DEF-CR-xxx [critical] double_free: 两条 goto error 路径共享同一 free 标签
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

extern int8_t  validate_data(const uint8_t *buf, uint16_t len);
extern int8_t  send_report(const uint8_t *buf, uint16_t len);
extern void    log_error(const char *msg);

/* ===== 缺陷 1：错误路径与末尾各 free 一次 ===== */

/**
 * 处理数据并发送报告。
 *
 * 缺陷：validate_data 失败时：
 *   - 执行 free(buf)（第一次）
 *   - 随后 return -1 ← 如果漏掉这个 return，继续执行到函数末尾
 *   此处故意省略 return，演示"提前 free 后继续执行到末尾 free"的场景。
 */
int8_t process_and_report(uint16_t data_len)
{
    uint8_t *buf = (uint8_t *)malloc(data_len);
    if (buf == NULL) return -1;

    /* 填充数据... */
    memset(buf, 0xAA, data_len);

    if (validate_data(buf, data_len) != 0) {
        log_error("validation failed");
        free(buf);   /* ��一次 free */
        /* BUG: 缺少 return -1，执行流继续向下 */
    }

    send_report(buf, data_len);
    free(buf);   /* 第二次 free（若上面 validate 失败且无 return）*/
    return 0;
}

/* ===== 缺陷 2：被调函数内部 free，调用者再次 free ===== */

typedef struct {
    uint8_t  session_id;
    uint8_t *data_buf;
    uint16_t buf_size;
} Session_t;

/**
 * 销毁会话，释放内部资源和 session 对象本身。
 */
void destroy_session(Session_t *s)
{
    if (s == NULL) return;
    if (s->data_buf != NULL) {
        free(s->data_buf);
        s->data_buf = NULL;
    }
    free(s);   /* 释放 session 对象本身 */
}

/**
 * 关闭并清理会话。
 *
 * 缺陷：destroy_session(session) 内部已经 free(session)，
 *       调用者随后又执行 free(session)，双重释放。
 */
void cleanup_session(Session_t *session)
{
    destroy_session(session);   /* 内部已 free(session) */

    /* BUG: session 指针已在 destroy_session 内被 free，此处再次 free */
    free(session);
}

/* ===== 缺陷 3：两条 goto error 路径共享同一 free ===== */

extern int8_t step_one(uint8_t *buf, uint16_t len);
extern int8_t step_two(uint8_t *buf, uint16_t len);

/**
 * 多步骤操作，任一步骤失败跳到 error 标签统一清理。
 *
 * 缺陷：step_one 失败时已执行 free(buf) 然后 goto error，
 *       error 标签处再次执行 free(buf)，双重释放。
 *       （经典的 goto-cleanup 反模式：在 goto 之前 free 又在目标处 free）
 */
int8_t handle_two_steps(uint16_t len)
{
    uint8_t *buf = (uint8_t *)malloc(len);
    if (buf == NULL) return -1;

    if (step_one(buf, len) != 0) {
        free(buf);      /* 第一次 free */
        goto error;     /* 跳到 error 处又会 free 一次 */
    }

    if (step_two(buf, len) != 0) {
        goto error;     /* 此分支只在 error 处 free 一次（正确）*/
    }

    free(buf);
    return 0;

error:
    free(buf);   /* BUG: step_one 失败时 buf 已被 free，此处再次 free */
    return -1;
}
