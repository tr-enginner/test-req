#include "../include/model.h"

static int compute_limit(int base) {
    int total = base;
    int i = 0;

    for (i = 0; i < 3; i++) {
        total = total + i;
    }

    while (total < 8) {
        total = total + 1;
    }

    return total + BOOT_INCREMENT;
}

/* Boot sequence entry point. */
void boot(void) {
    int limit = compute_limit(g_counter);
    device_ctx_t *ctx = g_ctx;

    if (ctx == 0) {
        return;
    }

    switch (ctx->state) {
    case DEV_INIT:
        update_global_len(limit);
        break;
    case DEV_READY:
        dispatch_event(limit);
        break;
    default:
        ctx->flags = ctx->flags + 1;
        break;
    }
}
