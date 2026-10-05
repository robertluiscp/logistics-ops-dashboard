# Vigia (watchdog) da API e do tunel publico -- self-healing.
#
# Nasceu de um incidente real: o servico do tunel ficou "Running" mas com ZERO
# conexao de verdade na borda (nao e' crash, entao as Recovery Actions do
# Windows Service nao pegam isso), e a API tambem nao sobreviveu a um
# logoff/reinicio da maquina. Virar servico sozinho nao teria evitado nenhum
# dos dois -- precisa de um vigia de verdade checando DE FORA.
#
# Rodar como tarefa agendada do Windows (a cada ~10 min) COMO SYSTEM: nao
# precisa de ninguem logado nem elevacao manual, SYSTEM ja' pode reiniciar
# servicos.
#
# Estrategia: local primeiro (isola se o problema e' a API ou o tunel), depois
# publico. So reinicia depois de uma SEGUNDA checagem confirmando a falha
# (evita reiniciar por causa de um soluco de rede de 1 request).
#
# Exemplo:
#   .\watchdog_painel.ps1 -PublicUrl "https://panel.example.com/api/saude" `
#       -ApiService "LogisticsOpsAPI" -TunnelService "cloudflared"
param(
    [string]$LocalUrl = "http://localhost:3001/api/saude",
    [string]$PublicUrl = "",                     # vazio = so' vigia a API local
    [string]$ApiService = "LogisticsOpsAPI",
    [string]$TunnelService = "cloudflared"
)

$ErrorActionPreference = "Stop"
$pastaLog = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $pastaLog | Out-Null
$arquivoLog = Join-Path $pastaLog "watchdog.log"

function Registrar($mensagem) {
    $linha = "{0} - {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $mensagem
    Add-Content -Path $arquivoLog -Value $linha
}

function TestarSaude($url) {
    try {
        $resp = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 10 -UseBasicParsing
        return $resp.StatusCode -eq 200
    } catch {
        return $false
    }
}

function TestarComRetentativa($url) {
    if (TestarSaude $url) { return $true }
    # segunda chance depois de 15s -- evita reiniciar por causa de um unico
    # soluco passageiro de rede.
    Start-Sleep -Seconds 15
    return TestarSaude $url
}

$localOk = TestarComRetentativa $LocalUrl
$publicoOk = if (-not $PublicUrl) { $true } elseif ($localOk) { TestarComRetentativa $PublicUrl } else { $false }

if ($localOk -and $publicoOk) {
    # tudo saudavel -- nao loga nada pra nao encher o arquivo de "ok" a cada
    # 10 minutos; so' registra quando ha' algo a fazer.
    exit 0
}

if (-not $localOk) {
    Registrar "API local NAO respondeu -- reiniciando servico $ApiService."
    try {
        Restart-Service -Name $ApiService -Force -ErrorAction Stop
        Registrar "Servico da API reiniciado."
    } catch {
        Registrar "FALHA ao reiniciar o servico da API: $_"
    }
}

if ($localOk -and -not $publicoOk) {
    # API local ok mas o link publico nao responde -- e' o tunel (ou DNS/CDN,
    # mas comecamos pelo que controlamos).
    Registrar "API local OK mas o endereco publico NAO respondeu -- reiniciando servico $TunnelService."
    try {
        Restart-Service -Name $TunnelService -Force -ErrorAction Stop
        Registrar "Servico do tunel reiniciado."
    } catch {
        Registrar "FALHA ao reiniciar o servico do tunel: $_"
    }
}

# confere de novo depois de dar um tempo pros servicos subirem, so' pra deixar
# registrado se a cura funcionou ou nao.
Start-Sleep -Seconds 20
$localOkDepois = TestarSaude $LocalUrl
$publicoOkDepois = if (-not $PublicUrl) { $true } elseif ($localOkDepois) { TestarSaude $PublicUrl } else { $false }
if ($localOkDepois -and $publicoOkDepois) {
    Registrar "Recuperado com sucesso -- local e publico OK depois do reinicio."
} else {
    Registrar "AINDA COM PROBLEMA depois do reinicio (local=$localOkDepois, publico=$publicoOkDepois) -- precisa de olho humano."
}
