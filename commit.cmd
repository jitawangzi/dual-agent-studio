set http_proxy=http://127.0.0.1:10809
set https_proxy=http://127.0.0.1:10809


@echo off
chcp 65001 > nul

setlocal enabledelayedexpansion

set /p commitMsg="请输入提交信息（直接回车使用默认信息）: "
if "!commitMsg!"=="" set commitMsg=一些普通的修改


git add .

git commit -m "!commitMsg!"

git push

set exitCode=%errorlevel%

if !exitCode! equ 0 (
    echo.
    echo 成功结束
    echo.
) else (
    echo.
    echo push到Git仓库失败。
    echo.
)

endlocal

pause

