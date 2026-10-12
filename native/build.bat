@echo off
REM build.bat — compile the AE1 native tools with MSVC (VS2019 Build Tools).
REM No CMake dependency: we drive cl.exe directly through vcvars64.bat.
REM Output: native\build\ae1pack.exe
setlocal

set "VCVARS=C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not exist "%VCVARS%" (
  echo ERROR: vcvars64.bat not found at "%VCVARS%"
  echo Install the "Desktop development with C++" workload for VS Build Tools 2019.
  exit /b 1
)

call "%VCVARS%" >nul
if errorlevel 1 ( echo ERROR: vcvars failed & exit /b 1 )

cd /d "%~dp0"
set "QJSDIR=third_party\quickjs-0.16.2"
if not exist build mkdir build
if not exist build\obj_pack mkdir build\obj_pack
if not exist build\obj_player mkdir build\obj_player
if not exist build\obj_qjs mkdir build\obj_qjs
if not exist build\obj_game mkdir build\obj_game

REM ---- QuickJS static lib (built once, cached; delete build\qjs.lib to rebuild) ----
if not exist build\qjs.lib (
  echo Building QuickJS static lib ^(first time, ~30s^) ...
  cl /nologo /std:c11 /c /O2 /w /D AE1_NO_ATOMICS /D WIN32_LEAN_AND_MEAN /D_WIN32_WINNT=0x0601 ^
     /Fobuild\obj_qjs\ ^
     "%QJSDIR%\dtoa.c" "%QJSDIR%\libregexp.c" "%QJSDIR%\libunicode.c" "%QJSDIR%\quickjs.c"
  if errorlevel 1 ( echo BUILD FAILED ^(quickjs^) & exit /b 1 )
  lib /nologo /OUT:build\qjs.lib build\obj_qjs\*.obj
  if errorlevel 1 ( echo LIB FAILED ^(quickjs^) & exit /b 1 )
)

REM ---- Basis Universal transcoder static lib (built once, cached) ----
set "BASISDIR=third_party\basis"
if not exist build\basis.lib (
  echo Building Basis Universal transcoder static lib ^(first time, ~1-2 min^) ...
  if not exist build\obj_basis mkdir build\obj_basis
  cl /nologo /std:c++17 /EHsc /O2 /w /D BASISD_SUPPORT_KTX2=1 /D BASISD_SUPPORT_KTX2_ZSTD=0 ^
     /Fobuild\obj_basis\ /c "%BASISDIR%\basisu_transcoder.cpp"
  if errorlevel 1 ( echo BUILD FAILED ^(basis^) & exit /b 1 )
  lib /nologo /OUT:build\basis.lib build\obj_basis\*.obj
  if errorlevel 1 ( echo LIB FAILED ^(basis^) & exit /b 1 )
)

REM ---- miniaudio static lib (built once, cached) ----
set "MADIR=third_party\miniaudio"
if not exist build\miniaudio.lib (
  echo Building miniaudio static lib ^(first time, ~30s^) ...
  if not exist build\obj_ma mkdir build\obj_ma
  cl /nologo /O2 /w /Fobuild\obj_ma\ /c "%MADIR%\ma_impl.c"
  if errorlevel 1 ( echo BUILD FAILED ^(miniaudio^) & exit /b 1 )
  lib /nologo /OUT:build\miniaudio.lib build\obj_ma\*.obj
  if errorlevel 1 ( echo LIB FAILED ^(miniaudio^) & exit /b 1 )
)

echo Compiling ae1pack (inspector) ...
cl /nologo /std:c++17 /EHsc /O2 /W4 /Zc:__cplusplus ^
   /Fe:build\ae1pack.exe /Fobuild\obj_pack\ ^
   src\main.cpp src\agp.cpp
if errorlevel 1 ( echo BUILD FAILED ^(ae1pack^) & exit /b 1 )

echo Compiling ae1player (native shell) ...
set "MOPTDIR=third_party\meshoptimizer"
set "STBDIR=third_party\stb"
cl /nologo /std:c++17 /EHsc /O2 /W4 /Zc:__cplusplus /I"%MOPTDIR%" /I"%BASISDIR%" /I"%STBDIR%" ^
   /Fe:build\ae1player.exe /Fobuild\obj_player\ ^
   src\player.cpp src\agp.cpp src\platform_win32.cpp src\gfx_d3d11.cpp src\gltf.cpp src\tex.cpp ^
   "%MOPTDIR%\vertexcodec.cpp" "%MOPTDIR%\indexcodec.cpp" "%MOPTDIR%\vertexfilter.cpp" ^
   build\basis.lib
if errorlevel 1 ( echo BUILD FAILED ^(ae1player^) & exit /b 1 )

echo Compiling ae1js (QuickJS host) ...
cl /nologo /std:c++17 /EHsc /O2 /W4 /Zc:__cplusplus /I"%QJSDIR%" ^
   /Fe:build\ae1js.exe /Fobuild\obj_qjs\ ^
   src\qjs_main.cpp src\agp.cpp build\qjs.lib
if errorlevel 1 ( echo BUILD FAILED ^(ae1js^) & exit /b 1 )

echo Compiling ae1run (engine scheduler host) ...
cl /nologo /std:c++17 /EHsc /O2 /W4 /Zc:__cplusplus /I"%QJSDIR%" ^
   /Fe:build\ae1run.exe /Fobuild\obj_qjs\ ^
   src\qjs_run.cpp src\qjs_host.cpp src\agp.cpp build\qjs.lib
if errorlevel 1 ( echo BUILD FAILED ^(ae1run^) & exit /b 1 )

echo Compiling ae1game (tick + draw) ...
cl /nologo /std:c++17 /EHsc /O2 /W4 /Zc:__cplusplus /I"%QJSDIR%" /I"%MOPTDIR%" /I"%BASISDIR%" /I"%STBDIR%" /I"%MADIR%" ^
   /Fe:build\ae1game.exe /Fobuild\obj_game\ ^
   src\game.cpp src\qjs_host.cpp src\agp.cpp src\platform_win32.cpp src\gfx_d3d11.cpp src\gltf.cpp src\tex.cpp src\audio.cpp ^
   "%MOPTDIR%\vertexcodec.cpp" "%MOPTDIR%\indexcodec.cpp" "%MOPTDIR%\vertexfilter.cpp" ^
   build\qjs.lib build\basis.lib build\miniaudio.lib
if errorlevel 1 ( echo BUILD FAILED ^(ae1game^) & exit /b 1 )

echo.
echo BUILD OK -^> ae1pack, ae1player, ae1js, ae1run, ae1game  (in native\build\)
