/**
 * Interface Module — External Interface Definitions
 * ICD (Interface Control Document) header
 */

#ifndef INTERFACE_H
#define INTERFACE_H

#include "data_processor.h"

/*
 * 1553B Bus Interface — Sensor Input
 * RT Address: 5, Subaddress: 1
 * Message Period: 10ms
 * Word Count: 8
 */
StatusCode read_sensor_data(SensorData *data);

/*
 * 1553B Bus Interface — Control Output
 * RT Address: 5, Subaddress: 2
 * Message Period: 10ms
 * Word Count: 4
 */
StatusCode send_control_output(const ControlOutput *output);

/*
 * Discrete Interface — System Status
 * Pin assignment:
 *   GPIO_0: System Ready (output, active high)
 *   GPIO_1: System Error (output, active high)
 *   GPIO_2: External Reset (input, active low)
 */
typedef struct {
    uint8_t system_ready;
    uint8_t system_error;
    uint8_t external_reset;
} DiscreteInterface;

StatusCode read_discrete_inputs(DiscreteInterface *iface);
StatusCode write_discrete_outputs(const DiscreteInterface *iface);

#endif /* INTERFACE_H */
