Unicode True

; =============================================================================
; Matrix Embedded Agent — NSIS 3.x Installer Script (MUI2)
; =============================================================================
; Build-time defines (passed via makensis -D flags):
;   PRODUCT_VERSION  — semver string, e.g. "0.1.0"
;   STAGING_DIR      — absolute path to staged offline files
;   OUTFILE          — output exe filename (optional override)
; =============================================================================

; ---------------------------------------------------------------------------
; Build-time defaults (overridable with -D on the makensis command line)
; ---------------------------------------------------------------------------
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.0.0-dev"
!endif

!ifndef OUTFILE
  !define OUTFILE "matrix-offline-v${PRODUCT_VERSION}-windows-x64.exe"
!endif

; ---------------------------------------------------------------------------
; Constants
; ---------------------------------------------------------------------------
!define PRODUCT_NAME      "Matrix Embedded Agent"
!define PRODUCT_PUBLISHER  "Matrix Team"
!define INSTALL_REG_KEY   "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

; ---------------------------------------------------------------------------
; Required includes
; ---------------------------------------------------------------------------
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "WordFunc.nsh"

; ---------------------------------------------------------------------------
; General settings
; ---------------------------------------------------------------------------
SetCompressor lzma
Name        "${PRODUCT_NAME} ${PRODUCT_VERSION}"
OutFile     "${OUTFILE}"
InstallDir  "C:\Matrix"
RequestExecutionLevel admin

; ---------------------------------------------------------------------------
; MUI settings
; ---------------------------------------------------------------------------
!define MUI_ICON                       "matrix-icon.ico"
!define MUI_UNICON                     "matrix-icon.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP         "matrix-banner.bmp"
!define MUI_ABORTWARNING

; ---------------------------------------------------------------------------
; Variables — LLM config custom page
; ---------------------------------------------------------------------------
Var LlmBaseUrl
Var LlmModel
Var LlmApiKey
Var LlmContextSize
Var LlmOutputSize
Var HwndLlmBaseUrl
Var HwndLlmModel
Var HwndLlmApiKey
Var HwndLlmContextSize
Var HwndLlmOutputSize

; ---------------------------------------------------------------------------
; Pages — Installer
; ---------------------------------------------------------------------------
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "license.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
Page custom LlmConfigPageCreate LlmConfigPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

; ---------------------------------------------------------------------------
; Pages — Uninstaller
; ---------------------------------------------------------------------------
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; ---------------------------------------------------------------------------
; Languages
; ---------------------------------------------------------------------------
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

; =============================================================================
; Custom page: LLM service configuration
; =============================================================================
Function LlmConfigPageCreate
  !insertmacro MUI_HEADER_TEXT "LLM 服务配置" "配置私有化大模型的连接信息"

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ; --- API Base URL ---
  ${NSD_CreateLabel} 0 0 100% 12u "API 地址 (例: http://llm.internal:8000/v1)"
  Pop $0
  ${NSD_CreateText} 0 14u 100% 12u "$LlmBaseUrl"
  Pop $HwndLlmBaseUrl

  ; --- Model name ---
  ${NSD_CreateLabel} 0 36u 100% 12u "模型名称 (例: qwen2.5-72b-instruct)"
  Pop $0
  ${NSD_CreateText} 0 50u 100% 12u "$LlmModel"
  Pop $HwndLlmModel

  ; --- API Key ---
  ${NSD_CreateLabel} 0 72u 100% 12u "API Key (可选，留空则不设置)"
  Pop $0
  ${NSD_CreateText} 0 86u 100% 12u "$LlmApiKey"
  Pop $HwndLlmApiKey

  ; --- Context window size ---
  ${NSD_CreateLabel} 0 108u 60% 12u "上下文窗口大小 (tokens)"
  Pop $0
  ${NSD_CreateText} 0 122u 40% 12u "$LlmContextSize"
  Pop $HwndLlmContextSize

  ; --- Output size ---
  ${NSD_CreateLabel} 0 144u 60% 12u "最大输出长度 (tokens)"
  Pop $0
  ${NSD_CreateText} 0 158u 40% 12u "$LlmOutputSize"
  Pop $HwndLlmOutputSize

  nsDialogs::Show
FunctionEnd

Function LlmConfigPageLeave
  ${NSD_GetText} $HwndLlmBaseUrl $LlmBaseUrl
  ${NSD_GetText} $HwndLlmModel  $LlmModel
  ${NSD_GetText} $HwndLlmApiKey $LlmApiKey
  ${NSD_GetText} $HwndLlmContextSize $LlmContextSize
  ${NSD_GetText} $HwndLlmOutputSize  $LlmOutputSize

  ; Validate: base URL must not be empty
  ${If} $LlmBaseUrl == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "API 地址不能为空，请填写 LLM 服务的 Base URL。"
    Abort
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; .onInit — set default values for LLM config variables
; ---------------------------------------------------------------------------
Function .onInit
  StrCpy $LlmBaseUrl     "http://localhost:8000/v1"
  StrCpy $LlmModel       "qwen2.5-72b-instruct"
  StrCpy $LlmApiKey       ""
  StrCpy $LlmContextSize "131072"
  StrCpy $LlmOutputSize  "16384"
FunctionEnd

; =============================================================================
; Installer Sections
; =============================================================================

; ---------------------------------------------------------------------------
; Core (required)
; ---------------------------------------------------------------------------
Section "Matrix 核心" SecCore
  SectionIn RO

  ; --- Runtime ---
  SetOutPath "$INSTDIR\runtime"
  File /r "${STAGING_DIR}\runtime\*.*"

  ; --- Plugin ---
  SetOutPath "$INSTDIR\plugin"
  File /r "${STAGING_DIR}\plugin\*.*"

  ; --- Register plugin with OpenCode ---
  ; OpenCode Desktop/current OpenCode builds auto-load local JS plugins from
  ; plugins/ (plural). Mirror to plugin/ (singular) for older TUI builds.
  ; Write both the documented ~/.config/opencode tree and the Windows roaming
  ; app-data tree so Desktop sidecar processes that resolve config through
  ; %APPDATA% can see the same Matrix plugin.
  CreateDirectory "$PROFILE\.config\opencode\plugin"
  CreateDirectory "$PROFILE\.config\opencode\plugins"
  CreateDirectory "$PROFILE\.config\opencode\skills"
  CreateDirectory "$PROFILE\.config\opencode\templates"
  CreateDirectory "$PROFILE\.config\opencode\standards"
  CreateDirectory "$PROFILE\.config\opencode\bin"
  CreateDirectory "$PROFILE\.config\opencode\joern"
  CreateDirectory "$PROFILE\.config\opencode\node_modules"
  CreateDirectory "$APPDATA\opencode\plugin"
  CreateDirectory "$APPDATA\opencode\plugins"
  CreateDirectory "$APPDATA\opencode\skills"
  CreateDirectory "$APPDATA\opencode\templates"
  CreateDirectory "$APPDATA\opencode\standards"
  CreateDirectory "$APPDATA\opencode\bin"
  CreateDirectory "$APPDATA\opencode\joern"
  CreateDirectory "$APPDATA\opencode\node_modules"

  ; Copy compiled plugin JS to OpenCode local plugin dirs.
  CopyFiles /SILENT "$INSTDIR\plugin\dist\index.js" "$PROFILE\.config\opencode\plugins\matrix.js"
  CopyFiles /SILENT "$INSTDIR\plugin\dist\index.js" "$PROFILE\.config\opencode\plugin\matrix.js"
  CopyFiles /SILENT "$INSTDIR\plugin\dist\index.js" "$APPDATA\opencode\plugins\matrix.js"
  CopyFiles /SILENT "$INSTDIR\plugin\dist\index.js" "$APPDATA\opencode\plugin\matrix.js"
  FileOpen  $0 "$PROFILE\.config\opencode\plugins\package.json" w
  FileWrite $0 '{$\n'
  FileWrite $0 '  "type": "module"$\n'
  FileWrite $0 '}$\n'
  FileClose $0
  FileOpen  $0 "$PROFILE\.config\opencode\plugin\package.json" w
  FileWrite $0 '{$\n'
  FileWrite $0 '  "type": "module"$\n'
  FileWrite $0 '}$\n'
  FileClose $0
  FileOpen  $0 "$APPDATA\opencode\plugins\package.json" w
  FileWrite $0 '{$\n'
  FileWrite $0 '  "type": "module"$\n'
  FileWrite $0 '}$\n'
  FileClose $0
  FileOpen  $0 "$APPDATA\opencode\plugin\package.json" w
  FileWrite $0 '{$\n'
  FileWrite $0 '  "type": "module"$\n'
  FileWrite $0 '}$\n'
  FileClose $0

  ; Copy runtime assets next to each plugin root. Runtime asset resolution uses
  ; the parent directory of plugin(s)/matrix.js.
  CopyFiles /SILENT "$INSTDIR\plugin\skills\*.*" "$PROFILE\.config\opencode\skills"
  CopyFiles /SILENT "$INSTDIR\plugin\skills\*.*" "$APPDATA\opencode\skills"
  CopyFiles /SILENT "$INSTDIR\plugin\templates\*.*" "$PROFILE\.config\opencode\templates"
  CopyFiles /SILENT "$INSTDIR\plugin\templates\*.*" "$APPDATA\opencode\templates"
  CopyFiles /SILENT "$INSTDIR\plugin\standards\*.*" "$PROFILE\.config\opencode\standards"
  CopyFiles /SILENT "$INSTDIR\plugin\standards\*.*" "$APPDATA\opencode\standards"
  CopyFiles /SILENT "$INSTDIR\plugin\bin\*.*" "$PROFILE\.config\opencode\bin"
  CopyFiles /SILENT "$INSTDIR\plugin\bin\*.*" "$APPDATA\opencode\bin"
  CopyFiles /SILENT "$INSTDIR\plugin\joern\*.*" "$PROFILE\.config\opencode\joern"
  CopyFiles /SILENT "$INSTDIR\plugin\joern\*.*" "$APPDATA\opencode\joern"
  ; Keep package assets resolvable from matrix.js. Tree-sitter loads WASM files
  ; through import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm") and
  ; @repomix/tree-sitter-wasms, so node_modules must exist beside the local
  ; plugin root, not only under $INSTDIR\plugin.
  CopyFiles /SILENT "$INSTDIR\plugin\node_modules\*.*" "$PROFILE\.config\opencode\node_modules"
  CopyFiles /SILENT "$INSTDIR\plugin\node_modules\*.*" "$APPDATA\opencode\node_modules"

  ; --- Ensure ripgrep is available for OpenCode's grep/glob tools ---
  ; OpenCode looks for rg.exe in XDG_DATA_HOME/opencode/bin/ before trying
  ; to download from GitHub (which fails on offline machines).
  ; rg.exe is bundled in runtime/ by pack-offline.ts; copy it to both:
  ;   1. ~/.local/share/opencode/bin/ (XDG data dir, OpenCode core lookup)
  ;   2. runtime/ is already on PATH (oh-my-opencode lookup via Bun.which)
  ${If} ${FileExists} "$INSTDIR\runtime\rg.exe"
    CreateDirectory "$PROFILE\.local\share\opencode\bin"
    CopyFiles /SILENT "$INSTDIR\runtime\rg.exe" "$PROFILE\.local\share\opencode\bin\rg.exe"
  ${EndIf}

  ; --- Generate opencode.json ---
  ; Local JS plugins are loaded from plugins/ above. Do not put ./plugins/matrix.js
  ; into the "plugin" field: current OpenCode interprets that field as npm
  ; plugin packages, which can make Desktop skip the local Matrix plugin.
  SetOutPath "$PROFILE\.config\opencode"
  FileOpen  $0 "$PROFILE\.config\opencode\opencode.json" w
  FileWrite $0 '{$\n'
  FileWrite $0 '  "$$schema": "https://opencode.ai/config.json",$\n'
  FileWrite $0 '  "autoupdate": false,$\n'
  FileWrite $0 '  "default_agent": "conductor",$\n'
  FileWrite $0 '  "model": "private-llm/$LlmModel",$\n'
  FileWrite $0 '  "provider": {$\n'
  FileWrite $0 '    "private-llm": {$\n'
  FileWrite $0 '      "npm": "@ai-sdk/openai-compatible",$\n'
  FileWrite $0 '      "name": "私有大模型",$\n'
  FileWrite $0 '      "options": {$\n'
  FileWrite $0 '        "baseURL": "$LlmBaseUrl",$\n'
  FileWrite $0 '        "apiKey": "$LlmApiKey"$\n'
  FileWrite $0 '      },$\n'
  FileWrite $0 '      "models": {$\n'
  FileWrite $0 '        "$LlmModel": {$\n'
  FileWrite $0 '          "name": "$LlmModel",$\n'
  FileWrite $0 '          "tool_call": true,$\n'
  FileWrite $0 '          "limit": {$\n'
  FileWrite $0 '            "context": $LlmContextSize,$\n'
  FileWrite $0 '            "output": $LlmOutputSize$\n'
  FileWrite $0 '          }$\n'
  FileWrite $0 '        }$\n'
  FileWrite $0 '      }$\n'
  FileWrite $0 '    }$\n'
  FileWrite $0 '  }$\n'
  FileWrite $0 '}$\n'
  FileClose $0

  SetOutPath "$APPDATA\opencode"
  FileOpen  $0 "$APPDATA\opencode\opencode.json" w
  FileWrite $0 '{$\n'
  FileWrite $0 '  "$$schema": "https://opencode.ai/config.json",$\n'
  FileWrite $0 '  "autoupdate": false,$\n'
  FileWrite $0 '  "default_agent": "conductor",$\n'
  FileWrite $0 '  "model": "private-llm/$LlmModel",$\n'
  FileWrite $0 '  "provider": {$\n'
  FileWrite $0 '    "private-llm": {$\n'
  FileWrite $0 '      "npm": "@ai-sdk/openai-compatible",$\n'
  FileWrite $0 '      "name": "私有大模型",$\n'
  FileWrite $0 '      "options": {$\n'
  FileWrite $0 '        "baseURL": "$LlmBaseUrl",$\n'
  FileWrite $0 '        "apiKey": "$LlmApiKey"$\n'
  FileWrite $0 '      },$\n'
  FileWrite $0 '      "models": {$\n'
  FileWrite $0 '        "$LlmModel": {$\n'
  FileWrite $0 '          "name": "$LlmModel",$\n'
  FileWrite $0 '          "tool_call": true,$\n'
  FileWrite $0 '          "limit": {$\n'
  FileWrite $0 '            "context": $LlmContextSize,$\n'
  FileWrite $0 '            "output": $LlmOutputSize$\n'
  FileWrite $0 '          }$\n'
  FileWrite $0 '        }$\n'
  FileWrite $0 '      }$\n'
  FileWrite $0 '    }$\n'
  FileWrite $0 '  }$\n'
  FileWrite $0 '}$\n'
  FileClose $0

  ; --- Add runtime to system PATH (via registry, no EnVar plugin needed) ---
  ; Put Matrix runtime first so opencode.exe wins over stale npm/global
  ; opencode.cmd wrappers that may exist elsewhere on the machine.
  ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ${WordReplace} $1 ";$INSTDIR\runtime" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\runtime;" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\runtime"  "" "+" $1
  ${If} $1 != ""
    StrCpy $1 "$INSTDIR\runtime;$1"
  ${Else}
    StrCpy $1 "$INSTDIR\runtime"
  ${EndIf}
  WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" $1

  ${If} ${FileExists} "$INSTDIR\runtime\python\python.exe"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "MATRIX_PYTHON" "$INSTDIR\runtime\python\python.exe"
  ${ElseIf} ${FileExists} "$INSTDIR\runtime\python\Scripts\python.exe"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "MATRIX_PYTHON" "$INSTDIR\runtime\python\Scripts\python.exe"
  ${EndIf}



  ; Note: WM_SETTINGCHANGE is sent by the desktop shortcut section (last section)

  ; --- Write uninstaller ---
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; --- Add/Remove Programs registry entries ---
  WriteRegStr   HKLM "${INSTALL_REG_KEY}" "DisplayName"     "${PRODUCT_NAME}"
  WriteRegStr   HKLM "${INSTALL_REG_KEY}" "DisplayVersion"  "${PRODUCT_VERSION}"
  WriteRegStr   HKLM "${INSTALL_REG_KEY}" "Publisher"        "${PRODUCT_PUBLISHER}"
  WriteRegStr   HKLM "${INSTALL_REG_KEY}" "UninstallString"  "$INSTDIR\uninstall.exe"
  WriteRegStr   HKLM "${INSTALL_REG_KEY}" "InstallLocation"  "$INSTDIR"
  WriteRegDWORD HKLM "${INSTALL_REG_KEY}" "NoModify"  1
  WriteRegDWORD HKLM "${INSTALL_REG_KEY}" "NoRepair"  1

  ; Compute installed size
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${INSTALL_REG_KEY}" "EstimatedSize" $0
SectionEnd

; ---------------------------------------------------------------------------
; Optional: SpecChecker
; ---------------------------------------------------------------------------
Section "SpecChecker 静态分析工具" SecSpecChecker
  ${If} ${FileExists} "$EXEDIR\tools\specchecker\*.*"
    SetOutPath "$INSTDIR\tools\specchecker"
    CopyFiles /SILENT "$EXEDIR\tools\specchecker\*.*" "$INSTDIR\tools\specchecker"
    ; Register SPECCHECKER_HOME environment variable
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "SPECCHECKER_HOME" "$INSTDIR\tools\specchecker"
    ; Add to PATH
    ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
    StrCpy $1 "$1;$INSTDIR\tools\specchecker"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" $1
  ${Else}
    MessageBox MB_OK|MB_ICONINFORMATION "未找到 SpecChecker 文件。$\n请确认 tools\specchecker\ 目录与安装程序在同一目录下。"
  ${EndIf}
SectionEnd

; ---------------------------------------------------------------------------
; Optional: AUnit
; ---------------------------------------------------------------------------
Section "SunwiseAUnit 单元测试框架" SecAUnit
  ${If} ${FileExists} "$EXEDIR\tools\aunit\*.*"
    SetOutPath "$INSTDIR\tools\aunit"
    CopyFiles /SILENT "$EXEDIR\tools\aunit\*.*" "$INSTDIR\tools\aunit"
    ; Register AUNIT_HOME environment variable
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "AUNIT_HOME" "$INSTDIR\tools\aunit"
    ; Add to PATH
    ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
    StrCpy $1 "$1;$INSTDIR\tools\aunit"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" $1
  ${Else}
    MessageBox MB_OK|MB_ICONINFORMATION "未找到 AUnit 文件。$\n请确认 tools\aunit\ 目录与安装程序在同一目录下。"
  ${EndIf}
SectionEnd

; ---------------------------------------------------------------------------
; Optional: code_slicer
; ---------------------------------------------------------------------------
Section "code_slicer 上下文打包工具" SecCodeSlicer
  ${If} ${FileExists} "$EXEDIR\tools\code_slicer\*.*"
    SetOutPath "$INSTDIR\tools\code_slicer"
    CopyFiles /SILENT "$EXEDIR\tools\code_slicer\*.*" "$INSTDIR\tools\code_slicer"
  ${Else}
    MessageBox MB_OK|MB_ICONINFORMATION "未找到 code_slicer 文件。$\n请确认 tools\code_slicer\ 目录与安装程序在同一目录下。"
  ${EndIf}
SectionEnd

; ---------------------------------------------------------------------------
; Optional: Joern
; ---------------------------------------------------------------------------
Section "Joern 代码属性图分析" SecJoern
  ${If} ${FileExists} "$EXEDIR\tools\joern-cli\*.*"
    SetOutPath "$INSTDIR\tools\joern-cli"
    CopyFiles /SILENT "$EXEDIR\tools\joern-cli\*.*" "$INSTDIR\tools\joern-cli"
    ; Register JOERN_HOME environment variable
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "JOERN_HOME" "$INSTDIR\tools\joern-cli"
    ; Add joern-cli/bin to PATH (contains joern-parse.bat etc.)
    ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
    StrCpy $1 "$1;$INSTDIR\tools\joern-cli\bin"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" $1
  ${Else}
    MessageBox MB_OK|MB_ICONINFORMATION "未找到 Joern 文件。$\n请确认 tools\joern-cli\ 目录与安装程序在同一目录下。"
  ${EndIf}
SectionEnd

; ---------------------------------------------------------------------------
; Optional: Z3
; ---------------------------------------------------------------------------
Section "Z3 约束求解器" SecZ3
  ${If} ${FileExists} "$EXEDIR\tools\z3\*.*"
    SetOutPath "$INSTDIR\tools\z3"
    CopyFiles /SILENT "$EXEDIR\tools\z3\*.*" "$INSTDIR\tools\z3"
    ; Register Z3_HOME environment variable
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Z3_HOME" "$INSTDIR\tools\z3"
    ; Add z3/bin to PATH (contains z3.exe)
    ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
    StrCpy $1 "$1;$INSTDIR\tools\z3\bin"
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" $1
  ${Else}
    MessageBox MB_OK|MB_ICONINFORMATION "未找到 Z3 文件。$\n请确认 tools\z3\ 目录与安装程序在同一目录下。"
  ${EndIf}
SectionEnd

; ---------------------------------------------------------------------------
; Optional: Desktop shortcut
; ---------------------------------------------------------------------------
Section "桌面快捷方式" SecShortcut
  CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\runtime\opencode.exe"
SectionEnd

; ---------------------------------------------------------------------------
; Post-install: broadcast environment change to all running processes
; ---------------------------------------------------------------------------
Section "-PostInstall"
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
SectionEnd

; =============================================================================
; Section descriptions
; =============================================================================
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore}        "OpenCode CLI、Bun 运行时和 Matrix 插件（必选）"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecSpecChecker}  "航天器 C 语言编码规范静态检查工具"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAUnit}        "嵌入式软件单元测试框架"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCodeSlicer}   "code_slicer 上下文切片与打包工具"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecJoern}        "代码属性图生成，用于原子性违规检测"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecZ3}           "SMT 约束求解器，用于原子性违规可行性验证"
  !insertmacro MUI_DESCRIPTION_TEXT ${SecShortcut}     "在桌面创建 Matrix Agent 快捷方式"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; =============================================================================
; Uninstaller
; =============================================================================
Section "Uninstall"
  ; --- Remove all Matrix entries from system PATH ---
  ReadRegStr $1 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ; Runtime
  ${WordReplace} $1 ";$INSTDIR\runtime" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\runtime;" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\runtime"  "" "+" $1
  ; SpecChecker
  ${WordReplace} $1 ";$INSTDIR\tools\specchecker" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\tools\specchecker;" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\tools\specchecker"  "" "+" $1
  ; AUnit
  ${WordReplace} $1 ";$INSTDIR\tools\aunit" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\tools\aunit;" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\tools\aunit"  "" "+" $1
  ; Joern (bin subdir)
  ${WordReplace} $1 ";$INSTDIR\tools\joern-cli\bin" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\tools\joern-cli\bin;" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\tools\joern-cli\bin"  "" "+" $1
  ; Z3 (bin subdir)
  ${WordReplace} $1 ";$INSTDIR\tools\z3\bin" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\tools\z3\bin;" "" "+" $1
  ${WordReplace} $1 "$INSTDIR\tools\z3\bin"  "" "+" $1
  WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" $1

  ; --- Remove tool HOME environment variables ---
  DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "SPECCHECKER_HOME"
  DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "AUNIT_HOME"
  DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "JOERN_HOME"
  DeleteRegValue HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Z3_HOME"

  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; --- Remove registry key ---
  DeleteRegKey HKLM "${INSTALL_REG_KEY}"

  ; --- Remove OpenCode plugin and config we installed ---
  Delete "$PROFILE\.config\opencode\plugin\matrix.js"
  Delete "$PROFILE\.config\opencode\plugin\package.json"
  Delete "$PROFILE\.config\opencode\plugins\matrix.js"
  Delete "$PROFILE\.config\opencode\plugins\package.json"
  RMDir /r "$PROFILE\.config\opencode\skills"
  RMDir /r "$PROFILE\.config\opencode\templates"
  RMDir /r "$PROFILE\.config\opencode\standards"
  Delete "$PROFILE\.config\opencode\bin\pdf-extract.ts"
  Delete "$PROFILE\.config\opencode\bin\sg"
  Delete "$PROFILE\.config\opencode\bin\sg.exe"
  Delete "$PROFILE\.config\opencode\bin\ast-grep"
  Delete "$PROFILE\.config\opencode\bin\ast-grep.exe"
  Delete "$PROFILE\.config\opencode\bin\mdbook"
  Delete "$PROFILE\.config\opencode\bin\mdbook.exe"
  RMDir "$PROFILE\.config\opencode\bin"
  RMDir /r "$PROFILE\.config\opencode\joern"
  RMDir /r "$PROFILE\.config\opencode\node_modules"
  Delete "$PROFILE\.config\opencode\opencode.json"
  Delete "$APPDATA\opencode\plugin\matrix.js"
  Delete "$APPDATA\opencode\plugin\package.json"
  Delete "$APPDATA\opencode\plugins\matrix.js"
  Delete "$APPDATA\opencode\plugins\package.json"
  RMDir /r "$APPDATA\opencode\skills"
  RMDir /r "$APPDATA\opencode\templates"
  RMDir /r "$APPDATA\opencode\standards"
  Delete "$APPDATA\opencode\bin\pdf-extract.ts"
  Delete "$APPDATA\opencode\bin\sg"
  Delete "$APPDATA\opencode\bin\sg.exe"
  Delete "$APPDATA\opencode\bin\ast-grep"
  Delete "$APPDATA\opencode\bin\ast-grep.exe"
  Delete "$APPDATA\opencode\bin\mdbook"
  Delete "$APPDATA\opencode\bin\mdbook.exe"
  RMDir "$APPDATA\opencode\bin"
  RMDir /r "$APPDATA\opencode\joern"
  RMDir /r "$APPDATA\opencode\node_modules"
  Delete "$APPDATA\opencode\opencode.json"

  ; --- Remove bundled ripgrep from OpenCode data dir ---
  Delete "$PROFILE\.local\share\opencode\bin\rg.exe"

  ; --- Remove installation directory ---
  RMDir /r "$INSTDIR"

  ; --- Remove desktop shortcut ---
  Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
SectionEnd
