# B：当前不支持或仅部分支持

这个工程里的用例用于标记当前 Step 1 的已知边界。

## 覆盖点

- 深层指针别名和多跳共享状态传播
- 运行时函数指针调用解析
- GNU C / 非标准方言特性
- 宏展开驱动的字段或类型语义
- `void *` 和强制类型转换驱动的隐式类型恢复
- `container_of` 风格反推
- statement expression
- `typeof`
- 内联汇编

## 工程文件

- [complex.h](/C:/Users/84003/Desktop/doc/0/testcases/step1/B_unsupported/include/complex.h)
- [alias_maze.c](/C:/Users/84003/Desktop/doc/0/testcases/step1/B_unsupported/src/alias_maze.c)
- [fnptr_runtime.c](/C:/Users/84003/Desktop/doc/0/testcases/step1/B_unsupported/src/fnptr_runtime.c)
- [dialect_features.c](/C:/Users/84003/Desktop/doc/0/testcases/step1/B_unsupported/src/dialect_features.c)

## 预期

- 这些文件不应被当作“当前能力已经完整支持”的样例
- 其中一部分语法 `tree-sitter` 也许能 parse，但 Step 1 不会给出足够准确的语义结果
- 另一部分语法可能只能部分解析，或者根本不属于当前实现范围

## 典型边界示例

- `outer_t **slot = &g_outer;`
- `pick_inner(slot)` 这类跨函数别名传播
- `fn = ctx->inner->handler; fn(ctx->opaque);`
- `CALL_HANDLER(ctx)` 这类宏驱动的函数指针调用
- `typeof(...)`
- `({ ... })`
- `asm volatile`
- `container_of(...)`

这个目录的意义是固定边界，不是要求当前系统把这些场景都“解析正确”。
