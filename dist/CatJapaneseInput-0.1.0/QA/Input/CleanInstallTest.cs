using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class CleanInstallTest
{
    private const string ProductName = "CatJapaneseInput";
    private const string Version = "3.35.6359.100";
    private const string ProductCode = "{B18668DB-1688-4D33-B18E-ACBC5B321349}";
    private const string TipClass = "{663ED91C-B893-4159-B0BA-1B78443E0C42}";
    private const string TipProfile = "{F12E2BB4-EFA5-46B0-8176-1F06A12BDAC6}";
    private const string MsiName = "CatJapaneseInput-0.1.0-Windows-x64.msi";

    private static readonly string Exe = Assembly.GetExecutingAssembly().Location;
    private static readonly string InputDir = Path.GetDirectoryName(Exe);
    private static readonly string InstallDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), ProductName);

    [STAThread]
    private static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--input")
            return TestInput();
        if (args.Length == 1 && args[0] == "--audit")
        {
            List<string> state = Footprint();
            foreach (string item in state)
                Console.WriteLine(item);
            Console.WriteLine(state.Count == 0 ? "CATJ_PRESENT=NO" : "CATJ_PRESENT=YES");
            return state.Count == 0 ? 0 : 2;
        }

        if (args.Length != 1 || !Directory.Exists(args[0]))
        {
            Console.Error.WriteLine("Supply an existing results directory in the clean Windows guest.");
            return 2;
        }

        string reportDir = Path.Combine(args[0], DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff"));
        Directory.CreateDirectory(reportDir);
        int result;
        using (StreamWriter report = new StreamWriter(Path.Combine(reportDir, "result.txt"), false, Encoding.UTF8))
        {
            report.AutoFlush = true;
            try
            {
                result = Run(reportDir, report);
            }
            catch (Exception error)
            {
                Log(report, "ERROR=" + error.Message);
                result = 1;
            }
            Log(report, "RESULT=" + (result == 0 ? "PASS" : result == 2 ? "BLOCKED" : "FAIL"));
        }
        Console.WriteLine("Results: " + reportDir);
        return result;
    }

    private static int Run(string output, TextWriter report)
    {
        string msi = Path.Combine(InputDir, MsiName);
        string expectedHash = File.ReadAllText(Path.Combine(InputDir, "MSI.sha256")).Trim();
        string actualHash = Sha256(msi);
        string buildText;
        using (RegistryKey versionKey = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
            buildText = versionKey == null ? null : versionKey.GetValue("CurrentBuild") as string;
        Log(report, "Windows build=" + buildText);
        Log(report, "MSI_SHA256=" + actualHash);
        if (!String.Equals(expectedHash, actualHash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Installer SHA-256 differs from MSI.sha256.");
        int build;
        if (!Environment.Is64BitProcess || !Int32.TryParse(buildText, out build) || build < 22000)
            throw new PlatformNotSupportedException("Run on Windows 11 x64.");
        List<string> baseline = Footprint();
        if (baseline.Count != 0)
        {
            foreach (string item in baseline)
                Log(report, "Existing CatJapaneseInput: " + item);
            return 2;
        }
        Log(report, "Clean baseline: no CatJapaneseInput product, TSF registration, service or files.");
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            if (!new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
            {
                Log(report, "Run the test as an administrator in the clean guest.");
                return 2;
            }
        }

        bool inputPassed = false;
        bool installedCorrectly = false;
        bool cleanupPassed = false;
        try
        {
            int install = RunInstaller("/i \"" + msi + "\"", Path.Combine(output, "install.log"));
            Log(report, "INSTALL_EXIT=" + install);
            if (!Success(install) || !HasProduct())
                return 1;
            CheckInstalledFile("mozc_tip64.dll");
            CheckInstalledFile("catj_server.exe");
            foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
            {
                if (!HasKey(view, TipKey) || !HasKey(view, ComKey))
                    throw new InvalidOperationException("TSF or COM registration is absent in " + view);
            }
            if (!HasKey(RegistryView.Registry64, ServiceKey))
                throw new InvalidOperationException("Cache service registration is absent.");
            installedCorrectly = true;
            Log(report, "Verified clean installation, version, TSF registration and cache service.");
            int input = RunProcess(Exe, "--input");
            inputPassed = input == 0;
            Log(report, inputPassed
                ? "Japanese input verified: nihonngo -> Space -> Enter; committed editor text: 日本語; active Cat TSF."
                : "Japanese input did not pass; editor exit=" + input);
        }
        finally
        {
            if (HasProduct())
            {
                int uninstall = RunInstaller("/x " + ProductCode, Path.Combine(output, "uninstall.log"));
                Log(report, "UNINSTALL_EXIT=" + uninstall);
                List<string> remaining = Footprint();
                for (int wait = 0; remaining.Count != 0 && wait < 10; ++wait)
                {
                    Thread.Sleep(1000);
                    remaining = Footprint();
                }
                foreach (string item in remaining)
                    Log(report, "After uninstall: " + item);
                cleanupPassed = Success(uninstall) && remaining.Count == 0;
                if (cleanupPassed)
                    Log(report, "Uninstall verified: product, TSF registration, service and files removed.");
            }
        }
        return installedCorrectly && inputPassed && cleanupPassed ? 0 : 1;
    }

    private static int TestInput()
    {
        Application.EnableVisualStyles();
        using (Form form = new Form())
        using (Label instruction = new Label())
        using (RichTextBox editor = new RichTextBox())
        using (Label status = new Label())
        using (Button verify = new Button())
        {
            form.Text = "CatJapaneseInput 0.1.0 - clean Windows input test";
            form.StartPosition = FormStartPosition.CenterScreen;
            form.ClientSize = new Size(660, 245);
            instruction.SetBounds(16, 12, 620, 58);
            instruction.Text = "Select Japanese CatJapaneseInput with Windows + Space. In hiragana mode, type "
                + "n i h o n n g o, press Space once, then Enter to commit 日本語. Click Verify.";
            editor.SetBounds(16, 74, 625, 54);
            editor.ShortcutsEnabled = false;
            status.SetBounds(16, 138, 625, 52);
            status.Text = "The test checks the committed text and the active CatJapaneseInput TSF profile.";
            verify.SetBounds(16, 198, 120, 30);
            verify.Text = "Verify";
            verify.Click += delegate
            {
                if (editor.Text != "日本語")
                {
                    status.Text = "Expected exact text 日本語. Edit the field and try again.";
                    editor.Focus();
                    return;
                }
                editor.Focus();
                if (!CatProfileIsActive() || !CatTipIsLoaded())
                {
                    status.Text = "CatJapaneseInput was not active in this editor. Select its keyboard and repeat the input.";
                    return;
                }
                form.DialogResult = DialogResult.OK;
                form.Close();
            };
            form.Controls.AddRange(new Control[] { instruction, editor, status, verify });
            form.Shown += delegate { editor.Focus(); };
            return form.ShowDialog() == DialogResult.OK ? 0 : 1;
        }
    }

    private static bool CatProfileIsActive()
    {
        ProcessStartInfo info = new ProcessStartInfo(Path.Combine(InputDir, "profile.exe"));
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        using (Process probe = Process.Start(info))
        {
            string result = probe.StandardOutput.ReadToEnd();
            probe.WaitForExit();
            return probe.ExitCode == 0 && result.IndexOf("type=1 language=0411 " + TipClass + " " + TipProfile,
                StringComparison.OrdinalIgnoreCase) >= 0;
        }
    }

    private static bool CatTipIsLoaded()
    {
        string expected = Path.Combine(InstallDir, "mozc_tip64.dll");
        using (Process current = Process.GetCurrentProcess())
            return current.Modules.OfType<ProcessModule>().Any(
                module => String.Equals(module.FileName, expected, StringComparison.OrdinalIgnoreCase));
    }

    private static string Sha256(string path)
    {
        using (FileStream input = File.OpenRead(path))
        using (SHA256 hasher = SHA256.Create())
            return BitConverter.ToString(hasher.ComputeHash(input)).Replace("-", "");
    }

    private static bool Success(int code) { return code == 0 || code == 3010; }

    private static int RunInstaller(string arguments, string log)
    {
        return RunProcess(Path.Combine(Environment.SystemDirectory, "msiexec.exe"),
            arguments + " /passive /norestart /L*v \"" + log + "\"");
    }

    private static int RunProcess(string file, string arguments)
    {
        ProcessStartInfo info = new ProcessStartInfo(file, arguments);
        info.UseShellExecute = false;
        using (Process process = Process.Start(info))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    private static void CheckInstalledFile(string name)
    {
        string path = Path.Combine(InstallDir, name);
        if (!File.Exists(path) || FileVersionInfo.GetVersionInfo(path).FileVersion != Version)
            throw new InvalidOperationException("The installed file is missing or at the wrong version: " + name);
    }

    private static void Log(TextWriter report, string message)
    {
        report.WriteLine(message);
        Console.WriteLine(message);
    }

    private const string UninstallKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    private const string TipKey = @"SOFTWARE\Microsoft\CTF\TIP\" + TipClass
        + @"\LanguageProfile\0x00000411\" + TipProfile;
    private const string ComKey = @"SOFTWARE\Classes\CLSID\" + TipClass + @"\InProcServer32";
    private const string ServiceKey = @"SYSTEM\CurrentControlSet\Services\CatJapaneseInputCacheService";

    private static bool HasKey(RegistryView view, string name)
    {
        using (RegistryKey hive = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
        using (RegistryKey key = hive.OpenSubKey(name))
            return key != null;
    }

    private static bool HasProduct()
    {
        return HasKey(RegistryView.Registry64, UninstallKey + "\\" + ProductCode)
            || HasKey(RegistryView.Registry32, UninstallKey + "\\" + ProductCode);
    }

    private static List<string> Footprint()
    {
        var found = new List<string>();
        foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using (RegistryKey hive = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
            using (RegistryKey programs = hive.OpenSubKey(UninstallKey))
            {
                if (programs != null)
                {
                    foreach (string product in programs.GetSubKeyNames())
                    {
                        using (RegistryKey entry = programs.OpenSubKey(product))
                        {
                            if (entry != null && String.Equals(entry.GetValue("DisplayName") as string,
                                    ProductName, StringComparison.OrdinalIgnoreCase))
                                found.Add("Installed product (" + view + ")");
                        }
                    }
                }
            }
            if (HasKey(view, TipKey)) found.Add("TSF profile (" + view + ")");
            if (HasKey(view, ComKey)) found.Add("COM server (" + view + ")");
        }
        if (HasKey(RegistryView.Registry64, ServiceKey)) found.Add("Cache service");
        if (Directory.Exists(InstallDir) && Directory.EnumerateFileSystemEntries(InstallDir).Any())
            found.Add("Installed files");
        return found;
    }
}

