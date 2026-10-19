#include "../include/complex.h"

void dialect_features(void) {
    outer_t *ctx = g_outer;
    inner_t *member = 0;

    if (ctx == 0 || ctx->inner == 0) {
        return;
    }

    member = ({
        typeof(ctx->inner) tmp = ctx->inner;
        tmp;
    });

    asm volatile("" : : "r"(member) : "memory");

    if (GET_LEN(ctx) > 0) {
        outer_t *owner = container_of(member, outer_t, inner);
        owner->opaque = g_opaque;
    }
}
