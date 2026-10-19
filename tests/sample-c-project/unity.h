/** 
 * Unity Test Framework for Flight Control Data Processor
 * Includes Unity framework and test cases
 */

#ifndef UNITY_H
#define UNITY_H

#include <stdint.h>
#include <stdbool.h>
#include <float.h>

/* Unity framework definitions */
typedef struct {
    const char *test;
    const char *file;
    unsigned int line;
    bool failed;
} Unity_t;

extern Unity_t Unity;

/* Unity macros */
#define TEST_FAIL_MESSAGE(msg) do { \
    Unity.failed = true; \
    Unity.test = __func__; \
    Unity.file = __FILE__; \
    Unity.line = __LINE__; \
} while(0)

#define TEST_FAIL() TEST_FAIL_MESSAGE("Test failed")

#define TEST_ASSERT(condition) do { \
    if (!(condition)) { \
        TEST_FAIL_MESSAGE("Assertion failed: " #condition); \
    } \
} while(0)

#define TEST_ASSERT_TRUE(condition) TEST_ASSERT(condition)
#define TEST_ASSERT_FALSE(condition) TEST_ASSERT(!(condition))
#define TEST_ASSERT_EQUAL(expected, actual) TEST_ASSERT((expected) == (actual))
#define TEST_ASSERT_EQUAL_INT(expected, actual) TEST_ASSERT((expected) == (actual))
#define TEST_ASSERT_EQUAL_FLOAT(expected, actual, epsilon) TEST_ASSERT(((expected) - (actual)) < epsilon && ((expected) - (actual)) > -epsilon)
#define TEST_ASSERT_NOT_EQUAL(expected, actual) TEST_ASSERT((expected) != (actual))
#define TEST_ASSERT_GREATER_THAN(threshold, actual) TEST_ASSERT((actual) > (threshold))
#define TEST_ASSERT_LESS_THAN(threshold, actual) TEST_ASSERT((actual) < (threshold))
#define TEST_ASSERT_FLOAT_WITHIN(delta, expected, actual) TEST_ASSERT(((expected) - (delta) <= (actual)) && ((actual) <= (expected) + (delta)))

#define UNITY_BEGIN() 
#define UNITY_END()

/* Test runner macros */
#define RUN_TEST(func) do { \
    printf("Running %s...\n", #func); \
    Unity.failed = false; \
    func(); \
    if (Unity.failed) { \
        printf("FAIL: %s (%s:%d)\n", #func, __FILE__, __LINE__); \
        test_results.fail_count++; \
    } else { \
        printf("PASS: %s\n", #func); \
        test_results.pass_count++; \
    } \
} while(0)

/* Global test results */
typedef struct {
    int pass_count;
    int fail_count;
    int skip_count;
} TestResults;

extern TestResults test_results;

#endif /* UNITY_H */
