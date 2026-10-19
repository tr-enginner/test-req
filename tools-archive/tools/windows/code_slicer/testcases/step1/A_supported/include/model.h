/* Device lifecycle states. */
typedef enum device_state {
    DEV_INIT = 0,
    DEV_READY = 1,
    DEV_BUSY = 2,
} device_state_t;

typedef enum macro_state {
    MACRO_IDLE = 0,
    MACRO_BUSY = 1,
} macro_state_t;

#ifndef MODEL_CONTEXT_MACROS_H
#define MODEL_CONTEXT_MACROS_H
#if defined(USE_WIDE_LIMIT)
#define LIMIT_INCREMENT 2
#else
#define LIMIT_INCREMENT 1
#endif
/* Records a macro-hidden state update and adjusts a computed result. */
#define RECORD_MACRO_STATE(value) \
    (g_macro_state = MACRO_BUSY, (value) + LIMIT_INCREMENT)
#define BOOT_INCREMENT RECORD_MACRO_STATE(1)
#define UNUSED_CONTEXT_MACRO 99
#endif

/* Event callback type for device handlers. */
typedef void (*worker_fn_t)(int code);

/* Shared device context layout. */
typedef struct device_ctx {
    int len;
    int flags;
    device_state_t state;
    worker_fn_t on_event;
} device_ctx_t;

extern device_ctx_t *g_ctx;
extern int g_counter;
extern macro_state_t g_macro_state;

void boot(void);
void dispatch_event(int code);
void update_global_len(int value);
