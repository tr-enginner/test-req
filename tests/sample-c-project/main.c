/**
 * Sample Embedded C Project — Flight Control Data Processor
 *
 * This is a simplified example of an embedded software module
 * for testing the Matrix agent system.
 */

#include "data_processor.h"
#include "interface.h"

/* Global state */
static SystemState g_system_state = STATE_INIT;

int main(void)
{
    SystemConfig config;
    SensorData sensor_input;
    ControlOutput control_output;

    /* Initialize system */
    if (system_init(&config) != STATUS_OK) {
        error_handler(ERR_INIT_FAILED);
        return -1;
    }

    g_system_state = STATE_RUNNING;

    /* Main processing loop */
    while (g_system_state == STATE_RUNNING) {
        /* Read sensor data */
        if (read_sensor_data(&sensor_input) != STATUS_OK) {
            error_handler(ERR_SENSOR_READ);
            continue;
        }

        /* Validate input data */
        if (validate_sensor_data(&sensor_input) != STATUS_OK) {
            error_handler(ERR_DATA_INVALID);
            continue;
        }

        /* Process data */
        if (process_data(&sensor_input, &control_output) != STATUS_OK) {
            error_handler(ERR_PROCESS_FAILED);
            continue;
        }

        /* Output control commands */
        if (send_control_output(&control_output) != STATUS_OK) {
            error_handler(ERR_OUTPUT_FAILED);
        }
    }

    system_shutdown();
    return 0;
}
