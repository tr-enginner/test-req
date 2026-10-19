# A：当前支持且应稳定解析

这个工程里的用例应当被当前 Step 1 基本稳定地解析和索引。

## 覆盖点

- 普通全局变量、静态全局变量
- `static / global` 函数
- 参数、局部变量、赋值与简单访问路径
- `if / for / while / switch`
- `typedef`
- `struct`
- `enum`
- 函数指针 typedef
- 结构体字段
- 全局结构体指针
- 简单别名链，例如 `ctx = g_ctx; ctx->len`

## 工程文件

- [model.h](/C:/Users/84003/Desktop/doc/0/testcases/step1/A_supported/include/model.h)
- [entry.c](/C:/Users/84003/Desktop/doc/0/testcases/step1/A_supported/src/entry.c)
- [state.c](/C:/Users/84003/Desktop/doc/0/testcases/step1/A_supported/src/state.c)
- [worker.c](/C:/Users/84003/Desktop/doc/0/testcases/step1/A_supported/src/worker.c)

## 预期

- 可以正确提取函数、调用、条件与符号
- 可以正确索引 `device_ctx_t`、`struct device_ctx`、`worker_fn_t`
- 可以把 `g_ctx` 的直接访问和通过局部别名 `ctx` 的字段访问归并到同一个全局变量引用上

## 当前一次验证结果

这个用例此前的索引统计结果为：

```text
IndexStats(
  files_indexed=4,
  functions_indexed=6,
  calls_indexed=6,
  symbols_indexed=21,
  conditions_indexed=10,
  type_definitions_indexed=5,
  global_symbol_refs_indexed=4
)
```

如果后续实现变更导致这里的结果明显退化，应优先视为回归。
