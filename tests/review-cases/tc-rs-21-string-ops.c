/**
 * 测试用例：RS-21 不安全字符串操作（Unsafe String Operations）
 *
 * 规则说明：
 *   Inspector 检查 strcpy / strcat / sprintf / gets 等不携带目标缓冲区长度参数
 *   的字符串函数，以及 snprintf / strncpy 传入了错误尺寸（如 sizeof(指针) 代替
 *   sizeof(缓冲区)）的调用。这类问题的触发条件取决于运行时输入长度，
 *   静态工具通常只能检测常量长度情形，跨函数的动态长度需要人工推理。
 *
 * 缺陷注入点：
 *   1. build_log_entry()：用 sprintf 格式化可变长度的用户消息到固定 64 字节缓冲，
 *      消息超长时溢出相邻栈变量。
 *   2. append_path()：用 strcat 拼接路径，未检查拼接后总长是否超出 buf 容量。
 *   3. copy_device_name()：用 strcpy 复制外部来源的设备名，无长度上限。
 *   4. format_status()：snprintf 第二参数传入 sizeof(指针) 而非 sizeof(缓冲区)，
 *      实际限制为 4 或 8 字节（指针宽度），输出被截断为几乎空字符串。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] buffer_overflow: sprintf 写入固定缓冲，源长度无上限
 *   - DEF-CR-xxx [critical] buffer_overflow: strcat 拼接前未验证剩余容量
 *   - DEF-CR-xxx [critical] buffer_overflow: strcpy 复制外部字符串，无长度限制
 *   - DEF-CR-xxx [major]    buffer_overflow: snprintf 尺寸参数为 sizeof(指针)
 */

#include <stdint.h>
#include <string.h>
#include <stdio.h>

#define LOG_BUF_SIZE     64U
#define PATH_BUF_SIZE   128U
#define NAME_BUF_SIZE    32U

/* 外部输入（长度不可控）*/
extern const char *get_user_message(void);    /* 可返回任意长度字符串 */
extern const char *get_device_name(void);     /* 来自网络，最长 255 字节 */
extern const char *get_base_path(void);
extern const char *get_sub_path(void);
extern uint8_t     get_error_code(void);
extern uint32_t    get_uptime_ms(void);

/* ===== 缺陷 1：sprintf 写入固定缓冲 ===== */

/**
 * 构造日志条目字符串。
 *
 * 缺陷：get_user_message() 返回的字符串长度不受控制，
 *       sprintf 不限制写入长度，超过 64 字节时溢出 log_buf，
 *       覆盖相邻栈变量（如 uptime）或返回地址。
 */
void build_log_entry(char *out, uint16_t out_size)
{
    char log_buf[LOG_BUF_SIZE];          /* 64 字节固定缓冲 */
    uint32_t uptime = get_uptime_ms();   /* 相邻栈变量，可能被覆盖 */

    /* BUG: sprintf 无长度限制，user_msg 超长时 log_buf 溢出 */
    sprintf(log_buf, "[%lu] %s", uptime, get_user_message());

    snprintf(out, out_size, "%s", log_buf);
}

/* ===== 缺陷 2：strcat 拼接前未检查剩余容量 ===== */

/**
 * 将基础路径与子路径拼接为完整路径。
 *
 * 缺陷：未在 strcat 之前检查 strlen(base) + strlen(sub) < PATH_BUF_SIZE，
 *       两段路径之和超过 128 字节时，strcat 写入越界，
 *       溢出至相邻缓冲区或其他栈变量。
 */
void append_path(char *result_buf, uint16_t buf_size)
{
    char path[PATH_BUF_SIZE];
    strncpy(path, get_base_path(), PATH_BUF_SIZE - 1);
    path[PATH_BUF_SIZE - 1] = '\0';

    /* BUG: 未检查 strlen(path) + strlen(get_sub_path()) < PATH_BUF_SIZE */
    strcat(path, get_sub_path());   /* 拼接可能越界 */
    strcat(path, "/");

    snprintf(result_buf, buf_size, "%s", path);
}

/* ===== 缺陷 3：strcpy 复制外部来源字符串 ===== */

static char g_device_name[NAME_BUF_SIZE];   /* 全局，32 字节 */

/**
 * 保存设备名称。
 *
 * 缺陷：get_device_name() 来自网络报文，最长可达 255 字节，
 *       strcpy 不检查目标容量，超过 32 字节时溢出 g_device_name，
 *       覆盖 BSS 段中相邻全局变量。
 */
void copy_device_name(void)
{
    /* BUG: strcpy 无长度限制，源字符串可超过 NAME_BUF_SIZE */
    strcpy(g_device_name, get_device_name());
}

/* ===== 缺陷 4：snprintf 尺寸参数为 sizeof(指针) ===== */

/**
 * 将状态码格式化为可读字符串。
 *
 * 缺陷：status_str 是局部数组，但 sizeof(status_str) 在函数参数中
 *       若写成 sizeof(ptr) 则得到指针宽度（4 或 8），而非缓冲区大小（32）。
 *       此处直接演示：snprintf 第二参数硬编码为 sizeof(char*)，限制仅 4/8 字节，
 *       格式化结果几乎总是被截断，调用者拿到残缺字符串。
 */
void format_status(char *out_ptr, uint16_t out_size)
{
    char status_str[32];

    /* BUG: sizeof(out_ptr) = 4（32位） 或 8（64位），非 sizeof(status_str)=32 */
    snprintf(status_str, sizeof(out_ptr),
             "ERR=%02X UP=%lums", get_error_code(), get_uptime_ms());

    snprintf(out_ptr, out_size, "%s", status_str);
}
