/**
 * 测试用例：RS-22 分配尺寸整数溢出（Allocation Size Integer Overflow）
 *
 * 规则说明：
 *   Inspector 检查 malloc / calloc / realloc 的尺寸参数中含有乘法表达式的情形。
 *   若乘法操作数均为较窄类型（如 uint16_t），乘积可能在传给 malloc 之前就溢出截断，
 *   导致实际分配远小于预期。后续向该缓冲区写入"正确数量"的元素时发生堆缓冲区溢出，
 *   可覆盖堆管理元数据或其他分配块，后果极难调试。
 *   calloc(nmemb, size) 内部有溢出检查，但 malloc(nmemb * size) 没有。
 *
 * 缺陷注入点：
 *   1. alloc_sample_buffer()：uint16_t count × uint16_t element_size，
 *      两���均可达 ~1000，乘积最大 ~10^6，超出 uint16_t（65535），
 *      结果截断后传给 malloc，实际分配远小于 count × element_size 字节。
 *   2. resize_packet_pool()：realloc 的新尺寸 = new_count × PKT_SIZE，
 *      new_count 来自外部配置，可受攻击者控制，乘积溢出后 realloc 分配极小块。
 *   3. alloc_matrix()：rows × cols × sizeof(float) 三重乘积，
 *      任意一步溢出即导致欠分配。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] integer_overflow: uint16×uint16 乘积传给 malloc，溢出导致欠分配
 *   - DEF-CR-xxx [critical] integer_overflow: realloc 尺寸乘积溢出，可受外部控制
 *   - DEF-CR-xxx [critical] integer_overflow: 三重乘积未逐步检查溢出
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define PKT_SIZE   256U   /* 每个数据包固定 256 字节 */

extern uint16_t get_sample_count(void);      /* 来自协议帧，最大 65535 */
extern uint16_t get_element_size(void);      /* 运行时确定，最大几千 */
extern uint32_t get_new_pool_count(void);    /* 来自外部配置文件 */

/* ===== 缺陷 1：uint16 × uint16 乘积溢出 ===== */

/**
 * 分配采样缓冲区。
 *
 * 缺陷：count 和 elem_size 均为 uint16_t，乘法在 uint16_t 域内计算，
 *       count=1000, elem_size=100 → 乘积 100000，截断为 100000 % 65536 = 34464，
 *       malloc(34464) 成功，但后续写入 1000×100=100000 字节，溢出 65072 字节。
 */
uint8_t *alloc_sample_buffer(void)
{
    uint16_t count     = get_sample_count();
    uint16_t elem_size = get_element_size();

    /* BUG: 乘法在 uint16_t 范围内溢出截断，结果小于实际需要 */
    uint8_t *buf = (uint8_t *)malloc(count * elem_size);
    if (buf == NULL) return NULL;

    /* 后续代码以 count × elem_size 字节为假设写入，实际超出分配大小 */
    memset(buf, 0, count * elem_size);   /* 堆溢出 */
    return buf;
}

/* ===== 缺陷 2：realloc 尺寸溢出，操作数来自外部 ===== */

static uint8_t *g_pkt_pool    = NULL;
static uint32_t g_pool_count  = 0;

/**
 * 调整数据包内存池大小。
 *
 * 缺陷：new_count 来自外部配置，可被攻击者设为极大值（如 0x01000001），
 *       new_count × PKT_SIZE 溢出 uint32_t，结果极小（如 256），
 *       realloc 分配极小块，后续按 new_count 个包操作时大量越界写入。
 */
int8_t resize_packet_pool(void)
{
    uint32_t new_count = get_new_pool_count();

    /* BUG: new_count × PKT_SIZE 可溢出 uint32_t，未检查 */
    uint8_t *new_pool = (uint8_t *)realloc(g_pkt_pool, new_count * PKT_SIZE);
    if (new_pool == NULL) return -1;

    g_pkt_pool   = new_pool;
    g_pool_count = new_count;
    return 0;
}

/* ===== 缺陷 3：三重乘积逐步溢出 ===== */

/**
 * 分配二维浮点矩阵。
 *
 * 缺陷：rows × cols 先以 uint16_t 计算，结果再乘以 sizeof(float)=4，
 *       两步均可能溢出。rows=256, cols=256 时 rows×cols=65536（uint16_t 溢出为 0），
 *       malloc(0) 返回非 NULL 的合法指针，但后续写入崩溃。
 */
float *alloc_matrix(uint16_t rows, uint16_t cols)
{
    /* BUG: rows × cols 在 uint16_t 域计算，256×256=65536 截断为 0 */
    size_t total = (size_t)(rows * cols) * sizeof(float);

    float *mat = (float *)malloc(total);
    if (mat == NULL) return NULL;

    /* 初始化：写入 rows×cols 个元素，实际超出分配 */
    for (uint32_t i = 0; i < (uint32_t)rows * cols; i++) {
        mat[i] = 0.0f;   /* 堆溢出 */
    }
    return mat;
}
