# Software Requirements — Temperature Monitor & Alarm Controller

## SRS-001: Temperature Acquisition
The system shall read the ADC temperature sensor every 100ms via hardware timer interrupt.

Priority: high

## SRS-002: Moving Average Filter
The system shall apply a moving average filter (window size 8) to the raw ADC readings before further processing.

Priority: high

## SRS-003: Alarm State Machine
The system shall maintain a three-state alarm model:
- NORMAL: temperature below 75.00 C
- WARNING: temperature between 75.00 C and 85.00 C
- ALARM: temperature at or above 85.00 C

State transitions shall use 2.00 C hysteresis to prevent oscillation at thresholds.

Priority: critical

## SRS-004: Relay Control
The system shall activate the relay output when in ALARM state, and deactivate it in NORMAL or WARNING state.

Priority: critical

## SRS-005: LED Indication
The system shall control the status LED:
- NORMAL: LED off
- WARNING: LED blinking
- ALARM: LED on (steady)

Priority: medium

## SRS-006: Interrupt Safety
All variables shared between the ISR and main loop shall be accessed in a data-race-free manner.

Priority: critical
