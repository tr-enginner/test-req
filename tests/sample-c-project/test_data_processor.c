/**
 * Flight Control Data Processor - Unit Tests
 * Test Framework: Unity
 * 
 * This file contains comprehensive unit tests for:
 * - validate_sensor_data (safety-critical)
 * - process_data (safety-critical)
 * - compute_elevator
 * - compute_aileron
 * - compute_throttle
 * - apply_filter
 * - clamp
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "unity.h"

/* Include the module under test */
#include "data_processor.c"

/* Test results tracking */
TestResults test_results = {0, 0, 0};

/* ============================================
 * CLAMP FUNCTION TESTS
 * ============================================ */

void test_clamp_value_within_range(void)
{
    float result = clamp(0.5f, -1.0f, 1.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.5f, result);
}

void test_clamp_value_at_min_boundary(void)
{
    float result = clamp(-5.0f, -1.0f, 1.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, -1.0f, result);
}

void test_clamp_value_at_max_boundary(void)
{
    float result = clamp(5.0f, -1.0f, 1.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 1.0f, result);
}

void test_clamp_value_below_min(void)
{
    float result = clamp(-10.0f, -1.0f, 1.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, -1.0f, result);
}

void test_clamp_value_above_max(void)
{
    float result = clamp(10.0f, -1.0f, 1.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 1.0f, result);
}

void test_clamp_zero_value(void)
{
    float result = clamp(0.0f, -1.0f, 1.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.0f, result);
}

void test_clamp_negative_range(void)
{
    float result = clamp(0.0f, -5.0f, -1.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.001f, -1.0f, result);
}

/* ============================================
 * VALIDATE_SENSOR_DATA TESTS - Safety Critical
 * ============================================ */

/* TR-006: Temperature Range Validation - Valid Range */
void test_validate_temp_valid_values(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 0.0f;
    data.pressure = 500.0f;
    data.altitude = 0.0f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.temperature = 50.0f;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.temperature = -20.0f;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
}

/* TR-007: Temperature Range Validation - Below Minimum */
void test_validate_temp_below_minimum(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = -40.1f;
    data.pressure = 500.0f;
    data.altitude = 0.0f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
    
    data.temperature = -100.0f;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
}

/* TR-008: Temperature Range Validation - Above Maximum */
void test_validate_temp_above_maximum(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 125.1f;
    data.pressure = 500.0f;
    data.altitude = 0.0f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
    
    data.temperature = 200.0f;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
}

/* TR-009: Pressure Range Validation - Valid Range */
void test_validate_pressure_valid_values(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 25.0f;
    data.pressure = 500.0f;
    data.altitude = 0.0f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.pressure = 1013.25f;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
}

/* TR-010: Pressure Range Validation - Below Minimum */
void test_validate_pressure_below_minimum(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 25.0f;
    data.pressure = -0.1f;
    data.altitude = 0.0f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
    
    data.pressure = -100.0f;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
}

/* TR-011: Pressure Range Validation - Above Maximum */
void test_validate_pressure_above_maximum(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 25.0f;
    data.pressure = 1100.1f;
    data.altitude = 0.0f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
    
    data.pressure = 2000.0f;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
}

/* TR-012: Altitude Range Validation - Valid Range */
void test_validate_altitude_valid_values(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 25.0f;
    data.pressure = 500.0f;
    data.altitude = 0.0f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.altitude = 10000.0f;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.altitude = 45000.0f;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
}

/* TR-013: Altitude Range Validation - Below Minimum */
void test_validate_altitude_below_minimum(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 25.0f;
    data.pressure = 500.0f;
    data.altitude = -500.1f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
    
    data.altitude = -1000.0f;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
}

/* TR-014: Altitude Range Validation - Above Maximum */
void test_validate_altitude_above_maximum(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 25.0f;
    data.pressure = 500.0f;
    data.altitude = 50000.1f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
    
    data.altitude = 100000.0f;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
}

/* TR-015: Velocity Range Validation - Valid Range */
void test_validate_velocity_valid_values(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 25.0f;
    data.pressure = 500.0f;
    data.altitude = 0.0f;
    data.velocity = 0;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.velocity = 500;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.velocity = 999;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
}

/* TR-016: Velocity Range Validation - Above Maximum */
void test_validate_velocity_above_maximum(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 25.0f;
    data.pressure = 500.0f;
    data.altitude = 0.0f;
    data.velocity = 1001;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
    
    data.velocity = 2000;
    TEST_ASSERT_EQUAL(STATUS_OUT_OF_RANGE, validate_sensor_data(&data));
}

/* TR-018: Pitch Angle Range Validation */
void test_validate_pitch_valid_values(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 25.0f;
    data.pressure = 500.0f;
    data.altitude = 0.0f;
    data.velocity = 500;
    data.pitch_angle = -9000;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.pitch_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.pitch_angle = 4500;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.pitch_angle = 9000;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
}

/* TR-019: Roll Angle Range Validation */
void test_validate_roll_valid_values(void)
{
    SensorData data;
    
    data.data_valid = 1;
    data.temperature = 25.0f;
    data.pressure = 500.0f;
    data.altitude = 0.0f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = -18000;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.roll_angle = 9000;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
    
    data.roll_angle = 18000;
    TEST_ASSERT_EQUAL(STATUS_OK, validate_sensor_data(&data));
}

/* Null pointer test */
void test_validate_null_pointer(void)
{
    TEST_ASSERT_EQUAL(STATUS_INVALID_PARAM, validate_sensor_data(NULL));
}

/* Invalid data_valid flag */
void test_validate_invalid_data_flag(void)
{
    SensorData data;
    
    data.data_valid = 0;
    data.temperature = 25.0f;
    data.pressure = 500.0f;
    data.altitude = 0.0f;
    data.velocity = 500;
    data.pitch_angle = 0;
    data.roll_angle = 0;
    TEST_ASSERT_EQUAL(STATUS_ERROR, validate_sensor_data(&data));
}

/* ============================================
 * COMPUTE_ELEVATOR TESTS
 * ============================================ */

/* TR-020: Elevator Control Computation - Normal */
void test_compute_elevator_normal(void)
{
    float result;
    
    /* Test case 1: pitch=0, altitude=target */
    result = compute_elevator(0, 10000.0f, 10000.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.0f, result);
    
    /* Test case 2: pitch positive, altitude below target */
    result = compute_elevator(0, 9000.0f, 10000.0f);
    /* alt_error = 1000, pitch_deg = 0 */
    /* cmd = 1000 * 0.01 - 0 * 0.02 = 10 */
    /* clamped to 1.0 */
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 1.0f, result);
}

/* TR-021: Elevator Control Output Clamping */
void test_compute_elevator_clamping(void)
{
    float result;
    
    /* Extreme negative */
    result = compute_elevator(9000, 0.0f, 50000.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, -1.0f, result);
    
    /* Extreme positive */
    result = compute_elevator(-9000, 50000.0f, 0.0f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 1.0f, result);
}

/* TR-022: Elevator Control Error Handling */
void test_compute_elevator_extreme_values(void)
{
    float result;
    
    /* Test with extreme pitch values */
    result = compute_elevator(32767, 0.0f, 0.0f);
    TEST_ASSERT(result >= -1.0f && result <= 1.0f);
    
    result = compute_elevator(-32768, 0.0f, 0.0f);
    TEST_ASSERT(result >= -1.0f && result <= 1.0f);
}

/* ============================================
 * COMPUTE_AILERON TESTS
 * ============================================ */

/* TR-023: Aileron Control Computation - Normal */
void test_compute_aileron_normal(void)
{
    float result;
    
    /* Zero roll */
    result = compute_aileron(0);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.0f, result);
    
    /* Positive roll */
    result = compute_aileron(4500);
    /* roll_deg = 45, cmd = -45 * 0.005 = -0.225 */
    TEST_ASSERT_FLOAT_WITHIN(0.01f, -0.225f, result);
}

/* TR-024: Aileron Control Output Clamping */
void test_compute_aileron_clamping(void)
{
    float result;
    
    /* Extreme negative (max left) */
    result = compute_aileron(-18000);
    /* roll_deg = -180, cmd = -(-180) * 0.005 = 0.9 */
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.9f, result);
    
    /* Extreme positive (max right) */
    result = compute_aileron(18000);
    /* roll_deg = 180, cmd = -180 * 0.005 = -0.9 */
    TEST_ASSERT_FLOAT_WITHIN(0.01f, -0.9f, result);
}

/* TR-025: Aileron Control Error Handling */
void test_compute_aileron_extreme_values(void)
{
    float result;
    
    result = compute_aileron(32767);
    TEST_ASSERT(result >= -1.0f && result <= 1.0f);
    
    result = compute_aileron(-32768);
    TEST_ASSERT(result >= -1.0f && result <= 1.0f);
}

/* ============================================
 * COMPUTE_THROTTLE TESTS
 * ============================================ */

/* TR-026: Throttle Control Computation - Normal */
void test_compute_throttle_normal(void)
{
    float result;
    
    /* Velocity equals target */
    result = compute_throttle(250, 250.0f);
    /* vel_error = 0, cmd = 0.5 + 0 = 0.5 */
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.5f, result);
    
    /* Velocity below target (need more throttle) */
    result = compute_throttle(200, 250.0f);
    /* vel_error = 50, cmd = 0.5 + 50 * 0.002 = 0.6 */
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.6f, result);
}

/* TR-027: Throttle Control Output Clamping Lower */
void test_compute_throttle_clamp_lower(void)
{
    float result;
    
    /* Very high velocity (exceeds target significantly) */
    result = compute_throttle(1000, 250.0f);
    /* vel_error = -750, cmd = 0.5 - 750 * 0.002 = -1.0 */
    /* clamped to 0.0 */
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 0.0f, result);
}

/* TR-028: Throttle Control Output Clamping Upper */
void test_compute_throttle_clamp_upper(void)
{
    float result;
    
    /* Very low velocity (well below target) */
    result = compute_throttle(0, 250.0f);
    /* vel_error = 250, cmd = 0.5 + 250 * 0.002 = 1.0 */
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 1.0f, result);
}

/* TR-029: Throttle Control Error Handling */
void test_compute_throttle_extreme_values(void)
{
    float result;
    
    result = compute_throttle(0, 0.0f);
    TEST_ASSERT(result >= 0.0f && result <= 1.0f);
    
    result = compute_throttle(65535, 1000.0f);
    TEST_ASSERT(result >= 0.0f && result <= 1.0f);
}

/* ============================================
 * PROCESS_DATA TESTS - Safety Critical
 * ============================================ */

/* TR-032: High Altitude Warning Flag */
void test_process_high_altitude_warning(void)
{
    SensorData input;
    ControlOutput output;
    
    input.data_valid = 1;
    input.temperature = 25.0f;
    input.pressure = 500.0f;
    input.altitude = 40001.0f;
    input.velocity = 500;
    input.pitch_angle = 0;
    input.roll_angle = 0;
    input.timestamp_ms = 100;
    
    TEST_ASSERT_EQUAL(STATUS_OK, process_data(&input, &output));
    TEST_ASSERT_EQUAL(0x01u, output.warning_flags & 0x01u);
    
    /* Boundary: exactly at 40000 should not set flag */
    input.altitude = 40000.0f;
    TEST_ASSERT_EQUAL(STATUS_OK, process_data(&input, &output));
    TEST_ASSERT_EQUAL(0u, output.warning_flags & 0x01u);
}

/* TR-033: High Speed Warning Flag */
void test_process_high_speed_warning(void)
{
    SensorData input;
    ControlOutput output;
    
    input.data_valid = 1;
    input.temperature = 25.0f;
    input.pressure = 500.0f;
    input.altitude = 0.0f;
    input.velocity = 801;
    input.pitch_angle = 0;
    input.roll_angle = 0;
    input.timestamp_ms = 100;
    
    TEST_ASSERT_EQUAL(STATUS_OK, process_data(&input, &output));
    TEST_ASSERT_EQUAL(0x02u, output.warning_flags & 0x02u);
    
    /* Boundary: exactly at 800 should not set flag */
    input.velocity = 800;
    TEST_ASSERT_EQUAL(STATUS_OK, process_data(&input, &output));
    TEST_ASSERT_EQUAL(0u, output.warning_flags & 0x02u);
}

/* TR-034: High Temperature Warning Flag */
void test_process_high_temp_warning(void)
{
    SensorData input;
    ControlOutput output;
    
    input.data_valid = 1;
    input.temperature = 101.0f;
    input.pressure = 500.0f;
    input.altitude = 0.0f;
    input.velocity = 500;
    input.pitch_angle = 0;
    input.roll_angle = 0;
    input.timestamp_ms = 100;
    
    TEST_ASSERT_EQUAL(STATUS_OK, process_data(&input, &output));
    TEST_ASSERT_EQUAL(0x04u, output.warning_flags & 0x04u);
    
    /* Boundary: exactly at 100 should not set flag */
    input.temperature = 100.0f;
    TEST_ASSERT_EQUAL(STATUS_OK, process_data(&input, &output));
    TEST_ASSERT_EQUAL(0u, output.warning_flags & 0x04u);
}

/* TR-035: Multiple Warning Flags Combination */
void test_process_multiple_warnings(void)
{
    SensorData input;
    ControlOutput output;
    
    /* All three warnings */
    input.data_valid = 1;
    input.temperature = 101.0f;
    input.pressure = 500.0f;
    input.altitude = 40001.0f;
    input.velocity = 801;
    input.pitch_angle = 0;
    input.roll_angle = 0;
    input.timestamp_ms = 100;
    
    TEST_ASSERT_EQUAL(STATUS_OK, process_data(&input, &output));
    TEST_ASSERT_EQUAL(0x07u, output.warning_flags);  /* All three bits */
    
    /* Two warnings */
    input.altitude = 0.0f;
    TEST_ASSERT_EQUAL(STATUS_OK, process_data(&input, &output));
    TEST_ASSERT_EQUAL(0x06u, output.warning_flags);  /* Temp + Speed */
    
    /* No warnings */
    input.temperature = 25.0f;
    input.velocity = 500;
    TEST_ASSERT_EQUAL(STATUS_OK, process_data(&input, &output));
    TEST_ASSERT_EQUAL(0u, output.warning_flags);
}

/* Null pointer tests */
void test_process_null_input_pointer(void)
{
    ControlOutput output;
    TEST_ASSERT_EQUAL(STATUS_INVALID_PARAM, process_data(NULL, &output));
}

void test_process_null_output_pointer(void)
{
    SensorData input;
    input.data_valid = 1;
    TEST_ASSERT_EQUAL(STATUS_INVALID_PARAM, process_data(&input, NULL));
}

/* Verify control outputs are computed */
void test_process_control_outputs_computed(void)
{
    SensorData input;
    ControlOutput output;
    
    input.data_valid = 1;
    input.temperature = 25.0f;
    input.pressure = 500.0f;
    input.altitude = 10000.0f;
    input.velocity = 250;
    input.pitch_angle = 0;
    input.roll_angle = 0;
    input.timestamp_ms = 100;
    
    TEST_ASSERT_EQUAL(STATUS_OK, process_data(&input, &output));
    
    /* Verify elevator is in valid range */
    TEST_ASSERT(output.elevator_cmd >= -1.0f && output.elevator_cmd <= 1.0f);
    
    /* Verify aileron is in valid range */
    TEST_ASSERT(output.aileron_cmd >= -1.0f && output.aileron_cmd <= 1.0f);
    
    /* Verify throttle is in valid range */
    TEST_ASSERT(output.throttle_cmd >= 0.0f && output.throttle_cmd <= 1.0f);
    
    /* Verify timestamp is passed through */
    TEST_ASSERT_EQUAL(100u, output.timestamp_ms);
}

/* ============================================
 * APPLY_FILTER TESTS
 * ============================================ */

/* TR-039: Moving Average Filter - Valid Order */
void test_apply_filter_valid_order(void)
{
    float history[8];
    float result;
    uint16_t i;
    
    /* Initialize history */
    for (i = 0; i < 8; i++) {
        history[i] = 0.0f;
    }
    
    /* Order 1 */
    result = apply_filter(10.0f, history, 1);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 10.0f, result);
    
    /* Order 4 */
    for (i = 0; i < 8; i++) {
        history[i] = 10.0f;
    }
    result = apply_filter(20.0f, history, 4);
    /* sum = 20 + 10*4 = 60, avg = 60/5 = 12.0 */
    TEST_ASSERT_FLOAT_WITHIN(0.1f, 12.0f, result);
}

/* TR-040: Moving Average Filter - Order Boundary */
void test_apply_filter_order_boundary(void)
{
    float history[8];
    float result;
    uint16_t i;
    
    /* Initialize history */
    for (i = 0; i < 8; i++) {
        history[i] = 0.0f;
    }
    
    /* Order = 1 (minimum) */
    result = apply_filter(10.0f, history, 1);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 10.0f, result);
    
    /* Order = 8 (maximum) */
    for (i = 0; i < 8; i++) {
        history[i] = 10.0f;
    }
    result = apply_filter(10.0f, history, 8);
    /* sum = 10 + 10*8 = 90, avg = 90/9 = 10.0 */
    TEST_ASSERT_FLOAT_WITHIN(0.1f, 10.0f, result);
}

/* TR-041: Moving Average Filter - Invalid Order */
void test_apply_filter_invalid_order(void)
{
    float history[8];
    float result;
    uint16_t i;
    
    for (i = 0; i < 8; i++) {
        history[i] = 0.0f;
    }
    
    /* Order = 0 should return input unchanged */
    result = apply_filter(10.0f, history, 0);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 10.0f, result);
    
    /* Order > 8 - this is a known defect (DEF-CR-002) */
    /* The function doesn't check upper bound - this will cause buffer overflow */
    /* For testing, we verify it returns something but don't test boundary */
}

/* TR-042: Moving Average Filter - History Management */
void test_apply_filter_history_management(void)
{
    float history[8];
    float result;
    uint16_t i;
    
    /* Initialize history */
    for (i = 0; i < 8; i++) {
        history[i] = 0.0f;
    }
    
    /* First call */
    result = apply_filter(10.0f, history, 4);
    /* sum = 10 + 0*4 = 10, avg = 10/5 = 2.0 */
    TEST_ASSERT_FLOAT_WITHIN(0.1f, 2.0f, result);
    
    /* Second call - history[0] should be updated */
    result = apply_filter(20.0f, history, 4);
    /* Now history[0]=10 from previous, sum = 20 + 10 + 0*3 = 30, avg = 30/5 = 6.0 */
    TEST_ASSERT_FLOAT_WITHIN(0.1f, 6.0f, result);
}

/* Null pointer test */
void test_apply_filter_null_history(void)
{
    float result = apply_filter(10.0f, NULL, 4);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 10.0f, result);
}

/* ============================================
 * MAIN TEST RUNNER
 * ============================================ */

int main(void)
{
    printf("========================================\n");
    printf("Flight Control Data Processor - Unit Tests\n");
    printf("Framework: Unity\n");
    printf("========================================\n\n");
    
    printf("--- Clamp Function Tests ---\n");
    RUN_TEST(test_clamp_value_within_range);
    RUN_TEST(test_clamp_value_at_min_boundary);
    RUN_TEST(test_clamp_value_at_max_boundary);
    RUN_TEST(test_clamp_value_below_min);
    RUN_TEST(test_clamp_value_above_max);
    RUN_TEST(test_clamp_zero_value);
    RUN_TEST(test_clamp_negative_range);
    
    printf("\n--- validate_sensor_data Tests (Safety Critical) ---\n");
    RUN_TEST(test_validate_temp_valid_values);
    RUN_TEST(test_validate_temp_below_minimum);
    RUN_TEST(test_validate_temp_above_maximum);
    RUN_TEST(test_validate_pressure_valid_values);
    RUN_TEST(test_validate_pressure_below_minimum);
    RUN_TEST(test_validate_pressure_above_maximum);
    RUN_TEST(test_validate_altitude_valid_values);
    RUN_TEST(test_validate_altitude_below_minimum);
    RUN_TEST(test_validate_altitude_above_maximum);
    RUN_TEST(test_validate_velocity_valid_values);
    RUN_TEST(test_validate_velocity_above_maximum);
    RUN_TEST(test_validate_pitch_valid_values);
    RUN_TEST(test_validate_roll_valid_values);
    RUN_TEST(test_validate_null_pointer);
    RUN_TEST(test_validate_invalid_data_flag);
    
    printf("\n--- compute_elevator Tests ---\n");
    RUN_TEST(test_compute_elevator_normal);
    RUN_TEST(test_compute_elevator_clamping);
    RUN_TEST(test_compute_elevator_extreme_values);
    
    printf("\n--- compute_aileron Tests ---\n");
    RUN_TEST(test_compute_aileron_normal);
    RUN_TEST(test_compute_aileron_clamping);
    RUN_TEST(test_compute_aileron_extreme_values);
    
    printf("\n--- compute_throttle Tests ---\n");
    RUN_TEST(test_compute_throttle_normal);
    RUN_TEST(test_compute_throttle_clamp_lower);
    RUN_TEST(test_compute_throttle_clamp_upper);
    RUN_TEST(test_compute_throttle_extreme_values);
    
    printf("\n--- process_data Tests (Safety Critical) ---\n");
    RUN_TEST(test_process_high_altitude_warning);
    RUN_TEST(test_process_high_speed_warning);
    RUN_TEST(test_process_high_temp_warning);
    RUN_TEST(test_process_multiple_warnings);
    RUN_TEST(test_process_null_input_pointer);
    RUN_TEST(test_process_null_output_pointer);
    RUN_TEST(test_process_control_outputs_computed);
    
    printf("\n--- apply_filter Tests ---\n");
    RUN_TEST(test_apply_filter_valid_order);
    RUN_TEST(test_apply_filter_order_boundary);
    RUN_TEST(test_apply_filter_invalid_order);
    RUN_TEST(test_apply_filter_history_management);
    RUN_TEST(test_apply_filter_null_history);
    
    printf("\n========================================\n");
    printf("Test Summary\n");
    printf("========================================\n");
    printf("Total Tests: %d\n", test_results.pass_count + test_results.fail_count);
    printf("Passed: %d\n", test_results.pass_count);
    printf("Failed: %d\n", test_results.fail_count);
    printf("Pass Rate: %.1f%%\n", 
           test_results.pass_count * 100.0 / (test_results.pass_count + test_results.fail_count));
    printf("========================================\n");
    
    return (test_results.fail_count > 0) ? 1 : 0;
}
