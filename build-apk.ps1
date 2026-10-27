# Construit l'APK Android de la Crèche et jardin d'enfants Maryam -> Maryam.apk
# Le chemin du dossier contient des accents (é, è) que les outils Android refusent :
# on passe donc par une jonction C:\lamarelle qui pointe vers ce dossier.
$ErrorActionPreference = 'Stop'
$projet = $PSScriptRoot
$lien = 'C:\lamarelle'
if (-not (Test-Path $lien)) { New-Item -ItemType Junction -Path $lien -Target $projet | Out-Null }

$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21'
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"

Set-Location $lien
npx cap sync android
Set-Location "$lien\android"
& .\gradlew.bat assembleDebug
if ($LASTEXITCODE -ne 0) { Write-Host "Echec de la construction : Maryam.apk n'a pas ete modifie." -ForegroundColor Red; exit 1 }
Copy-Item "$lien\android\app\build\outputs\apk\debug\app-debug.apk" "$projet\Maryam.apk" -Force
Write-Host "APK prêt : $projet\Maryam.apk" -ForegroundColor Green
