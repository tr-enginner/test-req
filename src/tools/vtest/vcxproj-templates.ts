/**
 * VS2013 vcxproj / sln template generation for VTest device DLL and test driver DLL.
 *
 * Based on real VTest source (bus1553.vcxproj, CAN.vcxproj):
 *   - ToolsVersion=12.0, PlatformToolset=v120 (or v120_xp)
 *   - Win32 only (VTest is 32-bit)
 *   - MFC as Dynamic DLL (UseOfMfc=Dynamic) — required by vttDevice.h (#define _AFXDLL, <afxtempl.h>)
 *   - MultiByte charset
 *   - .def file for MainProc export
 *   - Precompiled headers (stdafx.h/stdafx.cpp)
 */

/**
 * Generate a deterministic GUID from a project name using FNV-1a hash.
 * Format: {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}
 */
export function deterministicGuid(name: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  const bytes: number[] = []
  let state = h >>> 0
  for (let i = 0; i < 16; i++) {
    state = Math.imul(state, 0x01000193) ^ (i * 0x27d4eb2d)
    bytes.push((state >>> 0) & 0xff)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = bytes.map((b) => b.toString(16).padStart(2, "0"))
  return (
    `{${hex[0]}${hex[1]}${hex[2]}${hex[3]}` +
    `-${hex[4]}${hex[5]}` +
    `-${hex[6]}${hex[7]}` +
    `-${hex[8]}${hex[9]}` +
    `-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}}`
  ).toUpperCase()
}

export interface VcxprojParams {
  projectName: string
  sourceFiles: string[]
  headerFiles: string[]
  vtestIncludePath: string
  projectGuid: string
  /** .def module definition file for DLL exports */
  defFile?: string
  /** Additional preprocessor definitions */
  extraDefines?: string
}

/**
 * Generate a .vcxproj file for a DynamicLibrary (DLL) project.
 * Matches real VTest device DLL build configuration:
 *   - v120 toolset (VS2013)
 *   - MFC Dynamic
 *   - Win32 platform
 *   - MultiByte charset
 *   - Precompiled headers (stdafx.h)
 */
export function generateVcxproj(params: VcxprojParams): string {
  const { projectName, sourceFiles, headerFiles, vtestIncludePath, projectGuid, defFile, extraDefines } = params
  const defines = `WIN32;_DEBUG;_WINDOWS;_USRDLL;${extraDefines ? extraDefines + ";" : ""}%(PreprocessorDefinitions)`
  const releaseDefines = `WIN32;NDEBUG;_WINDOWS;_USRDLL;${extraDefines ? extraDefines + ";" : ""}%(PreprocessorDefinitions)`

  const sourceItems = sourceFiles
    .map((f) => {
      if (f === "stdafx.cpp") {
        return `    <ClCompile Include="${f}">\r\n      <PrecompiledHeader Condition="'$(Configuration)|$(Platform)'=='Debug|Win32'">Create</PrecompiledHeader>\r\n      <PrecompiledHeader Condition="'$(Configuration)|$(Platform)'=='Release|Win32'">Create</PrecompiledHeader>\r\n    </ClCompile>`
      }
      return `    <ClCompile Include="${f}" />`
    })
    .join("\r\n")
  const headerItems = headerFiles
    .map((f) => `    <ClInclude Include="${f}" />`)
    .join("\r\n")

  const defFileSection = defFile
    ? `      <ModuleDefinitionFile>.\\${defFile}</ModuleDefinitionFile>\r\n`
    : ""

  return `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" ToolsVersion="12.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup Label="ProjectConfigurations">
    <ProjectConfiguration Include="Debug|Win32">
      <Configuration>Debug</Configuration>
      <Platform>Win32</Platform>
    </ProjectConfiguration>
    <ProjectConfiguration Include="Release|Win32">
      <Configuration>Release</Configuration>
      <Platform>Win32</Platform>
    </ProjectConfiguration>
  </ItemGroup>
  <PropertyGroup Label="Globals">
    <ProjectGuid>${projectGuid}</ProjectGuid>
    <RootNamespace>${projectName}</RootNamespace>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.Default.props" />
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Debug|Win32'" Label="Configuration">
    <ConfigurationType>DynamicLibrary</ConfigurationType>
    <UseDebugLibraries>true</UseDebugLibraries>
    <PlatformToolset>v120</PlatformToolset>
    <CharacterSet>MultiByte</CharacterSet>
    <UseOfMfc>Dynamic</UseOfMfc>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|Win32'" Label="Configuration">
    <ConfigurationType>DynamicLibrary</ConfigurationType>
    <UseDebugLibraries>false</UseDebugLibraries>
    <PlatformToolset>v120</PlatformToolset>
    <CharacterSet>MultiByte</CharacterSet>
    <UseOfMfc>Dynamic</UseOfMfc>
  </PropertyGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.props" />
  <ImportGroup Label="ExtensionSettings">
  </ImportGroup>
  <ImportGroup Condition="'$(Configuration)|$(Platform)'=='Debug|Win32'" Label="PropertySheets">
    <Import Project="$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props" Condition="exists('$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props')" Label="LocalAppDataPlatform" />
  </ImportGroup>
  <ImportGroup Condition="'$(Configuration)|$(Platform)'=='Release|Win32'" Label="PropertySheets">
    <Import Project="$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props" Condition="exists('$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props')" Label="LocalAppDataPlatform" />
  </ImportGroup>
  <PropertyGroup Label="UserMacros" />
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Debug|Win32'">
    <TargetName>${projectName}</TargetName>
    <TargetExt>.dll</TargetExt>
    <OutDir>$(SolutionDir)Debug\\</OutDir>
    <IntDir>$(SolutionDir)Debug\\$(ProjectName)\\</IntDir>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|Win32'">
    <TargetName>${projectName}</TargetName>
    <TargetExt>.dll</TargetExt>
    <OutDir>$(SolutionDir)Release\\</OutDir>
    <IntDir>$(SolutionDir)Release\\$(ProjectName)\\</IntDir>
  </PropertyGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Debug|Win32'">
    <ClCompile>
      <Optimization>Disabled</Optimization>
      <AdditionalIncludeDirectories>${vtestIncludePath};$(SolutionDir)..\\..\\..\\vtest-src\\inc;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
      <PreprocessorDefinitions>${defines}</PreprocessorDefinitions>
      <RuntimeLibrary>MultiThreadedDebugDLL</RuntimeLibrary>
      <WarningLevel>Level3</WarningLevel>
      <DebugInformationFormat>ProgramDatabase</DebugInformationFormat>
      <PrecompiledHeader>Use</PrecompiledHeader>
      <PrecompiledHeaderFile>stdafx.h</PrecompiledHeaderFile>
    </ClCompile>
    <Link>
      <GenerateDebugInformation>true</GenerateDebugInformation>
${defFileSection}    </Link>
  </ItemDefinitionGroup>
  <ItemDefinitionGroup Condition="'$(Configuration)|$(Platform)'=='Release|Win32'">
    <ClCompile>
      <Optimization>MaxSpeed</Optimization>
      <AdditionalIncludeDirectories>${vtestIncludePath};$(SolutionDir)..\\..\\..\\vtest-src\\inc;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
      <PreprocessorDefinitions>${releaseDefines}</PreprocessorDefinitions>
      <RuntimeLibrary>MultiThreadedDLL</RuntimeLibrary>
      <WarningLevel>Level3</WarningLevel>
      <FunctionLevelLinking>true</FunctionLevelLinking>
      <IntrinsicFunctions>true</IntrinsicFunctions>
      <PrecompiledHeader>Use</PrecompiledHeader>
      <PrecompiledHeaderFile>stdafx.h</PrecompiledHeaderFile>
    </ClCompile>
    <Link>
      <GenerateDebugInformation>true</GenerateDebugInformation>
      <EnableCOMDATFolding>true</EnableCOMDATFolding>
      <OptimizeReferences>true</OptimizeReferences>
${defFileSection}    </Link>
  </ItemDefinitionGroup>
  <ItemGroup>
${sourceItems}
  </ItemGroup>
  <ItemGroup>
${headerItems}
  </ItemGroup>
  <Import Project="$(VCTargetsPath)\\Microsoft.Cpp.targets" />
  <ImportGroup Label="ExtensionTargets">
  </ImportGroup>
</Project>
`
}

export interface VcxprojFiltersParams {
  sourceFiles: string[]
  headerFiles: string[]
}

/**
 * Generate a .vcxproj.filters file with standard Source Files / Header Files filters.
 */
export function generateVcxprojFilters(params: VcxprojFiltersParams): string {
  const { sourceFiles, headerFiles } = params

  const sourceItems = sourceFiles
    .map(
      (f) =>
        `    <ClCompile Include="${f}">\r\n      <Filter>Source Files</Filter>\r\n    </ClCompile>`,
    )
    .join("\r\n")
  const headerItems = headerFiles
    .map(
      (f) =>
        `    <ClInclude Include="${f}">\r\n      <Filter>Header Files</Filter>\r\n    </ClInclude>`,
    )
    .join("\r\n")

  return `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <ItemGroup>
    <Filter Include="Source Files">
      <UniqueIdentifier>{4FC737F1-C7A5-4376-A066-2A32D752A2FF}</UniqueIdentifier>
      <Extensions>cpp;c;cc;cxx;def;odl;idl;hpj;bat;asm;asmx</Extensions>
    </Filter>
    <Filter Include="Header Files">
      <UniqueIdentifier>{93995380-89BD-4b04-88EB-625FBE52EBFB}</UniqueIdentifier>
      <Extensions>h;hh;hpp;hxx;hm;inl;inc;xsd</Extensions>
    </Filter>
  </ItemGroup>
  <ItemGroup>
${sourceItems}
  </ItemGroup>
  <ItemGroup>
${headerItems}
  </ItemGroup>
</Project>
`
}

export interface SlnProject {
  name: string
  guid: string
  vcxprojRelPath: string
}

/**
 * Generate a .sln file containing all projects.
 * Uses VS2013 format version (12.00, Visual Studio 2013).
 */
export function generateSln(projects: SlnProject[], solutionName?: string): string {
  const cppProjectTypeGuid = "{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}"

  const projectEntries = projects
    .map(
      (p) =>
        `Project("${cppProjectTypeGuid}") = "${p.name}", "${p.vcxprojRelPath}", "${p.guid}"\r\nEndProject`,
    )
    .join("\r\n")

  const configEntries = projects
    .map(
      (p) =>
        `\t\t${p.guid}.Debug|Win32.ActiveCfg = Debug|Win32\r\n` +
        `\t\t${p.guid}.Debug|Win32.Build.0 = Debug|Win32\r\n` +
        `\t\t${p.guid}.Release|Win32.ActiveCfg = Release|Win32\r\n` +
        `\t\t${p.guid}.Release|Win32.Build.0 = Release|Win32`,
    )
    .join("\r\n")

  return `\r\nMicrosoft Visual Studio Solution File, Format Version 12.00\r
# Visual Studio 2013\r
VisualStudioVersion = 12.0.40629.0\r
MinimumVisualStudioVersion = 10.0.40219.1\r
${projectEntries}\r
Global\r
\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\r
\t\tDebug|Win32 = Debug|Win32\r
\t\tRelease|Win32 = Release|Win32\r
\tEndGlobalSection\r
\tGlobalSection(ProjectConfigurationPlatforms) = postSolution\r
${configEntries}\r
\tEndGlobalSection\r
\tGlobalSection(SolutionProperties) = preSolution\r
\t\tHideSolutionNode = FALSE\r
\tEndGlobalSection\r
EndGlobal\r
`
}
