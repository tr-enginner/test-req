#include "../include/model.h"

static void default_worker(int code) {
    if (g_ctx != 0) {
        g_ctx->flags = g_ctx->flags + code;
    }
}

void dispatch_event(int code) {
    worker_fn_t fn = 0;
    device_ctx_t *ctx = g_ctx;

    if (ctx == 0) {
        return;
    }

    fn = ctx->on_event;
    if (fn != 0) {
        fn(code);
    } else {
        default_worker(code);
    }
}
