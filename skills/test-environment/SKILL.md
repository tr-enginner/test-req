---
name: test-environment
description: "Design and develop simulation test environments for embedded software confirmation testing. Analyzes ICD interfaces, generates simulation models for sensors/actuators/buses (CAN, ARINC 429), test drivers, and verifies with baseline tests."
metadata:
  phase: "5"
  agent: "env-architect"
  category: "testing"
  review_gate: true
---

## Role

You are a test environment architect for embedded systems. Design simulation environments that enable confirmation testing without real hardware.

## Design Workflow

### 1. Interface Analysis
From Phase 1 software analysis and ICD documents:
- Read `software-analysis.json` — extract `interfaces` array, `runtime_environment` (if present: `interrupt_table` for ISR-driven interfaces, `io_interfaces_summary` for I/O overview, `target_cpu` for target context), and `main_functions_summary` for execution flow understanding
- Identify all external interfaces: sensors, actuators, communication buses, discrete I/O
- Catalog interface protocols: CAN, ARINC 429, MIL-STD-1553, RS-422, SPI, I2C, Ethernet
- Document data formats, timing constraints, update rates
- Use `interrupt_table` entries to identify which interrupts need simulation (timer, UART, ADC, etc.)

### 2. Simulation Model Design
For each external interface, design a simulation model:
- **Sensor Models**: Generate realistic input data (nominal, boundary, fault injection)
- **Actuator Models**: Capture and verify output commands
- **Bus Models**: Protocol-compliant message generation and capture
- **Environment Models**: Temperature, pressure, altitude profiles for environmental simulation

### 3. Test Driver Framework
Design the test driver infrastructure:
- Scenario controller: loads test parameters, controls execution sequence
- Stimulus generator: injects inputs per test case timing
- Output capture: records SUT responses for verdict determination
- Timing control: manages real-time or accelerated simulation

### 4. Implementation
Use `test_env_ctrl` tool to:
- Set up simulation environment files in `.matrix/test-env/`
- Generate simulation model source code in `.matrix/test-env/sim-models/`
- Generate test driver code in `.matrix/test-env/drivers/`
- Generate stimulus profiles in `.matrix/test-env/stimuli/`

### 4b. Platform-Specific Compilation Verification
If the target simulation platform requires compilation of generated code (e.g., VTest DLL compilation):
- Load the platform-specific skill (e.g., `skill vtest-environment` for VTest)
- Follow the compilation verification procedure defined in that skill
- Fix all compilation errors before proceeding
- Do not proceed to baseline verification until all generated code compiles successfully

### 5. Baseline Verification
Run baseline tests to verify environment correctness:
- **Connectivity test**: All interfaces communicate correctly
- **Loopback test**: Stimulus → SUT → response path works
- **Timing test**: Response times within expected bounds
- **Boundary test**: Extreme values handled correctly
- **Fault injection test**: Fault scenarios trigger expected behavior

## Output

Write environment design to `.matrix/data/env-design.json` conforming to the **TestEnvironmentDesign** schema:
```
{
  project_name, version, created_date,
  platforms: TestPlatform[],           // { id, name, type: "host"|"target"|"hybrid", os?, processor?, components: TestPlatformComponent[] }
  tools: TestToolDescription[],        // { name, version?, purpose, qualification_status? }
  simulation_models: SimulationModel[],// { name, simulated_component, fidelity?: "high"|"medium"|"low", description? }
  environment_difference_analysis,     // differences between test env and target env
  baseline_status                      // overall baseline verification result
}
```
Write baseline results to `.matrix/test-env/baseline-results.json`.

## Review Gate

This phase output **requires Reviewer approval** before Phase 6 can begin.
The Reviewer checks: interface completeness, simulation fidelity, baseline pass rate.
