/**
 * Data Processor Module — Header
 * Processes sensor data and generates control outputs.
 */

#ifndef DATA_PROCESSOR_H
#define DATA_PROCESSOR_H

#include <stdint.h>

/* Status codes */
typedef enum {
    STATUS_OK = 0,
    STATUS_ERROR = -1,
    STATUS_INVALID_PARAM = -2,
    STATUS_OUT_OF_RANGE = -3,
} StatusCode;

/* Error codes */
typedef enum {
    ERR_NONE = 0,
    ERR_INIT_FAILED,
    ERR_SENSOR_READ,
    ERR_DATA_INVALID,
    ERR_PROCESS_FAILED,
    ERR_OUTPUT_FAILED,
} ErrorCode;

/* System states */
typedef enum {
    STATE_INIT = 0,
    STATE_RUNNING,
    STATE_ERROR,
    STATE_SHUTDOWN,
} SystemState;

/* System configuration */
typedef struct {
    uint16_t sample_rate_hz;
    uint16_t filter_order;
    float    gain;
    float    offset;
    uint8_t  channel_count;
} SystemConfig;

/* Sensor data structure */
typedef struct {
    float    temperature;       /* Range: -40.0 to 125.0 degC */
    float    pressure;          /* Range: 0.0 to 1100.0 hPa */
    float    altitude;          /* Range: -500.0 to 50000.0 m */
    uint16_t velocity;          /* Range: 0 to 1000 m/s */
    int16_t  pitch_angle;       /* Range: -90 to 90 deg * 100 */
    int16_t  roll_angle;        /* Range: -180 to 180 deg * 100 */
    uint32_t timestamp_ms;
    uint8_t  data_valid;
} SensorData;

/* Control output structure */
typedef struct {
    float    elevator_cmd;      /* Range: -1.0 to 1.0 */
    float    aileron_cmd;       /* Range: -1.0 to 1.0 */
    float    throttle_cmd;      /* Range: 0.0 to 1.0 */
    uint8_t  warning_flags;
    uint32_t timestamp_ms;
} ControlOutput;

/* Function prototypes */
StatusCode system_init(SystemConfig *config);
StatusCode system_shutdown(void);
StatusCode read_sensor_data(SensorData *data);
StatusCode validate_sensor_data(const SensorData *data);
StatusCode process_data(const SensorData *input, ControlOutput *output);
StatusCode send_control_output(const ControlOutput *output);
void       error_handler(ErrorCode code);

/* Internal processing functions */
float compute_elevator(int16_t pitch, float altitude, float target_alt);
float compute_aileron(int16_t roll);
float compute_throttle(uint16_t velocity, float target_vel);
float apply_filter(float input, float *history, uint16_t order);
float clamp(float value, float min, float max);

#endif /* DATA_PROCESSOR_H */
