/**
 * Pre-built stub content for commonly missing headers in embedded projects.
 *
 * These stubs provide minimal type definitions, function prototypes, and macros
 * — just enough for the preprocessor and parser to resolve symbols.
 * They do NOT provide real implementations.
 */

// ---------------------------------------------------------------------------
// Standard C library stubs
// ---------------------------------------------------------------------------
export const STANDARD_C_STUBS: Record<string, string> = {
  "stdint.h": `#ifndef _STDINT_H
#define _STDINT_H
typedef signed char        int8_t;
typedef unsigned char      uint8_t;
typedef signed short       int16_t;
typedef unsigned short     uint16_t;
typedef signed int         int32_t;
typedef unsigned int       uint32_t;
typedef signed long long   int64_t;
typedef unsigned long long uint64_t;

typedef int8_t   int_least8_t;
typedef uint8_t  uint_least8_t;
typedef int16_t  int_least16_t;
typedef uint16_t uint_least16_t;
typedef int32_t  int_least32_t;
typedef uint32_t uint_least32_t;
typedef int64_t  int_least64_t;
typedef uint64_t uint_least64_t;

typedef int8_t   int_fast8_t;
typedef uint8_t  uint_fast8_t;
typedef int32_t  int_fast16_t;
typedef uint32_t uint_fast16_t;
typedef int32_t  int_fast32_t;
typedef uint32_t uint_fast32_t;
typedef int64_t  int_fast64_t;
typedef uint64_t uint_fast64_t;

typedef long          intptr_t;
typedef unsigned long uintptr_t;
typedef int64_t       intmax_t;
typedef uint64_t      uintmax_t;

#define INT8_MIN    (-128)
#define INT8_MAX    127
#define UINT8_MAX   255
#define INT16_MIN   (-32768)
#define INT16_MAX   32767
#define UINT16_MAX  65535
#define INT32_MIN   (-2147483647 - 1)
#define INT32_MAX   2147483647
#define UINT32_MAX  4294967295U
#define INT64_MIN   (-9223372036854775807LL - 1)
#define INT64_MAX   9223372036854775807LL
#define UINT64_MAX  18446744073709551615ULL
#endif /* _STDINT_H */
`,

  "stddef.h": `#ifndef _STDDEF_H
#define _STDDEF_H
typedef unsigned long size_t;
typedef long          ptrdiff_t;
#ifndef NULL
#define NULL ((void *)0)
#endif
#define offsetof(type, member) ((size_t)&((type *)0)->member)
typedef int           wchar_t;
#endif /* _STDDEF_H */
`,

  "stdbool.h": `#ifndef _STDBOOL_H
#define _STDBOOL_H
#ifndef __cplusplus
#define bool  _Bool
#define true  1
#define false 0
#endif
#define __bool_true_false_are_defined 1
#endif /* _STDBOOL_H */
`,

  "string.h": `#ifndef _STRING_H
#define _STRING_H
#include <stddef.h>
void *memcpy(void *dest, const void *src, size_t n);
void *memmove(void *dest, const void *src, size_t n);
void *memset(void *s, int c, size_t n);
int   memcmp(const void *s1, const void *s2, size_t n);
char *strcpy(char *dest, const char *src);
char *strncpy(char *dest, const char *src, size_t n);
char *strcat(char *dest, const char *src);
char *strncat(char *dest, const char *src, size_t n);
int   strcmp(const char *s1, const char *s2);
int   strncmp(const char *s1, const char *s2, size_t n);
size_t strlen(const char *s);
char *strchr(const char *s, int c);
char *strrchr(const char *s, int c);
char *strstr(const char *haystack, const char *needle);
void *memchr(const void *s, int c, size_t n);
#endif /* _STRING_H */
`,

  "stdlib.h": `#ifndef _STDLIB_H
#define _STDLIB_H
#include <stddef.h>
int    atoi(const char *nptr);
long   atol(const char *nptr);
double atof(const char *nptr);
long   strtol(const char *nptr, char **endptr, int base);
unsigned long strtoul(const char *nptr, char **endptr, int base);
void  *malloc(size_t size);
void  *calloc(size_t nmemb, size_t size);
void  *realloc(void *ptr, size_t size);
void   free(void *ptr);
void   abort(void);
void   exit(int status);
int    abs(int j);
long   labs(long j);
int    rand(void);
void   srand(unsigned int seed);
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#define RAND_MAX     2147483647
#endif /* _STDLIB_H */
`,

  "stdio.h": `#ifndef _STDIO_H
#define _STDIO_H
#include <stddef.h>
typedef struct _FILE FILE;
extern FILE *stdin;
extern FILE *stdout;
extern FILE *stderr;
#define EOF (-1)
#define SEEK_SET 0
#define SEEK_CUR 1
#define SEEK_END 2
int    printf(const char *format, ...);
int    sprintf(char *str, const char *format, ...);
int    snprintf(char *str, size_t size, const char *format, ...);
int    fprintf(FILE *stream, const char *format, ...);
int    scanf(const char *format, ...);
int    sscanf(const char *str, const char *format, ...);
int    putchar(int c);
int    puts(const char *s);
int    getchar(void);
FILE  *fopen(const char *pathname, const char *mode);
int    fclose(FILE *stream);
size_t fread(void *ptr, size_t size, size_t nmemb, FILE *stream);
size_t fwrite(const void *ptr, size_t size, size_t nmemb, FILE *stream);
int    fseek(FILE *stream, long offset, int whence);
long   ftell(FILE *stream);
int    feof(FILE *stream);
int    ferror(FILE *stream);
#endif /* _STDIO_H */
`,

  "limits.h": `#ifndef _LIMITS_H
#define _LIMITS_H
#define CHAR_BIT   8
#define SCHAR_MIN  (-128)
#define SCHAR_MAX  127
#define UCHAR_MAX  255
#define CHAR_MIN   0
#define CHAR_MAX   255
#define SHRT_MIN   (-32768)
#define SHRT_MAX   32767
#define USHRT_MAX  65535
#define INT_MIN    (-2147483647 - 1)
#define INT_MAX    2147483647
#define UINT_MAX   4294967295U
#define LONG_MIN   (-2147483647L - 1)
#define LONG_MAX   2147483647L
#define ULONG_MAX  4294967295UL
#define LLONG_MIN  (-9223372036854775807LL - 1)
#define LLONG_MAX  9223372036854775807LL
#define ULLONG_MAX 18446744073709551615ULL
#endif /* _LIMITS_H */
`,

  "float.h": `#ifndef _FLOAT_H
#define _FLOAT_H
#define FLT_RADIX     2
#define FLT_MANT_DIG  24
#define FLT_DIG       6
#define FLT_MIN_EXP   (-125)
#define FLT_MAX_EXP   128
#define FLT_MIN       1.17549435e-38F
#define FLT_MAX       3.40282347e+38F
#define FLT_EPSILON   1.19209290e-07F
#define DBL_MANT_DIG  53
#define DBL_DIG       15
#define DBL_MIN_EXP   (-1021)
#define DBL_MAX_EXP   1024
#define DBL_MIN       2.2250738585072014e-308
#define DBL_MAX       1.7976931348623157e+308
#define DBL_EPSILON   2.2204460492503131e-16
#endif /* _FLOAT_H */
`,

  "math.h": `#ifndef _MATH_H
#define _MATH_H
#define M_PI 3.14159265358979323846
double fabs(double x);
double sqrt(double x);
double pow(double base, double exponent);
double sin(double x);
double cos(double x);
double tan(double x);
double asin(double x);
double acos(double x);
double atan(double x);
double atan2(double y, double x);
double log(double x);
double log10(double x);
double exp(double x);
double ceil(double x);
double floor(double x);
double fmod(double x, double y);
float  fabsf(float x);
float  sqrtf(float x);
float  sinf(float x);
float  cosf(float x);
#endif /* _MATH_H */
`,

  "assert.h": `#ifndef _ASSERT_H
#define _ASSERT_H
#ifdef NDEBUG
#define assert(expr) ((void)0)
#else
#define assert(expr) ((void)0) /* stub */
#endif
#endif /* _ASSERT_H */
`,

  "errno.h": `#ifndef _ERRNO_H
#define _ERRNO_H
extern int errno;
#define EDOM   33
#define ERANGE 34
#define EILSEQ 84
#endif /* _ERRNO_H */
`,

  "ctype.h": `#ifndef _CTYPE_H
#define _CTYPE_H
int isalnum(int c);
int isalpha(int c);
int isdigit(int c);
int islower(int c);
int isupper(int c);
int isspace(int c);
int isxdigit(int c);
int tolower(int c);
int toupper(int c);
#endif /* _CTYPE_H */
`,

  "setjmp.h": `#ifndef _SETJMP_H
#define _SETJMP_H
typedef int jmp_buf[16];
int  setjmp(jmp_buf env);
void longjmp(jmp_buf env, int val);
#endif /* _SETJMP_H */
`,

  "signal.h": `#ifndef _SIGNAL_H
#define _SIGNAL_H
typedef int sig_atomic_t;
typedef void (*sighandler_t)(int);
#define SIG_DFL ((sighandler_t)0)
#define SIG_IGN ((sighandler_t)1)
#define SIG_ERR ((sighandler_t)-1)
#define SIGABRT 6
#define SIGFPE  8
#define SIGILL  4
#define SIGINT  2
#define SIGSEGV 11
#define SIGTERM 15
sighandler_t signal(int signum, sighandler_t handler);
int raise(int sig);
#endif /* _SIGNAL_H */
`,

  "time.h": `#ifndef _TIME_H
#define _TIME_H
#include <stddef.h>
typedef long time_t;
typedef long clock_t;
struct tm {
  int tm_sec;
  int tm_min;
  int tm_hour;
  int tm_mday;
  int tm_mon;
  int tm_year;
  int tm_wday;
  int tm_yday;
  int tm_isdst;
};
#define CLOCKS_PER_SEC 1000000
time_t  time(time_t *tloc);
clock_t clock(void);
double  difftime(time_t time1, time_t time0);
struct tm *localtime(const time_t *timer);
struct tm *gmtime(const time_t *timer);
size_t  strftime(char *s, size_t maxsize, const char *format, const struct tm *timeptr);
#endif /* _TIME_H */
`,

  "stdarg.h": `#ifndef _STDARG_H
#define _STDARG_H
typedef __builtin_va_list va_list;
#define va_start(ap, last) __builtin_va_start(ap, last)
#define va_arg(ap, type)   __builtin_va_arg(ap, type)
#define va_end(ap)         __builtin_va_end(ap)
#define va_copy(dest, src) __builtin_va_copy(dest, src)
#endif /* _STDARG_H */
`,
}

// ---------------------------------------------------------------------------
// CMSIS stubs (ARM Cortex-M core definitions)
// ---------------------------------------------------------------------------
export const CMSIS_STUBS: Record<string, string> = {
  "cmsis_compiler.h": `#ifndef __CMSIS_COMPILER_H
#define __CMSIS_COMPILER_H
#define __STATIC_INLINE    static inline
#define __STATIC_FORCEINLINE static inline
#define __NO_RETURN
#define __USED
#define __WEAK
#define __PACKED
#define __PACKED_STRUCT    struct
#define __PACKED_UNION     union
#define __ALIGNED(x)
#define __RESTRICT
#define __COMPILER_BARRIER() do {} while(0)
#define __NOP()            do {} while(0)
#define __WFI()            do {} while(0)
#define __WFE()            do {} while(0)
#define __SEV()            do {} while(0)
#define __ISB()            do {} while(0)
#define __DSB()            do {} while(0)
#define __DMB()            do {} while(0)
#define __REV(x)           (x)
#define __REV16(x)         (x)
#define __REVSH(x)         (x)
#define __ROR(x,n)         (x)
#define __CLZ(x)           (0)
#define __RBIT(x)          (x)
#define __LDREXB(ptr)      (*(ptr))
#define __LDREXH(ptr)      (*(ptr))
#define __LDREXW(ptr)      (*(ptr))
#define __STREXB(val,ptr)  (0)
#define __STREXH(val,ptr)  (0)
#define __STREXW(val,ptr)  (0)
#define __CLREX()          do {} while(0)
#define __get_CONTROL()    (0U)
#define __set_CONTROL(x)   ((void)(x))
#define __get_IPSR()       (0U)
#define __get_APSR()       (0U)
#define __get_xPSR()       (0U)
#define __get_PSP()        (0U)
#define __set_PSP(x)       ((void)(x))
#define __get_MSP()        (0U)
#define __set_MSP(x)       ((void)(x))
#define __get_PRIMASK()    (0U)
#define __set_PRIMASK(x)   ((void)(x))
#define __enable_irq()     do {} while(0)
#define __disable_irq()    do {} while(0)
#define __get_BASEPRI()    (0U)
#define __set_BASEPRI(x)   ((void)(x))
#define __get_FAULTMASK()  (0U)
#define __set_FAULTMASK(x) ((void)(x))
#endif /* __CMSIS_COMPILER_H */
`,

  "cmsis_gcc.h": `#ifndef __CMSIS_GCC_H
#define __CMSIS_GCC_H
#include "cmsis_compiler.h"
#endif /* __CMSIS_GCC_H */
`,

  "cmsis_version.h": `#ifndef __CMSIS_VERSION_H
#define __CMSIS_VERSION_H
#define __CM_CMSIS_VERSION_MAIN  (5U)
#define __CM_CMSIS_VERSION_SUB   (6U)
#define __CM_CMSIS_VERSION       ((__CM_CMSIS_VERSION_MAIN << 16U) | __CM_CMSIS_VERSION_SUB)
#endif /* __CMSIS_VERSION_H */
`,

  "core_cm0.h": `#ifndef __CORE_CM0_H
#define __CORE_CM0_H
#include <stdint.h>
#include "cmsis_compiler.h"
typedef struct { volatile uint32_t ISER[1]; volatile uint32_t ICER[1]; volatile uint32_t ISPR[1]; volatile uint32_t ICPR[1]; uint32_t RESERVED[24]; volatile uint32_t IP[8]; } NVIC_Type;
typedef struct { volatile uint32_t CTRL; volatile uint32_t LOAD; volatile uint32_t VAL; volatile uint32_t CALIB; } SysTick_Type;
typedef struct { volatile uint32_t CPUID; volatile uint32_t ICSR; uint32_t RESERVED0; volatile uint32_t AIRCR; volatile uint32_t SCR; volatile uint32_t CCR; uint32_t RESERVED1; volatile uint32_t SHP[2]; volatile uint32_t SHCSR; } SCB_Type;
#define SCS_BASE   (0xE000E000UL)
#define SysTick_BASE (SCS_BASE + 0x0010UL)
#define NVIC_BASE  (SCS_BASE + 0x0100UL)
#define SCB_BASE   (SCS_BASE + 0x0D00UL)
#define SCB        ((SCB_Type *)SCB_BASE)
#define SysTick    ((SysTick_Type *)SysTick_BASE)
#define NVIC       ((NVIC_Type *)NVIC_BASE)
static inline void NVIC_EnableIRQ(int IRQn) { (void)IRQn; }
static inline void NVIC_DisableIRQ(int IRQn) { (void)IRQn; }
static inline void NVIC_SetPriority(int IRQn, uint32_t priority) { (void)IRQn; (void)priority; }
static inline uint32_t NVIC_GetPriority(int IRQn) { (void)IRQn; return 0; }
static inline void NVIC_SystemReset(void) {}
#endif /* __CORE_CM0_H */
`,

  "core_cm3.h": `#ifndef __CORE_CM3_H
#define __CORE_CM3_H
#include <stdint.h>
#include "cmsis_compiler.h"
typedef struct { volatile uint32_t ISER[8]; uint32_t RESERVED0[24]; volatile uint32_t ICER[8]; uint32_t RESERVED1[24]; volatile uint32_t ISPR[8]; uint32_t RESERVED2[24]; volatile uint32_t ICPR[8]; uint32_t RESERVED3[24]; volatile uint32_t IABR[8]; uint32_t RESERVED4[56]; volatile uint8_t IP[240]; uint32_t RESERVED5[644]; volatile uint32_t STIR; } NVIC_Type;
typedef struct { volatile uint32_t CTRL; volatile uint32_t LOAD; volatile uint32_t VAL; volatile uint32_t CALIB; } SysTick_Type;
typedef struct { volatile uint32_t CPUID; volatile uint32_t ICSR; volatile uint32_t VTOR; volatile uint32_t AIRCR; volatile uint32_t SCR; volatile uint32_t CCR; volatile uint8_t SHP[12]; volatile uint32_t SHCSR; volatile uint32_t CFSR; volatile uint32_t HFSR; volatile uint32_t DFSR; volatile uint32_t MMFAR; volatile uint32_t BFAR; volatile uint32_t AFSR; } SCB_Type;
#define SCS_BASE   (0xE000E000UL)
#define SysTick_BASE (SCS_BASE + 0x0010UL)
#define NVIC_BASE  (SCS_BASE + 0x0100UL)
#define SCB_BASE   (SCS_BASE + 0x0D00UL)
#define SCB        ((SCB_Type *)SCB_BASE)
#define SysTick    ((SysTick_Type *)SysTick_BASE)
#define NVIC       ((NVIC_Type *)NVIC_BASE)
static inline void NVIC_EnableIRQ(int IRQn) { (void)IRQn; }
static inline void NVIC_DisableIRQ(int IRQn) { (void)IRQn; }
static inline void NVIC_SetPriority(int IRQn, uint32_t priority) { (void)IRQn; (void)priority; }
static inline uint32_t NVIC_GetPriority(int IRQn) { (void)IRQn; return 0; }
static inline void __NVIC_SetPendingIRQ(int IRQn) { (void)IRQn; }
static inline void NVIC_SystemReset(void) {}
#endif /* __CORE_CM3_H */
`,

  "core_cm4.h": `#ifndef __CORE_CM4_H
#define __CORE_CM4_H
#include "core_cm3.h"
/* CM4 extends CM3 with FPU and DSP — for parsing purposes CM3 stubs suffice */
#endif /* __CORE_CM4_H */
`,

  "core_cm7.h": `#ifndef __CORE_CM7_H
#define __CORE_CM7_H
#include "core_cm3.h"
/* CM7 extends CM3 — for parsing purposes CM3 stubs suffice */
#endif /* __CORE_CM7_H */
`,

  "core_cm33.h": `#ifndef __CORE_CM33_H
#define __CORE_CM33_H
#include "core_cm3.h"
#endif /* __CORE_CM33_H */
`,
}

// ---------------------------------------------------------------------------
// FreeRTOS stubs
// ---------------------------------------------------------------------------
export const RTOS_STUBS: Record<string, string> = {
  "FreeRTOS.h": `#ifndef INC_FREERTOS_H
#define INC_FREERTOS_H
#include <stdint.h>
#include <stddef.h>
typedef uint32_t TickType_t;
typedef uint32_t UBaseType_t;
typedef int32_t  BaseType_t;
typedef void *   TaskHandle_t;
typedef void *   QueueHandle_t;
typedef void *   SemaphoreHandle_t;
typedef void *   TimerHandle_t;
typedef void *   EventGroupHandle_t;
typedef void *   StreamBufferHandle_t;
typedef void *   MessageBufferHandle_t;
#define pdTRUE   ((BaseType_t)1)
#define pdFALSE  ((BaseType_t)0)
#define pdPASS   (pdTRUE)
#define pdFAIL   (pdFALSE)
#define portMAX_DELAY (TickType_t)0xFFFFFFFF
#define configMAX_PRIORITIES 5
#define configMINIMAL_STACK_SIZE 128
#define configTICK_RATE_HZ 1000
#define portTICK_PERIOD_MS ((TickType_t)1000 / configTICK_RATE_HZ)
#define configUSE_PREEMPTION 1
#define portYIELD() do {} while(0)
#define taskENTER_CRITICAL() do {} while(0)
#define taskEXIT_CRITICAL() do {} while(0)
#define taskDISABLE_INTERRUPTS() do {} while(0)
#define taskENABLE_INTERRUPTS() do {} while(0)
void vTaskStartScheduler(void);
void vTaskDelay(TickType_t xTicksToDelay);
TickType_t xTaskGetTickCount(void);
#endif /* INC_FREERTOS_H */
`,

  "task.h": `#ifndef INC_TASK_H
#define INC_TASK_H
#include "FreeRTOS.h"
typedef struct tskTaskControlBlock * TaskHandle_t;
BaseType_t xTaskCreate(void (*pxTaskCode)(void *), const char *pcName, uint16_t usStackDepth, void *pvParameters, UBaseType_t uxPriority, TaskHandle_t *pxCreatedTask);
void vTaskDelete(TaskHandle_t xTaskToDelete);
void vTaskDelay(TickType_t xTicksToDelay);
void vTaskDelayUntil(TickType_t *pxPreviousWakeTime, TickType_t xTimeIncrement);
void vTaskSuspend(TaskHandle_t xTaskToSuspend);
void vTaskResume(TaskHandle_t xTaskToResume);
UBaseType_t uxTaskPriorityGet(TaskHandle_t xTask);
void vTaskPrioritySet(TaskHandle_t xTask, UBaseType_t uxNewPriority);
TaskHandle_t xTaskGetCurrentTaskHandle(void);
void vTaskStartScheduler(void);
TickType_t xTaskGetTickCount(void);
#endif /* INC_TASK_H */
`,

  "queue.h": `#ifndef INC_QUEUE_H
#define INC_QUEUE_H
#include "FreeRTOS.h"
QueueHandle_t xQueueCreate(UBaseType_t uxQueueLength, UBaseType_t uxItemSize);
BaseType_t xQueueSend(QueueHandle_t xQueue, const void *pvItemToQueue, TickType_t xTicksToWait);
BaseType_t xQueueSendFromISR(QueueHandle_t xQueue, const void *pvItemToQueue, BaseType_t *pxHigherPriorityTaskWoken);
BaseType_t xQueueReceive(QueueHandle_t xQueue, void *pvBuffer, TickType_t xTicksToWait);
BaseType_t xQueueReceiveFromISR(QueueHandle_t xQueue, void *pvBuffer, BaseType_t *pxHigherPriorityTaskWoken);
UBaseType_t uxQueueMessagesWaiting(QueueHandle_t xQueue);
void vQueueDelete(QueueHandle_t xQueue);
BaseType_t xQueueReset(QueueHandle_t xQueue);
#endif /* INC_QUEUE_H */
`,

  "semphr.h": `#ifndef INC_SEMPHR_H
#define INC_SEMPHR_H
#include "FreeRTOS.h"
#include "queue.h"
#define xSemaphoreCreateBinary()            xQueueCreate(1, 0)
#define xSemaphoreCreateMutex()             xQueueCreate(1, 0)
#define xSemaphoreCreateCounting(max, init) xQueueCreate(max, 0)
#define xSemaphoreTake(sem, wait)           xQueueReceive(sem, NULL, wait)
#define xSemaphoreGive(sem)                 xQueueSend(sem, NULL, 0)
#define xSemaphoreTakeFromISR(sem, woken)   xQueueReceiveFromISR(sem, NULL, woken)
#define xSemaphoreGiveFromISR(sem, woken)   xQueueSendFromISR(sem, NULL, woken)
#define vSemaphoreDelete(sem)               vQueueDelete(sem)
#endif /* INC_SEMPHR_H */
`,

  "event_groups.h": `#ifndef INC_EVENT_GROUPS_H
#define INC_EVENT_GROUPS_H
#include "FreeRTOS.h"
typedef uint32_t EventBits_t;
EventGroupHandle_t xEventGroupCreate(void);
EventBits_t xEventGroupSetBits(EventGroupHandle_t xEventGroup, EventBits_t uxBitsToSet);
EventBits_t xEventGroupClearBits(EventGroupHandle_t xEventGroup, EventBits_t uxBitsToClear);
EventBits_t xEventGroupWaitBits(EventGroupHandle_t xEventGroup, EventBits_t uxBitsToWaitFor, BaseType_t xClearOnExit, BaseType_t xWaitForAllBits, TickType_t xTicksToWait);
EventBits_t xEventGroupGetBits(EventGroupHandle_t xEventGroup);
void vEventGroupDelete(EventGroupHandle_t xEventGroup);
#endif /* INC_EVENT_GROUPS_H */
`,

  "timers.h": `#ifndef INC_TIMERS_H
#define INC_TIMERS_H
#include "FreeRTOS.h"
TimerHandle_t xTimerCreate(const char *pcTimerName, TickType_t xTimerPeriod, UBaseType_t uxAutoReload, void *pvTimerID, void (*pxCallbackFunction)(TimerHandle_t));
BaseType_t xTimerStart(TimerHandle_t xTimer, TickType_t xTicksToWait);
BaseType_t xTimerStop(TimerHandle_t xTimer, TickType_t xTicksToWait);
BaseType_t xTimerReset(TimerHandle_t xTimer, TickType_t xTicksToWait);
void vTimerSetTimerID(TimerHandle_t xTimer, void *pvNewID);
void *pvTimerGetTimerID(TimerHandle_t xTimer);
BaseType_t xTimerDelete(TimerHandle_t xTimer, TickType_t xTicksToWait);
#endif /* INC_TIMERS_H */
`,

  "FreeRTOSConfig.h": `#ifndef FREERTOS_CONFIG_H
#define FREERTOS_CONFIG_H
/* Minimal stub configuration */
#define configUSE_PREEMPTION           1
#define configUSE_IDLE_HOOK            0
#define configUSE_TICK_HOOK            0
#define configCPU_CLOCK_HZ             72000000
#define configTICK_RATE_HZ             1000
#define configMAX_PRIORITIES           5
#define configMINIMAL_STACK_SIZE       128
#define configTOTAL_HEAP_SIZE          (10 * 1024)
#define configMAX_TASK_NAME_LEN        16
#define configUSE_16_BIT_TICKS         0
#define configIDLE_SHOULD_YIELD        1
#define configUSE_MUTEXES              1
#define configUSE_COUNTING_SEMAPHORES  1
#define configUSE_RECURSIVE_MUTEXES    1
#define configUSE_TIMERS               1
#define configTIMER_TASK_PRIORITY      2
#define configTIMER_QUEUE_LENGTH       10
#define configTIMER_TASK_STACK_DEPTH   256
#define INCLUDE_vTaskPrioritySet       1
#define INCLUDE_uxTaskPriorityGet      1
#define INCLUDE_vTaskDelete            1
#define INCLUDE_vTaskSuspend           1
#define INCLUDE_vTaskDelay             1
#define INCLUDE_vTaskDelayUntil        1
#endif /* FREERTOS_CONFIG_H */
`,
}

// ---------------------------------------------------------------------------
// Vendor HAL patterns — for demand-driven stub generation
// ---------------------------------------------------------------------------
export const VENDOR_PATTERNS: Array<{
  pattern: RegExp
  category: "vendor_hal" | "bsp" | "driver" | "middleware"
  description: string
}> = [
  { pattern: /^stm32\w*\.h$/i, category: "vendor_hal", description: "STM32 HAL" },
  { pattern: /^stm32\w*_hal\w*\.h$/i, category: "vendor_hal", description: "STM32 HAL driver" },
  { pattern: /^stm32\w*_ll_\w+\.h$/i, category: "vendor_hal", description: "STM32 LL driver" },
  { pattern: /^nrf\w*\.h$/i, category: "vendor_hal", description: "Nordic nRF SDK" },
  { pattern: /^nrfx?\w*\.h$/i, category: "vendor_hal", description: "Nordic nrfx" },
  { pattern: /^ti[\/_]\w+\.h$/i, category: "vendor_hal", description: "TI driverlib" },
  { pattern: /^driverlib[\/_]\w+\.h$/i, category: "vendor_hal", description: "TI driverlib" },
  { pattern: /^fsl_\w+\.h$/i, category: "vendor_hal", description: "NXP SDK" },
  { pattern: /^em_\w+\.h$/i, category: "vendor_hal", description: "Silicon Labs emlib" },
  { pattern: /^cy_\w+\.h$/i, category: "vendor_hal", description: "Cypress/Infineon PDL" },
  { pattern: /^hal_\w+\.h$/i, category: "vendor_hal", description: "Generic HAL" },
  { pattern: /^bsp\w*\.h$/i, category: "bsp", description: "Board Support Package" },
  { pattern: /^board\w*\.h$/i, category: "bsp", description: "Board definitions" },
  { pattern: /^system_\w+\.h$/i, category: "bsp", description: "System init" },
  { pattern: /^startup_\w+\.h$/i, category: "bsp", description: "Startup code" },
  { pattern: /^FreeRTOS\w*\.h$/i, category: "middleware", description: "FreeRTOS" },
  { pattern: /^task\.h$/i, category: "middleware", description: "FreeRTOS task" },
  { pattern: /^queue\.h$/i, category: "middleware", description: "FreeRTOS queue" },
  { pattern: /^semphr\.h$/i, category: "middleware", description: "FreeRTOS semaphore" },
  { pattern: /^event_groups\.h$/i, category: "middleware", description: "FreeRTOS events" },
  { pattern: /^timers\.h$/i, category: "middleware", description: "FreeRTOS timers" },
  { pattern: /^lwip[\/_]\w*\.h$/i, category: "middleware", description: "lwIP" },
  { pattern: /^ff\.h$/i, category: "middleware", description: "FatFs" },
  { pattern: /^usb\w*\.h$/i, category: "middleware", description: "USB stack" },
]

/**
 * Categorize a missing header based on its filename.
 */
export function categorizeHeader(
  headerName: string,
): "vendor_hal" | "bsp" | "rtos" | "compiler_builtin" | "standard_lib" | "driver" | "middleware" | "unknown" {
  const basename = headerName.replace(/^.*[\\/]/, "")

  // Standard C library
  if (STANDARD_C_STUBS[basename]) return "standard_lib"

  // CMSIS
  if (CMSIS_STUBS[basename]) return "compiler_builtin"
  if (/^cmsis\w*\.h$/i.test(basename) || /^core_cm\w*\.h$/i.test(basename)) return "compiler_builtin"

  // FreeRTOS
  if (RTOS_STUBS[basename]) return "rtos"

  // Vendor patterns
  for (const { pattern, category } of VENDOR_PATTERNS) {
    if (pattern.test(basename)) return category
  }

  return "unknown"
}

/**
 * Get pre-built stub content for a header, or null if no pre-built stub exists.
 */
export function getPrebuiltStub(headerName: string): string | null {
  const basename = headerName.replace(/^.*[\\/]/, "")

  if (STANDARD_C_STUBS[basename]) return STANDARD_C_STUBS[basename]
  if (CMSIS_STUBS[basename]) return CMSIS_STUBS[basename]
  if (RTOS_STUBS[basename]) return RTOS_STUBS[basename]

  return null
}
