/**
 * temp_monitor.c — Embedded temperature monitoring and alarm controller
 *
 * Target: Cortex-M4, bare-metal
 * Reads ADC temperature sensor, applies filtering, manages alarm state
 * machine with hysteresis, controls relay output and status LED.
 */

#include <stdint.h>
#include <stdbool.h>

/* ---------- Hardware registers (memory-mapped) ---------- */
#define ADC_DR    (*(volatile uint32_t *)0x40012440)
#define GPIO_ODR  (*(volatile uint32_t *)0x40020014)
#define RELAY_PIN (1U << 8)
#define LED_PIN   (1U << 13)

/* ---------- Configuration ---------- */
#define FILTER_LEN       8
#define TEMP_SCALE       100        /* ADC counts per degree C */
#define WARNING_THRESH   7500       /* 75.00 C */
#define ALARM_THRESH     8500       /* 85.00 C */
#define HYST_MARGIN      200        /* 2.00 C hysteresis */
#define SAMPLE_PERIOD_MS 100

/* ---------- Types ---------- */
typedef enum {
    STATE_NORMAL,
    STATE_WARNING,
    STATE_ALARM
} AlarmState;

typedef struct {
    int32_t  buf[FILTER_LEN];
    uint8_t  idx;
    uint8_t  count;
    int32_t  sum;
} Filter;

/* ---------- Globals ---------- */
static Filter    g_filter;
static AlarmState g_state = STATE_NORMAL;
static uint32_t  g_sample_count;  /* shared with TIM2_IRQHandler */
static bool      g_new_sample;    /* flag set by ISR */

/* ---------- Filter ---------- */
void filter_init(Filter *f) {
    for (uint8_t i = 0; i < FILTER_LEN; i++)
        f->buf[i] = 0;
    f->idx   = 0;
    f->count = 0;
    f->sum   = 0;
}

int32_t filter_update(Filter *f, int32_t sample) {
    f->sum -= f->buf[f->idx];
    f->buf[f->idx] = sample;
    f->sum += sample;
    f->idx = (f->idx + 1) % FILTER_LEN;
    if (f->count < FILTER_LEN)
        f->count++;
    return f->sum / f->count;
}

/* ---------- State Machine ---------- */
AlarmState evaluate_state(AlarmState current, int32_t temp) {
    switch (current) {
    case STATE_NORMAL:
        if (temp >= ALARM_THRESH)
            return STATE_ALARM;
        if (temp >= WARNING_THRESH)
            return STATE_WARNING;
        break;
    case STATE_WARNING:
        if (temp >= ALARM_THRESH)
            return STATE_ALARM;
        if (temp < WARNING_THRESH - HYST_MARGIN)
            return STATE_NORMAL;
        break;
    case STATE_ALARM:
        if (temp < ALARM_THRESH - HYST_MARGIN)
            return STATE_WARNING;
        break;
    }
    return current;
}

/* ---------- Actuator control ---------- */
void apply_outputs(AlarmState state) {
    if (state == STATE_ALARM) {
        GPIO_ODR |= RELAY_PIN;      /* activate relay */
        GPIO_ODR |= LED_PIN;        /* LED on */
    } else {
        GPIO_ODR &= ~RELAY_PIN;
        if (state == STATE_WARNING)
            GPIO_ODR ^= LED_PIN;    /* blink LED */
        else
            GPIO_ODR &= ~LED_PIN;
    }
}

/* ---------- ISR ---------- */
void TIM2_IRQHandler(void) {
    g_sample_count++;
    g_new_sample = true;
}

/* ---------- Main loop ---------- */
int main(void) {
    filter_init(&g_filter);

    while (1) {
        if (!g_new_sample)
            continue;
        g_new_sample = false;

        int32_t raw   = (int32_t)ADC_DR;
        int32_t temp  = filter_update(&g_filter, raw);

        g_state = evaluate_state(g_state, temp);
        apply_outputs(g_state);
    }
    return 0;
}
