/**
 * 139 undecidable SpecChecker rules — rules where accurate determination
 * requires data flow, control flow, cross-TU, or semantic analysis that
 * the tool cannot reliably perform.
 *
 * Used by sa-preclassifier to programmatically pre-classify raw findings.
 * Rule metadata (rule_name, fp_guidance) is injected into sa_fetch_findings
 * output so page workers receive per-finding context without needing the
 * full 139-rule table in the skill prompt.
 */

export type UndecidableCategory =
  | "A1"   // 数据流分析型
  | "A2"   // 值域/运行时分析型
  | "A3a"  // 上下文意图依赖型
  | "A3b"  // 偏向真实违规型
  | "A4"   // 意图理解型
  | "A5"   // 控制流分析型
  | "A6"   // 语义分析型
  | "B2"   // 跨函数调用链型
  | "B3"   // 运行时环境依赖型

export interface UndecidableRuleInfo {
  category: UndecidableCategory
  rule_name: string
  fp_guidance: string
}

// prettier-ignore
const entries: ReadonlyArray<[string, UndecidableRuleInfo]> = [
  // ── Category 1: 数据流分析型 (A1) — 28 rules ──
  ["CID215",  { category: "A1", rule_name: "变量使用前必须赋值", fp_guidance: "OUT参数方式赋值的变量被误报为未初始化" }],
  ["CID4109", { category: "A1", rule_name: "变量禁止未赋值就使用", fp_guidance: "OUT参数方式赋值的变量被认为未初始化" }],
  ["CID3142", { category: "A1", rule_name: "禁止使用未初始化的自动变量", fp_guidance: "所有路径上都初始化但工具路径分析不完整导致误报" }],
  ["CID3143", { category: "A1", rule_name: "禁止使用未初始化的自动变量", fp_guidance: "所有路径上都初始化但工具路径分析不完整导致误报" }],
  ["CID3144", { category: "A1", rule_name: "不要读取未初始化的内存", fp_guidance: "所有路径上都初始化但工具路径分析不完整导致误报" }],
  ["CID3145", { category: "A1", rule_name: "禁止使用未初始化的自动变量", fp_guidance: "所有路径上都初始化但工具路径分析不完整导致误报" }],
  ["CID184",  { category: "A1", rule_name: "禁止使用已被释放了的内存空间", fp_guidance: "指针释放后立即置NULL但工具未追踪到置NULL操作" }],
  ["CID4170", { category: "A1", rule_name: "禁止使用或释放未分配空间或已被释放的指针", fp_guidance: "指针在释放后立即置NULL但工具未追踪到置NULL操作" }],
  ["CID4120", { category: "A1", rule_name: "不要访问已释放的内存", fp_guidance: "指针释放后置NULL但后续分支基于NULL判断访问被误报" }],
  ["CID4239", { category: "A1", rule_name: "不要访问已经释放的内存", fp_guidance: "指针置NULL后的访问被工具误认为释放后访问" }],
  ["CID092",  { category: "A1", rule_name: "禁止使用或释放未分配空间或已被释放的指针", fp_guidance: "通过封装函数释放的指针被工具认为仍未释放" }],
  ["CID243",  { category: "A1", rule_name: "禁止引用空指针", fp_guidance: "已在if语句检查过非NULL但工具控制流未追踪到" }],
  ["CID4220", { category: "A1", rule_name: "不要对空指针进行解引用", fp_guidance: "条件分支保证指针非NULL后的解引用被工具误报" }],
  ["CID4064", { category: "A1", rule_name: "动态分配的指针变量第一次使用前必须进行是否为NULL的判别", fp_guidance: "在if语句���检查NULL后才使用的动态分配指针" }],
  ["CID185",  { category: "A1", rule_name: "数组使用必须保证不会出现越界", fp_guidance: "下标经过范围检查后的合法数组访问被保守报告" }],
  ["CID292",  { category: "A1", rule_name: "memset()和memcpy()函数使用时缓冲区溢出", fp_guidance: "已按size限制的memset/memcpy调用被保守误报" }],
  ["CID210",  { category: "A1", rule_name: "memset()和memcpy()函数使用时缓冲���溢出", fp_guidance: "已按size限制的memset/memcpy调用被保守误报" }],
  ["CID4108", { category: "A1", rule_name: "缓存区写入操作禁止越界", fp_guidance: "已经过边界检查的写操作仍被保守报告" }],
  ["CID4107", { category: "A1", rule_name: "缓存区读取操作禁止越界", fp_guidance: "已知在边界内的读操作被保守报告" }],
  ["CID1006", { category: "A1", rule_name: "禁止string.h中的字符串操作函数的参数数组越界", fp_guidance: "有边界保护的字符串操作被保守报告" }],
  ["CID4124", { category: "A1", rule_name: "使用字符串赋值/拷贝/追加等函数时禁止目标字符串存储空间越界", fp_guidance: "已经过大小限制的字符串赋值函数被报告" }],
  ["CID4164", { category: "A1", rule_name: "动态申请的内存空间用完后及时释放", fp_guidance: "在函数返回前统一释放的合法模式被误认为未释放" }],
  ["CID1010", { category: "A1", rule_name: "必须显示释放标准库函数动态分配的资源", fp_guidance: "在错误处理路径中统一释放资源的goto-cleanup模式" }],
  ["CID4248", { category: "A1", rule_name: "只应释放动态分配的内存", fp_guidance: "自定义内存池（内部用malloc）分配的内存被认为非动态分配" }],
  ["CID1020", { category: "A1", rule_name: "禁止释放不是标准库申请的内存", fp_guidance: "自定义内存池分配的内存被认为不能用标准free" }],
  ["CID4122", { category: "A1", rule_name: "被free的指针必须指向最初malloc/calloc分配的地址", fp_guidance: "通过中间指针释放但指向同一块内存起始地址的情况" }],
  ["CID4062", { category: "A1", rule_name: "指针变量被释放后必须置为NULL", fp_guidance: "通过封装函数（如safe_free(&ptr)内部执行free(*p);*p=NULL;）释放并置NULL，但工具无法追踪封装函数的写入语义。注意：函数末尾free后未置NULL是规范违规（工具检出正确），不是误报" }],
  ["CID4058", { category: "A1", rule_name: "动态分配的指针变量定义时如未被分配空间必须初始化为NULL", fp_guidance: "动态分配指针在声明后立即进行分配时被要求初始为NULL" }],

  // ── Category 2: 值域/运行时分析型 (A2) — 33 rules ──
  ["CID086",  { category: "A2", rule_name: "整数溢出", fp_guidance: "仅限无符号整数：有意的模运算（利用unsigned回绕特性的算法，如CRC、哈希、环形缓冲区索引）被误报。警告：有符号整数溢出是C99 §6.5/5明确的UB，永远不应判为误报" }],
  ["CID1109", { category: "A2", rule_name: "无符号整型做乘100/1000/10000等运算可能会发生运算溢出", fp_guidance: "乘法操作数由上游范围检查、类型宽度或业务约束保证乘积不溢出，工具无法追踪该约束而保守报告" }],
  ["CID1101", { category: "A2", rule_name: "if条件中的加法运算可能导致运算溢出", fp_guidance: "加法操作数值域被if前置条件、宏常量、或类型宽度限定在安全范围内，工具无法追踪值域约束而保守报告" }],
  ["CID744",  { category: "A2", rule_name: "&&/||操作的区间判断为恒真或恒假", fp_guidance: "依赖平台ABI保证的值域在工具无平台知识时被误报" }],
  ["CID1059", { category: "A2", rule_name: "在判断变量值范围之前给变量赋了范围内的值导致判断恒为真", fp_guidance: "先赋安全默认值、再用if检查是否需要覆盖的防御性模式。注意区分：如果赋值与检查之间无其他逻辑路径可修改该变量，则恒真检查可能是重构遗留的死代码，不应判误报" }],
  ["CID1060", { category: "A2", rule_name: "在判断变量值范围之前给变量赋了范围外的值导致判断恒为假", fp_guidance: "赋哨兵值后检查是否被正常流程覆盖的防御性模式。注意区分：如果中间无路径可修改该变量，恒假分支是死代码，不应判误报" }],
  ["CID1073", { category: "A2", rule_name: "if(x==c)语句恒为假", fp_guidance: "依赖输入范围保证的比较在工具无输入信息时被误报" }],
  ["CID1063", { category: "A2", rule_name: "逻辑或操作导致if条件恒为真", fp_guidance: "互斥条件的或运算实际不恒真但工具无法证明" }],
  ["CID897",  { category: "A2", rule_name: "高位清零后计数加1再与0比较导致逻辑判断恒为假", fp_guidance: "多步运算中间结果比较被误认为最终恒假" }],
  ["CID1100", { category: "A2", rule_name: "变量与255比较又在分支内清零取值范围可能有误", fp_guidance: "uint8_t变量与255（最大值）比较是饱和/溢出保护的合法边界检查，分支内清零是饱和复位逻辑" }],
  ["CID218",  { category: "A2", rule_name: "避免对无符号数进行大于等于零或小于零的比较", fp_guidance: "通过typedef定义的类型实际是unsigned但名称不明显" }],
  ["CID866",  { category: "A2", rule_name: "将无符号数与负数进行比较时应该进行正确性验证", fp_guidance: "无符号操作数与编译期已知的非负常量比较，常量类型声明为signed但值为非负，隐式转换后比较语义正确" }],
  ["CID4079", { category: "A2", rule_name: "除法运算中禁止被零除", fp_guidance: "已在if语句检查过非零但工具未追踪到该检查" }],
  ["CID4251", { category: "A2", rule_name: "确保除法和余数运算不会导致被零除错误", fp_guidance: "已在if语句检查过非零但工具未追踪到该检查" }],
  ["CID087",  { category: "A2", rule_name: "禁止signed和unsigned之间隐式转换", fp_guidance: "已知非负的有符号整数赋给无符号整数的合法转换" }],
  ["CID1105", { category: "A2", rule_name: "位长小的有符号整型被强转为大的无符号整型可能导致负数变为无符号大数", fp_guidance: "已知位长小的有符号数非负时的合法转换被报告" }],
  ["CID031",  { category: "A2", rule_name: "将double类型数转为float类型", fp_guidance: "明知精度足够的double到float赋值被标记" }],
  ["CID1098", { category: "A2", rule_name: "位运算导致符号位发生变化", fp_guidance: "有意操作符号位的位域处理代码" }],
  ["CID4249", { category: "A2", rule_name: "将整数值转换为浮点类型时保持精度", fp_guidance: "源整数值由上游代码保证在目标浮点类型可精确表示的范围内，工具无法追踪值域约束而保守报告" }],
  ["CID4256", { category: "A2", rule_name: "确保整数转换不会导致数据丢失或解释错误", fp_guidance: "源整数值由上游范围检查或类型宽度保证在目标类型可表示范围内，工具无法追踪该约束而保守报告" }],
  ["CID883",  { category: "A2", rule_name: "将负的double类型赋值给无符号整型可能赋值异常", fp_guidance: "已知double值为正数但类型声明为double时触发规则" }],
  ["CID989",  { category: "A2", rule_name: "在判断两数差值范围时用两数互相相减必然出现大数减小数", fp_guidance: "��方已保证a>=b再做a-b的有效差值运算" }],
  ["CID297",  { category: "A2", rule_name: "谨慎对两个无符号整型进行减法运算", fp_guidance: "上方已保证a>=b再做a-b的有效差值运算" }],
  ["CID755",  { category: "A2", rule_name: "地址范围判断缺陷", fp_guidance: "通过分段检查上下界的合法地址范围验证" }],
  ["CID1125", { category: "A2", rule_name: "地址判断错误", fp_guidance: "内存映射IO地址、Flash/RAM分区边界等平台固定地址常量的合法比较，工具缺乏目标平台地址空间布局信息而误判" }],
  ["CID985",  { category: "A2", rule_name: "用于拼接的或运算操作数的位之间不应相互覆盖", fp_guidance: "有意对相同位域多次操作的合法位域合并" }],
  ["CID991",  { category: "A2", rule_name: "或运算的位互相覆盖", fp_guidance: "有意对相同位域多次操作的合法位域合并" }],
  ["CID1057", { category: "A2", rule_name: "变量的差值运算错误", fp_guidance: "环形缓冲区首尾指针差值、时间戳差值等在上游逻辑已保证被减数≥减数条件下的合法无符号减法" }],
  ["CID986",  { category: "A2", rule_name: "浮点数判0缺陷", fp_guidance: "极窄场景：变量由字面量0.0或整数0直接赋值、且未经任何浮点运算，此时判0合法。经过ADC采样、滤波、算术运算后的浮点值判0几乎必然是缺陷" }],
  ["CID4250", { category: "A2", rule_name: "确保可变长度数组的大小参数在有效范围内", fp_guidance: "运行时已验证有效范围的VLA大小参数" }],
  ["CID997",  { category: "A2", rule_name: "变量&操作溢出", fp_guidance: "位掩码操作的合法&运算被认为可能溢出" }],
  ["CID998",  { category: "A2", rule_name: "左移运算后将小的无符号数据类型强转为大的有符号数据类型可能导致负数变为正数", fp_guidance: "有意操作有符号位时的合法位运算" }],
  ["CID1096", { category: "A2", rule_name: "指针被强制转换为较短类型", fp_guidance: "指针转换为uintptr_t等安全的整数表示" }],

  // ── Category 3a: 上下文意图依赖型 (A3a) — 18 rules ──
  ["CID6676", { category: "A3a", rule_name: "谨慎使用无法控制的循环条件", fp_guidance: "检查：循环条件变量来源（硬件状态寄存��vs外部输入）；是否在ISR中；是否有看门狗保护" }],
  ["CID4132", { category: "A3a", rule_name: "谨慎使用abort/exit函数", fp_guidance: "检查：调用是否在不可恢复的致命错误路径；系统是否有软重启机制作为等价替代" }],
  ["CID006",  { category: "A3a", rule_name: "谨慎对指针进��代数运算", fp_guidance: "检查：是否基于已知固定大小的数组；偏移量是否有边界检查或由常量保证安全；是否在DMA/内存映射IO场景" }],
  ["CID103",  { category: "A3a", rule_name: "谨慎使用指针的逻辑比较", fp_guidance: "检查：两个指针是否指向同一对象/数组（合法）还是不相关对象（UB）；是否仅做NULL检查（完全合法）" }],
  ["CID279",  { category: "A3a", rule_name: "谨慎使用八进制数", fp_guidance: "检查：八进制字面量是否在文件权限/ASCII码等明确语义场景；还是普通整数中的意外八进制" }],
  ["CID004",  { category: "A3a", rule_name: "谨慎使用++/--操作符", fp_guidance: "检查：是否在复合表达式同一求值序列中出现多次（真实UB）；还是独立语句或for步进（完全合法）" }],
  ["CID252",  { category: "A3a", rule_name: "尽量避免用+=或-=操作符", fp_guidance: "检查：是否用于累加器/计数器增量（语义明确合理）；还是在复杂表达式中使求值顺序模糊" }],
  ["CID186",  { category: "A3a", rule_name: "尽量避免使用三元运算符", fp_guidance: "检查：是否简单清晰（等价min/max，完全合法）；还是多层嵌套（真实可读性问题）" }],
  ["CID175",  { category: "A3a", rule_name: "尽量避免使用continue", fp_guidance: "检查：是否用于跳过不满足条件的循环迭代（滤波逻辑惯用法）；循环体是否短小" }],
  ["CID240",  { category: "A3a", rule_name: "尽量避免使用逗号操作符", fp_guidance: "检查：逗号是否在for循环初始化/步进中（公认合理）；还是在普通表达式语句中" }],
  ["CID212",  { category: "A3a", rule_name: "谨慎使用不同类型变量的混合运算", fp_guidance: "检查：是否涉及有符号/无符号混合（常见真实bug风险）；是否有显式类型转换表明开发者已知类型差异" }],
  ["CID226",  { category: "A3a", rule_name: "谨慎将double型数转换成float型数", fp_guidance: "检查：精度损失是否被有意接受（嵌入式FPU通常只有��精度）；字面量是否带f后缀" }],
  ["CID054",  { category: "A3a", rule_name: "避免使用不必要的类型转换", fp_guidance: "检查：类型转换是否是消除编译器隐式转换警告的显式注解（有意为之）；还是掩盖实际类型不匹配" }],
  ["CID270",  { category: "A3a", rule_name: "尽量避免逻辑判别的表达式不是逻辑表达式", fp_guidance: "检查：if(ptr)和if(!ptr)是NULL检查的C惯用法（合理）；整型条件if(some_int)需检查变量名是否表达布尔意图" }],
  ["CID234",  { category: "A3a", rule_name: "避免无用的多余变量", fp_guidance: "检查：变量是否为调试辅助（#ifdef DEBUG）；是否为提高可读性的命名中间量；需确认是否真正无用" }],
  ["CID228",  { category: "A3a", rule_name: "避免函数参数在函数调用中未被使用", fp_guidance: "检查：参数是否为回调接口强制签名（如RTOS任务void task(void *pvParam)）；是否为多态接口占位参数" }],
  ["CID4139", { category: "A3a", rule_name: "谨慎做整型量除以整型变量的除法", fp_guidance: "检查：除数是否可能为零（需检查除零保护）；结果是否为有意的整数截断（地址对齐计算）" }],
  ["CID107",  { category: "A3a", rule_name: "谨慎使用联合的声明", fp_guidance: "检查：是否在函数局部作用域声明union（规避类型系统）；还是在全局/结构体中的合法union成员" }],

  // ── Category 3b: 偏向真实违规型 (A3b) — 5 rules ──
  ["CID190",  { category: "A3b", rule_name: "避免使用不加以分析的注释（注释掉的代码）", fp_guidance: "GJB 5000A明确禁止将代码注释掉，被注释代码是维护风险；合法注释（说明性文字）不触发此规则" }],
  ["CID287",  { category: "A3b", rule_name: "尽量不对实数类型做是否相等的比较", fp_guidance: "浮点相等比较在嵌入式FPU场景几乎必然产生意外结果；合法替代是epsilon比较" }],
  ["CID013",  { category: "A3b", rule_name: "应避免声明了函数/变量/常量但未使用", fp_guidance: "未使用的局部变量通常是清理不彻底的遗留代码；接口兼容性保留应改用(void)param注解" }],
  ["CID034",  { category: "A3b", rule_name: "避免声明了类型但未使用", fp_guidance: "未使用的类型定义通常表明头文件依赖链混乱；公共头文件中的类型可走跨文件视图局限豁免路径" }],
  ["CID194",  { category: "A3b", rule_name: "有符号类型的位长度必须不小于两位", fp_guidance: "1位有符号位域只能存-1和0，几乎所有开发者期望存0和1，是真实语义陷阱" }],

  // ── Category 4: 意图理解型 (A4) — 22 rules ──
  ["CID949",  { category: "A4", rule_name: "函数定义中不应该存在没有使用的参数", fp_guidance: "接口兼容性保留参数、回调函数未使用的参数（签名固定）" }],
  ["CID1147", { category: "A4", rule_name: "标志变量仅置有效或仅置无效", fp_guidance: "一次性标志（初始化完成标志）只需置位的合法设计" }],
  ["CID843",  { category: "A4", rule_name: "标识变量状态清理不及时可能导致中断设置的最新标识状态被覆盖", fp_guidance: "合理的延迟清理状态标志被误认为设计缺陷" }],
  ["CID761",  { category: "A4", rule_name: "全局变量仅累加未清零", fp_guidance: "单调递增计数器被误报为只累加未清零" }],
  ["CID893",  { category: "A4", rule_name: "全局变量仅累加未清零可能导致结果跳变", fp_guidance: "单调递增计数器被误报为只累加未清零" }],
  ["CID758",  { category: "A4", rule_name: "全局变量只有写操作", fp_guidance: "通过硬件寄存器或DMA访问的只写全局变量" }],
  ["CID757",  { category: "A4", rule_name: "全局变量只有读操作", fp_guidance: "通过硬件寄存器或DMA访问的只读全局变量" }],
  ["CID845",  { category: "A4", rule_name: "if/else分支前对变量的赋值被if-else块中的赋值操作覆盖", fp_guidance: "先设置默认值再按条件覆盖的合法防御性编程模式" }],
  ["CID846",  { category: "A4", rule_name: "if/else分支中对变量的赋值被if/else块后的赋值操作覆盖", fp_guidance: "先设置默认值再按条件覆盖的合法防御性编程模式" }],
  ["CID108",  { category: "A4", rule_name: "避免当switch语句的表达式是枚举类型时缺少case分支", fp_guidance: "有意不处理某些枚举值（仅处理关心的状态）时被误报" }],
  ["CID1049", { category: "A4", rule_name: "确认多个if与一个else的结构是否设计有误", fp_guidance: "有意的if-if-else结构（只有最后一个if有else）" }],
  ["CID848",  { category: "A4", rule_name: "在多重判断中变量的取值范围设计不连续", fp_guidance: "故意跳过某些枚举值的状态机设计" }],
  ["CID888",  { category: "A4", rule_name: "谨慎在循环中赋值的变量在循环外使用可能是逻辑设计缺陷", fp_guidance: "有意使用循环结束后index值（如查找位置）的合法模式" }],
  ["CID895",  { category: "A4", rule_name: "函数只有一个固定返回值", fp_guidance: "有意返回��定状态码的状态判断函数" }],
  ["CID753",  { category: "A4", rule_name: "函数有多个返回语句但返回值固定为1/true或0/false", fp_guidance: "有意返回固定状态码的状态判断函数" }],
  ["CID1067", { category: "A4", rule_name: "累加变量在当前分支中未进行清零可能导致分支重复执行", fp_guidance: "跨分支累积值的有意设计" }],
  ["CID1054", { category: "A4", rule_name: "全局计数变量设计不当变量进行清零时会影响当前运算", fp_guidance: "受保护的计数器清零操作被误认为影响并发计算" }],
  ["CID1055", { category: "A4", rule_name: "接收了函数的返回值后没有处理", fp_guidance: "有意忽略printf等函数的返回值" }],
  ["CID956",  { category: "A4", rule_name: "函数的返回值必须被使用", fp_guidance: "有意忽略printf等函数的返回值" }],
  ["CID4245", { category: "A4", rule_name: "应该侦测和处理标准库产生的错误", fp_guidance: "在已知不会失败的条件下调用库函数被要求检查错误" }],
  ["CID3218", { category: "A4", rule_name: "如果一个函数产生错误信息则应测试该错误信息", fp_guidance: "已知函数在当前上下文不会产生错误时被要求检查" }],
  ["CID760",  { category: "A4", rule_name: "全局变量赋值和条件判断设计不匹配（变量未赋过值）", fp_guidance: "通过回调或函数指针赋值的全局变量被认为未赋过值" }],

  // ── Category 5: 控制流分析型 (A5) — 9 rules ──
  ["CID024",  { category: "A5", rule_name: "禁止不可达语句", fp_guidance: "平台相关宏条件展开后实际可达的代码被误判为不可达" }],
  ["CID267",  { category: "A5", rule_name: "禁止不可达分支", fp_guidance: "依赖运行时输入的条件分支被保守认定为不可达" }],
  ["CID1021", { category: "A5", rule_name: "工程中不应该含有不可达代码", fp_guidance: "防御性代码（错误处理逃生门）被工具认为不可达" }],
  ["CID4171", { category: "A5", rule_name: "工程中不应该含有不可达代码", fp_guidance: "防御性代码（错误处理逃生门）被工具认为不可达" }],
  ["CID1022", { category: "A5", rule_name: "禁止出现死代码", fp_guidance: "条件编译的非活动分支被误判为死代码" }],
  ["CID145",  { category: "A5", rule_name: "避��由于设计原因导致某些代码不能执行", fp_guidance: "防御性断言代码（不期望到达但���在安全网）被认为不可执行" }],
  ["CID857",  { category: "A5", rule_name: "非条件控制的break/continue/return/goto语句出现在循环内", fp_guidance: "if语句内的break/return被工具误识别为无条件跳转" }],
  ["CID144",  { category: "A5", rule_name: "非void类型的函数必须有返回语句", fp_guidance: "通过assert(false)等方式确保不到达的路径仍被要求return" }],
  ["CID001",  { category: "A5", rule_name: "有返回值的函数中return必须带有返回值", fp_guidance: "通过longjmp等特殊控制流跳过的return路径" }],

  // ── Category 6: 语义分析型 (A6) — 17 rules ──
  ["CID3075", { category: "A6", rule_name: "逻辑表达式&&或||的右操作数不应含有副作用", fp_guidance: "右操作数调用纯函数（无副作用）但工具保守判定为违规" }],
  ["CID3016", { category: "A6", rule_name: "不要依赖于副作用的计算顺序", fp_guidance: "实际代码逻辑不依赖顺序但表达式形式触发规则" }],
  ["CID1040", { category: "A6", rule_name: "一个表达式的值在标准所允许的任意计算顺序下都应该是相同的", fp_guidance: "实际不依赖顺序的表达式因形式触发规则" }],
  ["CID726",  { category: "A6", rule_name: "避免在存在++或--的表达式中使用其它有副作用的语句", fp_guidance: "包含函数调用的表达式被保守认定为有副作用" }],
  ["CID3074", { category: "A6", rule_name: "禁止在sizeof操作中使用有副作用的语句", fp_guidance: "调用纯函数的sizeof表达式被保守认定为有副作用" }],
  ["CID4202", { category: "A6", rule_name: "不要依赖sizeof/_Alignof/_Generic操作符的副作用", fp_guidance: "sizeof参数包含函数调用但实际无副作用时被报告" }],
  ["CID727",  { category: "A6", rule_name: "避免使用赋值表达式作为其他运算的数值", fp_guidance: "while((c=getchar())!=EOF)这类惯用法被误报" }],
  ["CID876",  { category: "A6", rule_name: "在邻近操作中针对同一变量的非顺序修改可导致未定义的行为", fp_guidance: "在不同语句中修改同一变量但不违反序列点规则时被误报" }],
  ["CID4209", { category: "A6", rule_name: "在信号处理函数中不应使用共享对象", fp_guidance: "使用信号安全的原子操作访问共享对象时被误报" }],
  ["CID4200", { category: "A6", rule_name: "在中断信号处理函数中不应该调用signal()", fp_guidance: "在正确保护下重设信号处理函数的合法用法" }],
  ["CID4208", { category: "A6", rule_name: "在信号处理函数中只能调用同步安全的函数", fp_guidance: "自定义的信号安全函数被认为不安全" }],
  ["CID4204", { category: "A6", rule_name: "不要从计算异常信号处理函数中返回", fp_guidance: "某些平台上从SIGFPE返回是有意义的" }],
  ["CID4112", { category: "A6", rule_name: "程序外部可改写的变量必须使用volatile类型说明", fp_guidance: "非volatile的全局变量在单线程环境中被误要求加volatile" }],
  ["CID173",  { category: "A6", rule_name: "对于无法缓存的数据建议使用volatile关键字", fp_guidance: "非volatile的全局变量在单线程环境中被误要求加volatile" }],
  ["CID4206", { category: "A6", rule_name: "不要通过非易失性引用访问易失性对象", fp_guidance: "受保护代码段内的多次volatile访问" }],
  ["CID4113", { category: "A6", rule_name: "禁止在表达式中出现多个同一volatile类型变量的运算", fp_guidance: "受保护代码段内的多次volatile访问" }],
  ["CID6672", { category: "A6", rule_name: "禁止在复杂表达式中使用volatile类型的变量", fp_guidance: "受保护代码段内的多次volatile访问" }],

  // ── Category 7: 跨函数调用链型 (B2) — 5 rules ──
  ["CID1144", { category: "B2", rule_name: "lock和unlock函数不匹配", fp_guidance: "获锁在函数A，解锁在函数B（A调用B或在同一控制流路径上），工具在A的路径内找不到对应unlock" }],
  ["CID069",  { category: "B2", rule_name: "禁止返回指向局部变量的指针", fp_guidance: "函数返回指向static局部变量的指针（static变量生命周期是整个程序运行期，返回其地址合法）" }],
  ["CID3164", { category: "B2", rule_name: "禁止将局部变量地址做为函数返回值返回", fp_guidance: "同CID069" }],
  ["CID1019", { category: "B2", rule_name: "不应将自动存储的变量地址赋值给另一个在其消失后还存在的对象", fp_guidance: "局部变量地址赋给外层指针但在局部变量所在函数返回之前即使用完毕（合法的短期指针传递）" }],
  ["CID3159", { category: "B2", rule_name: "应检查从外部资源接收值的有效性", fp_guidance: "调用方在调用函数之前已对参数做充分验证，函数内部省略重复验证，工具无法追踪调用方的验证逻辑" }],

  // ── Category 7: 运行时环境依赖型 (B3) — 2 rules ──
  ["CID4255", { category: "B3", rule_name: "格式化字符串不能包含用户输入", fp_guidance: "嵌入式系统用户输入往往是受控的串口命令/遥控指令，经协议解析后已强类型约束" }],
  ["CID4222", { category: "B3", rule_name: "在访问文件时避免TOCTOU资源竞争情况", fp_guidance: "TOCTOU前提是存在并发；裸机单任务环境或关中断/互斥保护下的文件访问不存在TOCTOU风险" }],
]

/** Map from rule CID to its undecidable rule info (category, name, FP guidance) */
export const UNDECIDABLE_RULES: ReadonlyMap<string, UndecidableRuleInfo> =
  new Map(entries)
