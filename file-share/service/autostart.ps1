# Registers (or removes) the logon task that starts the download service.
#
#   powershell -ExecutionPolicy Bypass -File service\autostart.ps1
#   powershell -ExecutionPolicy Bypass -File service\autostart.ps1 -Remove
#
# Why: the download service is a detached process, so it does NOT survive a
# reboot by itself. Without this task, links stay dead after a restart until
# something (an agent upload, or a manual `manage.mjs start`) brings it back.
param(
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$TaskName = 'download-service-autostart'
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root     = Split-Path -Parent $Here
$Manage   = Join-Path $Here 'manage.mjs'
$Node     = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { $Node = 'C:\Program Files\nodejs\node.exe' }

if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "已删除计划任务：$TaskName"
    } else {
        Write-Output "计划任务不存在：$TaskName"
    }
    exit 0
}

if (-not (Test-Path $Manage)) { throw "找不到 manage.mjs：$Manage" }
if (-not (Test-Path $Node))   { throw "找不到 node.exe：$Node" }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Output "计划任务已存在，先删除以便按当前路径重建"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# 20s delay so logon contention doesn't make the port bind fail
$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$Manage`" start" -WorkingDirectory $Here

$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = 'PT20S'

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal `
    -Description '登录时启动下载服务（download-service MCP 的本机只读 HTTP 服务）。删除本任务即可取消开机自启。' | Out-Null

Write-Output "已注册计划任务：$TaskName"
$t = Get-ScheduledTask -TaskName $TaskName
Write-Output ("  触发：{0}" -f ($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }))
Write-Output ("  执行：{0} {1}" -f $t.Actions[0].Execute, $t.Actions[0].Arguments)
Write-Output ("  延迟：{0} 秒" -f ([int]([System.Xml.XmlConvert]::ToTimeSpan($t.Triggers[0].Delay).TotalSeconds)))
