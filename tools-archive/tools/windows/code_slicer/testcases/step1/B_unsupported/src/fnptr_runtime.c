#include "../include/complex.h"

static void fallback(void *arg) {
    (void)arg;
}

void fnptr_runtime_dispatch(void) {
    outer_t *ctx = g_outer;
    void (*fn)(void *) = fallback;

    if (ctx == 0 || ctx->inner == 0) {
        return;
    }

    fn = ctx->inner->handler;
    if (fn != 0) {
        fn(ctx->opaque);
    }

    CALL_HANDLER(ctx);
}
