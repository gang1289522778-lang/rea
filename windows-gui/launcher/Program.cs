using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using System.Windows.Forms;

internal static class Program
{
    private const string AppTitle = "REA Windows GUI";

    [STAThread]
    private static int Main(string[] args)
    {
        var validateOnly = args.Length == 1 && args[0] == "--validate-only";
        if (args.Length > 0 && !validateOnly)
        {
            ReportError("지원하지 않는 실행 옵션입니다.", validateOnly);
            return 2;
        }

        var root = AppContext.BaseDirectory;
        var packageRoot = Path.Combine(root, "node_modules", "rea-agents");
        var scriptPath = Path.Combine(packageRoot, "windows-gui", "rea-gui.ps1");
        var nodePath = Path.Combine(root, "node.exe");
        var requiredPaths = new[]
        {
            scriptPath,
            nodePath,
            Path.Combine(packageRoot, "scripts", "rea.mjs"),
        };
        var missingPath = requiredPaths.FirstOrDefault(path => !File.Exists(path));
        if (missingPath is not null)
        {
            var message =
                $"배포 파일이 누락되었습니다: {missingPath}{Environment.NewLine}"
                + "압축 파일의 모든 내용을 함께 풀고 rea-gui.exe를 다시 실행하세요.";
            ReportError(
                message,
                validateOnly
            );
            return 1;
        }

        var systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
        var powershellPath = Path.Combine(
            systemDirectory,
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe"
        );
        if (!File.Exists(powershellPath))
        {
            ReportError("Windows PowerShell을 찾을 수 없습니다.", validateOnly);
            return 1;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = powershellPath,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("-NoLogo");
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-STA");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("RemoteSigned");
        startInfo.ArgumentList.Add("-File");
        startInfo.ArgumentList.Add(scriptPath);
        if (validateOnly)
            startInfo.ArgumentList.Add("-ValidateOnly");
        startInfo.Environment["PATH"] =
            $"{root}{Path.PathSeparator}{Environment.GetEnvironmentVariable("PATH")}";

        try
        {
            using var process = new Process { StartInfo = startInfo };
            var standardOutput = new StringBuilder();
            var standardError = new StringBuilder();
            process.OutputDataReceived += (_, eventArgs) =>
            {
                if (eventArgs.Data is not null)
                    standardOutput.AppendLine(eventArgs.Data);
            };
            process.ErrorDataReceived += (_, eventArgs) =>
            {
                if (eventArgs.Data is not null)
                    standardError.AppendLine(eventArgs.Data);
            };
            if (!process.Start())
            {
                ReportError("Windows PowerShell을 시작하지 못했습니다.", validateOnly);
                return 1;
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            process.WaitForExit();
            process.WaitForExit();
            if (process.ExitCode == 0)
                return 0;

            var details =
                standardError.Length > 0
                    ? standardError.ToString()
                    : standardOutput.ToString();
            var message =
                string.IsNullOrWhiteSpace(details)
                    ? $"REA GUI가 종료 코드 {process.ExitCode}로 종료되었습니다."
                    : details.Trim();
            ReportError(message, validateOnly);
            return process.ExitCode;
        }
        catch (Exception exception) when (exception is IOException or Win32Exception)
        {
            ReportError(
                $"REA GUI를 시작하지 못했습니다: {exception.Message}",
                validateOnly
            );
            return 1;
        }
    }

    private static void ReportError(string message, bool validateOnly)
    {
        if (validateOnly)
        {
            Console.Error.WriteLine(message);
            return;
        }

        MessageBox.Show(message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
