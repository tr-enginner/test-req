#ifndef B_UNSUPPORTED_COMPLEX_H
#define B_UNSUPPORTED_COMPLEX_H

#include <stddef.h>

typedef struct inner {
    int len;
    void (*handler)(void *arg);
} inner_t;

typedef struct outer {
    inner_t *inner;
    void *opaque;
} outer_t;

#define GET_LEN(obj) ((obj)->inner->len)
#define CALL_HANDLER(obj) ((obj)->inner->handler((obj)->opaque))
#define container_of(ptr, type, member) ((type *)((char *)(ptr) - offsetof(type, member)))

extern outer_t *g_outer;
extern void *g_opaque;

void alias_maze(void);
void fnptr_runtime_dispatch(void);
void dialect_features(void);

#endif
