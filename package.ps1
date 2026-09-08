# 打包 .eext 扩展（zip，扁平正斜杠条目）
# 用法: powershell -ExecutionPolicy Bypass -File package.ps1 [-Version 1.2.0]
# 未传 -Version 时自动读取 extension.json 中的版本号
param(
	[string]$Version = ""
)

$ErrorActionPreference = "Stop"
# 控制台输出统一为 UTF-8，避免中文输出在 Git Bash 等终端显示为乱码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $Version) {
	$manifest = Get-Content -Raw -Encoding UTF8 (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "extension.json") | ConvertFrom-Json
	$Version = $manifest.version
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$outDir = Join-Path $root "release"
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$outFile = Join-Path $outDir "signal-absence-detection-$Version.eext"
if (Test-Path $outFile) { Remove-Item $outFile -Force }

$entries = @(
	@("extension.json",        "extension.json"),
	@("dist\index.js",         "dist/index.js"),
	@("iframe\index.html",     "iframe/index.html"),
	@("iframe\config.html",    "iframe/config.html"),
	@("images\logo.png",       "images/logo.png"),
	@("images\image.png",      "images/image.png"),
	@("images\image02.png",    "images/image02.png"),
	@("README.md",             "README.md"),
	@("CHANGELOG.md",          "CHANGELOG.md")
)

$zip = [System.IO.Compression.ZipFile]::Open($outFile, 'Create')
try {
	foreach ($e in $entries) {
		$src = Join-Path $root $e[0]
		if (-not (Test-Path $src)) { throw "缺少文件: $($e[0])" }
		[System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $src, $e[1], 'Optimal') | Out-Null
	}
} finally {
	$zip.Dispose()
}

Write-Output "已打包: $outFile"
