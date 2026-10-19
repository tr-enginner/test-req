# Step 1 用例集

这个目录包含两个小型 C 工程，用来验证当前 Step 1 的能力范围和边界。

## 目录说明

- [A_supported](/C:/Users/84003/Desktop/doc/0/testcases/step1/A_supported)
  - 放置当前实现应当可以稳定解析、索引结果应基本符合预期的代码模式
- [B_unsupported](/C:/Users/84003/Desktop/doc/0/testcases/step1/B_unsupported)
  - 放置当前实现已知不支持、支持不完整、或只能部分理解的复杂场景

## 当前 Step 1 已覆盖的能力

- 函数定义和调用关系提取
- `static / global` 级别的轻量调用解析
- 参数、局部变量、同文件全局变量
- 条件变量和简单访问路径提取
- `typedef`
- `struct`
- `enum`
- 函数指针 typedef
- 结构体字段索引
- 全局变量反向引用索引
- 简单别名链，例如 `ctx = g_ctx; ctx->len`

## 当前 Step 1 的明确边界

- 不做精确的函数指针调用解析
- 不做完整的 points-to / alias analysis
- 不做宏展开后的精确语义恢复
- 不覆盖 GNU C、内核风格扩展、内联汇编、statement expression 等复杂语义
- 不做跨文件完整类型推导和完整类型系统建模

## 用法建议

验证当前实现时，优先先跑 [A_supported](/C:/Users/84003/Desktop/doc/0/testcases/step1/A_supported)。

如果要确认边界是否被正确识别，再看 [B_unsupported](/C:/Users/84003/Desktop/doc/0/testcases/step1/B_unsupported)；这些用例的目的不是要求当前系统“完全解析正确”，而是明确哪些情况暂时不在能力范围内。
