*** Settings ***
Documentation    Matrix Robot Executor Demo Test Suite
Library          Collections

*** Variables ***
${MESSAGE}       Hello, Robot Framework!
${EXPECTED}      Hello, Robot Framework!
${NUMBER}        42

*** Test Cases ***
String Equality Test
    [Documentation]    Verify two strings are equal
    Should Be Equal    ${MESSAGE}    ${EXPECTED}

Arithmetic Addition Test
    [Documentation]    Verify basic addition
    ${result}=    Evaluate    20 + 22
    Should Be Equal As Numbers    ${result}    ${NUMBER}

List Contains Value Test
    [Documentation]    Verify list operations
    @{fruits}=    Create List    apple    banana    cherry
    List Should Contain Value    ${fruits}    banana

Intentional Failure Test
    [Documentation]    This test is designed to fail (for demo purposes)
    [Tags]    expected-fail
    Should Be Equal    actual_value    expected_value

Length Check Test
    [Documentation]    Verify string length
    ${length}=    Get Length    ${MESSAGE}
    Should Be True    ${length} > 10

*** Keywords ***
Create List
    [Arguments]    @{items}
    RETURN    ${items}
