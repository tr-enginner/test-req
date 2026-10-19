/**
 * 测试用例：RS-17 浮点陷阱（Floating Point Traps）
 *
 * 规则说明：
 *   Inspector 检查浮点运算中的三类语义陷阱：
 *   1. NaN/Inf 传播：一处产生 NaN/Inf 后，下游所有依赖该值的计算
 *      均变为 NaN/Inf，且比较运算（NaN != NaN）导致控制流异常跳转。
 *   2. 精确相等比较：浮点数因精度损失无法精确相等，
 *      == 比较几乎永远为 false（或偶然为 true），应使用容差比较。
 *   3. 累积误差：控制循环中浮点步进累加，长时间运行后误差放大，
 *      导致定时器漂移或位置估计漂移。
 *
 * 缺陷注入点：
 *   1. normalize_vector()：向量模长可能为 0.0f，除零产生 Inf，
 *      归一化结果三分量均为 NaN，传播至姿态控制。
 *   2. wait_for_phase()：用 == 比较浮点相位角，永远不等，循环不退出。
 *   3. integrate_position()：浮点步进累加 10000 次，
 *      累积误差可达数个 LSB，位置估计漂移。
 *
 * 期望 Inspector 发现：
 *   - DEF-CR-xxx [critical] float NaN: normalize_vector 零向量产生 NaN 传播
 *   - DEF-CR-xxx [critical] float equality: 相位角 == 比较永不成立
 *   - DEF-CR-xxx [minor]    float accumulation: 步进累加长期漂移
 */

#include <stdint.h>
#include <math.h>

/* ===== 缺陷 1：NaN/Inf 传播 ===== */

typedef struct {
    float x, y, z;
} Vec3_t;

extern void  set_attitude(Vec3_t normal);
extern float sqrtf(float x);

/**
 * 将三维向量归一化为单位向量。
 *
 * 缺陷：当输入向量为零向量（x=y=z=0）时，
 *       magnitude = 0.0f，除法产生 Inf 或 NaN，
 *       归一化结果三分量均为 NaN，
 *       传递给 set_attitude 后，所有依赖姿态的计算均产生 NaN，
 *       PID 输出 NaN，执行机构收到 NaN 指令（通常被解析为极大值）。
 */
Vec3_t normalize_vector(Vec3_t v)
{
    float magnitude = sqrtf(v.x*v.x + v.y*v.y + v.z*v.z);

    /* BUG: magnitude 可能为 0，产生 NaN（未检查零向量）*/
    Vec3_t result;
    result.x = v.x / magnitude;   /* 0/0 = NaN */
    result.y = v.y / magnitude;
    result.z = v.z / magnitude;
    return result;
}

void update_attitude(Vec3_t raw_normal)
{
    Vec3_t unit = normalize_vector(raw_normal);
    set_attitude(unit);   /* 可能传入 NaN 姿态向量 */
}

/* ===== 缺陷 2：浮点精确相等比较 ===== */

#define TWO_PI   6.28318530718f
#define PHASE_STEP 0.001f          /* 每次步进 0.001 rad */

/**
 * 等待信号相位角到达目标值（例如等待过零点）。
 *
 * 缺陷：phase 由浮点步进累加，因精度问题几乎不会精确等于 target_phase。
 *       例如 target_phase = 3.14159f，累加步进经过时：
 *       3.14058...，3.14158...，3.14258...（跨越但不等于）
 *       循环永不退出（或需等待极长时间才偶然相等）。
 */
void wait_for_phase(float target_phase)
{
    float phase = 0.0f;

    /* BUG: 浮点 == 比较，步进累加几乎不会精确命中目标值 */
    while (phase != target_phase) {   /* 应用容差比较：fabsf(phase - target) < 0.001f */
        phase += PHASE_STEP;
        if (phase >= TWO_PI) {
            phase -= TWO_PI;
        }
    }
}

/* ===== 缺陷 3：步进累加长期漂移 ===== */

/**
 * 通过速度积分估计位置（简化航位推算）。
 *
 * 缺陷：连续对 float 做 += delta 操作 10000 次，
 *       每次累加引入约 1 ULP（~1e-7 相对误差）的舍入误差，
 *       10000 次后累积误差约 10000 × 1e-7 × 值大小，
 *       位置估计相对真值可漂移 0.1%~1%（取决于值域）。
 *       长时间运行的飞行器或机器人位置估计因此持续漂移。
 */
float integrate_position(float initial_pos, float velocity, float dt, uint32_t steps)
{
    float position = initial_pos;

    /* BUG: 直接逐步累加，每步引入舍入误差，steps 大时误差积累显著 */
    for (uint32_t i = 0; i < steps; i++) {
        position += velocity * dt;   /* 应定期与绝对参考对齐，或使用补偿算法 */
    }
    return position;
}
