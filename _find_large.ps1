Get-ChildItem -Path 'packages/core/src','packages/cli/src','packages/tools/src','packages/providers/src' -Filter '*.ts' -Recurse -File | ForEach-Object {
    $lines = (Get-Content $_.FullName | Measure-Object -Line).Lines
    if ($lines -gt 500) {
        [PSCustomObject]@{
            File = $_.FullName.Replace($PWD.Path, '.')
            Lines = $lines
        }
    }
} | Sort-Object -Property Lines -Descending | Format-Table -AutoSize