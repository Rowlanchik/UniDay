param([Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version)
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  $changes = & git status --porcelain
  if ($LASTEXITCODE -ne 0) { throw 'Откройте клонированный GitHub-проект.' }
  if ($changes) { throw 'Сначала сохраните и отправьте изменения. Рабочая папка должна быть чистой.' }
  $tag = "v$Version"
  & git tag $tag
  if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать тег. Проверьте, нет ли такой версии.' }
  & git push origin $tag
  if ($LASTEXITCODE -ne 0) { throw "Не удалось отправить тег. После настройки входа повторите: git push origin $tag" }
  Write-Output "Выпуск $tag запущен: https://github.com/Rowlanchik/UniDay/actions"
} finally { Pop-Location }
