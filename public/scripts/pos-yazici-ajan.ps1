<#
.SYNOPSIS
    PAKETÜS — Yerel 80mm Termal Yazıcı, ESC/POS Yakalayıcı ve Caller ID Ajanı
    Uyumluluk: Windows 7 / 8.1 / 10 / 11 (PowerShell 3.0 ve üzeri)

.DESCRIPTION
    1. PAKETÜS bulut veya yerel sunucusundaki bekleyen yazdırma işlerini (print_jobs)
       dinler ve işletmenin varsayılan 80mm termal yazıcısından sessiz (onaysız) çıktı alır.
    2. Yerel POS klasörüne (ör: SambaPOS, Adisyo, Sanal Yazıcı Portu -> C:\PaketusPOS\Fisler)
       bırakılan .txt / .prn / .esc fiş dosyalarını anında okuyup PAKETÜS sunucusuna
       (/api/integrations/webhook/pos_agent) otomatik kurye paketi olarak düşürür.
    3. İsteğe bağlı Caller ID cihazı log dosyasını izleyerek arayan numarayı kasada açar.

.EXAMPLE
    powershell.exe -ExecutionPolicy Bypass -File .\pos-yazici-ajan.ps1 -ServerUrl "https://paketus.onrender.com" -ApiToken "TOKEN" -ShopId 1
#>

param(
    [string]$ServerUrl = "http://localhost:3000",
    [string]$ApiToken = "",
    [int]$ShopId = 1,
    [string]$PrinterName = "",
    [string]$PosDropFolder = "C:\PaketusPOS\Fisler",
    [int]$PollIntervalSeconds = 4,
    [switch]$Once
)

$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  PAKETÜS — 80mm Termal Yazıcı & POS Entegrasyon Ajanı    " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Sunucu       : $ServerUrl"
Write-Host "Şube ID      : #$ShopId"
Write-Host "POS Klasörü  : $PosDropFolder"
Write-Host "Yazıcı       : $(if ($PrinterName) { $PrinterName } else { '[Varsayılan Windows Termal Yazıcı]' })"
Write-Host "----------------------------------------------------------"

# Klasör hazırlığı
$ProcessedFolder = Join-Path $PosDropFolder "Islenenler"
if (-not (Test-Path $PosDropFolder)) {
    New-Item -ItemType Directory -Path $PosDropFolder -Force | Out-Null
}
if (-not (Test-Path $ProcessedFolder)) {
    New-Item -ItemType Directory -Path $ProcessedFolder -Force | Out-Null
}

function Send-PosReceiptToPaketus {
    param(
        [string]$FilePath
    )
    try {
        $rawText = Get-Content -Path $FilePath -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($rawText)) {
            return
        }

        $fileName = [System.IO.Path]::GetFileNameWithoutExtension($FilePath)
        $payloadObj = @{
            shopId     = $ShopId
            externalId = "POS-$fileName"
            rawText    = $rawText
        }
        $jsonBody = $payloadObj | ConvertTo-Json -Depth 5 -Compress

        $headers = @{
            "Content-Type" = "application/json; charset=utf-8"
        }
        if ($ApiToken) {
            $headers["Authorization"] = "Bearer $ApiToken"
        }

        $webhookUri = "$($ServerUrl.TrimEnd('/'))/api/integrations/webhook/pos_agent"
        $response = Invoke-RestMethod -Uri $webhookUri -Method Post -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($jsonBody)) -TimeoutSec 10

        if ($response -and $response.ok) {
            Write-Host "[POS -> PAKETÜS] Fiş başarıyla kurye havuzuna aktarıldı: $($response.externalId)" -ForegroundColor Green
            $destPath = Join-Path $ProcessedFolder ([System.IO.Path]::GetFileName($FilePath))
            Move-Item -Path $FilePath -Destination $destPath -Force
        }
    }
    catch {
        Write-Warning "[POS HATA] Fiş gönderilemedi ($FilePath): $($_.Exception.Message)"
    }
}

function Print-ThermalReceiptText {
    param(
        [string]$ReceiptHtml,
        [string]$OrderId
    )
    try {
        # HTML etiketlerini temizleyip 80mm düz termal satırlara dönüştür
        $plain = $ReceiptHtml -replace '<style[\s\S]*?</style>', ''
        $plain = $plain -replace '<br\s*/?>', "`r`n"
        $plain = $plain -replace '</(div|p|tr|h1|h2|h3)>', "`r`n"
        $plain = $plain -replace '<[^>]+>', ''
        $plain = [System.Net.WebUtility]::HtmlDecode($plain)
        $lines = ($plain -split "`r?`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
        $formattedText = ($lines -join "`r`n") + "`r`n`r`n`r`n"

        if ($PrinterName) {
            $formattedText | Out-Printer -Name $PrinterName
        }
        else {
            $formattedText | Out-Printer
        }
        Write-Host "[80MM YAZICI] Sipariş #$OrderId termal yazıcıdan yazdırıldı." -ForegroundColor Yellow
    }
    catch {
        Write-Warning "[YAZICI HATA] #$OrderId yazdırılamadı: $($_.Exception.Message)"
    }
}

$PrintedCache = @{}

do {
    # 1. Yerel POS fiş klasörünü kontrol et (.txt, .prn, .esc)
    $files = Get-ChildItem -Path $PosDropFolder -File -Include *.txt, *.prn, *.esc -ErrorAction SilentlyContinue
    foreach ($file in $files) {
        Send-PosReceiptToPaketus -FilePath $file.FullName
    }

    # 2. Sunucudaki bekleyen yazdırma kuyruğunu kontrol et (Token verilmişse)
    if ($ApiToken) {
        try {
            $headers = @{ "Authorization" = "Bearer $ApiToken" }
            $bootUri = "$($ServerUrl.TrimEnd('/'))/api/bootstrap"
            $boot = Invoke-RestMethod -Uri $bootUri -Method Get -Headers $headers -TimeoutSec 10

            if ($boot -and $boot.printJobs) {
                foreach ($job in $boot.printJobs) {
                    $jobId = "$($job.id)"
                    $orderId = "$($job.order_id)"
                    if ($job.status -eq "queued" -and -not $PrintedCache.ContainsKey($jobId)) {
                        $receiptUri = "$($ServerUrl.TrimEnd('/'))/api/integrations/receipt/$orderId/html"
                        $html = Invoke-RestMethod -Uri $receiptUri -Method Get -Headers $headers -TimeoutSec 10
                        if ($html) {
                            Print-ThermalReceiptText -ReceiptHtml $html -OrderId $orderId
                            $PrintedCache[$jobId] = $true
                        }
                    }
                }
            }
        }
        catch {
            Write-Verbose "Sunucu yazdırma kuyruğu kontrol hatası: $($_.Exception.Message)"
        }
    }

    if ($Once) { break }
    Start-Sleep -Seconds $PollIntervalSeconds
} while ($true)
