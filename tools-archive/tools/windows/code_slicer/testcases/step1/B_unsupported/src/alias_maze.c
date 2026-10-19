#include "../include/complex.h"

outer_t *g_outer;
void *g_opaque;

static inner_t *pick_inner(outer_t **slot) {
    return (*slot)->inner;
}

void alias_maze(void) {
    outer_t **slot = &g_outer;
    outer_t *owner = *slot;
    inner_t *first = pick_inner(slot);
    inner_t *second = owner->inner;
    void *opaque = g_opaque;

    if (first != 0 && second != 0) {
        first->len = second->len + 1;
        second->handler(opaque);
    }
}
