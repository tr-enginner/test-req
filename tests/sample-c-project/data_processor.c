/**
 * Data Processor Module — Implementation
 * SAFETY_CRITICAL module: processes flight control data.
 */

#include "data_processor.h"

/* Constants */
#define TEMP_MIN        (-40.0f)
#define TEMP_MAX        (125.0f)
#define PRESSURE_MIN    (0.0f)
#define PRESSURE_MAX    (1100.0f)
#define ALTITUDE_MIN    (-500.0f)
#define ALTITUDE_MAX    (50000.0f)
#define VELOCITY_MAX    (1000u)
#define PITCH_MAX       (9000)     /* 90.0 deg * 100 */
#define ROLL_MAX        (18000)    /* 180.0 deg * 100 */

#define FILTER_HISTORY_SIZE  (8u)
#define KP_ELEVATOR     (0.01f)
#define KP_AILERON      (0.005f)
#define KP_THROTTLE     (0.002f)

/* Static variables */
static float g_filter_history[FILTER_HISTORY_SIZE];
static float g_target_altitude = 10000.0f;
static float g_target_velocity = 250.0f;
static SystemConfig g_config;

/* SAFETY_CRITICAL */
StatusCode validate_sensor_data(const SensorData *data)
{
    if (data == (void *)0) {
        return STATUS_INVALID_PARAM;
    }

    if (data->data_valid != 1u) {
        return STATUS_ERROR;
    }

    /* Range checks */
    if (data->temperature < TEMP_MIN || data->temperature > TEMP_MAX) {
        return STATUS_OUT_OF_RANGE;
    }

    if (data->pressure < PRESSURE_MIN || data->pressure > PRESSURE_MAX) {
        return STATUS_OUT_OF_RANGE;
    }

    if (data->altitude < ALTITUDE_MIN || data->altitude > ALTITUDE_MAX) {
        return STATUS_OUT_OF_RANGE;
    }

    if (data->velocity > VELOCITY_MAX) {
        return STATUS_OUT_OF_RANGE;
    }

    if (data->pitch_angle < -PITCH_MAX || data->pitch_angle > PITCH_MAX) {
        return STATUS_OUT_OF_RANGE;
    }

    if (data->roll_angle < -ROLL_MAX || data->roll_angle > ROLL_MAX) {
        return STATUS_OUT_OF_RANGE;
    }

    return STATUS_OK;
}

/* SAFETY_CRITICAL */
StatusCode process_data(const SensorData *input, ControlOutput *output)
{
    if (input == (void *)0 || output == (void *)0) {
        return STATUS_INVALID_PARAM;
    }

    /* Compute control outputs */
    output->elevator_cmd = compute_elevator(
        input->pitch_angle,
        input->altitude,
        g_target_altitude
    );

    output->aileron_cmd = compute_aileron(input->roll_angle);

    output->throttle_cmd = compute_throttle(
        input->velocity,
        g_target_velocity
    );

    /* Set warning flags */
    output->warning_flags = 0u;
    if (input->altitude > 40000.0f) {
        output->warning_flags |= 0x01u;  /* High altitude warning */
    }
    if (input->velocity > 800u) {
        output->warning_flags |= 0x02u;  /* High speed warning */
    }
    if (input->temperature > 100.0f) {
        output->warning_flags |= 0x04u;  /* High temperature warning */
    }

    output->timestamp_ms = input->timestamp_ms;

    return STATUS_OK;
}

float compute_elevator(int16_t pitch, float altitude, float target_alt)
{
    float pitch_deg = (float)pitch / 100.0f;
    float alt_error = target_alt - altitude;
    float cmd = (alt_error * KP_ELEVATOR) - (pitch_deg * 0.02f);
    return clamp(cmd, -1.0f, 1.0f);
}

float compute_aileron(int16_t roll)
{
    float roll_deg = (float)roll / 100.0f;
    float cmd = -(roll_deg * KP_AILERON);
    return clamp(cmd, -1.0f, 1.0f);
}

float compute_throttle(uint16_t velocity, float target_vel)
{
    float vel_error = target_vel - (float)velocity;
    float cmd = 0.5f + (vel_error * KP_THROTTLE);
    return clamp(cmd, 0.0f, 1.0f);
}

float apply_filter(float input, float *history, uint16_t order)
{
    float sum = input;
    uint16_t i;

    if (history == (void *)0 || order == 0u) {
        return input;
    }

    /* Shift history and add new sample */
    for (i = order - 1u; i > 0u; i--) {
        history[i] = history[i - 1u];
        sum += history[i];
    }
    history[0] = input;
    sum += history[0];

    return sum / (float)(order + 1u);
}

float clamp(float value, float min, float max)
{
    if (value < min) {
        return min;
    }
    if (value > max) {
        return max;
    }
    return value;
}

StatusCode system_init(SystemConfig *config)
{
    uint16_t i;

    if (config == (void *)0) {
        return STATUS_INVALID_PARAM;
    }

    /* Default configuration */
    config->sample_rate_hz = 100u;
    config->filter_order = 4u;
    config->gain = 1.0f;
    config->offset = 0.0f;
    config->channel_count = 6u;

    g_config = *config;

    /* Clear filter history */
    for (i = 0u; i < FILTER_HISTORY_SIZE; i++) {
        g_filter_history[i] = 0.0f;
    }

    return STATUS_OK;
}

StatusCode system_shutdown(void)
{
    return STATUS_OK;
}

void error_handler(ErrorCode code)
{
    /* Log error — in real system would write to error log */
    (void)code;
}
