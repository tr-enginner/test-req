# Robot Rendering

## Output Directory

Write final `.robot` files to:

- `.matrix/data/DTPProject/V1/测试用例`

Create the directory if it does not already exist.

## File Naming

Generate one `.robot` file per case.

Prefer:

- `{case_id}.robot`

If the case id is missing, fall back to a sanitized case name.

## VTE Handling

Locate `.vte` by scanning the runtime directory first:

- `.matrix/data/DTPProject/V1`

If no `.vte` is found there, optionally scan the DTP root.

If still missing:

- use the fallback placeholder path
- record a warning in the result JSON

## Step Rendering

Use upstream `keyword_name` and resolved arguments directly.

Do not:

- change the keyword name
- reorder business arguments unless the upstream contract explicitly requires it
- infer new arguments

If a step was downgraded because the keyword could not be validated:

- render it as a description-style step
- keep the case inspectable

## Path Formatting

All Robot-facing paths must use double backslashes.

Examples:

```robotframework
Resource    组合关键字\\VTest.txt
发送CANA数据_数据文件  1.1  1  输入数据\\公共需求工程\\典型用例\\CAN\\测试指令\\速变遥测轮询\\速变遥测轮询.txt  1
```

## Warning Handling

Warnings belong in the robot-generation result JSON.

Do not write warning comments into the `.robot` file body.
