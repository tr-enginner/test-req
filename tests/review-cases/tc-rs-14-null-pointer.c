/**
 * 测试用例：RS-14 空指针解引用（Null Pointer Dereference）
 *
 * 规则说明：
 *   Inspector 追踪指针的来源，检查在解引用之前是否有 NULL 值防护。
 *   重点关注：函数返回值（查找/分配函数）、可选参数指针、
 *   以及跨函数传递的指针（调用者不检查直接传给解引用方）。
 *   此类缺陷在嵌入式系统上通常导致硬件异常（HardFault/BusFault），
 *   且触发条件往往依赖运行时状态，静态工具难以跨函数追踪。
 *
 * 缺陷注入点：
 *   1. get_device_config()：返回查找结果（可能为 NULL）给调用者，
 *      调用者 init_device() 未检查直接解引用。
 *   2. log_message()：out 参数为可选（调用者可传 NULL），
 *      函数内部未检查直接写入。
 *   3. find_and_update()：查找链表节点后，节点不存在时返回 NULL，
 *      上层函数对返回值解引用前未判 NULL。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] null pointer: init_device 未检查 get_device_config 返回值
 *   - DEF-CR-xxx [critical] null pointer: log_message out 参数可为 NULL 未防护
 *   - DEF-CR-xxx [critical] null pointer: find_and_update 对 NULL 节点解引用
 */

#include <stdint.h>
#include <string.h>

/* ===== 缺陷 1：查找函数返回值未检查 ===== */

typedef struct {
    uint8_t  device_id;
    uint32_t base_addr;
    uint8_t  irq_num;
} DeviceConfig_t;

/**
 * 按 ID 查找设备配置，不存在时返回 NULL。
 */
extern DeviceConfig_t *lookup_device(uint8_t id);   /* 可能返回 NULL */

/**
 * 初始化设备。
 *
 * 缺陷：lookup_device 当设备未注册时返回 NULL，
 *       init_device 未检查返回值直接解引用 cfg，
 *       在首次上电或配置丢失时触发 HardFault。
 */
void init_device(uint8_t id)
{
    DeviceConfig_t *cfg = lookup_device(id);

    /* BUG: 未检查 cfg != NULL */
    uint32_t base = cfg->base_addr;   /* NULL 解引用 → HardFault */
    uint8_t  irq  = cfg->irq_num;
    (void)base;
    (void)irq;
    /* 继续初始化... */
}

/* ===== 缺陷 2：可选输出参数未防护 ===== */

/**
 * 格式化日志消息到 out 缓冲区（out 为可选参数，调用者可传 NULL 表示丢弃）。
 *
 * 缺陷：函数文档说明 out 可为 NULL，但实现中未检查，
 *       直接调用 memcpy 写入 out，传入 NULL 时触发写入地址 0x00 → HardFault。
 */
void log_message(const char *msg, uint8_t *out, uint8_t out_size)
{
    uint8_t msg_len = (uint8_t)strlen(msg);
    if (msg_len > out_size) {
        msg_len = out_size;
    }
    /* BUG: out 可为 NULL，未检查（可选参数未防护）*/
    memcpy(out, msg, msg_len);   /* out=NULL 时写入非法地址 */
}

/* ===== 缺陷 3：链表查找结果跨函数解引用 ===== */

typedef struct Node {
    uint8_t       key;
    uint32_t      value;
    struct Node  *next;
} Node_t;

/**
 * 在链表中查找 key 对应节点，不存在时返回 NULL。
 */
Node_t *find_node(Node_t *head, uint8_t key)
{
    while (head != NULL) {
        if (head->key == key) return head;
        head = head->next;
    }
    return NULL;   /* 未找到 */
}

/**
 * 查找节点并更新其值。
 *
 * 缺陷：find_node 返回 NULL（key 不存在时）后，
 *       直接对 node->value 赋值，触发 NULL 解引用。
 *       应先判断 node != NULL 再操作。
 */
void find_and_update(Node_t *head, uint8_t key, uint32_t new_value)
{
    Node_t *node = find_node(head, key);

    /* BUG: 未检查 node != NULL */
    node->value = new_value;   /* key 不存在时 NULL 解引用 */
}
