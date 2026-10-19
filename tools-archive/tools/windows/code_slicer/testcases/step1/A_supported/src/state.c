#include "../include/model.h"

/* Default device context backing storage. */
device_ctx_t default_ctx = {0};
/* Active global device context. */
device_ctx_t *g_ctx = &default_ctx;
/* Global update counter. */
int g_counter = 0;
/* State touched only through a macro expansion. */
macro_state_t g_macro_state = MACRO_IDLE;

static void mark_busy(device_ctx_t *ctx) {
    if (ctx != 0) {
        ctx->state = DEV_BUSY;
    }
}

/* Writes the computed length into the shared context. */
void update_global_len(int value) {
    device_ctx_t *ctx = g_ctx;
    if (ctx == 0) {
        return;
    }

    if (value > 0) {
        ctx->len = value;
        g_counter = g_counter + 1;
        mark_busy(ctx);
    }
}
