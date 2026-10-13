using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Rea.WindowsGui
{
    public sealed class ReaGuiOutputLine
    {
        public ReaGuiOutputLine(string stream, string text)
        {
            Stream = stream;
            Text = text;
        }

        public string Stream { get; private set; }
        public string Text { get; private set; }
    }

    public sealed class ReaGuiProcessRunner : IDisposable
    {
        private readonly ConcurrentQueue<ReaGuiOutputLine> _output =
            new ConcurrentQueue<ReaGuiOutputLine>();
        private readonly Process _process;

        public ReaGuiProcessRunner(ProcessStartInfo startInfo)
        {
            if (startInfo == null)
            {
                throw new ArgumentNullException("startInfo");
            }

            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.StandardOutputEncoding = Encoding.UTF8;
            startInfo.StandardErrorEncoding = Encoding.UTF8;

            _process = new Process();
            _process.StartInfo = startInfo;
            _process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data != null)
                {
                    _output.Enqueue(new ReaGuiOutputLine("stdout", args.Data));
                }
            };
            _process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
            {
                if (args.Data != null)
                {
                    _output.Enqueue(new ReaGuiOutputLine("stderr", args.Data));
                }
            };
        }

        public static bool IsLocalPath(string path)
        {
            if (String.IsNullOrWhiteSpace(path))
            {
                return false;
            }

            string root = Path.GetPathRoot(path);
            if (String.IsNullOrEmpty(root) || root.StartsWith(@"\\", StringComparison.Ordinal))
            {
                return false;
            }

            uint driveType = GetDriveType(root);
            return driveType == 2 || driveType == 3 || driveType == 5 || driveType == 6;
        }

        public bool HasExited
        {
            get { return _process.HasExited; }
        }

        public int ExitCode
        {
            get { return _process.ExitCode; }
        }

        public void Start()
        {
            if (!_process.Start())
            {
                throw new InvalidOperationException("REA CLI 프로세스를 시작하지 못했습니다.");
            }

            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();
        }

        public void WaitForExit()
        {
            _process.WaitForExit();
        }

        public bool TryDequeue(out ReaGuiOutputLine line)
        {
            return _output.TryDequeue(out line);
        }

        public void Dispose()
        {
            _process.Dispose();
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern uint GetDriveType(string rootPathName);
    }
}
